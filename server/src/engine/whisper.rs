//! whisper.cpp STT via whisper-rs. Metal on macOS; on Linux / Windows the first GPU device ggml
//! found (Vulkan in release builds), else the CPU.

use std::{path::Path, sync::Mutex};

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

use std::{ffi::c_void, os::raw::c_int, time::Instant};

use super::{SttEngine, Timings, TranscribeRequest};

/// Minimum probability for trusting the small model's language guess.
const LANGUAGE_CONFIDENCE: f32 = 0.7;

/// Timestamps from inside whisper.cpp, to split one `full()` call into stages:
/// - `prepare`: start until the first encoder pass (mel spectrogram, plus whisper.cpp's own
///   language detection when the small detector was not used);
/// - `encoder`: every 30 s window from its encoder start to its first logits, so it includes
///   that window's first decoder step;
/// - `decoder`: the rest.
///
/// whisper.cpp calls the logits callback from several threads at once during beam search, so
/// the callbacks only ever take a shared reference and lock.
#[derive(Default)]
struct Marks(Mutex<MarkState>);

#[derive(Default)]
struct MarkState {
    first_encoder: Option<Instant>,
    /// Encoder start of the window whose first logits have not arrived yet.
    pending_encoder: Option<Instant>,
    encode_total: std::time::Duration,
}

impl Marks {
    fn with(user_data: *mut c_void, f: impl FnOnce(&mut MarkState)) {
        // SAFETY: user_data points at a `Marks` that outlives the `full()` call that invokes the
        // callbacks; only shared references are formed, and the Mutex serializes access.
        let marks = unsafe { &*(user_data as *const Marks) };
        if let Ok(mut m) = marks.0.lock() {
            f(&mut m);
        }
    }
}

unsafe extern "C" fn on_encoder_begin(
    _ctx: *mut whisper_rs_sys::whisper_context,
    _state: *mut whisper_rs_sys::whisper_state,
    user_data: *mut c_void,
) -> bool {
    let now = Instant::now();
    Marks::with(user_data, |m| {
        m.first_encoder.get_or_insert(now);
        m.pending_encoder = Some(now);
    });
    true
}

unsafe extern "C" fn on_logits(
    _ctx: *mut whisper_rs_sys::whisper_context,
    _state: *mut whisper_rs_sys::whisper_state,
    _tokens: *const whisper_rs_sys::whisper_token_data,
    _n_tokens: c_int,
    _logits: *mut f32,
    user_data: *mut c_void,
) {
    let now = Instant::now();
    Marks::with(user_data, |m| {
        if let Some(start) = m.pending_encoder.take() {
            m.encode_total += now.saturating_duration_since(start);
        }
    });
}

/// A small Whisper model (base) used only to pick the language. whisper.cpp's own "auto" runs a
/// full extra encoder pass of the big model (about half of turbo's latency); base does it in
/// ~35 ms on Metal, then the big model decodes with the language fixed. Low-confidence results
/// fall back to the big model's own detection. A confident small-model guess can still be wrong.
struct LanguageDetector {
    state: Mutex<WhisperState>,
    _ctx: WhisperContext,
}

pub struct WhisperStt {
    /// One reusable decoder state: creating a state allocates GPU buffers, which is costly.
    state: Mutex<WhisperState>,
    _ctx: WhisperContext,
    detector: Option<LanguageDetector>,
    threads: i32,
    beam_size: i32,
    accelerator: String,
}

