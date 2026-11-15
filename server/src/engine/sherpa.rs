//! sherpa-onnx engines, configured from catalog entries.
//!
//! Speech recognition families: sense_voice, paraformer, transducer (e.g. NeMo Parakeet),
//! nemo_ctc, fire_red_asr, fire_red_asr_ctc, dolphin, omnilingual, moonshine, qwen3_asr.
//! Speech synthesis families: kokoro, vits (incl. MeloTTS, Piper), matcha.

use sherpa_onnx::{
    GenerationConfig, OfflineDolphinModelConfig, OfflineFireRedAsrCtcModelConfig, OfflineFireRedAsrModelConfig,
    OfflineMoonshineModelConfig, OfflineNemoEncDecCtcModelConfig, OfflineOmnilingualAsrCtcModelConfig, OfflineParaformerModelConfig,
    OfflineQwen3ASRModelConfig, OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig,
    OfflineTransducerModelConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig,
    OfflineTtsMatchaModelConfig, OfflineTtsModelConfig, OfflineTtsSupertonicModelConfig, OfflineTtsVitsModelConfig,
};

use super::{SpeakRequest, SttEngine, Timings, TranscribeRequest, TtsEngine, Voice};
use crate::{
    audio::Pcm,
    catalog::{Installed, ModelEntry},
};

/// ONNX Runtime execution provider. "cpu" is the safe default; "coreml" / "cuda" are opt-in.
fn provider_name(provider: &str) -> String {
    match provider {
        "coreml" | "cuda" | "directml" => provider.to_string(),
        _ => "cpu".to_string(),
    }
}

pub struct SherpaStt {
    recognizer: OfflineRecognizer,
    accelerator: String,
    /// SenseVoice and Paraformer write English in capitals.
    tidy_caps: bool,
    /// Qwen3-ASR can return its `language <Name><asr_text>` header with the transcript.
    qwen3_asr: bool,
}

impl SherpaStt {
    pub fn load(entry: &ModelEntry, inst: &Installed, provider: &str, threads: i32, vocabulary: Option<&str>) -> anyhow::Result<Self> {
        let family = entry.family.as_deref().unwrap_or_default();
        let f = |role: &str| inst.files_csv(entry, role);
        let mut config = OfflineRecognizerConfig::default();
        let mc = &mut config.model_config;
        match family {
            "sense_voice" => {
                mc.sense_voice = OfflineSenseVoiceModelConfig {
                    model: f("model"),
                    language: Some(entry.option_str("language").unwrap_or("").to_string()),
                    use_itn: entry.option_bool("use_itn").unwrap_or(true),
                }
            }
            "paraformer" => mc.paraformer = OfflineParaformerModelConfig { model: f("model") },
            "transducer" => {
                mc.transducer = OfflineTransducerModelConfig { encoder: f("encoder"), decoder: f("decoder"), joiner: f("joiner") };
                mc.model_type = entry.option_str("model_type").map(str::to_string);
            }
            "nemo_ctc" => mc.nemo_ctc = OfflineNemoEncDecCtcModelConfig { model: f("model") },
            "fire_red_asr" => mc.fire_red_asr = OfflineFireRedAsrModelConfig { encoder: f("encoder"), decoder: f("decoder") },
            "fire_red_asr_ctc" => mc.fire_red_asr_ctc = OfflineFireRedAsrCtcModelConfig { model: f("model") },
            "dolphin" => mc.dolphin = OfflineDolphinModelConfig { model: f("model") },
            "omnilingual" => mc.omnilingual = OfflineOmnilingualAsrCtcModelConfig { model: f("model") },
            "moonshine" => {
                mc.moonshine = OfflineMoonshineModelConfig {
                    preprocessor: f("preprocessor"),
                    encoder: f("encoder"),
                    uncached_decoder: f("uncached_decoder"),
                    cached_decoder: f("cached_decoder"),
                    merged_decoder: f("merged_decoder"),
                }
            }
            "qwen3_asr" => {
                mc.qwen3_asr = OfflineQwen3ASRModelConfig {
                    conv_frontend: f("conv_frontend"),
                    encoder: f("encoder"),
                    decoder: f("decoder"),
                    tokenizer: f("tokenizer"),
                    // Vocabulary from settings biases recognition of names and terms.
                    hotwords: vocabulary.map(|v| v.replace(',', " ")).filter(|v| !v.trim().is_empty()),
                    ..Default::default()
                }
            }
            other => anyhow::bail!("unsupported sherpa-onnx speech recognition family {other:?}"),
        }
        mc.tokens = f("tokens");
        mc.num_threads = threads;
        mc.provider = Some(provider_name(provider));
        let recognizer = OfflineRecognizer::create(&config)
            .ok_or_else(|| anyhow::anyhow!("sherpa-onnx could not load {} ({family}) from {}", entry.id, inst.root.display()))?;
        Ok(Self {
            recognizer,
            accelerator: provider_name(provider),
            tidy_caps: matches!(family, "sense_voice" | "paraformer"),
            qwen3_asr: family == "qwen3_asr",
        })
    }

}

