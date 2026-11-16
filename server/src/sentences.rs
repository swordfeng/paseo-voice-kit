//! Shared, conservative TTS sentence/clause boundaries, not a linguistic parser.
//! Preserve source slices, including whitespace, and keep common dotted tokens intact.

fn terminal(c: char) -> bool {
    ".!?;。！？；؟۔؛।॥…\r\n\u{2028}\u{2029}".contains(c)
}
fn closing(c: char) -> bool {
    "\"'”’»›」』）)]}》】〕〉〗〙〛".contains(c)
}
pub fn clause_boundary(c: char) -> bool {
    c.is_whitespace() || ",，、،﹐､：:".contains(c)
}

fn protected_period(text: &str, i: usize, token_start: usize) -> bool {
    let before = &text[..i];
    let after = &text[i + 1..];
    let prev = before.chars().next_back();
    let next = after.chars().next();
    // Decimal/version numbers, domain names, addresses, and internal acronym dots.
    let ascii_word = prev.is_some_and(|c| c.is_ascii_alphanumeric())
        && next.is_some_and(|c| c.is_ascii_alphanumeric());
    let decimal = prev.is_some_and(char::is_numeric) && next.is_some_and(char::is_numeric);
    let token_prefix = &text[token_start..i];
    let address = prev.is_some_and(char::is_alphanumeric)
        && next.is_some_and(char::is_alphanumeric)
        && (token_prefix.contains("://")
            || token_prefix.contains('@')
            || token_prefix.starts_with("www."));
    if ascii_word || decimal || address {
        return true;
    }
    let Some(next_word) = after.trim_start().chars().next() else {
        return false;
    };
    if !next_word.is_alphabetic() {
        return false;
    }
    let token = text[token_start..i].trim_start_matches(|c: char| !c.is_alphabetic());
    let lower = token.to_lowercase();
    // Conservative exceptions: an abbreviation can also end a sentence. Keeping
    // that ambiguity together is preferable to cutting a title from its name.
    if [
        "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "fig", "no",
        "dept", "inc", "ltd", "approx", "cf", "bzw", "z.b", "usw", "d.h", "mme", "mlle", "sra",
        "srta", "dra", "ud", "uds", "p.ej", "г", "ул", "им", "рис", "стр", "т.д", "т.п",
    ]
    .contains(&lower.as_str())
    {
        return true;
    }
    let initial = token.chars().count() == 1 && token.chars().all(|c| c.is_ascii_uppercase());
    let acronym = token.contains('.')
        && token
            .split('.')
            .all(|s| s.len() == 1 && s.chars().all(|c| c.is_ascii_uppercase()));
    acronym || (initial && next_word.is_uppercase())
}

pub fn split(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut start, mut token_start) = (0, 0);
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        let prefix = &text[token_start..i];
        if c.is_whitespace() {
            token_start = i + c.len_utf8();
        }
        let in_address = matches!(c, '.' | '?' | '!' | ';')
            && (prefix.contains("://") || prefix.contains('@') || prefix.starts_with("www."))
            && text[i + c.len_utf8()..]
                .chars()
                .next()
                .is_some_and(|next| !next.is_whitespace() && !closing(next) && !terminal(next));
        if !terminal(c) || in_address || (c == '.' && protected_period(text, i, token_start)) {
            continue;
        }
        let mut end = i + c.len_utf8();
        // Keep punctuation runs and closing quotes/brackets with the sentence.
        while let Some(&(j, next)) = chars.peek() {
            if (terminal(next) && !next.is_whitespace())
                || closing(next)
                || (c == '\r' && next == '\n')
            {
                chars.next();
                end = j + next.len_utf8();
            } else {
                break;
            }
        }
        out.push(&text[start..end]);
        start = end;
        token_start = end;
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn multilingual_boundaries_preserve_punctuation_quotes_and_every_byte() {
        for (text, expected) in [
            (
                "你好。今日は晴れです！괜찮아요？",
                vec!["你好。", "今日は晴れです！", "괜찮아요？"],
            ),
            (
                "Hello! Bonjour? Danke. Hola; Ciao!",
                vec!["Hello!", " Bonjour?", " Danke.", " Hola;", " Ciao!"],
            ),
            ("مرحبا؟نعم؛ٹھیک ہے۔", vec!["مرحبا؟", "نعم؛", "ٹھیک ہے۔"]),
            ("नमस्ते।अगला वाक्य॥", vec!["नमस्ते।", "अगला वाक्य॥"]),
        ] {
            assert_eq!(split(text), expected, "{text}");
            assert_eq!(split(text).concat(), text);
        }
        let quoted = "“真的吗？！”（是的。）Next…Done.\r\n尾句";
        assert_eq!(
            split(quoted),
            vec![
                "“真的吗？！”",
                "（是的。）",
                "Next…",
                "Done.",
                "\r\n",
                "尾句"
            ]
        );
        assert_eq!(split(quoted).concat(), quoted);
        assert!(split("").is_empty());
        assert_eq!(split(" \n\u{2028}\u{2029}").concat(), " \n\u{2028}\u{2029}");
    }
    #[test]
    fn numbers_abbreviations_initials_and_web_addresses_stay_intact() {
        for text in [
            "Dr. Smith met Prof. Jones.",
            "J. R. Tolkien wrote a book.",
            "Use e.g. apples, i.e. fruit.",
            "The U.S. office is open.",
            "版本0.2和v1.2.3，价格３.１４元。",
            "Visit https://example.com/a.b?q=1.2.",
            "Email a.b@example.org.",
            "Frau Dr. Müller erklärt z.B. die Version.",
            "La Sra. García llega hoy.",
        ] {
            assert_eq!(split(text), vec![text], "{text}");
        }
        assert_eq!(split("Done. Next."), vec!["Done.", " Next."]);
        assert_eq!(split("Done.你好。"), vec!["Done.", "你好。"]);
        assert_eq!(
            split("See example.com. Next."),
            vec!["See example.com.", " Next."]
        );
    }
}
