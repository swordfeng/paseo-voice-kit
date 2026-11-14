//! Engine lifecycle: lazy load, warm-up, idle unload, background reload, status and latency stats.

use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::json;

use crate::{
    catalog::{Catalog, Engine, Kind, ModelEntry, Store},
    download::{coreml_key, Downloads},
    engine::{self, remote::RemoteEngine, route, sherpa, whisper, SttEngine, TtsEngine},
};

/// Load a sherpa-onnx or remote voice model (anything but a chain).
/// Why a voice model can never load with this build and settings, or None when it can.
/// These are configuration facts, not failures: nothing here installs anything.
fn unrunnable_voice(entry: &ModelEntry, store: &Store, use_gpu: bool) -> Option<String> {
    match entry.engine {
        Engine::Mlx if !cfg!(all(target_os = "macos", target_arch = "aarch64")) => {
            Some("MLX voice models need an Apple Silicon Mac".into())
        }
        Engine::Mlx if !use_gpu => Some("MLX voice models need GPU acceleration; Acceleration is set to CPU only".into()),
        Engine::Mlx if engine::mlx::python(&store.models_dir).is_none() => {
            Some("The MLX speech runtime is not installed; run install-qwen-runtime.sh".into())
        }
        Engine::Gguf if engine::gguf::worker_path().is_none() => Some("The GGUF speech worker is missing from this installation".into()),
        _ => None,
    }
}

fn load_leaf_tts(entry: &ModelEntry, store: &Store, provider: &str, threads: i32, default_voice: &str, handle: &tokio::runtime::Handle, use_gpu: bool) -> anyhow::Result<Arc<dyn TtsEngine>> {
    let (entry, inst) = store.resolve(entry).ok_or_else(|| anyhow::anyhow!("model {} is not installed", entry.id))?;
    let entry = &entry;
    Ok(match entry.engine {
        Engine::Sherpa => Arc::new(sherpa::SherpaTts::load(entry, &inst, provider, threads, default_voice)?),
        Engine::Openai => Arc::new(RemoteEngine::connect(entry.remote.as_ref().expect("validated"), handle.clone())?),
        Engine::Mlx => Arc::new(engine::mlx::MlxTts::load(entry, &inst.root, &store.models_dir, use_gpu)?),
        Engine::Gguf => Arc::new(engine::gguf::GgufTts::load(entry, &inst.root, use_gpu)?),
        Engine::Whisper | Engine::Chain => anyhow::bail!("{} is not a voice model", entry.id),
    })
}

/// Catalog id of the small Whisper model used for language detection.
pub const LANGUAGE_DETECTOR: &str = "whisper-base-q5_1";

#[derive(Debug, Clone)]
pub struct Settings {
    /// Speech recognition models this server serves. The first is the default; a request
    /// selects another by naming it in the `model` field.
    pub stt_models: Vec<String>,
    pub tts_model: String,
    /// "auto" uses the GPU where the engine supports it; "cpu" forces CPU.
    pub accelerator: String,
    /// ONNX Runtime provider for sherpa engines ("cpu", "coreml", "cuda").
    pub onnx_provider: String,
    pub threads: i32,
    pub beam_size: i32,
    pub default_voice: String,
    /// Speech rate used when a request does not send `speed` (Paseo never does).
    pub default_speed: f32,
    /// "auto" (detect), "request" (use the client's value) or a fixed ISO code.
    pub language: String,
    pub stt_prompt: Option<String>,
    pub honor_request_prompt: bool,
    pub idle_unload: Option<Duration>,
    /// Download and use Apple Neural Engine encoders for Whisper models (CoreML builds).
    pub coreml: bool,
    /// Download configured missing models when allowed.
    pub auto_pull: bool,
    pub stub: bool,
}

enum SlotState<T: ?Sized> {
    Unloaded,
    Ready(Arc<T>),
    Failed { error: String, at: Instant },
}

struct Slot<T: ?Sized> {
    /// Held only briefly, so status reads never wait on a model load.
    state: Mutex<SlotState<T>>,
    /// Serializes loads (a load can take seconds).
    load: Mutex<()>,
    loading: std::sync::atomic::AtomicBool,
    /// Serializes inference: one request at a time per engine keeps GPU memory predictable.
    run: Mutex<()>,
    last_used: Mutex<Instant>,
    loaded_once: Mutex<bool>,
    latencies: Mutex<VecDeque<u64>>,
    stages: Mutex<BTreeMap<&'static str, VecDeque<f64>>>,
    /// Consecutive failures (loads, or an engine found unavailable), for retry backoff.
    failures: std::sync::atomic::AtomicU32,
}

/// First retry 30 s after a failure, doubling up to 4 minutes while it keeps failing.
const SLOT_RETRY: Duration = Duration::from_secs(30);

impl<T: ?Sized> Slot<T> {
    fn new() -> Self {
        Self {
            state: Mutex::new(SlotState::Unloaded),
            load: Mutex::new(()),
            loading: std::sync::atomic::AtomicBool::new(false),
            run: Mutex::new(()),
            last_used: Mutex::new(Instant::now()),
            loaded_once: Mutex::new(false),
            latencies: Mutex::new(VecDeque::new()),
            stages: Mutex::new(BTreeMap::new()),
            failures: std::sync::atomic::AtomicU32::new(0),
        }
    }

    fn retry_delay(&self) -> Duration {
        SLOT_RETRY * 2u32.pow(self.failures.load(std::sync::atomic::Ordering::SeqCst).saturating_sub(1).min(3))
    }

    fn current(&self) -> Option<anyhow::Result<Arc<T>>> {
        let delay = self.retry_delay();
        match &*self.state.lock().unwrap() {
            SlotState::Ready(engine) => Some(Ok(engine.clone())),
            SlotState::Failed { error, at } if at.elapsed() < delay => {
                Some(Err(anyhow::anyhow!("{error}")))
            }
            _ => None,
        }
    }