impl SttEngine for SherpaStt {
    fn transcribe(&self, req: TranscribeRequest<'_>, _timings: &mut Timings) -> anyhow::Result<String> {
        let audio = req.audio;
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(audio.sample_rate as i32, &audio.samples);
        self.recognizer.decode(&stream);
        let result = stream.get_result().ok_or_else(|| anyhow::anyhow!("no recognition result"))?;
        let text = result.text.trim();
        if self.qwen3_asr {
            return Ok(qwen3_asr_transcript(text));
        }
        Ok(if self.tidy_caps { tidy_caps(text) } else { text.to_string() })
    }

    fn accelerator(&self) -> &str {
        &self.accelerator
    }
}

pub struct SherpaTts {
    tts: OfflineTts,
    /// Supertonic needs the text's language with every request.
    needs_language: bool,
    languages: Vec<String>,
    voices: Vec<(Voice, i32)>,
    default_sid: i32,
    accelerator: String,
}

impl SherpaTts {
    pub fn load(entry: &ModelEntry, inst: &Installed, provider: &str, threads: i32, default_voice: &str) -> anyhow::Result<Self> {
        let family = entry.family.as_deref().unwrap_or_default();
        let f = |role: &str| inst.files_csv(entry, role);
        let mut model = OfflineTtsModelConfig { num_threads: threads, provider: Some(provider_name(provider)), ..Default::default() };
        match family {
            "kokoro" => {
                model.kokoro = OfflineTtsKokoroModelConfig {
                    model: f("model"),
                    voices: f("voices"),
                    tokens: f("tokens"),
                    lexicon: f("lexicon"),
                    dict_dir: f("dict_dir"),
                    lang: entry.option_str("lang").map(str::to_string),
                    ..Default::default()
                }
            }
            "vits" => {
                model.vits = OfflineTtsVitsModelConfig {
                    model: f("model"),
                    lexicon: f("lexicon"),
                    tokens: f("tokens"),
                    data_dir: f("data_dir"),
                    dict_dir: f("dict_dir"),
                    ..Default::default()
                }
            }
            "matcha" => {
                model.matcha = OfflineTtsMatchaModelConfig {
                    acoustic_model: f("acoustic_model"),
                    vocoder: f("vocoder"),
                    lexicon: f("lexicon"),
                    tokens: f("tokens"),
                    data_dir: f("data_dir"),
                    dict_dir: f("dict_dir"),
                    ..Default::default()
                }
            }
            "supertonic" => {
                model.supertonic = OfflineTtsSupertonicModelConfig {
                    duration_predictor: f("duration_predictor"),
                    text_encoder: f("text_encoder"),
                    vector_estimator: f("vector_estimator"),
                    vocoder: f("vocoder"),
                    tts_json: f("tts_json"),
                    unicode_indexer: f("unicode_indexer"),
                    voice_style: f("voice_style"),
                }
            }
            other => anyhow::bail!("unsupported sherpa-onnx speech synthesis family {other:?}"),
        }
        let config = OfflineTtsConfig { model, rule_fsts: f("rule_fsts"), max_num_sentences: 1, ..Default::default() };
        let tts = OfflineTts::create(&config)
            .ok_or_else(|| anyhow::anyhow!("sherpa-onnx could not load {} ({family}) from {}", entry.id, inst.root.display()))?;
        let voices = voice_list(entry, family, tts.num_speakers());
        let mut engine = Self { tts, needs_language: family == "supertonic", languages: entry.languages.clone(), voices, default_sid: 0, accelerator: provider_name(provider) };
        let preferred = [default_voice, entry.default_voice.as_deref().unwrap_or("")];
        engine.default_sid = preferred.iter().find_map(|v| engine.resolve_sid(v)).unwrap_or(0);
        Ok(engine)
    }

    fn resolve_sid(&self, voice: &str) -> Option<i32> {
        let voice = voice.trim();
        if voice.is_empty() {
            return None;
        }
        if let Some((_, sid)) = self.voices.iter().find(|(v, _)| v.id == voice) {
            return Some(*sid);
        }
        voice.strip_prefix("sid:").unwrap_or(voice).parse::<i32>().ok().filter(|sid| self.voices.iter().any(|(_, s)| s == sid))
    }
}

