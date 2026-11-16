//! OpenAI-compatible HTTP surface plus voicekit management routes.

use std::{
    path::PathBuf,
    sync::{atomic::AtomicU64, Arc},
    time::Instant,
};

use axum::{
    body::Body,
    extract::{
        multipart::MultipartRejection,
        rejection::JsonRejection,
        DefaultBodyLimit, Multipart, Path, Request, State,
    },
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;

use crate::{
    audio,
    engine::{SpeakRequest, Timings, TranscribeRequest},
    runtime::Runtime,
};

/// Below this peak amplitude we treat the clip as silence and skip inference (Whisper
/// hallucinates on silence).
const SILENCE_PEAK: f32 = 0.008;

pub struct AppState {
    pub runtime: Arc<Runtime>,
    pub token: String,
    pub capture_dir: Option<PathBuf>,
    seq: AtomicU64,
}

impl AppState {
    pub fn new(runtime: Arc<Runtime>, token: String, capture_dir: Option<PathBuf>) -> Self {
        Self { runtime, token, capture_dir, seq: AtomicU64::new(0) }
    }

    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    fn capture(&self, name: &str, bytes: &[u8]) {
        if let Some(dir) = &self.capture_dir {
            if let Err(err) = std::fs::write(dir.join(name), bytes) {
                tracing::warn!(%err, "capture write failed");
            }
        }
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    let authed = Router::new()
        .route("/v1/models", get(list_models))
        .route("/v1/audio/transcriptions", post(transcriptions))
        .route("/v1/audio/speech", post(speech))
        .route("/voicekit/status", get(status))
        .route("/voicekit/models", get(catalog))
        .route("/voicekit/voices", get(voices))
        .route("/voicekit/pull", post(pull))
        .route("/voicekit/models/{id}", delete(remove_model))
        .layer(middleware::from_fn_with_state(state.clone(), auth));

    Router::new()
        .route("/health", get(health))
        .merge(authed)
        // Before the layers, so unknown routes get the loopback check and error shape too.
        .fallback(fallback)
        .layer(middleware::from_fn(loopback_host))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(state)
}

/// Only answer requests addressed to a loopback host. A web page that rebinds its own domain
/// to 127.0.0.1 sends its domain in `Host`, so it is refused before any handler runs.
async fn loopback_host(req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    let name = host.rsplit_once(':').map_or(host, |(name, _)| name);
    if !matches!(name, "127.0.0.1" | "localhost" | "[::1]") {
        return api_error(StatusCode::MISDIRECTED_REQUEST, "invalid_host", "voicekit only serves loopback hosts");
    }
    next.run(req).await
}

async fn auth(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let ok = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|t| constant_time_eq(t.as_bytes(), state.token.as_bytes()));
    if !ok {
        return api_error(StatusCode::UNAUTHORIZED, "invalid_api_key", "Missing or invalid bearer token");
    }
    next.run(req).await
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn fallback(req: Request) -> Response {
    tracing::warn!(method = %req.method(), path = %req.uri().path(), "unknown route");
    api_error(StatusCode::NOT_FOUND, "not_found", "Unknown route")
}

/// Unauthenticated liveness + readiness summary (no model paths or settings).
/// Unauthenticated liveness probe. Reveals nothing beyond up/down; details need the token.
async fn health(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(json!({ "status": state.runtime.status()["status"] }))
}

async fn status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(state.runtime.status())
}

async fn catalog(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(state.runtime.models_json())
}

async fn list_models(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let r = &state.runtime.settings;
    Json(json!({
        "object": "list",
        "data": r.stt_models.iter().chain(std::iter::once(&r.tts_model))
            .map(|id| json!({ "id": id, "object": "model", "owned_by": "voicekit" }))
            .collect::<Vec<_>>(),
    }))
}

async fn voices(State(state): State<Arc<AppState>>) -> Response {
    let runtime = state.runtime.clone();
    match tokio::task::spawn_blocking(move || runtime.tts_voices()).await {
        Ok(Ok((voices, routes))) => Json(json!({ "voices": voices, "routes": routes, "default": state.runtime.settings.default_voice })).into_response(),
        Ok(Err(err)) => api_error(StatusCode::SERVICE_UNAVAILABLE, "engine_unavailable", &format!("{err:#}")),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", &err.to_string()),
    }
}

#[derive(Deserialize)]
struct PullBody {
    id: String,
}

async fn pull(State(state): State<Arc<AppState>>, body: Result<Json<PullBody>, JsonRejection>) -> Response {
    // Malformed requests get the same OpenAI error shape as every other error.
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection) => return api_error(rejection.status(), "invalid_request", &rejection.body_text()),
    };
    let Some(entry) = state.runtime.catalog.find(&body.id).cloned() else {
        return api_error(StatusCode::NOT_FOUND, "unknown_model", "Unknown model id");
    };
    // A voice list's models that can't run here (e.g. MLX with CPU only) aren't fetched.
    let entries: Vec<_> = state.runtime.with_dependencies(&entry).into_iter()
        .filter(|e| e.engine != crate::catalog::Engine::Chain && state.runtime.unrunnable(e).is_none()).cloned().collect();
    if state.runtime.installed(&entry) && entries.iter().all(|e| state.runtime.store.locate(e).is_some()) {
        let runtime = state.runtime.clone();
        let id = entry.id.clone();
        tokio::task::spawn_blocking(move || runtime.recover_downloaded(&id));
        return Json(json!({ "id": entry.id, "state": "installed" })).into_response();
    }
    if state.runtime.store.paseo_model(&entry).is_some() {
        return api_error(StatusCode::CONFLICT, "paseo_model_manager", "Shared model downloads use Paseo's model manager");
    }
    if entries.iter().any(|e| state.runtime.store.locate(e).is_none() && e.download.is_empty()) {
        return api_error(StatusCode::BAD_REQUEST, "not_downloadable", "This model has no download source");
    }
    let missing: Vec<_> = entries.iter().filter(|e| state.runtime.store.locate(e).is_none()).collect();
    if state.runtime.downloads.is_active(&entry.id) || (!missing.is_empty() && missing.iter().all(|e| state.runtime.downloads.is_active(&e.id))) {
        return Json(json!({ "id": entry.id, "state": "downloading" })).into_response();
    }
    let runtime = state.runtime.clone();
    let id = entry.id.clone();
    tokio::spawn(async move {
        for leaf in entries {
            if runtime.downloads.is_active(&leaf.id) { continue; }
            if let Err(err) = runtime.downloads.ensure(&runtime.store, &leaf).await {
                tracing::error!(model = leaf.id, error = %format!("{err:#}"), "download failed");
                continue;
            }
            let (rt, id) = (runtime.clone(), leaf.id.clone());
            let _ = tokio::task::spawn_blocking(move || rt.recover_downloaded(&id)).await;
        }
    });
    (StatusCode::ACCEPTED, Json(json!({ "id": id, "state": "downloading" }))).into_response()
}

