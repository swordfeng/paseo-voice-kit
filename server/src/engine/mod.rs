//! Engine traits and implementations.

pub mod remote;
pub mod mlx;
pub mod gguf;
pub mod chain;
pub mod route;
pub mod sherpa;
pub mod whisper;

use serde::Serialize;

use crate::audio::Pcm;

/// The engine itself can't serve requests right now (its server is unreachable, rejects
/// the configured credentials, or is overloaded), as opposed to a problem with one request.
/// The runtime marks the model unavailable so the plugin falls back, then reconnects in the
/// background.
#[derive(Debug)]
pub struct Unavailable(pub String);

impl std::fmt::Display for Unavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Unavailable {}

/// Whether `error` means the engine is unavailable rather than one request failing.
pub fn is_unavailable(error: &anyhow::Error) -> bool {
    error.downcast_ref::<Unavailable>().is_some()
}

/// Named stage durations for one request, in milliseconds, in the order they happened.
#[derive(Debug, Default, Clone)]
pub struct Timings(pub Vec<(&'static str, f64)>);

impl Timings {
    pub fn push(&mut self, stage: &'static str, ms: f64) {
        self.0.push((stage, ms));
    }

    /// Time `f` and record it as `stage`.
    pub fn time<R>(&mut self, stage: &'static str, f: impl FnOnce() -> R) -> R {
        let started = std::time::Instant::now();
        let out = f();
        self.push(stage, started.elapsed().as_secs_f64() * 1000.0);
        out
    }

    pub fn summary(&self) -> String {
        self.0.iter().map(|(k, v)| format!("{k}={v:.0}")).collect::<Vec<_>>().join(" ")
    }
}

pub struct TranscribeRequest<'a> {
    /// Mono audio at 16 kHz.
    pub audio: &'a Pcm,
    /// ISO 639-1 code, or None to auto-detect.
    pub language: Option<&'a str>,
    /// Vocabulary / style hint.
    pub prompt: Option<&'a str>,
}

pub trait SttEngine: Send + Sync {
    /// Engines may add finer stages (e.g. whisper encode/decode) to `timings`.
    fn transcribe(&self, req: TranscribeRequest<'_>, timings: &mut Timings) -> anyhow::Result<String>;
    /// Short label for the hardware path in use, e.g. "metal" or "cpu".
    fn accelerator(&self) -> &str;
}

#[derive(Debug, Clone, Serialize)]
pub struct Voice {
    pub id: String,
    pub label: String,
    pub language: String,
    pub gender: String,
    /// Part of the short list shown before "all voices".
    pub featured: bool,
}

pub struct SpeakRequest<'a> {
    pub text: &'a str,
    pub voice: &'a str,
    pub speed: f32,
    /// ISO 639-1 code of the text, when known. Multilingual engines need it.
    pub language: Option<&'a str>,
}

pub trait TtsEngine: Send + Sync {
    /// A lazy route must validate deferred workers before advertising successful recovery.
    /// Direct MLX construction can still defer its worker until first use.
    fn prepare(&self) -> anyhow::Result<()> { Ok(()) }
    fn synthesize(&self, req: SpeakRequest<'_>, timings: &mut Timings) -> anyhow::Result<Pcm>;
    fn voices(&self) -> Vec<Voice>;
    fn accelerator(&self) -> &str;
    /// Chain children have independent idle clocks even while other routes remain active.
    fn unload_idle(&self, _after: std::time::Duration) {}
    fn failure(&self) -> Option<String> { None }
    fn retry_failed(&self) {}
    fn model_downloaded(&self, _id: &str) {}
    fn last_error(&self) -> Option<serde_json::Value> { None }
    /// The voices of each enabled model, for picking them one by one.
    fn routes(&self) -> Vec<route::RouteVoices> {
        Vec::new()
    }
}

/// Stub engines, used by tests and `--stub` capture mode.
pub mod stub {
    use super::*;

    pub struct StubStt;
    impl SttEngine for StubStt {
        fn transcribe(&self, req: TranscribeRequest<'_>, _timings: &mut Timings) -> anyhow::Result<String> {
            Ok(format!("[voicekit stub: {:.2}s of audio]", req.audio.duration_secs()))
        }
        fn accelerator(&self) -> &str {
            "none"
        }
    }

    /// Two short beeps (440 Hz then 660 Hz) at 24 kHz.
    pub struct StubTts;
    impl TtsEngine for StubTts {
        fn synthesize(&self, _req: SpeakRequest<'_>, _timings: &mut Timings) -> anyhow::Result<Pcm> {
            let rate = 24_000u32;
            let mut samples = Vec::new();
            for (freq, len) in [(440.0f32, 0.25f32), (0.0, 0.1), (660.0, 0.25)] {
                let n = (len * rate as f32) as usize;
                for i in 0..n {
                    let t = i as f32 / rate as f32;
                    samples.push(if freq == 0.0 { 0.0 } else { 0.3 * (2.0 * std::f32::consts::PI * freq * t).sin() });
                }
            }
            Ok(Pcm { samples, sample_rate: rate })
        }
        fn voices(&self) -> Vec<Voice> {
            vec![Voice { id: "beep".into(), label: "Beep".into(), language: "en".into(), gender: String::new(), featured: true }]
        }
        fn accelerator(&self) -> &str {
            "none"
        }
    }
}