    fn get(&self, load: impl FnOnce() -> anyhow::Result<Arc<T>>) -> anyhow::Result<Arc<T>> {
        if let Some(ready) = self.current() {
            return ready;
        }
        let _loading = self.load.lock().unwrap();
        // Another caller may have finished loading while we waited.
        if let Some(ready) = self.current() {
            return ready;
        }
        self.loading.store(true, std::sync::atomic::Ordering::SeqCst);
        let started = Instant::now();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(load))
            .unwrap_or_else(|_| Err(anyhow::anyhow!("engine loader panicked")));
        self.loading.store(false, std::sync::atomic::Ordering::SeqCst);
        match result {
            Ok(engine) => {
                tracing::info!(ms = started.elapsed().as_millis() as u64, "engine loaded");
                *self.state.lock().unwrap() = SlotState::Ready(engine.clone());
                *self.loaded_once.lock().unwrap() = true;
                self.failures.store(0, std::sync::atomic::Ordering::SeqCst);
                Ok(engine)
            }
            Err(err) => {
                let error = format!("{err:#}");
                tracing::error!(%error, "engine load failed");
                self.failures.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                *self.state.lock().unwrap() = SlotState::Failed { error: error.clone(), at: Instant::now() };
                anyhow::bail!(error)
            }
        }
    }

    fn touch(&self) {
        *self.last_used.lock().unwrap() = Instant::now();
    }

    fn record(&self, ms: u64) {
        let mut l = self.latencies.lock().unwrap();
        if l.len() >= 50 {
            l.pop_front();
        }
        l.push_back(ms);
    }

    fn record_stages(&self, timings: &crate::engine::Timings) {
        let mut stages = self.stages.lock().unwrap();
        for (stage, ms) in &timings.0 {
            let q = stages.entry(*stage).or_default();
            if q.len() >= 50 {
                q.pop_front();
            }
            q.push_back(*ms);
        }
    }

    fn stage_p50(&self) -> BTreeMap<String, f64> {
        self.stages
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, q)| !q.is_empty())
            .map(|(k, q)| {
                let mut v: Vec<f64> = q.iter().copied().collect();
                v.sort_by(|a, b| a.total_cmp(b));
                (k.to_string(), (v[v.len() / 2] * 10.0).round() / 10.0)
            })
            .collect()
    }

    fn p50(&self) -> Option<u64> {
        let mut v: Vec<u64> = self.latencies.lock().unwrap().iter().copied().collect();
        if v.is_empty() {
            return None;
        }
        v.sort_unstable();
        Some(v[v.len() / 2])
    }

    fn unload_if_idle(&self, after: Duration) -> bool {
        if self.last_used.lock().unwrap().elapsed() < after {
            return false;
        }
        // Do not unload while a request is running.
        let Ok(_guard) = self.run.try_lock() else { return false };
        let mut state = self.state.lock().unwrap();
        if matches!(*state, SlotState::Ready(_)) {
            *state = SlotState::Unloaded;
            return true;
        }
        false
    }

    fn state_label(&self) -> (&'static str, Option<String>) {
        if self.loading.load(std::sync::atomic::Ordering::SeqCst) {
            return ("loading", None);
        }
        match &*self.state.lock().unwrap() {
            SlotState::Ready(_) => ("ready", None),
            SlotState::Unloaded if *self.loaded_once.lock().unwrap() => ("idle", None),
            SlotState::Unloaded => ("unloaded", None),
            SlotState::Failed { error, .. } => ("failed", Some(error.clone())),
        }
    }
}


impl<T: ?Sized> Slot<T> {
    fn retry_due(&self) -> bool {
        let delay = self.retry_delay();
        !self.loading.load(std::sync::atomic::Ordering::SeqCst)
            && matches!(&*self.state.lock().unwrap(), SlotState::Failed { at, .. } if at.elapsed() >= delay)
    }

    /// A loaded engine reported that it can't serve requests (e.g. its server went away).
    /// Report the model unavailable so the plugin falls back; the background retry reloads
    /// it, which for remote engines checks the server answers again.
    fn mark_unavailable(&self, error: String) {
        let mut state = self.state.lock().unwrap();
        if matches!(*state, SlotState::Ready(_)) {
            self.failures.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            *state = SlotState::Failed { error, at: Instant::now() };
        }
    }