async fn remove_model(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let Some(entry) = state.runtime.catalog.find(&id) else {
        return api_error(StatusCode::NOT_FOUND, "unknown_model", "Unknown model id");
    };
    if state.runtime.in_use(&id) {
        return api_error(StatusCode::CONFLICT, "model_in_use", "Model is in use (directly or by another model); switch models first");
    }
    if state.runtime.store.paseo_model(entry).is_some() {
        return api_error(StatusCode::CONFLICT, "paseo_model_manager", "Shared model removal uses Paseo's model manager");
    }
    // A download still writing into the folder would recreate it.
    if state.runtime.downloads.is_active(&entry.id) {
        return api_error(StatusCode::CONFLICT, "download_in_progress", "The model is downloading; wait for it to finish or fail, then remove it");
    }
    // Only ever delete our own downloads; Paseo's models and user paths are left alone.
    let target = state.runtime.store.own_dir(entry);
    if entry.path.is_some() || !target.starts_with(&state.runtime.store.models_dir) || !target.exists() {
        return api_error(StatusCode::NOT_FOUND, "not_installed", "Model is not installed in the voicekit models dir");
    }
    match tokio::fs::remove_dir_all(&target).await {
        Ok(()) => {
            state.runtime.downloads.clear(&entry.id);
            crate::download::clean_partials(&state.runtime.store.models_dir, &entry.id).await;
            Json(json!({ "id": entry.id, "removed": true })).into_response()
        }
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "remove_failed", &err.to_string()),
    }
}

/// Audio that can't be decoded: the request's fault, not the engine's.
#[derive(Debug)]
struct BadAudio(String);
impl std::fmt::Display for BadAudio {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.0) }
}
impl std::error::Error for BadAudio {}

