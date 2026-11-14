//! Lazy, independently unloadable voice models used by the ordered TTS chain.
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, atomic::{AtomicU32, Ordering}},
    time::{Duration, Instant},
};

use serde::Serialize;

use super::{TtsEngine, Voice};

/// Loads an enabled model. None while its model is not installed (the loader starts
/// the download); Some(Err) when loading failed.
pub type LazyLoad = Box<dyn Fn() -> Option<anyhow::Result<Arc<dyn TtsEngine>>> + Send + Sync>;

/// One enabled model and its independently managed engine.
pub struct Route {
    /// Catalog identity and display label.
    pub model: String,
    pub label: String,
    /// Explicit native language codes.
    pub languages: Vec<String>,
    /// The voice every persona uses here (single-speaker models).
    pub shared_voice: Option<String>,
    /// Voices listed while the engine is not loaded (from the catalog).
    pub catalog_voices: Vec<Voice>,
    state: Arc<RouteState>,
    installed: Option<Box<dyn Fn() -> bool + Send + Sync>>,
    /// Why this model can't run with this build and settings (CPU only for an MLX model, a
    /// missing MLX runtime or GGUF worker). Checked live, so fixing the cause needs no restart.
    unrunnable: Option<Box<dyn Fn() -> Option<String> + Send + Sync>>,
}

struct RouteState {
    engine: Mutex<Option<Arc<dyn TtsEngine>>>,
    lazy: Option<LazyLoad>,
    failed_at: Mutex<Option<Instant>>,
    last_used: Mutex<Instant>,
    load: Mutex<()>,
    failures: AtomicU32,
}

/// After a failed lazy load, wait this long before trying again.
const RETRY_AFTER: Duration = Duration::from_secs(60);

impl Route {
    pub fn lazy(load: LazyLoad, model: String, label: String, languages: Vec<String>, shared_voice: Option<String>, catalog_voices: Vec<Voice>) -> Self {
        Self { model, label, languages, shared_voice, catalog_voices, installed: None, unrunnable: None, state: Arc::new(RouteState { engine: Mutex::new(None), lazy: Some(load), failed_at: Mutex::new(None), last_used: Mutex::new(Instant::now()), load: Mutex::new(()), failures: AtomicU32::new(0) }) }
    }

    pub fn with_installed(mut self, installed: Box<dyn Fn() -> bool + Send + Sync>) -> Self { self.installed = Some(installed); self }
    pub fn with_unrunnable(mut self, unrunnable: Box<dyn Fn() -> Option<String> + Send + Sync>) -> Self { self.unrunnable = Some(unrunnable); self }

    pub(crate) fn succeeded(&self) {
        // Start the idle interval after speech finishes, including a long generation.
        *self.state.last_used.lock().unwrap() = Instant::now();
        self.state.failures.store(0, Ordering::SeqCst);
        *self.state.failed_at.lock().unwrap() = None;
    }

