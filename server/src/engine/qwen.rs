//! Shared Qwen text budgeting. Token counts come from each loaded model's tokenizer.
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use anyhow::{ensure, Result};

use super::{cooldown, is_request_failure, RequestFailure};

const TEXT_TOKENS: usize = 64;
// Bound private JSON probes (even control characters expand by at most 6x).
const PROBE_BYTES: usize = 8_000;

const DEFAULT_INSTRUCTION: &str = "用平静、自然、平稳的语气朗读，语速适中，吐字清楚，音量均匀，情绪克制，不加入笑声、叹气或额外语气词，不刻意卖萌或表演。";

/// The 12 Hz codec: one frame is 1920 samples at 24 kHz, 80 ms.
const FRAMES_PER_SECOND: f64 = 12.5;
/// The workers' hard ceiling per generation: 96 seconds of audio.
pub(super) const MAX_FRAMES: u32 = 1200;

/// Sampling for one generation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Sampling {
    pub temperature: f64,
    pub seed: u64,
    pub max_frames: u32,
}

fn base_temperature() -> f64 {
    // Diagnostic override for controlled sampling trials, like VOICEKIT_QWEN_INSTRUCTION.
    std::env::var("VOICEKIT_QWEN_TEMPERATURE")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|t| *t > 0.0 && *t <= 2.0)
        // 0.2 sometimes never reached the end token with seed 42 (3 of 7 voices on six short
        // sentences, 0.6B GGUF on Metal); 0.4 had none on the same set. See eval.md.
        .unwrap_or(0.4)
}

fn seed() -> u64 {
    // Diagnostic override for controlled sampling trials.
    std::env::var("VOICEKIT_QWEN_SEED").ok().and_then(|v| v.parse().ok()).filter(|s| *s <= i64::MAX as u64).unwrap_or(42)
}

/// Frames a chunk of `tokens` text tokens may need, with room for slow voices and pauses
/// (0.8 s per token plus 4 s; real speech is about 0.3 s per token). A generation that never
/// reaches its end token then fails after seconds, not after 96 seconds of audio.
pub(super) fn max_frames(tokens: usize) -> u32 {
    ((tokens as f64 * 0.8 + 4.0) * FRAMES_PER_SECOND).ceil().min(MAX_FRAMES as f64) as u32
}

pub(super) fn first_sampling(tokens: usize) -> Sampling {
    Sampling { temperature: base_temperature(), seed: seed(), max_frames: max_frames(tokens) }
}

/// The same sampling with another fixed seed (same temperature, so the same delivery).
pub(super) fn retry_sampling(tokens: usize) -> Sampling {
    let first = first_sampling(tokens);
    Sampling { seed: if first.seed == 7 { 43 } else { 7 }, ..first }
}

fn token_limited(error: &anyhow::Error) -> bool {
    error.downcast_ref::<RequestFailure>().is_some_and(|f| f.code.as_deref() == Some("token_limit"))
}

/// Generate one chunk, capped by its text length. A generation that never reaches its end token
/// repeats exactly with the same seed, but another seed almost always finishes (eval.md), so it is
/// retried once with another seed at the same temperature.
pub(super) fn speak_chunk<T>(tokens: usize, mut speak: impl FnMut(Sampling) -> Result<T>) -> Result<T> {
    match speak(first_sampling(tokens)) {
        Err(error) if token_limited(&error) => {
            tracing::warn!(tokens, "Qwen generation reached its frame limit; retrying once with another seed");
            speak(retry_sampling(tokens))
        }
        other => other,
    }
}

/// The private worker reported an error for one request: the request failed, the worker lives.
pub(super) fn worker_error(header: &serde_json::Value, backend: &str) -> anyhow::Error {
    let message = header["error"].as_str().map(str::to_owned).unwrap_or_else(|| header["error"].to_string());
    RequestFailure { code: header["code"].as_str().map(str::to_owned), message: format!("{backend} synthesis failed: {message}") }.into()
}

