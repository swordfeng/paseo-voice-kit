//! Forward to another OpenAI-compatible speech server (local or remote): models voicekit does
//! not run natively (MLX, PyTorch, cloud). Paseo still talks only to voicekit, so the plugin's
//! fallback, settings and per-feature model choice keep working.

use std::time::Duration;

use super::{SpeakRequest, SttEngine, Timings, TranscribeRequest, TtsEngine, Unavailable, Voice};
use crate::{audio, audio::Pcm, catalog::Remote};

pub struct RemoteEngine {
    remote: Remote,
    client: reqwest::Client,
    handle: tokio::runtime::Handle,
}

impl RemoteEngine {
    /// Checks the server answers before reporting the model as available.
    pub fn connect(remote: &Remote, handle: tokio::runtime::Handle) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(120)).connect_timeout(Duration::from_secs(5)).build()?;
        let engine = Self { remote: remote.clone(), client, handle };
        let url = engine.url("models");
        let probe = engine.handle.block_on(async { engine.auth(engine.client.get(&url)).timeout(Duration::from_secs(5)).send().await });
        match probe {
            Ok(resp) if matches!(resp.status().as_u16(), 401 | 403) => {
                anyhow::bail!("{} rejected the API key ({})", engine.remote.base_url, resp.status())
            }
            // Any other HTTP answer means a server is there; many speech servers lack /models.
            Ok(_) => Ok(engine),
            Err(err) => anyhow::bail!("cannot reach {}: {err}", engine.remote.base_url),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{path}", self.remote.base_url.trim_end_matches('/'))
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self.remote.api_key.as_deref().filter(|k| !k.is_empty()) {
            Some(key) => req.bearer_auth(key),
            None => req,
        }
    }

    async fn error_text(resp: reqwest::Response) -> String {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| body.chars().take(200).collect());
        format!("{status}: {msg}")
    }

    /// A failure to reach or use the server at all (as opposed to a rejected request).
    fn transport(&self, err: reqwest::Error) -> anyhow::Error {
        Unavailable(format!("cannot reach {}: {err}", self.remote.base_url)).into()
    }
}

/// HTTP statuses that say the server can't serve any request now: credentials rejected,
/// endpoint missing (wrong base URL), timeout, overload or a failing upstream. Other errors
/// (400, 413, 415, 422, 500 …) concern the request and leave the model available.
fn unavailable_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 401 | 403 | 404 | 408 | 429 | 502 | 503 | 504)
}

impl SttEngine for RemoteEngine {
    fn transcribe(&self, req: TranscribeRequest<'_>, timings: &mut Timings) -> anyhow::Result<String> {
        let wav = req.audio.to_wav();
        let mut form = reqwest::multipart::Form::new()
            .part("file", reqwest::multipart::Part::bytes(wav).file_name("audio.wav").mime_str("audio/wav")?)
            .text("model", self.remote.model.clone())
            .text("response_format", "json");
        if let Some(lang) = req.language {
            form = form.text("language", lang.to_string());
        }
        if let Some(prompt) = req.prompt {
            form = form.text("prompt", prompt.to_string());
        }
        let started = std::time::Instant::now();
        let text = self.handle.block_on(async {
            let resp = self.auth(self.client.post(self.url("audio/transcriptions"))).multipart(form).send().await.map_err(|e| self.transport(e))?;
            let status = resp.status();
            if !status.is_success() {
                let message = format!("remote transcription failed: {}", Self::error_text(resp).await);
                if unavailable_status(status) {
                    return Err(Unavailable(message).into());
                }
                anyhow::bail!(message);
            }
            // A connection dropped or timing out mid-body is a transport failure; a body that
            // isn't the expected JSON is a problem with this response.
            let body = resp.bytes().await.map_err(|e| self.transport(e))?;
            let body: serde_json::Value = serde_json::from_slice(&body).map_err(|e| anyhow::anyhow!("remote transcription returned invalid JSON: {e}"))?;
            Ok(body["text"].as_str().unwrap_or_default().trim().to_string())
        })?;
        timings.push("remote", started.elapsed().as_secs_f64() * 1000.0);
        Ok(text)
    }