    pub(crate) fn failed(&self) {
        self.state.engine.lock().unwrap().take();
        *self.state.failed_at.lock().unwrap() = Some(Instant::now());
        self.state.failures.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn unload_idle(&self, after: Duration) {
        // Loading/inference retains its own Arc; unloading never kills a model in use.
        let Ok(_load) = self.state.load.try_lock() else { return };
        let mut engine = self.state.engine.lock().unwrap();
        if self.state.last_used.lock().unwrap().elapsed() >= after && engine.as_ref().is_some_and(|e| Arc::strong_count(e) == 1) {
            engine.take();
            tracing::info!(model = self.model, "unloaded idle voice model");
        }
    }

    /// The engine, loading a model if it has been installed meanwhile.
    pub(crate) fn engine(&self) -> Option<Arc<dyn TtsEngine>> {
        let _loading = self.state.load.lock().unwrap();
        if self.loaded_engine().is_none() {
            let load = self.state.lazy.as_ref()?;
            let delay = RETRY_AFTER * 2u32.pow(self.state.failures.load(Ordering::SeqCst).saturating_sub(1).min(5));
            if self.state.failed_at.lock().unwrap().is_some_and(|at| at.elapsed() < delay) {
                return None;
            }
            let loaded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                load().map(|result| result.and_then(|engine| {
                    engine.prepare()?;
                    Ok(engine)
                }))
            }))
                .unwrap_or_else(|_| Some(Err(anyhow::anyhow!("voice model loader panicked"))));
            match loaded {
                Some(Ok(e)) => {
                    tracing::info!(model = self.model, "loaded voice model");
                    *self.state.engine.lock().unwrap() = Some(e);
                }
                Some(Err(err)) => {
                    tracing::warn!(model = self.model, error = %format!("{err:#}"), "voice model failed to load");
                    self.failed();
                }
                None => {}
            }
        }
        *self.state.last_used.lock().unwrap() = Instant::now();
        self.loaded_engine()
    }

    pub(crate) fn loaded_engine(&self) -> Option<Arc<dyn TtsEngine>> {
        self.state.engine.lock().unwrap().clone()
    }

    pub(crate) fn installed(&self) -> bool { self.installed.as_ref().map_or(true, |f| f()) }
    /// Some(reason) when this model can never load here as configured (not a transient failure).
    pub(crate) fn unrunnable(&self) -> Option<String> { self.unrunnable.as_ref().and_then(|f| f()) }
    /// Installed and able to run here; it may still be cooling down after a failure.
    pub(crate) fn usable(&self) -> bool { self.installed() && self.unrunnable().is_none() }
    pub(crate) fn retry_after(&self) -> Option<u64> {
        let delay = RETRY_AFTER * 2u32.pow(self.state.failures.load(Ordering::SeqCst).saturating_sub(1).min(5));
        self.state.failed_at.lock().unwrap().as_ref().map(|t| delay.saturating_sub(t.elapsed()).as_secs())
    }
}

#[derive(Debug, Clone)]
pub struct Persona {
    pub id: String,
    pub label: String,
    pub gender: String,
    /// Route key -> voice id in that route's model.
    pub voices: BTreeMap<String, String>,
}

/// One route's voices, for the "Custom" picker.
#[derive(Debug, Clone, Serialize)]
pub struct RouteVoices {
    pub route: String,
    pub label: String,
    pub model: String,
    pub voices: Vec<Voice>,
    /// Persona id -> this route's voice in that persona (to start a custom pairing from one).
    pub persona_voices: BTreeMap<String, String>,
    /// Set when every persona uses this one voice here (nothing to pick).
    pub shared_voice: Option<String>,
    /// Whether this model is loaded in memory.
    pub ready: bool,
    pub accelerator: Option<String>,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub languages: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "retryAfterSeconds")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
}


#[cfg(test)]
mod tests {
    use super::*;
    use super::super::{SpeakRequest, Timings};
    use crate::audio::Pcm;
    use std::sync::atomic::AtomicUsize;
    #[test]
    fn deferred_worker_must_start_before_route_recovery_clears_failure() {
        struct BrokenWorker;
        impl TtsEngine for BrokenWorker {
            fn prepare(&self) -> anyhow::Result<()> { anyhow::bail!("worker imports failed") }
            fn synthesize(&self, _: SpeakRequest<'_>, _: &mut Timings) -> anyhow::Result<Pcm> { unreachable!() }
            fn voices(&self) -> Vec<Voice> { vec![] }
            fn accelerator(&self) -> &str { "idle" }
        }
        let attempts = Arc::new(AtomicUsize::new(0));
        let loads = attempts.clone();
        let route = Route::lazy(Box::new(move || {
            loads.fetch_add(1, Ordering::SeqCst);
            Some(Ok(Arc::new(BrokenWorker)))
        }), "broken-mlx".into(), "fixture".into(), vec!["en".into()], None, vec![]);
        assert!(route.engine().is_none());
        assert!(route.retry_after().is_some());
        assert!(route.engine().is_none());
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        *route.state.failed_at.lock().unwrap() = Some(Instant::now() - Duration::from_secs(61));
        assert!(route.engine().is_none());
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(route.state.failures.load(Ordering::SeqCst), 2);
        assert!(route.loaded_engine().is_none());
        assert!(route.retry_after().unwrap() > 60, "failed worker startup must retain increasing backoff");
    }

}
