//! Per-sentence language detection for multilingual speech output.

/// ISO 639-1 code for a text, or None when it cannot be told (too short, mixed, unknown).
///
/// CJK is decided by script: kana means Japanese, Hangul Korean, and Han characters that
/// outnumber the Latin words means Chinese (so "我们用 Kubernetes 部署" stays Chinese).
/// Everything else goes through whatlang's trigram model.
pub fn detect(text: &str) -> Option<&'static str> {
    let (mut han, mut kana, mut hangul, mut letters) = (0usize, 0usize, 0usize, 0usize);
    for c in text.chars() {
        match c as u32 {
            0x3040..=0x30FF | 0x31F0..=0x31FF | 0xFF66..=0xFF9D => kana += 1,
            0xAC00..=0xD7AF | 0x1100..=0x11FF | 0x3130..=0x318F => hangul += 1,
            0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF | 0x20000..=0x2A6DF => han += 1,
            _ if c.is_alphabetic() => letters += 1,
            _ => {}
        }
    }
    let latin_words = text.split(|c: char| !c.is_alphabetic() || (c as u32) >= 0x2E80).filter(|w| !w.is_empty()).count();
    if kana > 0 && kana + han >= latin_words {
        return Some("ja");
    }
    if hangul > 0 && hangul >= letters {
        return Some("ko");
    }
    if han > 0 && han >= latin_words {
        // Written Cantonese uses its own particles and pronouns, which Mandarin text does not.
        const CANTONESE: &[char] = &['嘅', '咗', '喺', '冇', '啲', '嚟', '佢', '哋', '咁', '乜', '嘢', '唔', '睇', '咩'];
        let cantonese = text.chars().filter(|c| CANTONESE.contains(c)).count();
        return Some(if cantonese >= 2 { "yue" } else { "zh" });
    }
    if letters >= 8 {
        if let Some(info) = whatlang::detect(text).filter(|info| info.confidence() >= 0.35) {
            if let Some(language) = iso639_1(info.lang().code()) { return Some(language); }
        }
    }
    // Distinct scripts must not fall through to English merely because a short phrase
    // is below the statistical detector's confidence threshold.
    for c in text.chars() {
        let language=match c as u32 {
            0x0E00..=0x0E7F=>Some("th"),0x0980..=0x09FF=>Some("bn"),
            0x0B80..=0x0BFF=>Some("ta"),0x0C00..=0x0C7F=>Some("te"),
            0x0C80..=0x0CFF=>Some("kn"),0x0D00..=0x0D7F=>Some("ml"),
            0x0A80..=0x0AFF=>Some("gu"),0x0A00..=0x0A7F=>Some("pa"),
            0x0590..=0x05FF=>Some("he"),0x0370..=0x03FF=>Some("el"),
            _=>None,
        };
        if language.is_some() {return language;}
    }
    // Short Arabic greetings often have low trigram confidence. Keep them out of the
    // English default; distinctive Urdu/Persian letters preserve their own routing.
    if text.chars().any(|c| matches!(c as u32, 0x0600..=0x06FF | 0x0750..=0x077F)) {
        if text.chars().any(|c| "ٹڈڑںھےۓ".contains(c)) { return Some("ur"); }
        if text.chars().any(|c| "پچژگ".contains(c)) { return Some("fa"); }
        return Some("ar");
    }
    None
}

fn iso639_1(code3: &str) -> Option<&'static str> {
    Some(match code3 {
        "eng" => "en",
        "spa" => "es",
        "fra" => "fr",
        "deu" => "de",
        "ita" => "it",
        "por" => "pt",
        "nld" => "nl",
        "rus" => "ru",
        "ukr" => "uk",
        "pol" => "pl",
        "ces" => "cs",
        "slk" => "sk",
        "slv" => "sl",
        "hrv" => "hr",
        "bul" => "bg",
        "ron" => "ro",
        "hun" => "hu",
        "fin" => "fi",
        "est" => "et",
        "lav" => "lv",
        "lit" => "lt",
        "swe" => "sv",
        "dan" => "da",
        "ell" => "el",
        "tur" => "tr",
        "ara" => "ar",
        "hin" => "hi",
        "vie" => "vi",
        "ind" => "id",
        "jpn" => "ja",
        "kor" => "ko",
        "cmn" => "zh",
        "tha" => "th",
        "pes" => "fa",
        "heb" => "he",
        "urd" => "ur",
        "ben" => "bn",
        "tam" => "ta",
        "tel" => "te",
        "mar" => "mr",
        "guj" => "gu",
        "kan" => "kn",
        "mal" => "ml",
        "pan" => "pa",
        "ori" => "or",
        "sin" => "si",
        "nep" => "ne",
        "khm" => "km",
        "mya" => "my",
        "cat" => "ca",
        "tgl" => "tl",
        "kat" => "ka",
        "hye" => "hy",
        "mkd" => "mk",
        "srp" => "sr",
        "bel" => "be",
        "aze" => "az",
        "uzb" => "uz",
        "afr" => "af",
        "nob" => "no",
        "amh" => "am",
        "jav" => "jv",
        "zul" => "zu",
        "yid" => "yi",
        _ => return None,
    })
}