/// Runtime failures of a worker (crash, failed start, timeout) and the cooldown they cause.
/// Request failures don't count: the same worker serves the next request.
#[derive(Default)]
pub(super) struct Health {
    failure: Mutex<Option<(String, Instant)>>,
    failures: AtomicU32,
}

impl Health {
    /// The last runtime failure while a cooldown is still running.
    pub fn cooling(&self) -> Option<String> {
        let delay = cooldown(self.failures.load(Ordering::SeqCst))?;
        let failure = self.failure.lock().unwrap();
        failure.as_ref().filter(|(_, at)| at.elapsed() < delay).map(|(error, _)| error.clone())
    }

    /// Record a finished request. Returns true when the worker must be discarded.
    pub fn record<T>(&self, result: &Result<T>) -> bool {
        match result {
            Ok(_) => {
                self.failures.store(0, Ordering::SeqCst);
                self.failure.lock().unwrap().take();
                false
            }
            Err(error) if is_request_failure(error) => false,
            Err(error) => {
                self.failures.fetch_add(1, Ordering::SeqCst);
                *self.failure.lock().unwrap() = Some((format!("{error:#}"), Instant::now()));
                true
            }
        }
    }

    pub fn failure(&self) -> Option<String> {
        self.failure.lock().unwrap().as_ref().map(|(error, _)| error.clone())
    }