/// Voices from the catalog when listed; Kokoro v1.1-zh gets readable names; otherwise one entry
/// per speaker. `featured` marks the short list the settings screen shows first.
fn voice_list(entry: &ModelEntry, family: &str, num_speakers: i32) -> Vec<(Voice, i32)> {
    if !entry.voices.is_empty() {
        return entry
            .voices
            .iter()
            .map(|v| (Voice { id: v.id.clone(), label: v.label.clone(), language: v.language.clone(), gender: v.gender.clone(), featured: v.featured }, v.sid))
            .collect();
    }
    let featured: Vec<String> = entry
        .options
        .get("featured_voices")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let n = num_speakers.max(1);
    let mut out: Vec<(Voice, i32)> = if family == "kokoro" && n == 103 {
        let mut v = [
            ("en-maple", "Maple (English, female)", "en", "female"),
            ("en-sol", "Sol (English, female)", "en", "female"),
            ("en-vale", "Vale (British English, female)", "en", "female"),
        ]
        .into_iter()
        .map(|(id, label, lang, g)| Voice { id: id.into(), label: label.into(), language: lang.into(), gender: g.into(), featured: false })
        .collect::<Vec<_>>();
        v.extend((1..=55).map(|i| Voice { id: format!("zh-f{i:02}"), label: format!("Mandarin female {i}"), language: "zh".into(), gender: "female".into(), featured: false }));
        v.extend((1..=45).map(|i| Voice { id: format!("zh-m{i:02}"), label: format!("Mandarin male {i}"), language: "zh".into(), gender: "male".into(), featured: false }));
        v.into_iter().zip(0..).collect()
    } else {
        (0..n)
            .map(|i| (Voice { id: format!("speaker-{i}"), label: format!("Voice {}", i + 1), language: "multi".into(), gender: String::new(), featured: false }, i))
            .collect()
    };
    for (i, (voice, _)) in out.iter_mut().enumerate() {
        voice.featured = if featured.is_empty() { i < 6 } else { featured.contains(&voice.id) };
    }
    out
}

fn speech_language<'a>(text: &str, provided: Option<&'a str>, supported: &[String]) -> &'a str {
    let language = provided.or_else(|| crate::lang::detect(text)).unwrap_or("en");
    if supported.is_empty() || supported.iter().any(|s| s == "multi" || s == language) {
        language
    } else {
        "en"
    }
}

impl TtsEngine for SherpaTts {
    fn synthesize(&self, req: SpeakRequest<'_>, _timings: &mut Timings) -> anyhow::Result<Pcm> {
        let sid = self.resolve_sid(req.voice).unwrap_or(self.default_sid);
        let mut config = GenerationConfig { sid, speed: req.speed, ..Default::default() };
        if self.needs_language {
            let lang = speech_language(req.text, req.language, &self.languages);
            config.extra = Some([("lang".to_string(), serde_json::Value::String(lang.to_string()))].into_iter().collect());
        }
        let audio = self
            .tts
            .generate_with_config(req.text, &config, None::<fn(&[f32], f32) -> bool>)
            .ok_or_else(|| anyhow::anyhow!("speech synthesis failed"))?;
        Ok(Pcm { samples: audio.samples().to_vec(), sample_rate: audio.sample_rate() as u32 })
    }

    fn voices(&self) -> Vec<Voice> {
        self.voices.iter().map(|(v, _)| v.clone()).collect()
    }

    fn accelerator(&self) -> &str {
        &self.accelerator
    }
}

/// Qwen3-ASR decodes `language <Name><asr_text><transcript>`, and `language None<asr_text>`
/// for audio without speech (Qwen3-ASR technical report; Hugging Face transformers
/// `processing_qwen3_asr._parse_single_output`). Like that parser, keep only the text after the
/// first marker, but only when what precedes it is such a header: `language …` or a single
/// label word. Anything else is left as recognized, so a transcript that merely mentions the
/// marker is not cut. Trailing end-of-turn control tokens are removed.
pub fn qwen3_asr_transcript(text: &str) -> String {
    const MARKER: &str = "<asr_text>";
    const END_TOKENS: &[&str] = &["<|im_end|>", "<|endoftext|>"];
    fn strip_end(mut text: &str) -> &str {
        loop {
            let trimmed = text.trim_end();
            match END_TOKENS.iter().find(|t| trimmed.ends_with(*t)) {
                Some(token) => text = &trimmed[..trimmed.len() - token.len()],
                None => return trimmed.trim_start(),
            }
        }
    }
    let text = text.trim();
    let Some((prefix, rest)) = text.split_once(MARKER) else {
        return strip_end(text).to_string();
    };
    let prefix = prefix.trim();
    let header = prefix.is_empty()
        || prefix.get(..9).is_some_and(|p| p.eq_ignore_ascii_case("language "))
        || prefix.chars().all(char::is_alphabetic);
    if header { strip_end(rest).to_string() } else { strip_end(text).to_string() }
}

