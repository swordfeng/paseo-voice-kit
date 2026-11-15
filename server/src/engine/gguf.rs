//! Persistent GGUF subprocess; its GGML stays isolated from whisper.cpp.

use super::{qwen_speak_chunk, qwen_worker_error, text_chunks, QwenHealth, QwenSampling, SpeakRequest, Timings, TtsEngine, Voice};
use crate::{audio::Pcm, catalog::ModelEntry};
use anyhow::{ensure, Context};
use serde_json::Value;
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc, Mutex,
    },
    time::{Duration, Instant},
};

const MAX_AUDIO: usize = 24_000 * 2 * 180;

pub fn worker_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("VOICEKIT_GGUF_WORKER").map(PathBuf::from) {
        return p.is_file().then_some(p);
    }
    let exe = std::env::current_exe().ok()?;
    let parent = exe.parent()?;
    let name = if cfg!(windows) {
        "voicekit-qwen-worker.exe"
    } else {
        "voicekit-qwen-worker"
    };
    [
        parent.join("gguf-runtime").join(name),
        parent.parent()?.join("gguf-runtime").join(name),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

fn device_code(s: &str) -> u32 {
    match s {
        "cpu" => 1,
        "metal" => 2,
        "vulkan" => 3,
        "cuda" => 4,
        _ => 5,
    }
}
fn device_name(n: u32) -> &'static str {
    match n {
        0 => "idle",
        1 => "cpu",
        2 => "metal",
        3 => "vulkan",
        4 => "cuda",
        _ => "gpu",
    }
}

struct Frame {
    header: Value,
    pcm: Vec<u8>,
}

struct Worker {
    child: Child,
    device: u32,
    input: Option<ChildStdin>,
    output: mpsc::Receiver<anyhow::Result<Frame>>,
}