/// A stretch of text in one language.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub text: String,
    pub lang: Option<&'static str>,
}

/// Split text into sentences, detect each sentence's language, let undetectable sentences
/// take their neighbour's language, and merge consecutive sentences of the same language.
pub fn runs(text: &str) -> Vec<Run> {
    let mut sentences: Vec<String> = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        current.push(c);
        if matches!(c, '.' | '!' | '?' | ';' | '。' | '！' | '？' | '；' | '\n') {
            if !current.trim().is_empty() {
                sentences.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
        }
    }
    if !current.trim().is_empty() {
        sentences.push(current);
    }

    let mut langs: Vec<Option<&'static str>> = sentences.iter().map(|s| detect(s)).collect();
    // Unknown sentences inherit from the previous known one, else the next.
    let mut last = None;
    for l in langs.iter_mut() {
        if l.is_none() {
            *l = last;
        } else {
            last = *l;
        }
    }
    let mut next = None;
    for l in langs.iter_mut().rev() {
        if l.is_none() {
            *l = next;
        } else {
            next = *l;
        }
    }

    let mut out: Vec<Run> = Vec::new();
    for (sentence, lang) in sentences.into_iter().zip(langs) {
        match out.last_mut() {
            Some(run) if run.lang == lang => run.text.push_str(&sentence),
            _ => out.push(Run { text: sentence, lang }),
        }
    }
    for run in &mut out {
        run.text = run.text.trim().to_string();
    }
    out.retain(|r| !r.text.is_empty());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_scripts_and_languages() {
        assert_eq!(detect("今天天气很好，我们去公园吧。"), Some("zh"));
        assert_eq!(detect("我们用 Kubernetes 部署服务。"), Some("zh"));
        assert_eq!(detect("ビルドが成功しました。"), Some("ja"));
        assert_eq!(detect("빌드가 성공했습니다."), Some("ko"));
        assert_eq!(detect("The build passed and all tests are green."), Some("en"));
        assert_eq!(detect("La compilación pasó y todas las pruebas están en verde."), Some("es"));
        assert_eq!(detect("Der Build ist durchgelaufen und alle Tests sind grün."), Some("de"));
        assert_eq!(detect("OK."), None);
        assert_eq!(detect("我哋今日去咗公園，你嚟唔嚟呀？"), Some("yue"));
        assert_eq!(detect("我们今天去了公园，你来不来？"), Some("zh"));
        assert_eq!(detect("วันนี้อากาศดีมาก เราไปเดินเล่นที่สวนสาธารณะกันไหม"), Some("th"));
        assert_eq!(detect("امروز هوا خیلی خوب است و ما به پارک می‌رویم."), Some("fa"));
        assert_eq!(detect("آج موسم بہت اچھا ہے اور ہم پارک جا رہے ہیں۔"), Some("ur"));
        assert_eq!(detect("आज मौसम बहुत अच्छा है और हम पार्क जा रहे हैं।"), Some("hi"));
        assert_eq!(detect("Avui fa molt bon temps i anirem al parc amb els nens."), Some("ca"));
    }

    #[test]
    fn groups_runs_and_inherits_short_sentences() {
        let r = runs("你好，我是你的助手。The build passed and all tests are green. OK. 还有别的问题吗？");
        let langs: Vec<_> = r.iter().map(|x| x.lang).collect();
        assert_eq!(langs, vec![Some("zh"), Some("en"), Some("zh")]);
        assert!(r[1].text.ends_with("OK."));
    }
}
    #[test]
    fn short_arabic_greeting_keeps_its_language() {
        assert_eq!(detect("مرحبا كيف حالك اليوم"), Some("ar"));
    }