    #[cfg(test)]
    pub fn failures(&self) -> u32 {
        self.failures.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub fn backdate(&self, by: std::time::Duration) {
        if let Some((_, at)) = self.failure.lock().unwrap().as_mut() {
            *at -= by;
        }
    }
}

pub(super) fn request(text: &str, voice: &str, language: Option<&str>, sampling: Sampling) -> Result<serde_json::Value> {
    let instruction = std::env::var("VOICEKIT_QWEN_INSTRUCTION")
        .unwrap_or_else(|_| DEFAULT_INSTRUCTION.to_owned());
    ensure!(instruction.len() <= 2048 && !instruction.contains('\0'), "Qwen instruction exceeds private IPC limit");
    Ok(serde_json::json!({"text":text,"voice":voice,"language":language,
        "temperature":sampling.temperature,"seed":sampling.seed,"instruction":instruction,
        "max_new_tokens":sampling.max_frames}))
}

/// Preserve source slices exactly; prefer whole sentences, then clauses/words.
/// Every returned slice is measured, since BPE prefix counts need not be monotonic.
pub(super) fn text_chunks<'a>(
    text: &'a str,
    mut count: impl FnMut(&str) -> Result<usize>,
) -> Result<Vec<&'a str>> {
    let mut out = Vec::new();
    for sentence in crate::sentences::split(text) {
        let mut rest = sentence;
        while !rest.is_empty() {
            if rest.len() <= PROBE_BYTES && count(rest)? <= TEXT_TOKENS {
                out.push(rest);
                break;
            }
            let boundaries: Vec<_> = rest
                .char_indices()
                .skip(1)
                .map(|(i, _)| i)
                .take_while(|&i| i <= PROBE_BYTES)
                .collect();
            let (mut lo, mut hi, mut best) = (0, boundaries.len(), 0);
            while lo < hi {
                let mid = lo + (hi - lo) / 2;
                let end = boundaries[mid];
                if count(&rest[..end])? <= TEXT_TOKENS {
                    best = end;
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            ensure!(
                best > 0,
                "one Unicode scalar exceeds the Qwen text token budget"
            );
            if let Some((i, c)) = rest[..best]
                .char_indices()
                .rev()
                .find(|(_, c)| crate::sentences::clause_boundary(*c))
            {
                let end = i + c.len_utf8();
                if end > best / 2 && count(&rest[..end])? <= TEXT_TOKENS {
                    best = end;
                }
            }
            out.push(&rest[..best]);
            rest = &rest[best..];
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budgets_model_tokens_instead_of_characters_and_preserves_unicode() {
        // A tokenizer may encode a long English word as one token. Do not cut
        // a sentence at 80 characters when its measured token count is small.
        let english = "extraordinary ".repeat(20) + ".";
        let chunks = text_chunks(&english, |s| Ok(s.split_whitespace().count())).unwrap();
        assert_eq!(chunks, vec![english.as_str()]);
        for text in [
            "没有标点🙂".repeat(80),
            "A long clause, with words ".repeat(80),
        ] {
            let count = |s: &str| {
                s.chars()
                    .map(|c| if c.is_ascii() { 1 } else { 3 })
                    .sum::<usize>()
            };
            let chunks = text_chunks(&text, |s| Ok(count(s))).unwrap();
            assert_eq!(chunks.concat(), text);
            assert!(chunks.len() > 1);
            assert!(chunks
                .iter()
                .all(|s| !s.is_empty() && count(s) <= TEXT_TOKENS));
        }
        assert!(text_chunks("too big", |_| Ok(100)).is_err());
        assert!(text_chunks("error", |_| anyhow::bail!("worker failed")).is_err());
    }

    #[test]
    fn oversized_input_keeps_token_count_probes_inside_private_ipc_limit() {
        let text = "字".repeat(4_000);
        let chunks = text_chunks(&text, |s| {
            assert!(s.len() <= PROBE_BYTES);
            Ok(s.chars().count())
        })
        .unwrap();
        assert_eq!(chunks.concat(), text);
        assert!(chunks.iter().all(|s| s.chars().count() <= TEXT_TOKENS));
    }

    #[test]
    fn frame_cap_follows_text_length_within_the_worker_ceiling() {
        // "OK." still gets several seconds; a full 64-token chunk gets far more than real speech
        // (about 0.3 s per token) but well under the 96-second ceiling.
        assert_eq!(max_frames(1), 60);
        assert!(max_frames(TEXT_TOKENS) as f64 / FRAMES_PER_SECOND > TEXT_TOKENS as f64 * 0.6);
        assert!(max_frames(TEXT_TOKENS) < MAX_FRAMES);
        assert_eq!(max_frames(10_000), MAX_FRAMES);
        let request = request("hi", "vivian", Some("en"), first_sampling(1)).unwrap();
        assert_eq!(request["max_new_tokens"], 60);
        assert!(request["temperature"].as_f64().unwrap() > 0.0);
    }

    #[test]
    fn a_generation_at_its_limit_is_retried_once_with_another_seed_only() {
        let limit = || -> anyhow::Error { RequestFailure { code: Some("token_limit".into()), message: "limit".into() }.into() };
        let mut tries = Vec::new();
        let result = speak_chunk(5, |s| { tries.push(s); if tries.len() == 1 { Err(limit()) } else { Ok(()) } });
        assert!(result.is_ok());
        assert_eq!(tries.len(), 2);
        assert_eq!(tries[0].temperature, tries[1].temperature, "the retry keeps the temperature");
        assert_ne!(tries[0].seed, tries[1].seed);
        assert_eq!(tries[0].max_frames, tries[1].max_frames);
        // Only once, and only for the limit: other failures aren't retried.
        let mut count = 0;
        assert!(speak_chunk(5, |_| -> Result<()> { count += 1; Err(limit()) }).is_err());
        assert_eq!(count, 2);
        count = 0;
        assert!(speak_chunk(5, |_| -> Result<()> { count += 1; anyhow::bail!("worker crashed") }).is_err());
        assert_eq!(count, 1);
    }

    #[test]
    fn sentence_boundaries_preserve_decimal_numbers_and_source_text() {
        let text = "温度是0.2。 Next sentence!\n还有一句。";
        let chunks = text_chunks(text, |_| Ok(1)).unwrap();
        assert_eq!(
            chunks,
            vec!["温度是0.2。", " Next sentence!", "\n", "还有一句。"]
        );
        assert_eq!(chunks.concat(), text);
    }
}
