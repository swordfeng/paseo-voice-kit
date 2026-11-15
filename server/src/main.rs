//! voicekit: local OpenAI-compatible speech server (STT + TTS).

mod api;
mod audio;
mod catalog;
mod download;
mod engine;
mod ggml;
mod lang;
mod probe;
mod runtime;
mod speech_filter;

use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

use anyhow::Context;
use clap::{Parser, Subcommand};
use tokio::io::AsyncReadExt;

#[derive(Parser, Debug)]
#[command(name = "voicekit", version, about = "Local OpenAI-compatible speech server")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Run the HTTP server.
    Serve(ServeArgs),
    /// Download a model into the models dir.
    Pull {
        id: String,
        #[command(flatten)]
        store: StoreArgs,
    },
    /// List the model catalog as JSON.
    Models {
        #[command(flatten)]
        store: StoreArgs,
    },
    /// Print the compute backends and devices ggml detected, as JSON.
    Devices,
    /// Measure whether Whisper turbo runs fast enough here (JSON). Times a small Whisper
    /// model's encoder on the GPU and extrapolates; machines without a GPU device are answered
    /// without downloading or loading anything.
    Probe(ProbeArgs),
}

#[derive(clap::Args, Debug, Clone)]
struct ProbeArgs {
    #[command(flatten)]
    store: StoreArgs,
    /// Model to time (default: the language-detection model, ~60 MB).
    #[arg(long, default_value = runtime::LANGUAGE_DETECTOR)]
    model: String,
    /// Download the model when missing.
    #[arg(long, default_value_t = false)]
    auto_pull: bool,
    /// Timed encoder passes (after one warm-up).
    #[arg(long, default_value_t = 3)]
    runs: usize,
    #[arg(long)]
    threads: Option<i32>,
    /// Time on the CPU even when a GPU device exists (for comparisons).
    #[arg(long, default_value_t = false)]
    cpu: bool,
}

#[derive(clap::Args, Debug, Clone)]
struct StoreArgs {
    /// Where voicekit keeps downloaded models.
    #[arg(long, env = "VOICEKIT_MODELS_DIR")]
    models_dir: PathBuf,
    /// Read-only directories to reuse models from (e.g. ~/.paseo/models/local-speech).
    #[arg(long = "reuse-dir")]
    reuse_dirs: Vec<PathBuf>,
    /// Canonical overlapping models, managed by Paseo's download/delete service.
    #[arg(long)]
    shared_models_dir: Option<PathBuf>,
    /// Delegate overlapping built-ins even when their canonical directory is unavailable.
    #[arg(long)]
    paseo_model_manager: bool,
    /// Extra catalog files with custom models (JSON: {"models": [...]}).
    #[arg(long = "catalog")]
    catalogs: Vec<PathBuf>,
}

impl StoreArgs {
    fn open(&self) -> anyhow::Result<(catalog::Catalog, catalog::Store)> {
        let catalog = catalog::Catalog::load(&self.catalogs)?;
        Ok((catalog, catalog::Store { models_dir: self.models_dir.clone(), reuse_dirs: self.reuse_dirs.clone(), shared_models_dir: self.shared_models_dir.clone(), paseo_managed: self.paseo_model_manager }))
    }
}