impl Worker {
    fn spawn(binary: &Path, model: &Path, codec: &Path, use_gpu: bool) -> anyhow::Result<Self> {
        let binary = std::path::absolute(binary)?;
        let model = std::path::absolute(model)?;
        let codec = std::path::absolute(codec)?;
        let root = binary.parent().context("GGUF worker parent")?;
        let mut child = Command::new(&binary)
            .arg(&model)
            .arg(&codec)
            .arg(if use_gpu { "auto" } else { "cpu" })
            .current_dir(root)
            .env("GGML_METAL_PATH_RESOURCES", root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("start GGUF speech worker")?;
        let input = child.stdin.take().context("GGUF stdin")?;
        let mut output = child.stdout.take().context("GGUF stdout")?;
        let (tx, rx) = mpsc::sync_channel(2);
        std::thread::spawn(move || loop {
            let frame = (|| -> anyhow::Result<Frame> {
                let mut length = [0; 4];
                output.read_exact(&mut length)?;
                let n = u32::from_le_bytes(length) as usize;
                ensure!((1..=65_536).contains(&n), "invalid GGUF frame header");
                let mut header = vec![0; n];
                output.read_exact(&mut header)?;
                let header: Value = serde_json::from_slice(&header)?;
                let n = header["bytes"]
                    .as_u64()
                    .context("missing GGUF audio size")? as usize;
                ensure!(n <= MAX_AUDIO && n % 2 == 0, "invalid GGUF audio size");
                let mut pcm = vec![0; n];
                output.read_exact(&mut pcm)?;
                Ok(Frame { header, pcm })
            })();
            let failed = frame.is_err();
            if tx.send(frame).is_err() || failed {
                break;
            }
        });
        let mut worker = Self {
            child,
            device: 0,
            input: Some(input),
            output: rx,
        };
        // Cold CPU loads on virtualized Macs can exceed 30 seconds. Keep a
        // bounded startup budget separate from each synthesis deadline.
        let ready = worker.receive(Duration::from_secs(90))?;
        ensure!(
            ready.header["event"] == "ready",
            "GGUF worker did not become ready"
        );
        worker.device = device_code(
            ready.header["device"]
                .as_str()
                .context("missing GGUF device")?,
        );
        if !use_gpu {
            ensure!(worker.device == 1, "CPU-only GGUF request used a GPU");
        }
        tracing::info!(accelerator = device_name(worker.device), "GGUF model ready");
        Ok(worker)
    }

    fn receive(&self, timeout: Duration) -> anyhow::Result<Frame> {
        let frame = self
            .output
            .recv_timeout(timeout)
            .context("GGUF worker response timed out or disconnected")??;
        if frame.header["event"] == "error" {
            return Err(qwen_worker_error(&frame.header, "GGUF"));
        }
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

    fn speak(
        &mut self,
        req: SpeakRequest<'_>,
        sampling: QwenSampling,
        timings: &mut Timings,
        deadline: Instant,
    ) -> anyhow::Result<Pcm> {
        let input = self.input.as_mut().context("GGUF input closed")?;
        writeln!(
            input,
            "{}",
            super::qwen_request(req.text, req.voice, Some(language(req.language)), sampling)?
        )?;
        input.flush()?;
        let mut samples = Vec::new();
        loop {
            let frame = self.receive(deadline.saturating_duration_since(Instant::now()))?;
            match frame.header["event"].as_str() {
                Some("done") => break,
                Some("audio") => {
                    ensure!(
                        frame.header["rate"] == 24_000,
                        "unexpected GGUF sample rate"
                    );
                    ensure!(
                        samples.len() * 2 + frame.pcm.len() <= MAX_AUDIO,
                        "GGUF audio is too long"
                    );
                    if let Some(ms) = frame.header["first_ms"].as_f64() {
                        timings.push("gguf_first_chunk", ms);
                    }
                    samples.extend(
                        frame
                            .pcm
                            .chunks_exact(2)
                            .map(|v| i16::from_le_bytes([v[0], v[1]]) as f32 / 32768.0),
                    );
                }
                _ => anyhow::bail!("unexpected GGUF worker response"),
            }
        }
        ensure!(!samples.is_empty(), "GGUF produced no speech");
        Ok(Pcm {
            samples,
            sample_rate: 24_000,
        })
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.input.take(); // EOF lets the idle worker release GGUF / Python resources cleanly.
        for _ in 0..50 {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct GgufTts {
    worker: Mutex<Option<Worker>>,
    voices: Vec<Voice>,
    default_voice: String,
    binary: PathBuf,
    model: PathBuf,
    codec: PathBuf,
    use_gpu: bool,
    device: AtomicU32,
    health: QwenHealth,
}
impl GgufTts {
    pub fn load(entry: &ModelEntry, root: &Path, use_gpu: bool) -> anyhow::Result<Self> {
        let binary = worker_path().context("GGUF worker is missing from this installation")?;
        let model = root.join(
            entry
                .files
                .get("model")
                .context("GGUF talker path missing")?,
        );
        let codec = root.join(
            entry
                .files
                .get("codec")
                .context("GGUF codec path missing")?,
        );
        let voices = entry
            .voices
            .iter()
            .map(|v| Voice {
                id: v.id.clone(),
                label: v.label.clone(),
                language: v.language.clone(),
                gender: v.gender.clone(),
                featured: v.featured,
            })
            .collect();
        // The containing route calls this only on first use, so a request is waiting: starting
        // the worker here reports a broken installation as a load failure right away.
        let worker = Worker::spawn(&binary, &model, &codec, use_gpu)?;
        let device = worker.device;
        Ok(Self {
            worker: Mutex::new(Some(worker)),
            voices,
            default_voice: entry
                .default_voice
                .clone()
                .unwrap_or_else(|| "vivian".into()),
            binary,
            model,
            codec,
            use_gpu,
            device: AtomicU32::new(device),
            health: QwenHealth::default(),
        })
    }
}

fn language(code: Option<&str>) -> &'static str {
    match code {
        Some("zh") => "chinese",
        Some("en") => "english",
        Some("ja") => "japanese",
        Some("ko") => "korean",
        Some("de") => "german",
        Some("fr") => "french",
        Some("ru") => "russian",
        Some("pt") => "portuguese",
        Some("es") => "spanish",
        Some("it") => "italian",
        _ => "auto",
    }
}

impl TtsEngine for GgufTts {
    fn synthesize(&self, req: SpeakRequest<'_>, timings: &mut Timings) -> anyhow::Result<Pcm> {
        if !req.text.chars().any(char::is_alphanumeric) {
            return Ok(Pcm {
                samples: vec![],
                sample_rate: 24_000,
            });
        }
        let mut worker = self.worker.lock().unwrap_or_else(|p| p.into_inner());
        if worker.is_none() {
            if let Some(error) = self.health.cooling() {
                anyhow::bail!("GGUF worker retry is cooling down: {error}");
            }
        }
        let requested_voice = req.voice.to_ascii_lowercase();
        let voice = if self.voices.iter().any(|v| v.id == requested_voice) {
            &requested_voice
        } else {
            &self.default_voice
        };
        let started = Instant::now();
        let planning_deadline = started + Duration::from_secs(180);
        let result = (|| -> anyhow::Result<Pcm> {
            if worker.is_none() {
                let loaded = timings.time("gguf_load", || {
                    Worker::spawn(&self.binary, &self.model, &self.codec, self.use_gpu)
                })?;
                tracing::info!(
                    accelerator = device_name(loaded.device),
                    pid = loaded.child.id(),
                    "loaded GGUF speech worker"
                );
                self.device.store(loaded.device, Ordering::SeqCst);
                *worker = Some(loaded);
            }
            let generation = worker.as_mut().context("Qwen worker stopped before text budgeting")?;
            let chunks = text_chunks(req.text, |text| generation.token_count(text, planning_deadline))?;
            let deadline = started + super::qwen_request_deadline(chunks.len());
            let mut samples = Vec::new();
            for text in chunks {
                if !text.chars().any(char::is_alphanumeric) {
                    continue;
                }
                let tokens = generation.token_count(text, deadline)?;
                let chunk = qwen_speak_chunk(tokens, |sampling| {
                    generation.speak(SpeakRequest { text, voice, ..req }, sampling, timings, deadline)
                })?;
                ensure!(
                    samples.len() + chunk.samples.len() <= 24_000 * 600,
                    "speech exceeds ten-minute output limit"
                );
                samples.extend(chunk.samples);
            }
            ensure!(!samples.is_empty(), "GGUF produced no speech");
            Ok(Pcm {
                samples,
                sample_rate: 24_000,
            })
        })();
        // A request failure leaves the worker serving; a crash, failed start or timeout drops it.
        if self.health.record(&result) {
            self.device.store(0, Ordering::SeqCst);
            worker.take();
        }
        drop(worker);
        let pcm = result?;
        if req.speed == 1.0 { Ok(pcm) } else { timings.time("tempo", || pcm.with_tempo(req.speed)) }
    }
    fn voices(&self) -> Vec<Voice> {
        self.voices.clone()
    }
    fn accelerator(&self) -> &str {
        device_name(self.device.load(Ordering::SeqCst))
    }
    fn failure(&self) -> Option<String> {
        self.health.failure()
    }
    // No background retry: a worker starts again only for a request (after any cooldown), so
    // nothing allocates GPU memory while no one is waiting for speech.
}