impl WhisperStt {
    /// `coreml`: a Neural Engine encoder sits next to the model and this build can use it
    /// (whisper.cpp picks it up by file name; it only changes the accelerator label here).
    pub fn load(model: &Path, detector_model: Option<&Path>, use_gpu: bool, threads: i32, beam_size: i32, coreml: bool) -> anyhow::Result<Self> {
        let hw = crate::ggml::hardware();
        // whisper.cpp throws (and aborts the process) when it finds no CPU backend.
        anyhow::ensure!(hw.has_cpu(), "the ggml CPU backend is missing next to the voicekit executable");
        // whisper.cpp offloads to the first GPU device when asked; label what it will use.
        let gpu_device = hw.gpu().filter(|_| use_gpu);
        let gpu = gpu_device.is_some();
        let mut params = WhisperContextParameters::default();
        params.use_gpu = gpu;
        params.flash_attn = gpu;
        let ctx = WhisperContext::new_with_params(model, params)
            .map_err(|e| anyhow::anyhow!("failed to load whisper model {}: {e}", model.display()))?;
        let accelerator = match gpu_device {
            None => "cpu".to_string(),
            Some(_) if coreml => "neural-engine".to_string(),
            // "metal", "vulkan", "cuda": the device's backend.
            Some(d) => d.backend.to_ascii_lowercase(),
        };
        let state = ctx.create_state().map_err(|e| anyhow::anyhow!("whisper state: {e}"))?;
        let detector = match detector_model {
            Some(path) => {
                let mut dp = WhisperContextParameters::default();
                dp.use_gpu = gpu;
                dp.flash_attn = gpu;
                match WhisperContext::new_with_params(path, dp).and_then(|c| c.create_state().map(|s| (c, s))) {
                    Ok((c, s)) => Some(LanguageDetector { state: Mutex::new(s), _ctx: c }),
                    Err(e) => {
                        tracing::warn!(error = %e, "language detector unavailable; using whisper auto-detect");
                        None
                    }
                }
            }
            None => None,
        };
        Ok(Self { state: Mutex::new(state), _ctx: ctx, detector, threads, beam_size, accelerator })
    }

    /// Time the encoder (a full 30 s window, as every request runs) on the device `load` would
    /// pick: one warm-up pass, then up to `runs` timed passes, stopping early once a pass takes
    /// longer than `enough_ms` (the answer is clear; slow devices take seconds per pass).
    /// Returns the device label and the times in milliseconds.
    pub fn time_encoder(model: &Path, use_gpu: bool, threads: i32, runs: usize, enough_ms: f64) -> anyhow::Result<(String, Vec<f64>)> {
        let engine = Self::load(model, None, use_gpu, threads, 1, false)?;
        let mut state = engine.state.lock().unwrap_or_else(|p| p.into_inner());
        // Two seconds of quiet noise; the encoder always processes a padded 30 s window.
        let mut seed = 0x2545_f491_u32;
        let samples: Vec<f32> = (0..32_000)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                (seed as f32 / u32::MAX as f32 - 0.5) * 0.02
            })
            .collect();
        let threads = threads.max(1) as usize;
        state.pcm_to_mel(&samples, threads).map_err(|e| anyhow::anyhow!("mel: {e}"))?;
        let mut times = Vec::with_capacity(runs);
        for i in 0..=runs {
            let started = Instant::now();
            state.encode(0, threads).map_err(|e| anyhow::anyhow!("encode: {e}"))?;
            if i > 0 {
                let ms = started.elapsed().as_secs_f64() * 1000.0;
                times.push(ms);
                if ms > enough_ms {
                    break;
                }
            }
        }
        Ok((engine.accelerator.clone(), times))
    }

    /// Pick the spoken language with the small model. None when no detector is loaded or when it
    /// is not confident (then the big model detects the language itself).
    fn detect_language(&self, samples: &[f32], timings: &mut Timings) -> Option<&'static str> {
        let detector = self.detector.as_ref()?;
        let started = Instant::now();
        let mut state = detector.state.lock().unwrap_or_else(|p| p.into_inner());
        let threads = self.threads.max(1) as usize;
        let lang = state
            .pcm_to_mel(samples, threads)
            .and_then(|_| state.lang_detect(0, threads))
            .ok()
            .and_then(|(id, probs)| {
                let p = probs.get(id.max(0) as usize).copied().unwrap_or(0.0);
                let lang = whisper_rs::get_lang_str(id);
                tracing::info!(?lang, probability = p, accepted = p >= LANGUAGE_CONFIDENCE, "language detected");
                (p >= LANGUAGE_CONFIDENCE).then_some(lang).flatten()
            });
        timings.push("language_id", started.elapsed().as_secs_f64() * 1000.0);
        lang
    }
}