async fn transcriptions(State(state): State<Arc<AppState>>, multipart: Result<Multipart, MultipartRejection>) -> Response {
    let mut multipart = match multipart {
        Ok(multipart) => multipart,
        Err(rejection) => return api_error(rejection.status(), "invalid_request", &rejection.body_text()),
    };
    let seq = state.next_seq();
    let started = Instant::now();
    let mut file: Option<(Option<String>, bytes::Bytes)> = None;
    let mut fields = serde_json::Map::new();

    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                let name = field.name().unwrap_or_default().to_string();
                if name == "file" {
                    let file_name = field.file_name().map(str::to_string);
                    match field.bytes().await {
                        Ok(bytes) => file = Some((file_name, bytes)),
                        Err(err) => return api_error(StatusCode::BAD_REQUEST, "invalid_request", &err.to_string()),
                    }
                } else {
                    fields.insert(name, json!(field.text().await.unwrap_or_default()));
                }
            }
            Ok(None) => break,
            Err(err) => return api_error(StatusCode::BAD_REQUEST, "invalid_request", &err.to_string()),
        }
    }
    let Some((file_name, bytes)) = file else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request", "Missing 'file' field");
    };
    let ext = file_name.as_deref().and_then(|n| n.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()));
    if state.capture_dir.is_some() {
        state.capture(&format!("stt-{seq:04}.{}", ext.as_deref().unwrap_or("bin")), &bytes);
        state.capture(&format!("stt-{seq:04}.json"), &serde_json::to_vec_pretty(&fields).unwrap_or_default());
    }

    let field = |k: &str| fields.get(k).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let settings = &state.runtime.settings;
    let language = match settings.language.as_str() {
        "auto" => None,
        "request" => field("language"),
        fixed => Some(fixed.to_string()),
    };
    let prompt = settings
        .stt_prompt
        .clone()
        .or_else(|| if settings.honor_request_prompt { field("prompt") } else { None });
    let response_format = field("response_format").unwrap_or_else(|| "json".into());
    let model = state.runtime.resolve_stt_model(field("model").as_deref());

    let runtime = state.runtime.clone();
    let model_for_task = model.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<(String, f32, Timings)> {
        let mut t = Timings::default();
        let decoded = t.time("decode", || audio::decode_any(&bytes, ext.as_deref())).map_err(|e| BadAudio(format!("Could not decode the audio: {e:#}")))?;
        let pcm = t.time("resample", || decoded.resample(16_000));
        let secs = pcm.duration_secs();
        if pcm.peak() < SILENCE_PEAK {
            // Silence needs no inference, but only a model that could answer may say so.
            let ready = runtime.catalog.find(&model_for_task).is_some_and(|entry| runtime.installed(entry));
            anyhow::ensure!(ready, "speech recognition model {model_for_task} is not installed");
            return Ok((String::new(), secs, t));
        }
        let text = runtime.with_stt(&model_for_task, &mut t, |engine, t| {
            let req = TranscribeRequest { audio: &pcm, language: language.as_deref(), prompt: prompt.as_deref() };
            let started = Instant::now();
            let text = engine.transcribe(req, t);
            t.push("inference", started.elapsed().as_secs_f64() * 1000.0);
            text
        })?;
        Ok((text, secs, t))
    })
    .await;

    let (text, secs, timings) = match result {
        Ok(Ok(v)) => v,
        Ok(Err(err)) if err.downcast_ref::<BadAudio>().is_some() => return api_error(StatusCode::BAD_REQUEST, "invalid_audio", &err.to_string()),
        Ok(Err(err)) => return api_error(StatusCode::SERVICE_UNAVAILABLE, "engine_error", &format!("{err:#}")),
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", &err.to_string()),
    };
    let total = started.elapsed().as_secs_f64() * 1000.0;
    let stages = timings.summary();
    tracing::info!(seq, model, ms = total as u64, audio_secs = secs, chars = text.chars().count(), stages = %stages, "transcribed");

    let mut response = match response_format.as_str() {
        "text" => (StatusCode::OK, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], text).into_response(),
        "verbose_json" => Json(json!({ "task": "transcribe", "language": "auto", "duration": secs, "text": text, "segments": [] })).into_response(),
        _ => Json(json!({ "text": text })).into_response(),
    };
    add_timing_header(&mut response, total, &stages);
    response
}

#[derive(Debug, Deserialize)]
struct SpeechBody {
    input: String,
    voice: Option<String>,
    response_format: Option<String>,
    speed: Option<f32>,
    /// Extension: ISO 639-1 language of `input`. Optional; detected when absent.
    language: Option<String>,
    /// Extension: read the whole input with this one model of the voice list (its preview).
    voicekit_route: Option<String>,
}