    fn accelerator(&self) -> &str {
        "remote"
    }
}

impl TtsEngine for RemoteEngine {
    fn synthesize(&self, req: SpeakRequest<'_>, timings: &mut Timings) -> anyhow::Result<Pcm> {
        let voice = self.remote.voice.clone().unwrap_or_else(|| req.voice.to_string());
        // Ask for WAV: self-describing and supported almost everywhere; voicekit converts to
        // whatever Paseo asked for.
        let body = serde_json::json!({ "model": self.remote.model, "input": req.text, "voice": voice, "response_format": "wav", "speed": req.speed });
        let started = std::time::Instant::now();
        // The same split as recognition: an unreachable or refusing server is unavailable (the
        // voice list cools it down), any other error concerns only this text.
        let bytes = self.handle.block_on(async {
            let resp = self.auth(self.client.post(self.url("audio/speech"))).json(&body).send().await.map_err(|e| self.transport(e))?;
            let status = resp.status();
            if !status.is_success() {
                let message = format!("remote speech failed: {}", Self::error_text(resp).await);
                return Err(if unavailable_status(status) { Unavailable(message).into() } else { super::RequestFailure { code: None, message }.into() });
            }
            resp.bytes().await.map_err(|e| self.transport(e))
        })?;
        timings.push("remote", started.elapsed().as_secs_f64() * 1000.0);
        timings.time("decode", || audio::decode_any(&bytes, Some("wav")))
    }

    fn voices(&self) -> Vec<Voice> {
        let id = self.remote.voice.clone().unwrap_or_else(|| "default".into());
        vec![Voice { id: id.clone(), label: id, language: "multi".into(), gender: String::new(), featured: true }]
    }

    fn accelerator(&self) -> &str {
        "remote"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn connects_and_transcribes_outside_the_async_runtime() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for body in [r#"{"data":[]}"#, r#"{"text":"remote works"}"#] {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut buf = [0u8; 8192];
                let _ = socket.read(&mut buf).unwrap();
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
        });
        let rt = tokio::runtime::Runtime::new().unwrap();
        let remote = Remote { base_url: format!("http://{address}/v1"), model: "test".into(), api_key: None, voice: None };
        let engine = RemoteEngine::connect(&remote, rt.handle().clone()).unwrap();
        let audio = Pcm { samples: vec![0.0; 160], sample_rate: 16000 };
        let text = engine.transcribe(TranscribeRequest { audio: &audio, language: None, prompt: None }, &mut Timings::default()).unwrap();
        assert_eq!(text, "remote works");
        server.join().unwrap();
    }

    #[test]
    fn remote_speech_errors_are_unavailable_or_request_failures_like_recognition() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for (status, body) in [("200 OK", r#"{"data":[]}"#), ("503 Service Unavailable", r#"{"error":{"message":"busy"}}"#), ("400 Bad Request", r#"{"error":{"message":"bad input"}}"#)] {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut buf = [0u8; 8192];
                let _ = socket.read(&mut buf).unwrap();
                write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
        });
        let rt = tokio::runtime::Runtime::new().unwrap();
        let remote = Remote { base_url: format!("http://{address}/v1"), model: "tts".into(), api_key: None, voice: None };
        let engine = RemoteEngine::connect(&remote, rt.handle().clone()).unwrap();
        let speak = || engine.synthesize(SpeakRequest { text: "hello", voice: "alloy", speed: 1.0, language: None }, &mut Timings::default()).unwrap_err();
        assert!(crate::engine::is_unavailable(&speak()), "503: the server can't serve now");
        assert!(crate::engine::is_request_failure(&speak()), "400: only this text");
        server.join().unwrap();
    }
}