impl SttEngine for WhisperStt {
    fn transcribe(&self, req: TranscribeRequest<'_>, timings: &mut Timings) -> anyhow::Result<String> {
        let audio = req.audio;
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let strategy = if self.beam_size > 1 {
            SamplingStrategy::BeamSearch { beam_size: self.beam_size, patience: -1.0 }
        } else {
            SamplingStrategy::Greedy { best_of: 1 }
        };
        let mut params = FullParams::new(strategy);
        params.set_n_threads(self.threads);
        params.set_translate(false);
        params.set_no_context(true);
        params.set_single_segment(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        params.set_no_speech_thold(0.6);
        params.set_temperature(0.0);
        if let Some(prompt) = req.prompt {
            params.set_initial_prompt(prompt);
        }

        // whisper.cpp needs at least 1s of audio; pad short clips with silence.
        let mut samples = audio.samples.clone();
        let min = audio.sample_rate as usize + audio.sample_rate as usize / 10;
        if samples.len() < min {
            samples.resize(min, 0.0);
        }
        let detected = match req.language {
            Some(_) => None,
            None => self.detect_language(&samples, timings),
        };
        params.set_language(Some(req.language.or(detected).unwrap_or("auto")));
        let marks = Marks::default();
        // SAFETY: `marks` lives until after `full()` returns; the callbacks only take shared
        // references to it (see `Marks::with`).
        unsafe {
            let ud = &marks as *const Marks as *mut c_void;
            params.set_start_encoder_callback(Some(on_encoder_begin));
            params.set_start_encoder_callback_user_data(ud);
            params.set_filter_logits_callback(Some(on_logits));
            params.set_filter_logits_callback_user_data(ud);
        }
        let started = Instant::now();
        state.full(params, &samples).map_err(|e| anyhow::anyhow!("whisper inference: {e}"))?;
        let finished = Instant::now();
        let ms = |a: Instant, b: Instant| b.saturating_duration_since(a).as_secs_f64() * 1000.0;
        let marks = marks.0.into_inner().unwrap_or_default();
        if let Some(first) = marks.first_encoder {
            let prepare = ms(started, first);
            let encode = marks.encode_total.as_secs_f64() * 1000.0;
            timings.push("prepare", prepare);
            timings.push("encoder", encode);
            timings.push("decoder", (ms(started, finished) - prepare - encode).max(0.0));
        }

        let mut text = String::new();
        for segment in state.as_iter() {
            if segment.no_speech_probability() > 0.8 {
                continue;
            }
            if let Ok(s) = segment.to_str_lossy() {
                text.push_str(&s);
            }
        }
        Ok(text.trim().to_string())
    }

    fn accelerator(&self) -> &str {
        &self.accelerator
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{ptr, thread, time::Duration};

    fn logits(ud: *mut c_void) {
        unsafe { on_logits(ptr::null_mut(), ptr::null_mut(), ptr::null(), 0, ptr::null_mut(), ud) }
    }

    #[test]
    fn marks_sum_every_window_and_tolerate_concurrent_logits() {
        let marks = Marks::default();
        let addr = &marks as *const Marks as usize;
        for _window in 0..2 {
            assert!(unsafe { on_encoder_begin(ptr::null_mut(), ptr::null_mut(), addr as *mut c_void) });
            thread::sleep(Duration::from_millis(5));
            // Beam search: several decoder threads report logits at once.
            thread::scope(|s| {
                for _ in 0..8 {
                    s.spawn(move || {
                        for _ in 0..100 {
                            logits(addr as *mut c_void);
                        }
                    });
                }
            });
        }
        let m = marks.0.into_inner().unwrap();
        assert!(m.first_encoder.is_some() && m.pending_encoder.is_none());
        assert!(m.encode_total >= Duration::from_millis(10), "{:?}", m.encode_total);
        assert!(m.encode_total < Duration::from_millis(500), "{:?}", m.encode_total);
    }
}