/// OpenAI voice names do not exist in Kokoro; map them to the configured default voice.
const OPENAI_VOICES: &[&str] = &["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "default"];

async fn speech(State(state): State<Arc<AppState>>, body: axum::body::Bytes) -> Response {
    let seq = state.next_seq();
    let started = Instant::now();
    let req: SpeechBody = match serde_json::from_slice(&body) {
        Ok(req) => req,
        Err(err) => return api_error(StatusCode::BAD_REQUEST, "invalid_request", &err.to_string()),
    };
    if req.input.trim().is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request", "Input is empty");
    }
    if req.input.chars().count()>20_000 { return api_error(StatusCode::BAD_REQUEST,"input_too_long","Speech input exceeds 20000 characters"); }
    // OpenAI's default is mp3, which voicekit doesn't produce: say so instead of guessing.
    let Some(format) = req.response_format.clone() else {
        return api_error(StatusCode::BAD_REQUEST, "unsupported_response_format", "Set response_format to pcm or wav (mp3, the OpenAI default, isn't supported)");
    };
    if !matches!(format.as_str(), "pcm" | "wav") {
        return api_error(StatusCode::BAD_REQUEST, "unsupported_response_format", "Use response_format pcm or wav");
    }
    let voice = req
        .voice
        .clone()
        .filter(|v| !OPENAI_VOICES.contains(&v.as_str()))
        .unwrap_or_else(|| state.runtime.settings.default_voice.clone());
    let speed = req.speed.unwrap_or(state.runtime.settings.default_speed).clamp(0.5, 2.0);
    let chars = req.input.chars().count();

    let runtime = state.runtime.clone();
    let input = req.input;
    let language = req.language.clone();
    let route = req.voicekit_route.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<(f32, &'static str, Vec<u8>, Timings, Option<String>)> {
        let mut t = Timings::default();
        let mut runs = None;
        let pcm = runtime.with_tts(&mut t, |engine, t| {
            let started = Instant::now();
            let request = SpeakRequest { text: &input, voice: &voice, speed, language: language.as_deref() };
            let pcm = match &route {
                Some(model) => engine.synthesize_route(model, request, t),
                None => engine.synthesize(request, t),
            };
            t.push("inference", started.elapsed().as_secs_f64() * 1000.0);
            // Read within the engine lock, so it belongs to this request. Only ids and codes.
            runs = engine.last_runs().map(|r| r.to_string());
            pcm
        })?;
        // Outside the engine lock. OpenAI `pcm` is raw 24 kHz signed 16-bit little-endian mono.
        let started = Instant::now();
        // One output policy for every TTS engine, after sentence assembly and tempo.
        let pcm = pcm.trim_tts_edges();
        let (content_type, bytes) = match format.as_str() {
            "pcm" => ("audio/pcm", pcm.resample(24_000).to_s16le()),
            _ => ("audio/wav", pcm.to_wav()),
        };
        let output_ms = started.elapsed().as_secs_f64() * 1000.0;
        t.push("output", output_ms);
        runtime.record_tts_stage("output", output_ms);
        Ok((pcm.duration_secs(), content_type, bytes, t, runs))
    })
    .await;
    let (audio_secs, content_type, bytes, timings, runs) = match result {
        Ok(Ok(out)) => out,
        Ok(Err(err)) => {
            if let Some(routing)=err.downcast_ref::<crate::engine::chain::RoutingError>() {
                return api_error(if routing.code=="unsupported_language" {StatusCode::BAD_REQUEST} else {StatusCode::SERVICE_UNAVAILABLE},routing.code,&routing.to_string());
            }
            // A single voice model asked for a language it doesn't speak: the request's fault.
            let code = err.downcast_ref::<crate::engine::RequestFailure>().and_then(|f| f.code.as_deref());
            if code == Some("unsupported_language") {
                return api_error(StatusCode::BAD_REQUEST, "unsupported_language", &err.to_string());
            }
            // Other worker-reported causes (such as `token_limit`) keep their code.
            return api_error(StatusCode::SERVICE_UNAVAILABLE, code.unwrap_or("engine_error"), &format!("{err:#}"));
        }
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", &err.to_string()),
    };
    let total = started.elapsed().as_secs_f64() * 1000.0;
    let stages = timings.summary();
    tracing::info!(seq, ms = total as u64, chars, audio_secs, stages = %stages, "synthesized");
    let mut response = Response::builder().header(header::CONTENT_TYPE, content_type).body(Body::from(bytes)).unwrap();
    // Which model and voice read each part (for "Try a reply"); ASCII ids only.
    if let Some(runs) = runs.filter(|r| r.is_ascii()).and_then(|r| header::HeaderValue::from_str(&r).ok()) {
        response.headers_mut().insert("x-voicekit-runs", runs);
    }
    add_timing_header(&mut response, total, &stages);
    response
}

/// `x-voicekit-timing: total=812 decode=1 resample=2 queue=0 prepare=9 encoder=520 decoder=280`
/// (speech output: `load queue inference output`).
fn add_timing_header(response: &mut Response, total_ms: f64, stages: &str) {
    if let Ok(value) = header::HeaderValue::from_str(&format!("total={total_ms:.0} {stages}")) {
        response.headers_mut().insert("x-voicekit-timing", value);
    }
}

fn api_error(status: StatusCode, code: &str, message: &str) -> Response {
    tracing::warn!(status = status.as_u16(), code, message, "request failed");
    (status, Json(json!({ "error": { "message": message, "type": "invalid_request_error", "code": code } }))).into_response()
}
