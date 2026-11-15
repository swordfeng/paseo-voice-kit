//! Shared Qwen text budgeting. Token counts come from each loaded model's tokenizer.
use anyhow::{ensure, Result};

const TEXT_TOKENS: usize = 64;
// Bound private JSON probes (even control characters expand by at most 6x).
const PROBE_BYTES: usize = 8_000;

const DEFAULT_INSTRUCTION: &str = "用平静、自然、平稳的语气朗读，语速适中，吐字清楚，音量均匀，情绪克制，不加入笑声、叹气或额外语气词，不刻意卖萌或表演。";

pub(super) fn request(text: &str, voice: &str, language: Option<&str>) -> Result<serde_json::Value> {
    let instruction = std::env::var("VOICEKIT_QWEN_INSTRUCTION")
        .unwrap_or_else(|_| DEFAULT_INSTRUCTION.to_owned());
    ensure!(instruction.len() <= 2048 && !instruction.contains('\0'), "Qwen instruction exceeds private IPC limit");
    Ok(serde_json::json!({"text":text,"voice":voice,"language":language,
        "temperature":0.2,"seed":42,"instruction":instruction}))
}

/// Preserve source slices exactly; prefer whole sentences, then clauses/words.
/// Every returned slice is measured, since BPE prefix counts need not be monotonic.
pub(super) fn text_chunks<'a>(
    text: &'a str,
    mut count: impl FnMut(&str) -> Result<usize>,
) -> Result<Vec<&'a str>> {
    let mut out = Vec::new();
    let mut pending = text;
    while !pending.is_empty() {
        let end = pending
            .char_indices()
            .find_map(|(i, c)| {
                let end = i + c.len_utf8();
                let decimal = c == '.'
                    && pending[..i]
                        .chars()
                        .next_back()
                        .is_some_and(|c| c.is_ascii_digit())
                    && pending[end..]
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_digit());
                (".!?。！？；;\n".contains(c) && !decimal).then_some(end)
            })
            .unwrap_or(pending.len());
        let mut rest = &pending[..end];
        pending = &pending[end..];
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
                .find(|(_, c)| c.is_whitespace() || "，,、：:".contains(*c))
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
