//! Owned MLX subprocess: no listening port, no daemon changes, and no installs in requests.

use std::{io::{Read, Write}, path::{Path, PathBuf}, process::{Child, ChildStdin, Command, Stdio}, sync::{mpsc, Mutex, atomic::{AtomicBool, AtomicU32, Ordering}}, time::{Duration, Instant}};
use anyhow::{Context, ensure};
use serde_json::Value;
use super::{text_chunks, SpeakRequest, Timings, TtsEngine, Voice};
use crate::{audio::Pcm, catalog::ModelEntry};

const MAX_AUDIO: usize = 24_000 * 2 * 180;

fn complete_bundle(worker: &Path) -> bool {
    let Some(root) = worker.parent() else { return false };
    if !worker.is_file() || !root.join("mlx.metallib").is_file() { return false; }
    let manifest = std::fs::read(root.join("runtime.json")).ok()
        .and_then(|data| serde_json::from_slice::<Value>(&data).ok());
    manifest.is_some_and(|m| {
        let Some(files) = m["files"].as_array() else { return false };
        m["backend"] == "swift-mlx" && m["protocol"] == 1
            && files.iter().any(|f| f == "voicekit-mlx-worker")
            && files.iter().any(|f| f == "mlx.metallib")
            && files.iter().all(|file| file.as_str().is_some_and(|file| {
                let path = Path::new(file);
                path.components().all(|p| matches!(p, std::path::Component::Normal(_)))
                    && root.join(path).is_file()
            }))
    })
}

pub fn worker_path() -> Option<PathBuf> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) { return None; }
    if let Some(path) = std::env::var_os("VOICEKIT_MLX_WORKER").map(PathBuf::from) {
        return complete_bundle(&path).then_some(path);
    }
    let executable = std::env::current_exe().ok()?;
    let parent = executable.parent()?;
    [parent.join("mlx-runtime/voicekit-mlx-worker"),
     parent.parent()?.join("mlx-runtime/voicekit-mlx-worker")]
        .into_iter().find(|path| complete_bundle(path))
}

struct Frame { header: Value, pcm: Vec<u8> }

struct Worker {
    child: Child,
    input: Option<ChildStdin>,
    output: mpsc::Receiver<anyhow::Result<Frame>>,
}

impl Worker {
    fn spawn(binary: &Path, model: &Path) -> anyhow::Result<Self> {
        let binary = std::path::absolute(binary)?;
        let model = std::path::absolute(model)?;
        let root = binary.parent().context("MLX worker parent")?;
        let mut child = Command::new(&binary).arg(&model).current_dir(root)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
            .spawn().context("start native MLX speech worker")?;
        let input = child.stdin.take().context("MLX stdin")?;
        let mut output = child.stdout.take().context("MLX stdout")?;
        let (tx, rx) = mpsc::sync_channel(2);
        std::thread::spawn(move || loop {
            let frame = (|| -> anyhow::Result<Frame> {
                let mut length = [0; 4]; output.read_exact(&mut length)?;
                let n = u32::from_le_bytes(length) as usize;
                ensure!((1..=65_536).contains(&n), "invalid MLX frame header");
                let mut header = vec![0; n]; output.read_exact(&mut header)?;
                let header: Value = serde_json::from_slice(&header)?;
                let n = header["bytes"].as_u64().context("missing MLX audio size")? as usize;
                ensure!(n <= MAX_AUDIO && n % 2 == 0, "invalid MLX audio size");
                let mut pcm = vec![0; n]; output.read_exact(&mut pcm)?;
                Ok(Frame { header, pcm })
            })();
            let failed = frame.is_err();
            if tx.send(frame).is_err() || failed { break; }
        });
        let worker = Self { child, input: Some(input), output: rx };
        let ready = worker.receive(Duration::from_secs(30))?;
        ensure!(ready.header["event"] == "ready" && ready.header["device"] == "metal" && ready.header["backend"] == "swift-mlx" && ready.header["protocol"] == 1, "MLX GPU worker did not become ready");
        tracing::info!(device = "metal", model_size = %ready.header["model_size"], quantization_bits = %ready.header["quantization_bits"], "MLX model ready");
        Ok(worker)
    }

    fn receive(&self, timeout: Duration) -> anyhow::Result<Frame> {
        let frame = self.output.recv_timeout(timeout).context("MLX worker response timed out or disconnected")??;
        if frame.header["event"] == "error" { anyhow::bail!("MLX synthesis failed: {}", frame.header["error"]); }
        Ok(frame)
    }

    fn token_count(&mut self, text: &str, deadline: Instant) -> anyhow::Result<usize> {
        let input = self.input.as_mut().context("Qwen input closed")?;
        writeln!(input, "{}", serde_json::json!({"op":"count_tokens","text":text}))?;
        input.flush()?;
        let frame = self.receive(deadline.saturating_duration_since(Instant::now()))?;
        ensure!(frame.header["event"] == "text_tokens" && frame.pcm.is_empty(), "invalid Qwen token count response");
        let count = frame.header["count"].as_u64().context("missing Qwen token count")?;
        ensure!(count <= 65_536, "invalid Qwen token count");
        Ok(count as usize)
    }

