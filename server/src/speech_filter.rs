//! Reject non-speech and crop idle microphone audio before speech recognition.
//! Keep the entire first-to-last speech span, including pauses and 300 ms at either edge.

use std::{ops::Range, path::Path, sync::OnceLock};

use sherpa_onnx::{SileroVadModelConfig, VadModelConfig, VoiceActivityDetector};

use crate::{audio::Pcm, catalog::{Engine, ModelEntry}};

/// These recognizers need speech bounds rather than an accumulated idle microphone buffer.
pub fn required(entry: &ModelEntry) -> bool {
    entry.engine == Engine::Whisper
        || (entry.engine == Engine::Sherpa && entry.family.as_deref() == Some("qwen3_asr"))
}

/// Internal resource, not a selectable transcription model. The store can reuse Paseo's copy.
pub fn model() -> &'static ModelEntry {
    static MODEL: OnceLock<ModelEntry> = OnceLock::new();
    MODEL.get_or_init(|| serde_json::from_str(r#"{
        "id": "silero-vad", "kind": "stt", "engine": "sherpa", "tier": "internal",
        "label": "Silero VAD", "files": {"model": "silero_vad.onnx"},
        "download": [{
            "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
            "sha256": "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
            "size": 643854
        }]
    }"#).expect("built-in VAD resource"))
}

pub struct SpeechFilter {
    detector: VoiceActivityDetector,
}

impl SpeechFilter {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let config = VadModelConfig {
            silero_vad: SileroVadModelConfig {
                model: Some(path.to_string_lossy().into_owned()),
                threshold: 0.5,
                min_silence_duration: 0.3,
                min_speech_duration: 0.1,
                window_size: 512,
                max_speech_duration: 30.0,
            },
            sample_rate: 16_000,
            num_threads: 1,
            provider: Some("cpu".into()),
            ..Default::default()
        };
        let detector = VoiceActivityDetector::create(&config, 60.0)
            .ok_or_else(|| anyhow::anyhow!("could not load speech activity detector {}", path.display()))?;
        Ok(Self { detector })
    }

    pub fn speech(&mut self, audio: &Pcm) -> anyhow::Result<Option<Pcm>> {
        anyhow::ensure!(audio.sample_rate == 16_000, "speech filter needs 16 kHz audio");
        self.detector.reset();
        self.detector.clear();
        let mut spans = Vec::new();
        for chunk in audio.samples.chunks(512) {
            // Drain as we feed, so long recordings cannot overflow the VAD's result buffer.
            if chunk.len() == 512 {
                self.detector.accept_waveform(chunk);
            } else {
                let mut last = [0.0; 512];
                last[..chunk.len()].copy_from_slice(chunk);
                self.detector.accept_waveform(&last);
            }
            self.drain(&mut spans);
        }
        self.detector.flush();
        self.drain(&mut spans);
        Ok(speech_range(audio.samples.len(), &spans).map(|range| Pcm {
            samples: audio.samples[range].to_vec(),
            sample_rate: audio.sample_rate,
        }))
    }

    fn drain(&self, spans: &mut Vec<Range<usize>>) {
        while let Some(segment) = self.detector.front() {
            let start = segment.start().max(0) as usize;
            spans.push(start..start.saturating_add(segment.n().max(0) as usize));
            self.detector.pop();
        }
    }
}

fn speech_range(samples: usize, spans: &[Range<usize>]) -> Option<Range<usize>> {
    let first = spans.iter().filter(|s| s.start < s.end && s.start < samples).map(|s| s.start).min()?;
    let last = spans.iter().filter(|s| s.start < s.end && s.start < samples).map(|s| s.end).max()?;
    let padding = 4_800; // 300 ms at 16 kHz; preserve speech onset and final consonants.
    Some(first.saturating_sub(padding)..last.saturating_add(padding).min(samples))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_onset_tail_and_all_internal_pauses() {
        assert_eq!(speech_range(100_000, &[20_000..30_000, 70_000..80_000]), Some(15_200..84_800));
        assert_eq!(speech_range(10_000, &[0..12_000]), Some(0..10_000));
        assert_eq!(speech_range(10_000, &[]), None);
        assert_eq!(speech_range(10_000, &[10_000..12_000, 5..5]), None);
    }

    // A bounded real-model regression; no model downloads in unit tests.
    #[test]
    #[ignore = "set VOICEKIT_TEST_VAD and VOICEKIT_TEST_SPEECH to local fixture paths"]
    fn real_speech_survives_idle_padding_and_noise_is_rejected() {
        let model = std::env::var("VOICEKIT_TEST_VAD").unwrap();
        let clip = std::env::var("VOICEKIT_TEST_SPEECH").unwrap();
        let audio = crate::audio::decode_any(&std::fs::read(clip).unwrap(), Some("wav")).unwrap().resample(16_000);
        let mut filter = SpeechFilter::load(Path::new(&model)).unwrap();
        let clean = filter.speech(&audio).unwrap().expect("speech fixture");
        let mut padded = vec![0.0; 100 * 16_000];
        padded.extend_from_slice(&audio.samples);
        padded.resize(padded.len() + 10 * 16_000, 0.0);
        let padded = Pcm { samples: padded, sample_rate: 16_000 };
        let trimmed = filter.speech(&padded).unwrap().expect("padded speech");
        assert!(trimmed.duration_secs() < audio.duration_secs() + 0.7);
        assert!(trimmed.duration_secs() >= clean.duration_secs() - 0.1);
        let silence = Pcm { samples: vec![0.0; 61 * 16_000], sample_rate: 16_000 };
        assert!(filter.speech(&silence).unwrap().is_none());
        // Low-level room noise passes the old peak-only gate but is not speech.
        let mut seed = 12345u32;
        let noise = Pcm { sample_rate: 16_000, samples: (0..5 * 16_000).map(|_| {
            seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
            (seed as f32 / u32::MAX as f32 - 0.5) * 0.04
        }).collect() };
        assert!(filter.speech(&noise).unwrap().is_none());
        assert!(filter.speech(&audio).unwrap().is_some(), "a rejected request must not poison the next request");
        eprintln!("input={:.2}s padded={:.2}s trimmed={:.2}s", audio.duration_secs(), padded.duration_secs(), trimmed.duration_secs());
    }
}