/// SenseVoice emits English in ALL CAPS ("HELLO AND THAT'S IT"). When all English letters are
/// capitals, lower-case words, keep "I", and capitalize sentence starts. Normally cased text
/// (acronyms included) and Chinese pass through unchanged.
pub fn tidy_caps(text: &str) -> String {
    let letters = text.chars().filter(|c| c.is_ascii_alphabetic());
    let shouting = letters.clone().count() > 1 && letters.clone().all(|c| c.is_ascii_uppercase());
    if !shouting {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut sentence_start = true;
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String, sentence_start: &mut bool| {
        if word.is_empty() {
            return;
        }
        let mut w = word.to_ascii_lowercase();
        if w == "i" || w.starts_with("i'") {
            w.replace_range(0..1, "I");
        }
        if *sentence_start {
            if let Some(first) = w.chars().next().filter(|c| c.is_ascii_alphabetic()) {
                w.replace_range(0..1, &first.to_ascii_uppercase().to_string());
            }
        }
        *sentence_start = false;
        out.push_str(&w);
        word.clear();
    };
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || c == '\'' {
            word.push(c);
            continue;
        }
        flush(&mut word, &mut out, &mut sentence_start);
        out.push(c);
        if matches!(c, '.' | '!' | '?' | '。' | '！' | '？') {
            sentence_start = true;
        } else if !c.is_whitespace() && !c.is_ascii_punctuation() {
            sentence_start = false;
        }
    }
    flush(&mut word, &mut out, &mut sentence_start);
    out
}

#[cfg(test)]
mod tests {
    use super::{qwen3_asr_transcript, tidy_caps, speech_language};

    #[test]
    fn qwen3_asr_header_is_removed_but_transcripts_are_kept() {
        // Plain transcripts and ordinary words pass through untouched.
        for plain in ["Hello, this is a speech test.", "你好，这是一个语音测试。", "language", "language matters here", "Utterance one, utterance two."] {
            assert_eq!(qwen3_asr_transcript(plain), plain);
        }
        // The official header, in any language, and a stray single-word label.
        assert_eq!(qwen3_asr_transcript("language English<asr_text>Hello, this is a speech test."), "Hello, this is a speech test.");
        assert_eq!(qwen3_asr_transcript("language Chinese<asr_text>你好，这是一个语音测试。"), "你好，这是一个语音测试。");
        assert_eq!(qwen3_asr_transcript("utterance<asr_text>Hello there"), "Hello there");
        assert_eq!(qwen3_asr_transcript("<asr_text>Bonjour"), "Bonjour");
        assert_eq!(qwen3_asr_transcript("  language English\n<asr_text> Hi.  "), "Hi.");
        // No speech, and end-of-turn control tokens.
        assert_eq!(qwen3_asr_transcript("language None<asr_text><|im_end|>"), "");
        assert_eq!(qwen3_asr_transcript("language English<asr_text>Done.<|im_end|>"), "Done.");
        assert_eq!(qwen3_asr_transcript("Done. <|im_end|><|endoftext|>"), "Done.");
        // Only the first marker counts; a later one is part of the transcript.
        assert_eq!(qwen3_asr_transcript("language English<asr_text>type <asr_text> literally"), "type <asr_text> literally");
        // A transcript that merely mentions the marker is not cut.
        for mention in ["please write <asr_text> here", "the tag <asr_text> marks text"] {
            assert_eq!(qwen3_asr_transcript(mention), mention);
        }
        // Control-token text inside a sentence is not a suffix and stays.
        assert_eq!(qwen3_asr_transcript("say <|im_end|> twice"), "say <|im_end|> twice");
    }

    #[test]
    fn unsupported_speech_language_falls_back_without_changing_recognition() {
        let supported = vec!["en".into(), "de".into()];
        assert_eq!(speech_language("你好，今天天气很好。", None, &supported), "en");
        assert_eq!(speech_language("hello", Some("th"), &supported), "en");
        assert_eq!(speech_language("hello", Some("de"), &supported), "de");
        assert_eq!(speech_language("你好", None, &["multi".into()]), "zh");
    }

    #[test]
    fn tidies_all_caps_english() {
        assert_eq!(tidy_caps("HELLO HELLO AND THAT'S IT"), "Hello hello and that's it");
        assert_eq!(tidy_caps("I THINK I'M DONE. OK GO"), "I think I'm done. Ok go");
        assert_eq!(tidy_caps("你好我是你的语音助手 WE BUILT PASS"), "你好我是你的语音助手 we built pass");
        assert_eq!(tidy_caps("use GPT and API keys"), "use GPT and API keys");
        assert_eq!(tidy_caps("你好"), "你好");
    }
}