    fn speak(&mut self, req: SpeakRequest<'_>, timings: &mut Timings, deadline: Instant) -> anyhow::Result<Pcm> {
        let input = self.input.as_mut().context("MLX input closed")?;
        writeln!(input, "{}", super::qwen_request(req.text, req.voice, req.language))?;
        input.flush()?;
        let mut samples = Vec::new();
        loop {
            let frame = self.receive(deadline.saturating_duration_since(Instant::now()))?;
            match frame.header["event"].as_str() {
                Some("done") => break,
                Some("audio") => {
                    ensure!(frame.header["rate"] == 24_000, "unexpected MLX sample rate");
                    ensure!(samples.len() * 2 + frame.pcm.len() <= MAX_AUDIO, "MLX audio is too long");
                    if let Some(ms) = frame.header["first_ms"].as_f64() { timings.push("mlx_first_chunk", ms); }
                    samples.extend(frame.pcm.chunks_exact(2).map(|v| i16::from_le_bytes([v[0],v[1]]) as f32 / 32768.0));
                }
                _ => anyhow::bail!("unexpected MLX worker response"),
            }
        }
        ensure!(!samples.is_empty(), "MLX produced no speech");
        Ok(Pcm { samples, sample_rate: 24_000 })
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.input.take(); // EOF lets the idle worker release MLX resources cleanly.
        for _ in 0..50 {
            if self.child.try_wait().ok().flatten().is_some() { return; }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct MlxTts { worker: Mutex<Option<Worker>>, voices: Vec<Voice>, default_voice: String, binary: PathBuf, model: PathBuf, running: AtomicBool, failure: Mutex<Option<(String, Instant)>>, failures: AtomicU32 }

impl MlxTts {
    pub fn load(entry: &ModelEntry, root: &Path, use_gpu: bool) -> anyhow::Result<Self> {
        ensure!(use_gpu, "Qwen3-TTS MLX requires GPU acceleration");
        let binary = worker_path().context("The native MLX worker is missing from this speech server installation")?;
        let voices = entry.voices.iter().map(|v| Voice { id:v.id.clone(), label:v.label.clone(), language:v.language.clone(), gender:v.gender.clone(), featured:v.featured }).collect();
        Ok(Self { worker: Mutex::new(None), voices, default_voice: entry.default_voice.clone().unwrap_or_else(|| "vivian".into()), binary, model: root.to_path_buf(), running: AtomicBool::new(false), failure: Mutex::new(None), failures: AtomicU32::new(0) })
    }
}

impl TtsEngine for MlxTts {
    fn prepare(&self) -> anyhow::Result<()> {
        let mut worker = self.worker.lock().unwrap_or_else(|p| p.into_inner());
        if worker.is_none() {
            *worker = Some(Worker::spawn(&self.binary, &self.model)?);
            self.running.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
    fn synthesize(&self, req: SpeakRequest<'_>, timings: &mut Timings) -> anyhow::Result<Pcm> {
        if !req.text.chars().any(char::is_alphanumeric) {
            return Ok(Pcm { samples: vec![], sample_rate: 24_000 });
        }
        let mut worker = self.worker.lock().unwrap_or_else(|p| p.into_inner());
        if worker.is_none() {
            let delay = Duration::from_secs(60) * 2u32.pow(self.failures.load(Ordering::SeqCst).saturating_sub(1).min(5));
            if let Some((error, at)) = self.failure.lock().unwrap().as_ref() {
                if at.elapsed() < delay { anyhow::bail!("MLX worker retry is cooling down: {error}"); }
            }
        }
        let requested_voice = req.voice.to_ascii_lowercase();
        let voice = if self.voices.iter().any(|v| v.id == requested_voice) { &requested_voice } else { &self.default_voice };
        let started = Instant::now();
        let planning_deadline = started + Duration::from_secs(180);
        let result = (|| -> anyhow::Result<Pcm> {
            if worker.is_none() {
                let loaded = timings.time("mlx_load", || Worker::spawn(&self.binary, &self.model))?;
                tracing::info!(accelerator = "metal", pid = loaded.child.id(), "loaded MLX speech worker");
                *worker = Some(loaded);
                self.running.store(true, Ordering::SeqCst);
            }
            let generation = worker.as_mut().context("Qwen worker stopped before text budgeting")?;
            let chunks = text_chunks(req.text, |text| generation.token_count(text, planning_deadline))?;
            let deadline = started + Duration::from_secs((60 + chunks.len() as u64 * 5).min(180));
            let mut samples = Vec::new();
            for text in chunks {
                if !text.chars().any(char::is_alphanumeric) { continue; }
                let chunk = generation.speak(SpeakRequest { text, voice, ..req }, timings, deadline)?;
                ensure!(samples.len() + chunk.samples.len() <= 24_000 * 600, "speech exceeds ten-minute output limit");
                samples.extend(chunk.samples);
            }
            ensure!(!samples.is_empty(), "MLX produced no speech");
            Ok(Pcm { samples, sample_rate: 24_000 })
        })();
        if let Err(error) = &result {
            self.running.store(false, Ordering::SeqCst); worker.take();
            self.failures.fetch_add(1, Ordering::SeqCst);
            *self.failure.lock().unwrap() = Some((format!("{error:#}"), Instant::now()));
        } else { self.failures.store(0, Ordering::SeqCst); self.failure.lock().unwrap().take(); }
        drop(worker);
        let pcm = result?;
        if req.speed == 1.0 { Ok(pcm) } else { timings.time("tempo", || pcm.with_tempo(req.speed)) }
    }
    fn voices(&self) -> Vec<Voice> { self.voices.clone() }
    fn accelerator(&self) -> &str { if self.running.load(Ordering::SeqCst) { "metal" } else { "idle" } }
    fn failure(&self) -> Option<String> { self.failure.lock().unwrap().as_ref().map(|(error, _)| error.clone()) }
    fn retry_failed(&self) {
        let delay = Duration::from_secs(60) * 2u32.pow(self.failures.load(Ordering::SeqCst).saturating_sub(1).min(5));
        if !self.failure.lock().unwrap().as_ref().is_some_and(|(_, at)| at.elapsed() >= delay) { return; }
        let Ok(mut worker) = self.worker.try_lock() else { return };
        match Worker::spawn(&self.binary, &self.model) {
            Ok(loaded) => {
                *worker = Some(loaded); self.running.store(true, Ordering::SeqCst); self.failure.lock().unwrap().take(); self.failures.store(0, Ordering::SeqCst);
            }
            Err(error) => {
                self.failures.fetch_add(1, Ordering::SeqCst);
                *self.failure.lock().unwrap() = Some((format!("{error:#}"), Instant::now()));
            }
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_probe_rejects_missing_resources_and_invalid_manifests() {
        let folder = std::env::temp_dir().join(format!("voicekit-mlx-bundle-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&folder).unwrap();
        let worker = folder.join("voicekit-mlx-worker");
        std::fs::write(&worker, []).unwrap();
        assert!(!complete_bundle(&worker));
        let manifest = serde_json::json!({"backend":"swift-mlx","protocol":1,"files":["voicekit-mlx-worker","mlx.metallib","compat.dylib"]});
        std::fs::write(folder.join("runtime.json"), manifest.to_string()).unwrap();
        std::fs::write(folder.join("mlx.metallib"), []).unwrap();
        assert!(!complete_bundle(&worker));
        std::fs::write(folder.join("compat.dylib"), []).unwrap();
        assert!(complete_bundle(&worker));
        std::fs::write(folder.join("runtime.json"), manifest.to_string().replace("compat.dylib", "../outside")).unwrap();
        assert!(!complete_bundle(&worker));
        std::fs::write(folder.join("runtime.json"), "{}").unwrap();
        assert!(!complete_bundle(&worker));
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn standalone_failure_is_reported_and_retries_back_off() {
        let engine = MlxTts { worker: Mutex::new(None), voices: vec![], default_voice: "vivian".into(), binary: PathBuf::from("/nonexistent/voicekit-mlx-worker"), model: std::env::temp_dir(), running: AtomicBool::new(false), failure: Mutex::new(None), failures: AtomicU32::new(0) };
        assert!(engine.synthesize(SpeakRequest { text: "hello", voice: "vivian", speed: 1.0, language: Some("en") }, &mut Timings::default()).is_err());
        assert!(engine.failure().is_some());
        assert!(engine.synthesize(SpeakRequest { text: "again", voice: "vivian", speed: 1.0, language: Some("en") }, &mut Timings::default()).is_err());
        assert_eq!(engine.failures.load(Ordering::SeqCst), 1, "requests must honor cooldown without another spawn attempt");
        assert!(engine.synthesize(SpeakRequest { text: ")\"🙂", voice: "vivian", speed: 1.0, language: Some("en") }, &mut Timings::default()).unwrap().samples.is_empty());
        engine.retry_failed(); assert_eq!(engine.failures.load(Ordering::SeqCst), 1);
        engine.failure.lock().unwrap().as_mut().unwrap().1 = Instant::now() - Duration::from_secs(61);
        engine.retry_failed(); assert_eq!(engine.failures.load(Ordering::SeqCst), 2);
        engine.failure.lock().unwrap().as_mut().unwrap().1 = Instant::now() - Duration::from_secs(61);
        engine.retry_failed(); assert_eq!(engine.failures.load(Ordering::SeqCst), 2, "second failure must wait longer");
    }



}
