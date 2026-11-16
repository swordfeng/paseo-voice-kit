//! Persistent GGUF subprocess; its GGML stays isolated from whisper.cpp.

use super::{qwen_speak_chunk, qwen_worker_error, text_chunks, QwenHealth, QwenSampling, SpeakRequest, Timings, TtsEngine, Voice};
use crate::{audio::Pcm, catalog::ModelEntry};
use anyhow::{ensure, Context};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc, Mutex,
    },
    time::{Duration, Instant},
};

const MAX_AUDIO: usize = 24_000 * 2 * 180;

/// The worker process ended while voicekit was waiting for it (a crash, not a request error).
#[derive(Debug)]
struct WorkerStopped(Option<String>);

impl std::fmt::Display for WorkerStopped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "GGUF speech worker stopped unexpectedly")?;
        match &self.0 {
            Some(status) => write!(f, " ({status})"),
            None => Ok(()),
        }
    }
}

impl std::error::Error for WorkerStopped {}

/// Models whose GPU worker crashed or failed to start, with the error. They run on the CPU from
/// then on, for as long as this server runs; reloading the model after an idle unload doesn't
/// try the GPU again.
static GPU_FALLBACK: Mutex<Option<HashMap<PathBuf, String>>> = Mutex::new(None);

fn gpu_fallback(model: &Path) -> Option<String> {
    GPU_FALLBACK.lock().unwrap_or_else(|p| p.into_inner()).as_ref()?.get(model).cloned()
}

fn fall_back_to_cpu(model: &Path, error: &anyhow::Error) {
    let error = format!("{error:#}");
    tracing::warn!(model = %model.display(), error, "GGUF speech worker failed on the GPU; this model runs on the CPU from now on");
    GPU_FALLBACK.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(HashMap::new).insert(model.to_path_buf(), error);
}