#[derive(clap::Args, Debug, Clone)]
struct ServeArgs {
    #[command(flatten)]
    store: StoreArgs,
    /// Port on 127.0.0.1. 0 picks a free port.
    #[arg(long, default_value_t = 0)]
    port: u16,
    /// Bearer token required on every request except /health.
    #[arg(long, env = "VOICEKIT_TOKEN", hide_env_values = true)]
    token: String,
    /// STT model(s) to serve, comma separated. The first is the default; requests pick
    /// another one through the OpenAI `model` field.
    #[arg(long, value_delimiter = ',', default_value = "sensevoice-int8")]
    stt_model: Vec<String>,
    #[arg(long, default_value = "supertonic-3")]
    tts_model: String,
    /// auto | cpu
    #[arg(long, default_value = "auto")]
    accelerator: String,
    /// ONNX Runtime provider for sherpa models when accelerating: cpu | coreml | cuda
    #[arg(long, default_value = "cpu")]
    onnx_provider: String,
    #[arg(long)]
    threads: Option<i32>,
    /// Whisper beam size (1 = greedy, fastest).
    #[arg(long, default_value_t = 1)]
    beam_size: i32,
    #[arg(long, default_value = "F1")]
    voice: String,
    /// Default speech rate (0.5 to 2.0).
    #[arg(long, default_value_t = 1.0)]
    speed: f32,
    /// auto | request | <iso code>
    #[arg(long, default_value = "auto")]
    language: String,
    /// Vocabulary / style hint passed to the recognizer.
    #[arg(long)]
    stt_prompt: Option<String>,
    /// Use the client's `prompt` field (off by default: Paseo sends GPT-style instructions).
    #[arg(long, default_value_t = false)]
    honor_request_prompt: bool,
    /// Unload engines after this many idle minutes (0 = never).
    #[arg(long, default_value_t = 10)]
    idle_unload_mins: u64,
    /// Use Apple Neural Engine encoders for Whisper models (CoreML builds on macOS): downloaded
    /// automatically with --auto-pull; the first load compiles them (minutes, then cached).
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    coreml: bool,
    /// Download missing configured models at startup.
    #[arg(long, default_value_t = false)]
    auto_pull: bool,
    /// Exit when stdin reaches EOF (the parent process went away).
    #[arg(long, default_value_t = false)]
    exit_on_stdin_eof: bool,
    /// Save every STT upload under this directory (debugging).
    #[arg(long)]
    capture_dir: Option<PathBuf>,
    /// Use stub engines (beeps / placeholder text). For protocol testing.
    #[arg(long, default_value_t = false)]
    stub: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("VOICEKIT_LOG").unwrap_or_else(|_| "info".into()))
        .init();

    match Cli::parse().command {
        Command::Serve(args) => serve(args).await,
        Command::Pull { id, store } => {
            let (catalog, store) = store.open()?;
            let entry = catalog.find(&id).ok_or_else(|| anyhow::anyhow!("unknown model {id}"))?;
            let rt = runtime::Runtime::new(catalog.clone(), store.clone(), default_settings(), tokio::runtime::Handle::current());
            let downloads = download::Downloads::default();
            for dependency in rt.with_dependencies(entry) {
                if dependency.engine != catalog::Engine::Chain {
                    downloads.ensure(&store, dependency).await?;
                }
            }
            if runtime::coreml_supported() && entry.coreml.is_some() {
                downloads.ensure_coreml(&store, entry).await?;
            }
            println!("{}", store.locate(entry).map(|i| i.root.display().to_string()).unwrap_or_default());
            Ok(())
        }
        Command::Models { store } => {
            let (catalog, store) = store.open()?;
            let rt = runtime::Runtime::new(catalog, store, default_settings(), tokio::runtime::Handle::current());
            println!("{}", serde_json::to_string_pretty(&rt.models_json())?);
            Ok(())
        }
        Command::Devices => {
            let hw = ggml::hardware();
            println!("{}", serde_json::to_string_pretty(&serde_json::json!({ "version": env!("CARGO_PKG_VERSION"), "hardware": hw }))?);
            Ok(())
        }
        Command::Probe(args) => {
            let report = probe::run(args).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
    }
}

fn default_threads() -> i32 {
    let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    (n / 2).clamp(2, 8) as i32
}

fn default_settings() -> runtime::Settings {
    runtime::Settings {
        stt_models: vec!["sensevoice-int8".into()],
        tts_model: "supertonic-3".into(),
        accelerator: "auto".into(),
        onnx_provider: "cpu".into(),
        threads: default_threads(),
        beam_size: 1,
        default_voice: "F1".into(),
        default_speed: 1.0,
        language: "auto".into(),
        stt_prompt: None,
        honor_request_prompt: false,
        idle_unload: None,
        coreml: true,
        auto_pull: false,
        stub: false,
    }
}

