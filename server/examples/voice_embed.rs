//! Voice similarity helper: prints a speaker embedding and median pitch for each WAV file, one
//! JSON object per line. Used to pair voices from different TTS models that sound alike.
//!
//! cargo run --release --example voice_embed -- <speaker-model.onnx> <a.wav> [b.wav ...]

use sherpa_onnx::{SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig, Wave};

/// Median fundamental frequency (Hz) over voiced 40 ms frames, by autocorrelation.
fn median_f0(samples: &[f32], rate: i32) -> f32 {
    let rate = rate as usize;
    let frame = rate * 40 / 1000;
    let (min_lag, max_lag) = (rate / 400, rate / 60);
    let mut f0s = Vec::new();
    let mut start = 0;
    while start + frame + max_lag < samples.len() {
        let x = &samples[start..start + frame + max_lag];
        let energy: f32 = x[..frame].iter().map(|v| v * v).sum::<f32>() / frame as f32;
        if energy > 1e-4 {
            let mut best = (0.0f32, 0usize);
            for lag in min_lag..max_lag {
                let s: f32 = (0..frame).map(|i| x[i] * x[i + lag]).sum();
                if s > best.0 {
                    best = (s, lag);
                }
            }
            // Keep clearly periodic frames only.
            if best.1 > 0 && best.0 / (energy * frame as f32) > 0.3 {
                f0s.push(rate as f32 / best.1 as f32);
            }
        }
        start += frame;
    }
    if f0s.is_empty() {
        return 0.0;
    }
    f0s.sort_by(|a, b| a.total_cmp(b));
    f0s[f0s.len() / 2]
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (model, files) = args.split_first().expect("usage: voice_embed <model.onnx> <wav...>");
    let config = SpeakerEmbeddingExtractorConfig { model: Some(model.clone()), num_threads: 4, ..Default::default() };
    let extractor = SpeakerEmbeddingExtractor::create(&config).expect("load speaker model");
    for file in files {
        let wave = Wave::read(file).unwrap_or_else(|| panic!("read {file}"));
        let stream = extractor.create_stream().expect("stream");
        stream.accept_waveform(wave.sample_rate(), wave.samples());
        stream.input_finished();
        let embedding = extractor.compute(&stream).expect("embedding");
        let f0 = median_f0(wave.samples(), wave.sample_rate());
        println!("{}", serde_json::json!({ "file": file, "f0": f0, "embedding": embedding }));
    }
}