/// Start a worker on the GPU when allowed and not already given up on for this model; a GPU
/// start that fails is retried once on the CPU.
fn start(binary: &Path, model: &Path, codec: &Path, use_gpu: bool) -> anyhow::Result<Worker> {
    let gpu = use_gpu && gpu_fallback(model).is_none();
    match Worker::spawn(binary, model, codec, gpu) {
        Err(error) if gpu => {
            fall_back_to_cpu(model, &error);
            Worker::spawn(binary, model, codec, false)
        }
        started => started,
    }
}

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

    fn receive(&mut self, timeout: Duration) -> anyhow::Result<Frame> {
        let frame = match self.output.recv_timeout(timeout) {
            Ok(Ok(frame)) => frame,
            Ok(Err(error)) if !error.downcast_ref::<std::io::Error>().is_some_and(|e| e.kind() == ErrorKind::UnexpectedEof) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => anyhow::bail!("GGUF worker response timed out"),
            // End of output: the process is gone.
            _ => return Err(self.stopped()),
        };
        if frame.header["event"] == "error" {
            return Err(qwen_worker_error(&frame.header, "GGUF"));
        }
        Ok(frame)
    }

    /// The process ended: report how, once it has been reaped (briefly waited for).
    fn stopped(&mut self) -> anyhow::Error {
        let mut status = None;
        for _ in 0..50 {
            match self.child.try_wait() {
                Ok(Some(exit)) => {
                    status = Some(exit.to_string());
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(_) => break,
            }
        }
        WorkerStopped(status).into()
    }

    fn send(&mut self, line: Value) -> anyhow::Result<()> {
        let input = self.input.as_mut().context("GGUF input closed")?;
        // A closed pipe means the worker has exited.
        match writeln!(input, "{line}").and_then(|_| input.flush()) {
            Ok(()) => Ok(()),
            Err(_) => Err(self.stopped()),
        }
    }

    fn token_count(&mut self, text: &str, deadline: Instant) -> anyhow::Result<usize> {
        self.send(serde_json::json!({"op":"count_tokens","text":text}))?;
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
        self.send(super::qwen_request(req.text, req.voice, Some(language(req.language)), sampling)?)?;
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
        let worker = start(&binary, &model, &codec, use_gpu)?;
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

impl GgufTts {
    /// One reading of the request, starting a worker first if none is running.
    fn attempt(&self, worker: &mut Option<Worker>, req: SpeakRequest<'_>, timings: &mut Timings) -> anyhow::Result<Pcm> {
        let started = Instant::now();
        let planning_deadline = started + Duration::from_secs(180);
        if worker.is_none() {
            let loaded = timings.time("gguf_load", || start(&self.binary, &self.model, &self.codec, self.use_gpu))?;
            tracing::info!(accelerator = device_name(loaded.device), pid = loaded.child.id(), "loaded GGUF speech worker");
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
                generation.speak(SpeakRequest { text, ..req }, sampling, timings, deadline)
            })?;
            ensure!(
                samples.len() + chunk.samples.len() <= 24_000 * 600,
                "speech exceeds ten-minute output limit"
            );
            samples.extend(chunk.samples);
        }
        ensure!(!samples.is_empty(), "GGUF produced no speech");
        Ok(Pcm { samples, sample_rate: 24_000 })
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
        let mut result = self.attempt(&mut worker, SpeakRequest { voice, ..req }, timings);
        if let Err(error) = &result {
            // A GPU worker that crashed mid-request: read it again on the CPU, and stay there.
            // (A GPU start that failed has already been retried on the CPU by `start`.)
            let on_gpu = worker.as_ref().is_some_and(|w| w.device != device_code("cpu"));
            if on_gpu && error.downcast_ref::<WorkerStopped>().is_some() {
                fall_back_to_cpu(&self.model, error);
                self.device.store(0, Ordering::SeqCst);
                worker.take();
                result = self.attempt(&mut worker, SpeakRequest { voice, ..req }, timings);
            }
        }
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
    fn gpu_fallback(&self) -> Option<String> {
        if self.use_gpu { gpu_fallback(&self.model) } else { None }
    }
    // No background retry: a worker starts again only for a request (after any cooldown), so
    // nothing allocates GPU memory while no one is waiting for speech.
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;

    /// One worker frame as printf octal escapes.
    fn frame(header: Value, pcm: &[u8]) -> String {
        let header = header.to_string();
        let mut bytes = (header.len() as u32).to_le_bytes().to_vec();
        bytes.extend(header.as_bytes());
        bytes.extend(pcm);
        bytes.iter().map(|b| format!("\\{b:03o}")).collect()
    }

    /// A stand-in worker: on the CPU it answers every request; asked for a GPU ("auto") it runs
    /// `gpu` instead, after noting the attempt in `gpu-starts`.
    fn engine(name: &str, gpu: &str) -> (GgufTts, PathBuf) {
        let dir = std::env::temp_dir().join(format!("voicekit-gguf-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ready = |device: &str| frame(json!({"event":"ready","device":device,"bytes":0}), &[]);
        let tokens = frame(json!({"event":"text_tokens","count":3,"bytes":0}), &[]);
        let audio = frame(json!({"event":"audio","rate":24000,"bytes":4}), &[0, 16, 0, 16]);
        let done = frame(json!({"event":"done","bytes":0}), &[]);
        let gpu = gpu.replace("READY", &ready("vulkan"));
        let script = format!(
            "#!/bin/sh\nif [ \"$3\" = auto ]; then\necho start >> gpu-starts\n{gpu}\nfi\nprintf '{}'\nwhile read line; do\ncase \"$line\" in\n*count_tokens*) printf '{tokens}' ;;\n*) printf '{audio}{done}' ;;\nesac\ndone\n",
            ready("cpu")
        );
        let binary = dir.join("voicekit-qwen-worker");
        std::fs::write(&binary, script).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let engine = GgufTts {
            worker: Mutex::new(None),
            voices: vec![],
            default_voice: "vivian".into(),
            binary,
            model: dir.join("model.gguf"),
            codec: dir.join("codec.gguf"),
            use_gpu: true,
            device: AtomicU32::new(0),
            health: QwenHealth::default(),
        };
        (engine, dir)
    }

    fn speak(engine: &GgufTts) -> anyhow::Result<Pcm> {
        engine.synthesize(SpeakRequest { text: "hello there", voice: "vivian", speed: 1.0, language: Some("en") }, &mut Timings::default())
    }

    fn gpu_starts(dir: &Path) -> usize {
        std::fs::read_to_string(dir.join("gpu-starts")).map_or(0, |s| s.lines().count())
    }

    #[test]
    fn gpu_worker_crash_is_read_again_on_the_cpu_and_stays_there() {
        // Like Dozen: the GPU worker starts, then aborts on its first request.
        let (engine, dir) = engine("crash", "printf 'READY'\nread line\nexit 134");
        assert!(!speak(&engine).unwrap().samples.is_empty(), "the request is answered on the CPU");
        assert_eq!(engine.accelerator(), "cpu");
        let reason = engine.gpu_fallback().expect("the fallback is reported");
        assert!(reason.contains("stopped unexpectedly") && !reason.contains("fill whole buffer"), "{reason}");
        assert_eq!(engine.health.failures(), 0, "a fallback that answered is not a failure");
        // An idle unload and reload stays on the CPU.
        engine.worker.lock().unwrap().take();
        assert!(!speak(&engine).unwrap().samples.is_empty());
        assert_eq!(gpu_starts(&dir), 1, "the GPU is not tried again");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn gpu_worker_that_fails_to_start_falls_back_to_the_cpu() {
        let (engine, dir) = engine("start", "exit 1");
        assert!(!speak(&engine).unwrap().samples.is_empty());
        assert_eq!(engine.accelerator(), "cpu");
        assert!(engine.gpu_fallback().unwrap().contains("stopped unexpectedly"));
        assert_eq!(gpu_starts(&dir), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_cpu_only_setting_never_tries_the_gpu_or_reports_a_fallback() {
        let (mut engine, dir) = engine("cpu-only", "exit 1");
        engine.use_gpu = false;
        assert!(!speak(&engine).unwrap().samples.is_empty());
        assert_eq!(gpu_starts(&dir), 0);
        assert!(engine.gpu_fallback().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