async fn serve(args: ServeArgs) -> anyhow::Result<()> {
    anyhow::ensure!(!args.token.is_empty(), "token must not be empty");
    if let Some(dir) = &args.capture_dir {
        std::fs::create_dir_all(dir).context("create capture dir")?;
    }
    std::fs::create_dir_all(&args.store.models_dir).context("create models dir")?;

    // Load the ggml backends (Vulkan only if its loader and a GPU exist) in the background:
    // initializing a GPU can take seconds (Metal compiles its library), and the handshake below
    // should not wait for it. Whisper loads wait for it instead.
    tokio::task::spawn_blocking(|| {
        ggml::hardware();
    });
    let (catalog, store) = args.store.open()?;
    let settings = runtime::Settings {
        stt_models: args.stt_model.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        tts_model: args.tts_model.clone(),
        accelerator: args.accelerator.clone(),
        onnx_provider: args.onnx_provider.clone(),
        threads: args.threads.unwrap_or_else(default_threads),
        beam_size: args.beam_size.max(1),
        default_voice: args.voice.clone(),
        default_speed: args.speed.clamp(0.5, 2.0),
        language: args.language.clone(),
        stt_prompt: args.stt_prompt.clone().filter(|s| !s.trim().is_empty()),
        honor_request_prompt: args.honor_request_prompt,
        idle_unload: (args.idle_unload_mins > 0).then(|| Duration::from_secs(args.idle_unload_mins * 60)),
        coreml: args.coreml,
        auto_pull: args.auto_pull,
        stub: args.stub,
    };
    let runtime = Arc::new(runtime::Runtime::new(catalog, store, settings, tokio::runtime::Handle::current()));
    let state = Arc::new(api::AppState::new(runtime.clone(), args.token.clone(), args.capture_dir.clone()));
    let app = api::router(state);

    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], args.port))).await.context("bind")?;
    let port = listener.local_addr()?.port();
    // Machine-readable handshake for the supervisor. Always the first stdout line.
    println!("{}", serde_json::json!({ "event": "listening", "port": port, "version": env!("CARGO_PKG_VERSION") }));

    // Download configured models in the background, but leave engines unloaded until a request.
    {
        let runtime = runtime.clone();
        let auto_pull = args.auto_pull;
        tokio::spawn(async move {
            if !runtime.settings.stub && auto_pull {
                for entry in runtime.missing_models() {
                    if let Err(err) = runtime.downloads.ensure(&runtime.store, &entry).await {
                        tracing::error!(model = entry.id, error = %format!("{err:#}"), "download failed");
                    }
                }
            }
            // Optional encoders may download now; only an already loaded model is reloaded.
            if !runtime.settings.stub && auto_pull {
                for entry in runtime.missing_coreml() {
                    match runtime.downloads.ensure_coreml(&runtime.store, &entry).await {
                        Ok(()) => {
                            let rt = runtime.clone();
                            let id = entry.id.clone();
                            let _ = tokio::task::spawn_blocking(move || rt.reload_stt(&id)).await;
                        }
                        Err(err) => tracing::error!(model = entry.id, error = %format!("{err:#}"), "CoreML encoder download failed"),
                    }
                }
            }
        });
    }

    // Idle unload ticker.
    {
        let runtime = runtime.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(30));
            loop {
                tick.tick().await;
                let rt = runtime.clone();
                let _ = tokio::task::spawn_blocking(move || { rt.unload_idle(); rt.retry_failed(); }).await;
            }
        });
    }

    let exit_on_eof = args.exit_on_stdin_eof;
    let shutdown = async move {
        if exit_on_eof {
            tokio::select! {
                _ = wait_stdin_eof() => tracing::info!("stdin closed, shutting down"),
                _ = shutdown_signal() => tracing::info!("signal, shutting down"),
            }
        } else {
            shutdown_signal().await;
        }
    };
    axum::serve(listener, app).with_graceful_shutdown(shutdown).await.context("serve")?;
    // Exit now: returning would make the tokio runtime wait for blocking tasks, and a model load
    // (a first-time Neural Engine compile takes minutes) would keep a stopped server alive.
    tracing::info!("stopped");
    // _exit: skip C++ static destructors (ONNX Runtime / ggml), which can abort while engine
    // threads are still alive.
    #[cfg(unix)]
    unsafe {
        libc::_exit(0)
    }
    #[cfg(not(unix))]
    std::process::exit(0);
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn wait_stdin_eof() {
    let mut stdin = tokio::io::stdin();
    let mut buf = [0u8; 256];
    loop {
        match stdin.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(_) => continue,
        }
    }
}
