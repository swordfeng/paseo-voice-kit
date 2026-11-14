//! `voicekit probe`: is Whisper turbo fast enough on this machine to be the default?
//!
//! Heuristic (the plugin's "Automatic" model uses the answer on Linux and Windows):
//! 1. No GPU device (no Vulkan loader, no driver, only a software rasterizer, or
//!    `--accelerator cpu`): no. Nothing is downloaded or loaded.
//! 2. Otherwise time the encoder of Whisper base (`whisper-base-q5_1`, ~60 MB, the model Whisper
//!    setups use for language detection anyway) on that device over a full 30 s window and
//!    extrapolate to turbo. Turbo's encoder does ~27x base's arithmetic (32 layers of width 1280
//!    vs 6 of width 512, same 1500 frames); GPUs run the larger matrices more efficiently, and on
//!    Apple M-series Metal the measured ratio is 20 (`--model whisper-large-v3-turbo-q5_0` times
//!    turbo directly), so the estimate is base x 20.
//! 3. Yes when the estimated turbo encoder time is at most 1000 ms: a dictation request then
//!    takes about 1.2 s with decoding, no slower than Qwen3-ASR on a typical CPU (0.4 to 1.1 s)
//!    and far more accurate across languages. Base therefore has to encode in 50 ms or less.

use serde_json::{json, Value};

use crate::{download, engine::whisper::WhisperStt, ggml, runtime::LANGUAGE_DETECTOR, ProbeArgs};

/// Turbo encoder time / base encoder time on the same device.
pub const TURBO_PER_BASE: f64 = 20.0;
/// Largest estimated turbo encoder time that still counts as fast.
pub const FAST_TURBO_ENCODER_MS: f64 = 1000.0;
const TURBO: &str = "whisper-large-v3-turbo-q5_0";

pub async fn run(args: ProbeArgs) -> anyhow::Result<Value> {
    let hw = ggml::hardware();
    let gpu = hw.gpu().cloned().filter(|_| !args.cpu);
    let mut report = json!({
        "version": env!("CARGO_PKG_VERSION"),
        "hardware": hw,
        "gpu": gpu,
        "model": args.model,
        "turboPerBase": TURBO_PER_BASE,
        "thresholdMs": FAST_TURBO_ENCODER_MS,
    });
    let factor = match args.model.as_str() {
        LANGUAGE_DETECTOR => TURBO_PER_BASE,
        TURBO => 1.0,
        other => anyhow::bail!("probe times {LANGUAGE_DETECTOR} or {TURBO}, not {other}"),
    };
    if gpu.is_none() && !args.cpu {
        report["fastWhisper"] = json!(false);
        report["reason"] = json!("no GPU device");
        return Ok(report);
    }

    let (catalog, store) = args.store.open()?;
    let entry = catalog.find(&args.model).ok_or_else(|| anyhow::anyhow!("unknown model {}", args.model))?.clone();
    if store.locate(&entry).is_none() {
        anyhow::ensure!(args.auto_pull, "{} is not downloaded (pass --auto-pull)", entry.id);
        std::fs::create_dir_all(&store.models_dir)?;
        download::Downloads::default().ensure(&store, &entry).await?;
    }
    let installed = store.locate(&entry).ok_or_else(|| anyhow::anyhow!("{} is not installed", entry.id))?;
    let mut path = installed.file(&entry, "model").ok_or_else(|| anyhow::anyhow!("{}: files.model missing", entry.id))?;
    // Never pick up (and compile) a Neural Engine encoder: this measures the GPU.
    if crate::catalog::coreml_encoder_path(&path).exists() {
        std::fs::create_dir_all(&store.models_dir)?;
        path = store.plain_whisper_path(&path)?;
    }
    let threads = args.threads.unwrap_or_else(crate::default_threads);
    let runs = args.runs.max(1);
    let use_gpu = !args.cpu;
    // A pass 5x over the limit settles it (slow devices take seconds per pass).
    let enough_ms = 5.0 * FAST_TURBO_ENCODER_MS / factor;
    let (accelerator, times) = tokio::task::spawn_blocking(move || WhisperStt::time_encoder(&path, use_gpu, threads, runs, enough_ms)).await??;
    let mut sorted = times.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let median = sorted[sorted.len() / 2];
    let estimate = median * factor;
    let fast = accelerator != "cpu" && estimate <= FAST_TURBO_ENCODER_MS;
    report["accelerator"] = json!(accelerator);
    report["encoderMs"] = json!(times.iter().map(|t| (t * 10.0).round() / 10.0).collect::<Vec<_>>());
    report["medianMs"] = json!((median * 10.0).round() / 10.0);
    report["estimatedTurboEncoderMs"] = json!(estimate.round());
    report["fastWhisper"] = json!(fast);
    report["reason"] = json!(if accelerator == "cpu" {
        "runs on the CPU".to_string()
    } else if fast {
        format!("turbo encoder about {} ms on {}", estimate.round(), accelerator)
    } else {
        format!("turbo encoder about {} ms on {} (limit {} ms)", estimate.round(), accelerator, FAST_TURBO_ENCODER_MS)
    });
    Ok(report)
}