    fn reset_failed(&self) {
        let Ok(_loading) = self.load.try_lock() else { return };
        let mut state = self.state.lock().unwrap();
        if matches!(*state, SlotState::Failed { .. }) {
            *state = SlotState::Unloaded;
            self.failures.store(0, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// Replace the engine with a freshly loaded one. The old engine keeps serving until then.
    fn swap(&self, engine: Arc<T>) {
        *self.state.lock().unwrap() = SlotState::Ready(engine);
        *self.loaded_once.lock().unwrap() = true;
    }
}

pub struct Runtime {
    pub catalog: Catalog,
    pub store: Store,
    pub downloads: Downloads,
    pub settings: Settings,
    stt: BTreeMap<String, Slot<dyn SttEngine>>,
    tts: Slot<dyn TtsEngine>,
    accelerators: Mutex<BTreeMap<String, String>>,
    /// CoreML encoders being compiled (first load takes minutes; cached by macOS afterwards).
    compiling: Mutex<BTreeMap<String, Instant>>,
    handle: tokio::runtime::Handle,
}

#[derive(Debug, Serialize)]
pub struct EngineStatus {
    pub model: String,
    /// missing | downloading | unloaded | loading | failed | ready | idle
    pub state: &'static str,
    /// True when requests can be served now or after a quick (re)load.
    pub available: bool,
    pub accelerator: Option<String>,
    pub error: Option<String>,
    pub p50_ms: Option<u64>,
    /// Median duration of each stage over recent requests (ms).
    pub stages_p50_ms: BTreeMap<String, f64>,
}

pub fn coreml_supported() -> bool {
    cfg!(all(target_os = "macos", feature = "coreml"))
}

impl Runtime {
    pub fn new(catalog: Catalog, store: Store, settings: Settings, handle: tokio::runtime::Handle) -> Self {
        let stt = settings.stt_models.iter().map(|id| (id.clone(), Slot::new())).collect();
        Self {
            catalog,
            store,
            downloads: Downloads::default(),
            settings,
            stt,
            tts: Slot::new(),
            accelerators: Mutex::new(BTreeMap::new()),
            compiling: Mutex::new(BTreeMap::new()),
            handle,
        }
    }

    pub fn default_stt_model(&self) -> &str {
        self.settings.stt_models.first().map(String::as_str).unwrap_or("")
    }

    /// Resolve a request's `model` field to a configured STT model id.
    pub fn resolve_stt_model(&self, requested: Option<&str>) -> String {
        match requested {
            Some(id) if self.stt.contains_key(id) => id.to_string(),
            _ => self.default_stt_model().to_string(),
        }
    }

    fn entry(&self, id: &str, kind: Kind) -> anyhow::Result<&ModelEntry> {
        self.catalog
            .find(id)
            .filter(|e| e.kind == kind)
            .ok_or_else(|| anyhow::anyhow!("unknown {} model {id}", if kind == Kind::Stt { "speech recognition" } else { "voice" }))
    }

    fn use_gpu(&self) -> bool {
        self.settings.accelerator != "cpu"
    }

    fn onnx_provider(&self) -> &str {
        if self.use_gpu() {
            &self.settings.onnx_provider
        } else {
            "cpu"
        }
    }

    fn set_accel(&self, model: &str, accel: &str) {
        self.accelerators.lock().unwrap().insert(model.to_string(), accel.to_string());
    }

    fn load_stt(&self, model: &str) -> anyhow::Result<Arc<dyn SttEngine>> {
        let entry = self.entry(model, Kind::Stt)?;
        let (entry, inst) = self.store.resolve(entry).ok_or_else(|| anyhow::anyhow!("model {} is not installed", entry.id))?;
        let entry = &entry;
        Ok(match entry.engine {
            Engine::Whisper => {
                let path = inst.file(entry, "model").ok_or_else(|| anyhow::anyhow!("{}: files.model missing", entry.id))?;
                let vad = crate::speech_filter::model();
                let vad_path = self.store.locate(vad).and_then(|i| i.file(vad, "model"))
                    .ok_or_else(|| anyhow::anyhow!("speech activity detector is not installed; pull {} again", entry.id))?;
                let detector = (entry.id != LANGUAGE_DETECTOR)
                    .then(|| self.catalog.find(LANGUAGE_DETECTOR))
                    .flatten()
                    .and_then(|d| self.store.locate(d).and_then(|i| i.file(d, "model")));
                let has_encoder = coreml_supported() && crate::catalog::coreml_encoder_path(&path).exists();
                let coreml = has_encoder && self.settings.coreml && self.use_gpu();
                // whisper.cpp loads `<name>-encoder.mlmodelc` whenever it sits next to the model.
                // When the Neural Engine is off, load through a differently named link so it
                // does not (no compile, plain Metal).
                let path = if has_encoder && !coreml { self.store.plain_whisper_path(&path)? } else { path };
                if coreml {
                    self.compiling.lock().unwrap().insert(entry.id.clone(), Instant::now());
                }
                let loaded = whisper::WhisperStt::load(&path, detector.as_deref(), self.use_gpu(), self.settings.threads, self.settings.beam_size, coreml);
                self.compiling.lock().unwrap().remove(&entry.id);
                Arc::new(loaded?.with_speech_filter(&vad_path)?)
            }
            Engine::Sherpa => Arc::new(sherpa::SherpaStt::load(entry, &inst, self.onnx_provider(), self.settings.threads, self.settings.stt_prompt.as_deref())?),
            Engine::Openai => Arc::new(RemoteEngine::connect(entry.remote.as_ref().expect("validated"), self.handle.clone())?),
            Engine::Chain | Engine::Mlx | Engine::Gguf => anyhow::bail!("{} is a voice model", entry.id),
        })
    }

    fn load_tts(&self) -> anyhow::Result<Arc<dyn TtsEngine>> {
        self.load_tts_entry(&self.settings.tts_model)
    }

    fn load_tts_entry(&self, id: &str) -> anyhow::Result<Arc<dyn TtsEngine>> {
        let entry = self.entry(id, Kind::Tts)?;
        if entry.engine == Engine::Chain {
            let mut models = Vec::new();
            for id in entry.chain_models() {
                let model = self.entry(&id, Kind::Tts)?;
                anyhow::ensure!(model.engine != Engine::Chain, "a voice chain cannot contain another chain");
                let voices = model.voices.iter().map(|v| engine::Voice {
                    id: v.id.clone(), label: v.label.clone(), language: v.language.clone(), gender: v.gender.clone(), featured: v.featured,
                }).collect();
                let route = route::Route::lazy(self.lazy_route(model), model.id.clone(), model.label.clone(), model.languages.clone(), None, voices);
                let (store, child) = (self.store.clone(), model.clone());
                let (check_store, check_child, use_gpu) = (self.store.clone(), model.clone(), self.use_gpu());
                models.push(Arc::new(
                    route
                        .with_installed(Box::new(move || store.locate(&child).is_some()))
                        .with_unrunnable(Box::new(move || unrunnable_voice(&check_child, &check_store, use_gpu))),
                ));
            }
            let preferred = serde_json::from_value(entry.options.get("language_models").cloned().unwrap_or_else(|| json!({})))?;
            let voices = serde_json::from_value(entry.options.get("model_voices").cloned().unwrap_or_else(|| json!({})))?;
            let approximate = serde_json::from_value(entry.options.get("approximate_languages").cloned().unwrap_or_else(|| json!([])))?;
            return Ok(Arc::new(engine::chain::ChainTts::new(models, entry.personas(), preferred, voices, approximate)));
        }
        load_leaf_tts(entry, &self.store, self.onnx_provider(), self.settings.threads, &self.settings.default_voice, &self.handle, self.use_gpu())
    }

    /// Loader for an enabled model whose model is not installed: starts its download (when
    /// downloads are allowed) and loads it once it is there.
    fn lazy_route(&self, model: &ModelEntry) -> route::LazyLoad {
        let (entry, store, downloads, handle) = (model.clone(), self.store.clone(), self.downloads.clone(), self.handle.clone());
        let (provider, threads, voice, auto_pull, use_gpu) = (self.onnx_provider().to_string(), self.settings.threads, self.settings.default_voice.clone(), self.settings.auto_pull, self.use_gpu());
        Box::new(move || {
            if let Some(error) = entry.option_str("unavailable") {
                return Some(Err(anyhow::anyhow!("{error}")));
            }
            if entry.engine == Engine::Mlx && (!use_gpu || engine::mlx::python(&store.models_dir).is_none()) {
                return None;
            }
            if store.locate(&entry).is_none() {
                if auto_pull && store.paseo_model(&entry).is_none() && !downloads.is_active(&entry.id) && downloads.error(&entry.id).is_none() {
                    tracing::info!(model = entry.id, "downloading an enabled voice model on first use");
                    let (downloads, store, entry) = (downloads.clone(), store.clone(), entry.clone());
                    handle.spawn(async move {
                        if let Err(err) = downloads.ensure(&store, &entry).await {
                            tracing::error!(model = entry.id, error = %format!("{err:#}"), "download failed");
                        }
                    });
                }
                return None;
            }
            Some(load_leaf_tts(&entry, &store, &provider, threads, &voice, &handle, use_gpu))
        })
    }

    /// Why `entry` can't run here as configured (see `unrunnable_voice`).
    pub fn unrunnable(&self, entry: &ModelEntry) -> Option<String> {
        unrunnable_voice(entry, &self.store, self.use_gpu())
    }

    /// A chain is usable when at least one enabled model is installed and can run here.
    pub fn installed(&self, entry: &ModelEntry) -> bool {
        if entry.engine == Engine::Whisper && self.store.locate(crate::speech_filter::model()).is_none() {
            return false;
        }
        if entry.engine == Engine::Chain {
            return entry.chain_models().iter().any(|id| {
                self.catalog.find(id).is_some_and(|m| m.engine != Engine::Chain && self.installed(m) && self.unrunnable(m).is_none())
            });
        }
        self.store.locate(entry).is_some()
    }

    /// Entries needed by this model, including its enabled chain children.
    pub fn with_dependencies<'a>(&'a self, entry: &'a ModelEntry) -> Vec<&'a ModelEntry> {
        let mut out = vec![entry];
        if entry.engine == Engine::Whisper {
            out.push(crate::speech_filter::model());
        }
        if entry.engine == Engine::Chain {
            for id in entry.chain_models() {
                if let Some(model) = self.catalog.find(&id) { out.push(model); }
            }
        }
        out
    }

    /// A completed download may unblock a configured chain as well as its leaf engine.
    /// Run on a blocking worker; unrelated and deliberately idle engines stay unloaded.
    pub fn recover_downloaded(&self, downloaded: &str) {
        for entry in self.configured_entries() {
            let uses_model = self.with_dependencies(entry).iter().any(|dep| dep.id == downloaded)
                || entry.chain_models().iter().any(|id| id == downloaded);
            if !uses_model || !self.installed(entry) {
                continue;
            }
            let result = if entry.kind == Kind::Stt {
                if let Some(slot) = self.stt.get(&entry.id) { slot.reset_failed(); }
                self.stt(&entry.id).map(|_| ())
            } else {
                let engine = match &*self.tts.state.lock().unwrap() { SlotState::Ready(engine) => Some(engine.clone()), _ => None };
                if let Some(engine) = engine { engine.model_downloaded(downloaded); }
                self.tts.reset_failed();
                self.tts().map(|_| ())
            };
            if let Err(err) = result {
                tracing::warn!(model = entry.id, error = %format!("{err:#}"), "downloaded model could not load");
            }
        }
    }

    /// Retry only failed, installed, configured engines. A retry never advertises
    /// availability until loading succeeds, and deliberately idle models stay unloaded.
    pub fn retry_failed(&self) {
        let voice = match &*self.tts.state.lock().unwrap() { SlotState::Ready(engine) => Some(engine.clone()), _ => None };
        if let Some(engine) = voice { engine.retry_failed(); }
        std::thread::scope(|scope| {
            for (model, slot) in &self.stt {
                if slot.retry_due() && self.catalog.find(model).is_some_and(|e| self.installed(e)) {
                    scope.spawn(move || { let _ = self.stt(model); });
                }
            }
            if self.tts.retry_due() && self.catalog.find(&self.settings.tts_model).is_some_and(|e| self.installed(e)) {
                scope.spawn(|| { let _ = self.tts(); });
            }
        });
    }

    /// Blocking: load (if needed) and return the STT engine for `model`.
    pub fn stt(&self, model: &str) -> anyhow::Result<Arc<dyn SttEngine>> {
        if self.settings.stub {
            return Ok(Arc::new(engine::stub::StubStt));
        }
        let slot = self.stt.get(model).ok_or_else(|| anyhow::anyhow!("STT model {model} is not configured"))?;
        slot.touch();
        let engine = slot.get(|| self.load_stt(model))?;
        self.set_accel(model, engine.accelerator());
        Ok(engine)
    }

    /// Blocking: load (if needed) and return the TTS engine.
    pub fn tts(&self) -> anyhow::Result<Arc<dyn TtsEngine>> {
        if self.settings.stub {
            return Ok(Arc::new(engine::stub::StubTts));
        }
        self.tts.touch();
        let engine = self.tts.get(|| self.load_tts())?;
        self.set_accel(&self.settings.tts_model, engine.accelerator());
        Ok(engine)
    }

    /// Blocking: load a new engine for `model` while the current one keeps serving, then swap.
    pub fn reload_stt(&self, model: &str) {
        let Some(slot) = self.stt.get(model) else { return };
        match self.load_stt(model) {
            Ok(engine) => {
                self.set_accel(model, engine.accelerator());
                slot.swap(engine);
                tracing::info!(model, "engine reloaded");
            }
            Err(err) => tracing::warn!(model, error = %format!("{err:#}"), "reload failed; keeping the current engine"),
        }
    }

    /// Run `f` with exclusive use of the STT engine for `model`, recording latency.
    pub fn with_stt<R>(
        &self,
        model: &str,
        timings: &mut crate::engine::Timings,
        f: impl FnOnce(&dyn SttEngine, &mut crate::engine::Timings) -> anyhow::Result<R>,
    ) -> anyhow::Result<R> {
        let engine = timings.time("load", || self.stt(model))?;
        let Some(slot) = self.stt.get(model) else {
            return f(engine.as_ref(), timings);
        };
        let _guard = timings.time("queue", || slot.run.lock().unwrap());
        let started = Instant::now();
        let out = f(engine.as_ref(), timings);
        slot.record(started.elapsed().as_millis() as u64);
        slot.record_stages(timings);
        slot.touch();
        if let Err(error) = &out {
            // Only engine-level failures take the model offline; a bad request does not.
            if engine::is_unavailable(error) {
                tracing::warn!(model, error = %format!("{error:#}"), "speech recognition engine unavailable; reconnecting in the background");
                slot.mark_unavailable(format!("{error:#}"));
            }
        }
        out
    }

    pub fn with_tts<R>(
        &self,
        timings: &mut crate::engine::Timings,
        f: impl FnOnce(&dyn TtsEngine, &mut crate::engine::Timings) -> anyhow::Result<R>,
    ) -> anyhow::Result<R> {
        let engine = timings.time("load", || self.tts())?;
        let _guard = timings.time("queue", || self.tts.run.lock().unwrap());
        let started = Instant::now();
        let out = f(engine.as_ref(), timings);
        self.tts.record(started.elapsed().as_millis() as u64);
        self.tts.record_stages(timings);
        self.tts.touch();
        out
    }

    /// A TTS stage measured after the engine lock is released (output audio encoding).
    pub fn record_tts_stage(&self, stage: &'static str, ms: f64) {
        self.tts.record_stages(&crate::engine::Timings(vec![(stage, ms)]));
    }

    /// Blocking: load every configured engine so first requests are fast. Engines load in
    /// parallel, so a slow one (a first-time Neural Engine compile takes minutes) does not hold
    /// back the others: the plugin can route dictation to a ready model meanwhile.
    pub fn warm_up(&self) {
        std::thread::scope(|scope| {
            scope.spawn(|| {
                if let Err(err) = self.tts() {
                    tracing::warn!(error = %format!("{err:#}"), "TTS warm-up failed");
                }
            });
            for model in &self.settings.stt_models {
                scope.spawn(move || {
                    if let Err(err) = self.stt(model) {
                        tracing::warn!(model, error = %format!("{err:#}"), "STT warm-up failed");
                    }
                });
            }
        });
    }

    fn configured_entries(&self) -> Vec<&ModelEntry> {
        self.settings
            .stt_models
            .iter()
            .filter_map(|id| self.catalog.find(id))
            .chain(self.catalog.find(&self.settings.tts_model))
            .collect()
    }

    /// Models to fetch: configured ones, plus the language detector when a big Whisper model is used.
    pub fn missing_models(&self) -> Vec<ModelEntry> {
        let mut wanted: Vec<&ModelEntry> = self.configured_entries().into_iter().flat_map(|e| self.with_dependencies(e)).collect();
        if wanted.iter().any(|e| e.engine == Engine::Whisper && e.id != LANGUAGE_DETECTOR) {
            wanted.extend(self.catalog.find(LANGUAGE_DETECTOR));
        }
        let mut out: Vec<ModelEntry> = Vec::new();
        for e in wanted {
            // A model that can't run here as configured is not fetched in the background.
            if self.store.paseo_model(e).is_none() && self.store.locate(e).is_none() && !e.download.is_empty() && e.path.is_none() && self.unrunnable(e).is_none() && !out.iter().any(|o| o.id == e.id) {
                out.push(e.clone());
            }
        }
        out
    }

    /// Whisper models whose Neural Engine encoder should be fetched.
    pub fn missing_coreml(&self) -> Vec<ModelEntry> {
        if !(coreml_supported() && self.settings.coreml && self.use_gpu()) {
            return vec![];
        }
        self.settings
            .stt_models
            .iter()
            .filter_map(|id| self.catalog.find(id))
            .filter(|e| e.engine == Engine::Whisper && e.coreml.is_some())
            .filter(|e| self.store.coreml_dir(e).is_some_and(|d| !d.exists()))
            .cloned()
            .collect()
    }

    pub fn unload_idle(&self) {
        if let Some(after) = self.settings.idle_unload {
            for (model, slot) in &self.stt {
                if slot.unload_if_idle(after) {
                    tracing::info!(model, "unloaded idle STT engine");
                }
            }
            let voice = match &*self.tts.state.lock().unwrap() { SlotState::Ready(engine) => Some(engine.clone()), _ => None };
            // Preserve a failed route's recovery state; otherwise idle unloading would
            // make an unhealthy chain look available again without a successful reload.
            if voice.as_ref().is_none_or(|engine| engine.failure().is_none()) && self.tts.unload_if_idle(after) {
                tracing::info!("unloaded idle TTS engine");
            }
            if let Some(engine) = voice { engine.unload_idle(after); }
        }
    }

    fn engine_status<T: ?Sized>(&self, slot: &Slot<T>, model: &str, kind: Kind) -> EngineStatus {
        let accel = if kind == Kind::Tts {
            match &*self.tts.state.lock().unwrap() {
                SlotState::Ready(engine) => Some(engine.accelerator().to_string()),
                _ => None,
            }
        } else { self.accelerators.lock().unwrap().get(model).cloned() };
        if self.settings.stub {
            return EngineStatus { model: model.into(), state: "ready", available: true, accelerator: Some("none".into()), error: None, p50_ms: slot.p50(), stages_p50_ms: slot.stage_p50() };
        }
        let Some(entry) = self.catalog.find(model).filter(|e| e.kind == kind) else {
            return EngineStatus { model: model.into(), state: "failed", available: false, accelerator: None, error: Some(format!("unknown model {model}")), p50_ms: None, stages_p50_ms: BTreeMap::new() };
        };
        let (mut state, mut error) = if !self.installed(entry) {
            let deps = self.with_dependencies(entry);
            let error = deps.iter().find_map(|d| d.option_str("unavailable").map(str::to_string).or_else(|| self.downloads.error(&d.id)));
            let downloading = deps.iter().any(|d| self.downloads.is_active(&d.id));
            match self.chain_unrunnable(entry) {
                // Nothing to wait for: every installed model is unable to run here.
                Some(reason) if !downloading => ("failed", Some(reason)),
                _ => (if downloading { "downloading" } else { "missing" }, error),
            }
        } else {
            slot.state_label()
        };
        if kind == Kind::Tts {
            if let SlotState::Ready(engine) = &*self.tts.state.lock().unwrap() {
                if let Some(failure) = engine.failure() { state = "failed"; error = Some(failure); }
            }
        }
        EngineStatus {
            model: entry.id.clone(),
            state,
            available: matches!(state, "ready" | "idle"),
            accelerator: accel,
            error,
            p50_ms: slot.p50(),
            stages_p50_ms: slot.stage_p50(),
        }
    }

    /// For a chain with no usable model: the reason when its installed models can't run here
    /// and no runnable model is left to download.
    fn chain_unrunnable(&self, entry: &ModelEntry) -> Option<String> {
        if entry.engine != Engine::Chain {
            return None;
        }
        let models: Vec<_> = entry.chain_models().iter().filter_map(|id| self.catalog.find(id)).collect();
        let downloadable = models.iter().any(|m| !self.installed(m) && self.unrunnable(m).is_none() && m.option_str("unavailable").is_none());
        if downloadable {
            return None;
        }
        models.iter().filter(|m| self.installed(m)).find_map(|m| self.unrunnable(m))
    }

    fn coreml_state(&self, entry: &ModelEntry) -> serde_json::Value {
        if !(coreml_supported() && entry.coreml.is_some()) {
            return serde_json::Value::Null;
        }
        let key = coreml_key(&entry.id);
        let state = if let Some(since) = self.compiling.lock().unwrap().get(&entry.id) {
            json!({ "state": "compiling", "seconds": since.elapsed().as_secs() })
        } else if self.store.coreml_dir(entry).is_some_and(|d| d.exists()) {
            json!({ "state": if self.settings.coreml { "installed" } else { "off" } })
        } else if self.downloads.is_active(&key) {
            json!({ "state": "downloading" })
        } else if let Some(error) = self.downloads.error(&key) {
            json!({ "state": "failed", "error": error })
        } else {
            json!({ "state": if self.settings.coreml { "missing" } else { "off" } })
        };
        state
    }

    pub fn status(&self) -> serde_json::Value {
        let stt: Vec<EngineStatus> = self.settings.stt_models.iter().map(|m| self.engine_status(&self.stt[m], m, Kind::Stt)).collect();
        let tts = self.engine_status(&self.tts, &self.settings.tts_model, Kind::Tts);
        let all: Vec<&EngineStatus> = stt.iter().chain(std::iter::once(&tts)).collect();
        let available = all.iter().filter(|e| e.available).count();
        let overall = if available == all.len() {
            "ready"
        } else if available > 0 {
            "degraded"
        } else if all.iter().any(|e| matches!(e.state, "downloading" | "unloaded" | "loading")) {
            "loading"
        } else {
            "failed"
        };
        let coreml: BTreeMap<String, serde_json::Value> = self
            .settings
            .stt_models
            .iter()
            .filter_map(|id| self.catalog.find(id))
            .map(|e| (e.id.clone(), self.coreml_state(e)))
            .filter(|(_, v)| !v.is_null())
            .collect();
        json!({
            "status": overall,
            "version": env!("CARGO_PKG_VERSION"),
            "stt": stt,
            "tts": tts,
            "ttsLastError": match &*self.tts.state.lock().unwrap() { SlotState::Ready(engine)=>engine.last_error(), _=>None },
            "coreml": coreml,
            "downloads": self.downloads.snapshot(),
            // ggml backends and devices (name, description, type, memory): what Whisper can use.
            // null until they are initialized (a second or so after start).
            "hardware": crate::ggml::hardware_ready(),
        })
    }

    /// Models that are not configured directly but are needed by one that is, and why:
    /// a voice chain's models, and the language detector of a big Whisper model.
    /// Configured directly or needed by a configured model.
    pub fn in_use(&self, id: &str) -> bool {
        self.stt.contains_key(id) || id == self.settings.tts_model || self.indirect_uses().contains_key(id)
    }

    fn indirect_uses(&self) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        for entry in self.configured_entries() {
            if entry.engine == Engine::Chain {
                for id in entry.chain_models() { out.entry(id).or_insert_with(|| format!("Part of {}", entry.label)); }
            }
            if entry.engine == Engine::Whisper && entry.id != LANGUAGE_DETECTOR {
                out.entry(LANGUAGE_DETECTOR.to_string()).or_insert_with(|| "Language detection".to_string());
            }
        }
        out
    }

    pub fn models_json(&self) -> serde_json::Value {
        let downloads = self.downloads.snapshot();
        let indirect = self.indirect_uses();
        let list: Vec<_> = self
            .catalog
            .entries()
            .iter()
            .map(|m| {
                let installed = self.store.locate(m).filter(|_| self.installed(m));
                let size: u64 = self.with_dependencies(m).iter().map(|d| d.size_bytes()).sum();
                json!({
                    "id": m.id,
                    "kind": m.kind,
                    "engine": m.engine,
                    "family": m.family,
                    "label": m.label,
                    "description": m.description,
                    "unavailable": m.option_str("unavailable"),
                    "languages": m.languages,
                    "tier": m.tier,
                    "configured": m.id==self.settings.tts_model || self.catalog.find(&self.settings.tts_model).filter(|e|e.options.get("chain").is_some()).is_some_and(|e|e.chain_models().iter().any(|id| id==&m.id)),
                    "uses": m.uses,
                    "sizeBytes": size,
                    "installed": installed.is_some(),
                    "shared": installed.as_ref().map(|i| i.shared),
                    "sharedWithPaseo": self.store.paseo_model(m).is_some(),
                    "download": downloads.get(&m.id),
                    "active": self.stt.contains_key(&m.id) || m.id == self.settings.tts_model || indirect.contains_key(&m.id),
                    "usedBy": indirect.get(&m.id),
                    "coreml": self.coreml_state(m),
                    "eval": m.eval,
                    // Multilingual voices: which model speaks which language; optional ones are
                    // downloaded when needed.
                })
            })
            .collect();
        json!({ "models": list, "coremlSupported": coreml_supported() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_or_panicking_loader_can_recover_without_poisoning_the_slot() {
        let slot: Slot<u8> = Slot::new();
        assert!(slot.get(|| panic!("simulated loader failure")).is_err());
        assert_eq!(slot.state_label().0, "failed");
        assert!(!slot.loading.load(std::sync::atomic::Ordering::SeqCst));
        slot.reset_failed();
        assert_eq!(*slot.get(|| Ok(Arc::new(7))).unwrap(), 7);
    }

    #[test]
    fn old_failure_remains_unavailable_until_a_retry_succeeds() {
        let slot: Slot<u8> = Slot::new();
        *slot.state.lock().unwrap() = SlotState::Failed {
            error: "temporary failure".into(),
            at: Instant::now() - Duration::from_secs(31),
        };
        assert_eq!(slot.state_label().0, "failed");
        assert!(slot.retry_due());
        assert_eq!(*slot.get(|| Ok(Arc::new(8))).unwrap(), 8);
        assert_eq!(slot.state_label().0, "ready");
        assert!(!slot.retry_due());
    }

    #[test]
    fn background_retry_only_announces_ready_after_a_successful_load() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            let until = Instant::now() + Duration::from_secs(5);
            loop {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        // Windows inherits the listener's nonblocking mode on accept.
                        // The fixture's request/response I/O is deliberately blocking.
                        socket.set_nonblocking(false).unwrap();
                        socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                        let mut data = [0u8; 4096];
                        let _ = socket.read(&mut data).unwrap();
                        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
                        break;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < until => std::thread::sleep(Duration::from_millis(5)),
                    Err(e) => panic!("background retry did not connect: {e}"),
                }
            }
        });
        let host = tokio::runtime::Runtime::new().unwrap();
        let folder = std::env::temp_dir().join(format!("vk-background-retry-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("catalog.json");
        std::fs::write(&file, json!({ "models": [{ "id": "retry-server", "kind": "stt", "label": "Retry fixture", "engine": "openai",
            "remote": { "base_url": format!("http://{address}/v1"), "model": "test" } }] }).to_string()).unwrap();
        let mut settings = crate::default_settings();
        settings.stt_models = vec!["retry-server".into()];
        let rt = Runtime::new(Catalog::load(&[file]).unwrap(), Store { models_dir: folder.join("models"), reuse_dirs: vec![], shared_models_dir: None, paseo_managed: false }, settings, host.handle().clone());
        let fail = || SlotState::Failed { error: "temporary failure".into(), at: Instant::now() - Duration::from_secs(31) };
        *rt.stt["retry-server"].state.lock().unwrap() = fail();
        assert_eq!(rt.status()["stt"][0]["available"], false);
        rt.retry_failed();
        assert_eq!(rt.status()["stt"][0]["state"], "ready");
        server.join().unwrap(); // the remote endpoint is now closed
        *rt.stt["retry-server"].state.lock().unwrap() = fail();
        rt.retry_failed();
        assert_eq!(rt.status()["stt"][0]["available"], false);
        assert_eq!(rt.status()["stt"][0]["state"], "failed");
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn paseo_shared_models_never_start_an_independent_native_download() {
        let host = tokio::runtime::Runtime::new().unwrap();
        let folder = std::env::temp_dir().join(format!("vk-paseo-no-download-{}", std::process::id()));
        let mut settings = crate::default_settings();
        settings.stt_models = vec!["sensevoice-int8".into()]; settings.tts_model = "unused".into();
        let store = Store { models_dir: folder.join("private"), reuse_dirs: vec![], shared_models_dir: Some(folder.join("paseo")), paseo_managed: true };
        let rt = Runtime::new(Catalog::load(&[]).unwrap(), store, settings, host.handle().clone());
        assert!(rt.missing_models().is_empty());
        let result = host.block_on(rt.downloads.ensure(&rt.store, rt.catalog.find("sensevoice-int8").unwrap()));
        assert!(result.unwrap_err().to_string().contains("managed by Paseo"));
        assert!(rt.downloads.snapshot().is_empty());
        assert!(!folder.exists(), "no transfer or directory should have started");
    }

    #[test]
    fn unavailable_custom_voice_does_not_disable_recognition_or_enable_other_models() {
        let host = tokio::runtime::Runtime::new().unwrap();
        let folder = std::env::temp_dir().join(format!("vk-unavailable-voice-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("catalog.json");
        std::fs::write(&path, json!({"models":[
            {"id":"fixture-stt","kind":"stt","engine":"openai","label":"fixture","remote":{"base_url":"http://127.0.0.1:9/v1","model":"fixture"}},
            {"id":"missing-voice","kind":"tts","engine":"sherpa","family":"unavailable","label":"fixture","languages":["en"],"options":{"unavailable":"ENOENT moved model"}},
            {"id":"unavailable-chain","kind":"tts","engine":"chain","label":"fixture","options":{"chain":["missing-voice"]}}
        ]}).to_string()).unwrap();
        let mut settings = crate::default_settings();
        settings.stt_models = vec!["fixture-stt".into()];
        settings.tts_model = "unavailable-chain".into();
        let rt = Runtime::new(Catalog::load(&[path]).unwrap(), Store { models_dir: folder.join("models"), reuse_dirs: vec![], shared_models_dir: None, paseo_managed: false }, settings, host.handle().clone());
        *rt.stt["fixture-stt"].state.lock().unwrap() = SlotState::Ready(Arc::new(engine::stub::StubStt));
        assert!(rt.tts().is_ok(), "the inert voice must not abort server configuration");
        assert_eq!(rt.status()["stt"][0]["available"], true);
        assert_eq!(rt.status()["tts"]["available"], false);
        assert_eq!(rt.status()["tts"]["error"], "ENOENT moved model");
        let entry = rt.catalog.find("missing-voice").unwrap();
        assert!(rt.store.locate(entry).is_none());
        assert!(rt.lazy_route(entry)().unwrap().is_err());
        assert!(rt.missing_models().is_empty());
        assert!(!rt.in_use("supertonic-3"));
        assert_eq!(rt.models_json()["models"].as_array().unwrap().iter().find(|m|m["id"]=="missing-voice").unwrap()["unavailable"], "ENOENT moved model");
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn enabled_voice_chain_downloads_no_disabled_qwen_weights() {
        let host=tokio::runtime::Runtime::new().unwrap();
        let folder=std::env::temp_dir().join(format!("vk-chain-downloads-{}",std::process::id()));std::fs::create_dir_all(&folder).unwrap();
        let path=folder.join("catalog.json");
        std::fs::write(&path,json!({"models":[{"id":"download-scope-chain","kind":"tts","engine":"chain","label":"fixture","options":{"chain":["supertonic-3"]}}]}).to_string()).unwrap();
        let catalog=Catalog::load(&[path]).unwrap();let mut settings=crate::default_settings();settings.stt_models.clear();settings.tts_model="download-scope-chain".into();
        let rt=Runtime::new(catalog,Store {models_dir:folder.join("models"),reuse_dirs:vec![], shared_models_dir: None, paseo_managed: false},settings,host.handle().clone());
        let missing=rt.missing_models();assert_eq!(missing.len(),1);assert_eq!(missing[0].id,"supertonic-3");
        assert!(!rt.in_use("qwen3-tts-0.6b-gguf-q4"));
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn whisper_fetches_speech_filter_and_reuses_shared_copy() {
        let handle = tokio::runtime::Runtime::new().unwrap();
        let dir = std::env::temp_dir().join(format!("vk-vad-deps-{}", std::process::id()));
        let mut settings = crate::default_settings();
        settings.stt_models = vec!["whisper-large-v3-turbo-q5_0".into()];
        let store = Store { models_dir: dir.join("own"), reuse_dirs: vec![dir.join("shared")], shared_models_dir: None, paseo_managed: false };
        let rt = Runtime::new(Catalog::load(&[]).unwrap(), store, settings, handle.handle().clone());
        let whisper = rt.catalog.find("whisper-large-v3-turbo-q5_0").unwrap();
        assert!(rt.with_dependencies(whisper).iter().any(|m| m.id == "silero-vad"));
        assert!(rt.missing_models().iter().any(|m| m.id == "silero-vad"));
        // Reusing Paseo's detector must not copy, replace or download that model.
        let shared = dir.join("shared/silero-vad");
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::write(shared.join("silero_vad.onnx"), b"fixture").unwrap();
        assert!(!rt.missing_models().iter().any(|m| m.id == "silero-vad"));
        assert!(rt.store.locate(crate::speech_filter::model()).unwrap().shared);
        assert!(rt.catalog.find("silero-vad").is_none(), "VAD is not a selectable recognizer");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn voice_failure_is_unavailable_even_when_chain_object_is_ready() {
        struct FailedVoice;
        impl TtsEngine for FailedVoice {
            fn synthesize(&self, _: crate::engine::SpeakRequest<'_>, _: &mut crate::engine::Timings) -> anyhow::Result<crate::audio::Pcm> { unreachable!() }
            fn voices(&self) -> Vec<crate::engine::Voice> { vec![] }
            fn accelerator(&self) -> &str { "idle" }
            fn failure(&self) -> Option<String> { Some("voice load failed".into()) }
        }
        let host = tokio::runtime::Runtime::new().unwrap();
        let dir = std::env::temp_dir().join(format!("vk-chain-health-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("catalog.json");
        std::fs::write(&file, json!({"models":[{"id":"health-voice","kind":"tts","label":"fixture","engine":"openai","remote":{"base_url":"http://127.0.0.1:1/v1","model":"fixture"}}]}).to_string()).unwrap();
        let mut settings = crate::default_settings(); settings.tts_model = "health-voice".into(); settings.idle_unload = Some(Duration::ZERO);
        let rt = Runtime::new(Catalog::load(&[file]).unwrap(), Store { models_dir: dir.clone(), reuse_dirs: vec![], shared_models_dir: None, paseo_managed: false }, settings, host.handle().clone());
        *rt.tts.state.lock().unwrap() = SlotState::Ready(Arc::new(FailedVoice));
        let status = rt.engine_status(&rt.tts, "health-voice", Kind::Tts);
        assert_eq!(status.state, "failed"); assert!(!status.available);
        rt.unload_idle();
        assert!(!rt.engine_status(&rt.tts, "health-voice", Kind::Tts).available, "idle unloading must not erase the failed route state");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A tiny OpenAI-compatible speech recognition server that can be switched between
    /// healthy, dropping every connection (as if it went away) and rejecting requests.
    struct FlakyServer {
        address: std::net::SocketAddr,
        mode: Arc<std::sync::atomic::AtomicU8>,
        stop: Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    const UP: u8 = 0;
    const DOWN: u8 = 1;
    const BAD_REQUEST: u8 = 2;
    impl FlakyServer {
        fn start() -> Self {
            use std::io::{Read, Write};
            use std::sync::atomic::Ordering;
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let mode = Arc::new(std::sync::atomic::AtomicU8::new(UP));
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let (m, st) = (mode.clone(), stop.clone());
            let thread = std::thread::spawn(move || {
                for socket in listener.incoming() {
                    if st.load(Ordering::SeqCst) { break; }
                    let Ok(mut socket) = socket else { continue };
                    if m.load(Ordering::SeqCst) == DOWN {
                        drop(socket); // closed before any response
                        continue;
                    }
                    socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                    // Read the whole request (headers, then Content-Length bytes).
                    let mut data = Vec::new();
                    let mut buf = [0u8; 8192];
                    let header_end = loop {
                        let n = socket.read(&mut buf).unwrap_or(0);
                        if n == 0 { break None; }
                        data.extend_from_slice(&buf[..n]);
                        if let Some(i) = data.windows(4).position(|w| w == b"\r\n\r\n") { break Some(i + 4); }
                    };
                    let Some(header_end) = header_end else { continue };
                    let head = String::from_utf8_lossy(&data[..header_end]).to_lowercase();
                    let length = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
                    while data.len() < header_end + length {
                        let n = socket.read(&mut buf).unwrap_or(0);
                        if n == 0 { break; }
                        data.extend_from_slice(&buf[..n]);
                    }
                    let (status, body) = match (m.load(Ordering::SeqCst), head.starts_with("get")) {
                        (_, true) => ("200 OK", r#"{"data":[]}"#),
                        (BAD_REQUEST, false) => ("400 Bad Request", r#"{"error":{"message":"audio too short"}}"#),
                        _ => ("200 OK", r#"{"text":"remote works"}"#),
                    };
                    let _ = write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                }
            });
            Self { address, mode, stop, thread: Some(thread) }
        }
        fn set(&self, mode: u8) { self.mode.store(mode, std::sync::atomic::Ordering::SeqCst); }
    }
    impl Drop for FlakyServer {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
            let _ = std::net::TcpStream::connect(self.address);
            if let Some(t) = self.thread.take() { let _ = t.join(); }
        }
    }

    #[test]
    fn remote_recognizer_going_away_falls_back_and_recovers_but_bad_requests_do_not() {
        let server = FlakyServer::start();
        let host = tokio::runtime::Runtime::new().unwrap();
        let folder = std::env::temp_dir().join(format!("vk-remote-flaky-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("catalog.json");
        std::fs::write(&file, json!({ "models": [{ "id": "custom-remote-asr", "kind": "stt", "label": "Remote", "engine": "openai",
            "remote": { "base_url": format!("http://{}/v1", server.address), "model": "fixture" } }] }).to_string()).unwrap();
        let mut settings = crate::default_settings();
        settings.stt_models = vec!["custom-remote-asr".into()];
        let rt = Runtime::new(Catalog::load(&[file]).unwrap(), Store { models_dir: folder.join("models"), reuse_dirs: vec![], shared_models_dir: None, paseo_managed: false }, settings, host.handle().clone());
        let audio = crate::audio::Pcm { samples: vec![0.1; 1600], sample_rate: 16_000 };
        let transcribe = || rt.with_stt("custom-remote-asr", &mut crate::engine::Timings::default(), |engine, t| {
            engine.transcribe(crate::engine::TranscribeRequest { audio: &audio, language: None, prompt: None }, t)
        });
        let status = || rt.status()["stt"][0].clone();

        assert_eq!(transcribe().unwrap(), "remote works");
        assert_eq!(status()["available"], true);

        // A request the server rejects is that request's problem: the model stays in use.
        server.set(BAD_REQUEST);
        assert!(transcribe().is_err());
        assert_eq!(status()["available"], true, "one rejected request must not take the model offline");

        // The server goes away: the model is reported unavailable, so the plugin falls back.
        server.set(DOWN);
        let err = transcribe().unwrap_err();
        assert!(crate::engine::is_unavailable(&err), "{err:#}");
        assert_eq!(status()["state"], "failed");
        assert_eq!(status()["available"], false);
        assert!(status()["error"].as_str().unwrap().contains("cannot reach"));
        // Within the retry delay requests fail fast and nothing reconnects.
        assert!(transcribe().is_err());
        rt.retry_failed();
        assert_eq!(status()["available"], false);

        // While still down, a due retry fails and the next one waits longer (bounded backoff).
        let age = |secs: u64| {
            if let SlotState::Failed { at, .. } = &mut *rt.stt["custom-remote-asr"].state.lock().unwrap() {
                *at = Instant::now() - Duration::from_secs(secs);
            }
        };
        age(31);
        rt.retry_failed();
        assert_eq!(status()["available"], false);
        age(31);
        assert!(!rt.stt["custom-remote-asr"].retry_due(), "repeated failures back off beyond 30 s");

        // The server is back: the background retry reconnects and the model is usable again.
        server.set(UP);
        age(240);
        rt.retry_failed();
        assert_eq!(status()["available"], true, "{}", status());
        assert_eq!(transcribe().unwrap(), "remote works");
        assert_eq!(rt.stt["custom-remote-asr"].failures.load(std::sync::atomic::Ordering::SeqCst), 0);
        drop(server);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn voice_models_that_cannot_run_here_are_unavailable_and_do_not_mark_the_chain_ready() {
        let host = tokio::runtime::Runtime::new().unwrap();
        let folder = std::env::temp_dir().join(format!("vk-unrunnable-{}", std::process::id()));
        let weights = folder.join("mlx");
        std::fs::create_dir_all(&weights).unwrap();
        std::fs::write(weights.join("config.json"), r#"{"model_type":"qwen3_tts","tts_model_type":"custom_voice"}"#).unwrap();
        let persona = |ids: &[&str]| json!([{ "id": "p", "label": "P", "gender": "female", "voices": ids.iter().map(|id| (id.to_string(), json!("v"))).collect::<serde_json::Map<_, _>>() }]);
        let file = folder.join("catalog.json");
        std::fs::write(&file, json!({ "models": [
            { "id": "custom-mlx", "kind": "tts", "label": "MLX", "engine": "mlx", "family": "qwen3_tts", "languages": ["en"],
              "path": weights.to_string_lossy(), "files": { "config": "config.json" } },
            { "id": "custom-remote-voice", "kind": "tts", "label": "Remote", "engine": "openai", "languages": ["de"],
              "remote": { "base_url": "http://127.0.0.1:9/v1", "model": "fixture" } },
            { "id": "only-mlx", "kind": "tts", "label": "chain", "engine": "chain", "options": { "chain": ["custom-mlx"], "personas": persona(&["custom-mlx"]) } },
            { "id": "mlx-and-remote", "kind": "tts", "label": "chain", "engine": "chain", "options": { "chain": ["custom-mlx", "custom-remote-voice"], "personas": persona(&["custom-mlx", "custom-remote-voice"]) } },
        ] }).to_string()).unwrap();
        let runtime = |tts: &str| {
            let mut settings = crate::default_settings();
            settings.stt_models.clear();
            settings.tts_model = tts.into();
            settings.accelerator = "cpu".into(); // MLX voices need the GPU
            settings.idle_unload = Some(Duration::ZERO);
            Runtime::new(Catalog::load(&[file.clone()]).unwrap(), Store { models_dir: folder.join("models"), reuse_dirs: vec![], shared_models_dir: None, paseo_managed: false }, settings, host.handle().clone())
        };

        // Only an MLX voice, with CPU only: the chain must not claim it can speak.
        let rt = runtime("only-mlx");
        let mlx = rt.catalog.find("custom-mlx").unwrap();
        assert!(rt.store.locate(mlx).is_some(), "fixture weights are installed");
        let reason = rt.unrunnable(mlx).expect("MLX can't run with CPU only");
        assert!(rt.missing_models().is_empty());
        for _ in 0..2 {
            let tts = rt.status()["tts"].clone();
            assert_eq!((tts["state"].as_str(), tts["available"].as_bool()), (Some("failed"), Some(false)), "{tts}");
            assert_eq!(tts["error"], reason.as_str());
            rt.tts().unwrap(); // loading the chain itself is lazy and starts no worker
        }
        let routes = rt.tts().unwrap().routes();
        assert_eq!((routes[0].installed, routes[0].available, routes[0].error.as_deref()), (true, Some(false), Some(reason.as_str())));
        let mut t = crate::engine::Timings::default();
        let err = rt.tts().unwrap().synthesize(crate::engine::SpeakRequest { text: "Hello there.", voice: "p", speed: 1.0, language: Some("en") }, &mut t).unwrap_err();
        assert_eq!(err.downcast_ref::<crate::engine::chain::RoutingError>().unwrap().code, "model_unavailable");
        rt.unload_idle();
        assert_eq!(rt.status()["tts"]["available"], false, "an unloaded chain must not look available either");

        // With another runnable voice the chain is available; only the MLX route is not.
        let rt = runtime("mlx-and-remote");
        let routes = rt.tts().unwrap().routes();
        assert_eq!(routes.iter().map(|r| r.available).collect::<Vec<_>>(), [Some(false), Some(true)]);
        assert_eq!(rt.status()["tts"]["available"], true, "{}", rt.status()["tts"]);
        std::fs::remove_dir_all(folder).unwrap();
    }
}
