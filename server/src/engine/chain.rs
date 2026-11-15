//! Ordered, native-language TTS candidates. Availability never silently drops source text.
use super::{
    route::{Persona, Route, RouteVoices},
    SpeakRequest, Timings, TtsEngine, Voice,
};
use crate::{audio::Pcm, lang};
use anyhow::Context;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Debug)]
pub struct RoutingError {
    pub code: &'static str,
    pub languages: Vec<String>,
}
impl std::fmt::Display for RoutingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.languages.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[derive(Clone, Copy, PartialEq)]
    enum Fail {
        No,
        /// The engine broke (a crash or timeout).
        Runtime,
        /// The engine rejected this input and keeps running.
        Request,
    }
    struct Recorder {
        id: &'static str,
        fail: Fail,
        calls: Arc<Mutex<Vec<String>>>,
    }
    impl TtsEngine for Recorder {
        fn synthesize(&self, req: SpeakRequest<'_>, _: &mut Timings) -> anyhow::Result<Pcm> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("{}:{}", self.id, req.language.unwrap_or("")));
            match self.fail {
                Fail::No => {}
                Fail::Runtime => anyhow::bail!("fixture failure"),
                Fail::Request => {
                    return Err(super::super::RequestFailure { code: Some("token_limit".into()), message: "fixture request failure".into() }.into())
                }
            }
            Ok(Pcm {
                samples: vec![0.1; 240],
                sample_rate: 24000,
            })
        }
        fn voices(&self) -> Vec<Voice> {
            vec![]
        }
        fn accelerator(&self) -> &str {
            "cpu"
        }
    }
    fn fixture(fail_first: bool) -> (ChainTts, Arc<Mutex<Vec<String>>>, Arc<AtomicUsize>) {
        fixture_failing(if fail_first { Fail::Runtime } else { Fail::No })
    }
    fn fixture_failing(first: Fail) -> (ChainTts, Arc<Mutex<Vec<String>>>, Arc<AtomicUsize>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let loads = Arc::new(AtomicUsize::new(0));
        let models = [
            ("super", vec!["en", "ja"], first),
            ("qwen", vec!["en", "ja", "zh"], Fail::No),
        ]
        .into_iter()
        .map(|(id, langs, fail)| {
            let (calls, loads) = (calls.clone(), loads.clone());
            Arc::new(Route::lazy(
                Box::new(move || {
                    loads.fetch_add(1, Ordering::SeqCst);
                    Some(Ok(Arc::new(Recorder {
                        id,
                        fail,
                        calls: calls.clone(),
                    })))
                }),
                id.into(),
                id.into(),
                langs.into_iter().map(str::to_string).collect(),
                None,
                vec![],
            ))
        })
        .collect();
        (
            ChainTts::new(
                models,
                vec![],
                BTreeMap::new(),
                BTreeMap::new(),
                BTreeSet::new(),
            ),
            calls,
            loads,
        )
    }
    fn speak(chain: &ChainTts, text: &str) -> anyhow::Result<Pcm> {
        chain.synthesize(
            SpeakRequest {
                text,
                voice: "default",
                speed: 1.0,
                language: None,
            },
            &mut Timings::default(),
        )
    }
    #[test]
    fn fixed_priority_lazy_reuse_and_independent_unload() {
        let (chain, calls, loads) = fixture(false);
        assert_eq!(loads.load(Ordering::SeqCst), 0);
        speak(&chain, "Hello.").unwrap();
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        speak(&chain, "你好。").unwrap();
        assert_eq!(loads.load(Ordering::SeqCst), 2);
        speak(&chain, "Hello.").unwrap();
        assert_eq!(loads.load(Ordering::SeqCst), 2);
        assert_eq!(*calls.lock().unwrap(), ["super:en", "qwen:zh", "super:en"]);
        std::thread::sleep(Duration::from_millis(15));
        speak(&chain, "Hello.").unwrap();
        chain.unload_idle(Duration::from_millis(10));
        assert!(chain.models[0].loaded_engine().is_some());
        assert!(chain.models[1].loaded_engine().is_none());
    }
    #[test]
    fn unsupported_mixed_reply_is_rejected_before_any_load() {
        let (chain, calls, loads) = fixture(false);
        let err = speak(&chain, "Hello. สวัสดีครับ").unwrap_err();
        assert_eq!(
            err.downcast_ref::<RoutingError>().unwrap().code,
            "unsupported_language"
        );
        assert_eq!(loads.load(Ordering::SeqCst), 0);
        assert!(calls.lock().unwrap().is_empty());
        assert!(chain.failure().is_none());
        assert_eq!(chain.last_error().unwrap()["languages"][0], "th");
    }
    #[test]
    fn synthesis_failure_falls_back_only_to_enabled_native_candidate() {
        let (chain, calls, loads) = fixture(true);
        speak(&chain, "Hello.").unwrap();
        assert_eq!(*calls.lock().unwrap(), ["super:en", "qwen:en"]);
        assert_eq!(loads.load(Ordering::SeqCst), 2);
        // One runtime failure is not a cooldown: the next request loads it again.
        speak(&chain, "Hello.").unwrap();
        assert_eq!(loads.load(Ordering::SeqCst), 3);
        // A second one in a row is: the failed candidate is skipped without loading.
        speak(&chain, "Hello.").unwrap();
        assert_eq!(loads.load(Ordering::SeqCst), 3, "failed candidate stays in cooldown");
        assert!(chain.models[0].retry_after().is_some());
        assert!(
            chain.failure().is_none(),
            "failures must not disable a healthy voice"
        );
    }
    #[test]
    fn per_model_voices_single_model_preview_and_run_report() {
        let (mut chain, calls, _) = fixture(false);
        chain.custom.insert("qwen".into(), "serena".into());
        speak(&chain, "Hello.").unwrap();
        assert_eq!(chain.last_runs().unwrap()[0]["model"], "super");
        speak(&chain, "你好。").unwrap();
        let runs = chain.last_runs().unwrap();
        assert_eq!(runs.as_array().unwrap().len(), 1, "each request reports only its own parts");
        assert_eq!(runs[0]["model"], "qwen");
        assert_eq!(runs[0]["voice"], "serena", "the model's own voice, whatever the request names");
        assert_eq!(runs[0]["language"], "zh");
        // A model's preview reads with that model only, even where another comes first.
        chain
            .synthesize_route("qwen", SpeakRequest { text: "Hello.", voice: "default", speed: 1.0, language: None }, &mut Timings::default())
            .unwrap();
        assert_eq!(calls.lock().unwrap().last().unwrap(), "qwen:en");
        assert_eq!(chain.last_runs().unwrap()[0]["model"], "qwen");
        assert!(chain
            .synthesize_route("missing", SpeakRequest { text: "Hello.", voice: "default", speed: 1.0, language: None }, &mut Timings::default())
            .is_err());
    }
    #[test]
    fn request_failure_falls_back_for_that_text_only() {
        let (chain, calls, loads) = fixture_failing(Fail::Request);
        speak(&chain, "Hello.").unwrap();
        speak(&chain, "Hello.").unwrap();
        assert_eq!(*calls.lock().unwrap(), ["super:en", "qwen:en", "super:en", "qwen:en"], "the model is tried again for the next request");
        assert_eq!(loads.load(Ordering::SeqCst), 2, "a request failure doesn't unload the model");
        assert!(chain.models[0].loaded_engine().is_some());
        assert!(chain.models[0].retry_after().is_none(), "nor start a cooldown");
    }
    #[test]
    fn disabled_qwen_does_not_supply_or_load_chinese() {
        let (mut chain, _, loads) = fixture(false);
        chain.models.pop();
        assert!(speak(&chain, "你好。").is_err());
        assert_eq!(loads.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn language_override_and_explicit_approximation() {
        let (mut chain, calls, _) = fixture(false);
        chain.preferred.insert("en".into(), "qwen".into());
        speak(&chain, "Hello.").unwrap();
        assert_eq!(calls.lock().unwrap()[0], "qwen:en");
        assert!(
            speak(&chain, "שלום").is_err(),
            "unknown script must not be spoken as English"
        );
    }
    /// `[(id, native languages, fails)]` in list order, with Catalan reading allowed as Spanish.
    fn approximating(models: &[(&'static str, &[&str], bool)]) -> (ChainTts, Arc<Mutex<Vec<String>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let routes = models
            .iter()
            .map(|&(id, langs, fail)| {
                let calls = calls.clone();
                Arc::new(Route::lazy(
                    Box::new(move || Some(Ok(Arc::new(Recorder { id, fail: if fail { Fail::Runtime } else { Fail::No }, calls: calls.clone() })))),
                    id.into(),
                    id.into(),
                    langs.iter().map(|l| l.to_string()).collect(),
                    None,
                    vec![],
                ))
            })
            .collect();
        let chain = ChainTts::new(routes, vec![], BTreeMap::new(), BTreeMap::new(), ["ca".to_string()].into_iter().collect());
        (chain, calls)
    }
    fn speak_as(chain: &ChainTts, text: &str, language: &str) -> anyhow::Result<Pcm> {
        chain.synthesize(SpeakRequest { text, voice: "default", speed: 1.0, language: Some(language) }, &mut Timings::default())
    }
    #[test]
    fn native_voice_wins_over_an_allowed_approximation_regardless_of_list_order() {
        // Spanish is listed first and may read Catalan approximately; the Catalan voice is native.
        let (mut chain, calls) = approximating(&[("es-voice", &["es"], false), ("ca-voice", &["ca"], false)]);
        speak_as(&chain, "123.", "ca").unwrap();
        assert_eq!(*calls.lock().unwrap(), ["ca-voice:ca"]);
        // A per-language choice of the approximate model does not outrank a native voice either.
        chain.preferred.insert("ca".into(), "es-voice".into());
        speak_as(&chain, "456.", "ca").unwrap();
        assert_eq!(calls.lock().unwrap()[1], "ca-voice:ca");
        // Spanish itself is unaffected.
        speak_as(&chain, "789.", "es").unwrap();
        assert_eq!(calls.lock().unwrap()[2], "es-voice:es");
    }
    #[test]
    fn approximation_is_used_only_when_no_native_voice_can_speak() {
        // Without a native voice, the allowed approximation reads Catalan as Spanish.
        let (chain, calls) = approximating(&[("es-voice", &["es"], false)]);
        speak_as(&chain, "123.", "ca").unwrap();
        assert_eq!(*calls.lock().unwrap(), ["es-voice:es"]);
        // When the native voice fails, the approximation is the fallback, after it.
        let (chain, calls) = approximating(&[("es-voice", &["es"], false), ("ca-voice", &["ca"], true)]);
        speak_as(&chain, "123.", "ca").unwrap();
        assert_eq!(*calls.lock().unwrap(), ["ca-voice:ca", "es-voice:es"]);
    }
}
impl std::error::Error for RoutingError {}

pub struct ChainTts {
    pub models: Vec<Arc<Route>>,
    personas: Vec<Persona>,
    preferred: BTreeMap<String, String>,
    custom: BTreeMap<String, String>,
    approximate: BTreeSet<String>,
    last_error: Mutex<Option<Value>>,
    last_runs: Mutex<Vec<Value>>,
}
impl ChainTts {
    pub fn new(
        models: Vec<Arc<Route>>,
        personas: Vec<Persona>,
        preferred: BTreeMap<String, String>,
        custom: BTreeMap<String, String>,
        approximate: BTreeSet<String>,
    ) -> Self {
        Self {
            models,
            personas,
            preferred,
            custom,
            approximate,
            last_error: Mutex::new(None),
            last_runs: Mutex::new(Vec::new()),
        }
    }
    fn language<'a>(&self, route: &Route, language: &'a str) -> Option<&'a str> {
        if route
            .languages
            .iter()
            .any(|l| l == language || l == "multi")
        {
            return Some(language);
        }
        if !self.approximate.contains(language) {
            return None;
        }
        let alias = match language {
            "ca" => "es",
            "tl" | "sw" | "ms" => "id",
            _ => return None,
        };
        route.languages.iter().any(|l| l == alias).then_some(alias)
    }
    /// Models that can speak `language`: every model that speaks it natively first, in list
    /// order, then (only for languages the user allows) models that read it approximately.
    /// The per-language choice moves to the front of its group, so it never puts an
    /// approximate reading ahead of a native voice.
    fn candidates(&self, language: &str) -> Vec<usize> {
        let native = |r: &Route| r.languages.iter().any(|l| l == language || l == "multi");
        let (mut native_models, mut approximate): (Vec<usize>, Vec<usize>) = self
            .models
            .iter()
            .enumerate()
            .filter(|(_, r)| self.language(r, language).is_some())
            .map(|(i, _)| i)
            .partition(|i| native(&self.models[*i]));
        if let Some(model) = self.preferred.get(language) {
            for group in [&mut native_models, &mut approximate] {
                if let Some(p) = group.iter().position(|i| self.models[*i].model == *model) {
                    let i = group.remove(p);
                    group.insert(0, i);
                }
            }
        }
        native_models.extend(approximate);
        native_models
    }
    fn record_error(&self, code: &'static str, languages: Vec<String>) -> anyhow::Error {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        *self.last_error.lock().unwrap() = Some(json!({"code":code,"languages":languages,"at":at}));
        RoutingError { code, languages }.into()
    }
    /// The voice chosen for this model (`model_voices`), whatever the request names; otherwise a
    /// voice the request names that the model has, a persona from a hand-written catalog, or the
    /// model's default.
    fn voice(&self, route: &Route, requested: &str) -> String {
        if let Some(v) = self.custom.get(&route.model) {
            return v.clone();
        }
        if route.catalog_voices.iter().any(|v| v.id == requested) {
            return requested.into();
        }
        if let Some(persona) = self
            .personas
            .iter()
            .find(|p| p.id == requested)
            .or_else(|| self.personas.first())
        {
            if let Some(v) = persona.voices.get(&route.model) {
                return v.clone();
            }
        }
        route
            .shared_voice
            .clone()
            .or_else(|| route.catalog_voices.first().map(|v| v.id.clone()))
            .unwrap_or_default()
    }
}
impl TtsEngine for ChainTts {
    fn synthesize_route(&self, model: &str, req: SpeakRequest<'_>, timings: &mut Timings) -> anyhow::Result<Pcm> {
        let route = self.models.iter().find(|r| r.model == model).context("this voice model isn't enabled")?;
        if let Some(reason) = route.unrunnable() {
            anyhow::bail!("{reason}");
        }
        let engine = route.engine().context("this voice model isn't available right now")?;
        // A preview reads with the voice picked on screen when the model has it, before the
        // choice is saved.
        let known = |id: &str| engine.voices().iter().any(|v| v.id == id) || route.catalog_voices.iter().any(|v| v.id == id);
        let voice = if known(req.voice) { req.voice.to_string() } else { self.voice(route, req.voice) };
        // As for a voice list request: the request's language, else the detected one, else English
        // for plain ASCII text.
        let language = req.language.map(str::to_string)
            .or_else(|| lang::runs(req.text).into_iter().find_map(|r| r.lang.map(str::to_string)))
            .or_else(|| req.text.is_ascii().then(|| "en".to_string()));
        let pcm = engine.synthesize(SpeakRequest { text: req.text, voice: &voice, language: language.as_deref().and_then(|l| self.language(route, l)), speed: req.speed }, timings)?;
        route.succeeded();
        *self.last_runs.lock().unwrap() = vec![json!({"model": route.model, "voice": voice, "language": language})];
        Ok(pcm)
    }
    fn last_runs(&self) -> Option<Value> {
        Some(Value::Array(self.last_runs.lock().unwrap().clone()))
    }
    fn synthesize(&self, req: SpeakRequest<'_>, timings: &mut Timings) -> anyhow::Result<Pcm> {
        self.last_runs.lock().unwrap().clear();
        let runs = lang::runs(req.text);
        let languages: Vec<_> = runs
            .iter()
            .map(|r| {
                r.lang
                    .or(req.language)
                    .unwrap_or_else(|| {
                        if r.text
                            .chars()
                            .filter(|c| c.is_alphabetic())
                            .all(|c| c.is_ascii())
                        {
                            "en"
                        } else {
                            "und"
                        }
                    })
                    .to_string()
            })
            .collect();
        let missing: BTreeSet<_> = runs
            .iter()
            .zip(&languages)
            .filter(|(r, l)| {
                r.text.chars().any(char::is_alphanumeric) && self.candidates(l).is_empty()
            })
            .map(|(_, l)| l.clone())
            .collect();
        if !missing.is_empty() {
            return Err(self.record_error("unsupported_language", missing.into_iter().collect()));
        }
        let mut selected = BTreeMap::<String, usize>::new();
        let mut rejected = BTreeSet::new();
        let mut samples = Vec::new();
        for (run, language) in runs.iter().zip(&languages) {
            if !run.text.chars().any(char::is_alphanumeric) {
                continue;
            }
            let mut candidates = self.candidates(language);
            if let Some(i) = selected.get(language) {
                candidates.retain(|v| v != i);
                candidates.insert(0, *i);
            }
            let mut output = None;
            for i in candidates {
                // Every engine bounds its own work, so there is no overall cutoff that would drop
                // the audio already made for earlier sentences.
                if rejected.contains(&i) {
                    continue;
                }
                let route = &self.models[i];
                // Can't run here as configured (e.g. MLX with CPU only): skip without
                // recording a failure; its status already says why.
                if route.unrunnable().is_some() {
                    continue;
                }
                let Some(engine) = route.engine() else {
                    continue;
                };
                let voice = self.voice(route, req.voice);
                match engine.synthesize(
                    SpeakRequest {
                        text: &run.text,
                        voice: &voice,
                        language: self.language(route, language),
                        speed: req.speed,
                    },
                    timings,
                ) {
                    Ok(pcm) => {
                        route.succeeded();
                        self.last_runs.lock().unwrap().push(json!({"model": route.model, "voice": voice, "language": language}));
                        selected.insert(language.clone(), i);
                        output = Some(pcm);
                        break;
                    }
                    Err(error) if super::is_request_failure(&error) => {
                        // Only this text failed: the model stays loaded for the next sentence.
                        tracing::warn!(model=route.model,error=%error,"voice candidate failed this sentence; trying next enabled model");
                    }
                    Err(error) => {
                        tracing::warn!(model=route.model,error=%error,"voice candidate failed; trying next enabled model");
                        route.failed();
                        rejected.insert(i);
                    }
                }
            }
            let Some(pcm) = output else {
                return Err(self.record_error("model_unavailable", vec![language.clone()]));
            };
            if !samples.is_empty() {
                samples.extend(std::iter::repeat_n(0.0, 2400));
            }
            samples.extend(pcm.resample(24000).samples);
            anyhow::ensure!(
                samples.len() <= 24000 * 600,
                "speech exceeds ten-minute output limit"
            );
        }
        *self.last_error.lock().unwrap() = None;
        Ok(Pcm {
            samples,
            sample_rate: 24000,
        })
    }
    fn voices(&self) -> Vec<Voice> {
        self.personas
            .iter()
            .map(|p| Voice {
                id: p.id.clone(),
                label: p.label.clone(),
                language: "multi".into(),
                gender: p.gender.clone(),
                featured: true,
            })
            .collect()
    }
    fn routes(&self) -> Vec<RouteVoices> {
        self.models
            .iter()
            .map(|r| {
                let loaded = r.loaded_engine();
                let retry = r.retry_after();
                let unrunnable = r.unrunnable();
                RouteVoices {
                    route: r.model.clone(),
                    model: r.model.clone(),
                    label: r.label.clone(),
                    voices: loaded
                        .as_ref()
                        .map_or_else(|| r.catalog_voices.clone(), |e| e.voices()),
                    persona_voices: self
                        .personas
                        .iter()
                        .filter_map(|p| p.voices.get(&r.model).map(|v| (p.id.clone(), v.clone())))
                        .collect(),
                    shared_voice: r.shared_voice.clone(),
                    ready: loaded.as_ref().is_some_and(|e| e.accelerator() != "idle"),
                    accelerator: loaded.as_ref().map(|e| e.accelerator().to_string()),
                    installed: r.installed(),
                    languages: Some(r.languages.clone()),
                    available: Some(r.installed() && unrunnable.is_none() && retry.is_none()),
                    error: unrunnable.or_else(|| retry.map(|_| "Voice model is cooling down after a failure".into())),
                    retry_after_seconds: retry,
                }
            })
            .collect()
    }
    fn accelerator(&self) -> &str {
        let devices: BTreeSet<_> = self
            .models
            .iter()
            .filter_map(|r| r.loaded_engine().map(|e| e.accelerator().to_string()))
            .filter(|d| d != "idle")
            .collect();
        if devices.len() > 1 {
            "mixed"
        } else {
            match devices.first().map(String::as_str) {
                Some("metal") => "metal",
                Some("cuda") => "cuda",
                Some("vulkan") => "vulkan",
                Some("cpu") => "cpu",
                _ => "idle",
            }
        }
    }
    fn unload_idle(&self, after: Duration) {
        for r in &self.models {
            r.unload_idle(after);
        }
    }
    /// The chain can't speak at all: every installed model that can run here is cooling down
    /// after a failure, or no enabled model can run here and none is still to be downloaded.
    /// Models that are merely missing or downloading are reported by the runtime instead.
    fn failure(&self) -> Option<String> {
        if self.models.is_empty() {
            return None;
        }
        let usable: Vec<_> = self.models.iter().filter(|r| r.usable()).collect();
        if usable.is_empty() {
            let pending = self.models.iter().any(|r| !r.installed() && r.unrunnable().is_none());
            return if pending { None } else { self.models.iter().find_map(|r| r.unrunnable()) };
        }
        usable.iter().all(|r| r.retry_after().is_some()).then(|| "All enabled voice models failed".into())
    }
    fn last_error(&self) -> Option<Value> {
        self.last_error.lock().unwrap().clone()
    }
    fn model_downloaded(&self, id: &str) {
        for r in self.models.iter().filter(|r| r.model == id) {
            r.succeeded();
        }
    }
    fn retry_failed(&self) {
        for r in self
            .models
            .iter()
            .filter(|r| r.retry_after() == Some(0) && r.usable())
        {
            if r.engine().is_some() {
                r.succeeded();
            }
        }
    }
}
