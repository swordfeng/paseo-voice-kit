//! Audio containers, decoding and resampling.
//!
//! Paseo uploads mono PCM16 WAV (24 kHz from current clients). WAV takes a fast path; other
//! containers (mp3, m4a/aac, flac, ogg) go through symphonia.

#[derive(Debug, Clone)]
pub struct Pcm {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

impl Pcm {
    /// Pitch-preserving tempo for engines without a native rate control. No resampling: the
    /// sample rate and voice pitch stay unchanged. At 1x even the original allocation is kept.
    pub fn with_tempo(mut self, speed: f32) -> anyhow::Result<Self> {
        anyhow::ensure!(speed.is_finite() && (0.5..=2.0).contains(&speed), "speech speed must be between 0.5 and 2");
        if speed == 1.0 || self.samples.is_empty() { return Ok(self); }
        let rate = std::num::NonZeroU32::new(self.sample_rate).ok_or_else(|| anyhow::anyhow!("invalid speech sample rate"))?;
        // Below a WSOLA frame, leave the tiny fragment intact rather than lose it to windowing.
        if self.samples.len() < self.sample_rate as usize * 30 / 1000 { return Ok(self); }
        let target = (self.samples.len() as f64 / speed as f64).round() as usize;
        // The stretcher needs complete analysis windows at EOF. Supply silence, then remove only
        // that padding: never truncate a final syllable just to force an exact sample count.
        let guard = self.sample_rate as usize / 10;
        self.samples.resize(self.samples.len() + guard, 0.0);
        let mut output = wsola::stretch(&self.samples, rate, std::num::NonZeroU16::new(1).unwrap(), speed)
            .map_err(|e| anyhow::anyhow!("speech tempo processing failed: {e}"))?;
        anyhow::ensure!(output.iter().all(|x| x.is_finite()), "invalid tempo output");
        let audible_end = output.iter().rposition(|x| x.abs() > 1e-7).map_or(0, |i| i + 1);
        output.truncate(target.max(audible_end));
        // Silence can finish short by a window. Pad silence only, keeping speech unchanged.
        if output.len() < target { output.resize(target, 0.0); }
        self.samples = output;
        Ok(self)
    }

    pub fn duration_secs(&self) -> f32 {
        if self.sample_rate == 0 {
            0.0
        } else {
            self.samples.len() as f32 / self.sample_rate as f32
        }
    }

    /// Band-limited resample (sherpa-onnx's windowed-sinc linear resampler).
    pub fn resample(&self, rate: u32) -> Pcm {
        if rate == self.sample_rate || self.samples.is_empty() {
            return self.clone();
        }
        match sherpa_onnx::LinearResampler::create(self.sample_rate as i32, rate as i32) {
            Some(r) => Pcm { samples: r.resample(&self.samples, true), sample_rate: rate },
            None => self.clone(),
        }
    }

    pub fn peak(&self) -> f32 {
        self.samples.iter().fold(0f32, |m, s| m.max(s.abs()))
    }

    pub fn to_s16le(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.samples.len() * 2);
        for s in &self.samples {
            let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            out.extend_from_slice(&v.to_le_bytes());
        }
        out
    }

    pub fn to_wav(&self) -> Vec<u8> {
        let data = self.to_s16le();
        let mut out = Vec::with_capacity(44 + data.len());
        let byte_rate = self.sample_rate * 2;
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM
        out.extend_from_slice(&1u16.to_le_bytes()); // mono
        out.extend_from_slice(&self.sample_rate.to_le_bytes());
        out.extend_from_slice(&byte_rate.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes()); // block align
        out.extend_from_slice(&16u16.to_le_bytes()); // bits
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&data);
        out
    }
}

#[cfg(test)]
mod tempo_tests {
    use super::*;
    const RATE: u32 = 24_000;
    fn tone(hz: f32, seconds: f32) -> Pcm {
        Pcm { sample_rate: RATE, samples: (0..(RATE as f32 * seconds) as usize)
            .map(|i| 0.4 * (2.0 * std::f32::consts::PI * hz * i as f32 / RATE as f32).sin()).collect() }
    }
    fn frequency(pcm: &Pcm) -> f32 {
        let middle = &pcm.samples[pcm.samples.len() / 4..pcm.samples.len() * 3 / 4];
        let crossings = middle.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        crossings as f32 * pcm.sample_rate as f32 / middle.len() as f32
    }
    #[test]
    fn tempo_changes_duration_without_changing_pitch() {
        let original = tone(220.0, 1.0);
        for speed in [0.5, 0.8, 1.2, 1.5, 2.0] {
            let out = original.clone().with_tempo(speed).unwrap();
            let expected = original.samples.len() as f32 / speed;
            assert!((out.samples.len() as f32 - expected).abs() < RATE as f32 * 0.08, "duration at {speed}: {} vs {expected}", out.samples.len());
            assert!((frequency(&out) - 220.0).abs() < 5.0, "pitch at {speed}: {}", frequency(&out));
            assert_eq!(out.sample_rate, RATE);
            assert!(out.peak() < 0.401);
        }
    }
    #[test]
    fn normal_speed_is_an_exact_noop_and_silence_is_bounded() {
        let original = tone(193.0, 0.15);
        let ptr = original.samples.as_ptr();
        let samples = original.samples.clone();
        let out = original.with_tempo(1.0).unwrap();
        assert_eq!(out.samples, samples);
        assert_eq!(out.samples.as_ptr(), ptr);
        for speed in [0.5, 2.0] {
            let out = Pcm { samples: vec![0.0; RATE as usize], sample_rate: RATE }.with_tempo(speed).unwrap();
            assert_eq!(out.samples.len(), (RATE as f32 / speed) as usize);
            assert_eq!(out.peak(), 0.0);
        }
        for samples in [vec![], vec![0.1, -0.1, 0.2]] {
            assert_eq!(Pcm { samples: samples.clone(), sample_rate: RATE }.with_tempo(2.0).unwrap().samples, samples);
        }
        for speed in [f32::NAN, f32::INFINITY, 0.0, 3.0] { assert!(tone(220.0, 0.1).with_tempo(speed).is_err()); }
    }
    #[test]
    fn final_sound_survives_end_of_input() {
        let mut input = tone(180.0, 0.7);
        let end = tone(650.0, 0.1);
        input.samples.extend(end.samples);
        for speed in [0.5, 1.2, 2.0] {
            let out = input.clone().with_tempo(speed).unwrap();
            let tail = &out.samples[out.samples.len() - RATE as usize / 50..];
            assert!(tail.iter().any(|x| x.abs() > 0.01), "last sound lost at {speed}");
        }
    }
    #[test]
    #[ignore = "manual listening fixture; set VOICEKIT_TEMPO_SAMPLE to an existing speech WAV"]
    fn export_listening_samples() {
        let file = std::env::var("VOICEKIT_TEMPO_SAMPLE").expect("VOICEKIT_TEMPO_SAMPLE");
        let folder = std::env::var("VOICEKIT_TEMPO_OUTPUT").expect("VOICEKIT_TEMPO_OUTPUT");
        std::fs::create_dir_all(&folder).unwrap();
        let original = decode_wav(&std::fs::read(file).unwrap()).unwrap();
        for speed in [0.8, 1.0, 1.25] {
            let started = std::time::Instant::now();
            let out = original.clone().with_tempo(speed).unwrap();
            assert!((out.duration_secs() - original.duration_secs() / speed).abs() < 0.08);
            std::fs::write(format!("{folder}/speed-{speed}.wav"), out.to_wav()).unwrap();
            println!("speed={speed} seconds={:.3} processing_ms={:.2}", out.duration_secs(), started.elapsed().as_secs_f64() * 1000.0);
        }
    }
}

/// Parse a RIFF/WAVE PCM16 file (any channel count; downmixed to mono).
pub fn decode_wav(bytes: &[u8]) -> anyhow::Result<Pcm> {
    anyhow::ensure!(bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE", "not a WAV file");
    let mut pos = 12;
    let mut fmt: Option<(u16, u16, u32, u16)> = None;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into()?) as usize;
        let body_start = pos + 8;
        let body_end = (body_start + size).min(bytes.len());
        let body = &bytes[body_start..body_end];
        match id {
            b"fmt " => {
                anyhow::ensure!(body.len() >= 16, "short fmt chunk");
                fmt = Some((
                    u16::from_le_bytes(body[0..2].try_into()?),
                    u16::from_le_bytes(body[2..4].try_into()?),
                    u32::from_le_bytes(body[4..8].try_into()?),
                    u16::from_le_bytes(body[14..16].try_into()?),
                ));
            }
            b"data" => {
                let (format, channels, rate, bits) = fmt.ok_or_else(|| anyhow::anyhow!("data before fmt"))?;
                anyhow::ensure!(format == 1 || format == 0xFFFE, "unsupported WAV format {format}");
                anyhow::ensure!(bits == 16, "unsupported WAV bit depth {bits}");
                let ch = channels.max(1) as usize;
                let frames = body.len() / (2 * ch);
                let mut samples = Vec::with_capacity(frames);
                for f in 0..frames {
                    let mut acc = 0f32;
                    for c in 0..ch {
                        let o = (f * ch + c) * 2;
                        acc += i16::from_le_bytes([body[o], body[o + 1]]) as f32 / 32768.0;
                    }
                    samples.push(acc / ch as f32);
                }
                return Ok(Pcm { samples, sample_rate: rate });
            }
            _ => {}
        }
        pos = body_start + size + (size & 1);
    }
    anyhow::bail!("WAV has no data chunk")
}

/// Decode any supported container to mono f32.
pub fn decode_any(bytes: &[u8], ext_hint: Option<&str>) -> anyhow::Result<Pcm> {
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" {
        if let Ok(pcm) = decode_wav(bytes) {
            return Ok(pcm);
        }
    }
    decode_symphonia(bytes, ext_hint)
}

fn decode_symphonia(bytes: &[u8], ext_hint: Option<&str>) -> anyhow::Result<Pcm> {
    use symphonia::core::{
        audio::SampleBuffer, codecs::DecoderOptions, errors::Error, formats::FormatOptions,
        io::MediaSourceStream, meta::MetadataOptions, probe::Hint,
    };
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mss = MediaSourceStream::new(Box::new(cursor), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = ext_hint {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| anyhow::anyhow!("unrecognized audio container: {e}"))?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| anyhow::anyhow!("no audio track"))?
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| anyhow::anyhow!("unsupported codec: {e}"))?;
    let mut rate = track.codec_params.sample_rate.unwrap_or(0);
    let mut samples = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Error::ResetRequired) => break,
            Err(e) => return Err(anyhow::anyhow!("read packet: {e}")),
        };
        if packet.track_id() != track.id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(Error::DecodeError(_)) => continue,
            Err(e) => return Err(anyhow::anyhow!("decode: {e}")),
        };
        let spec = *decoded.spec();
        rate = spec.rate;
        let channels = spec.channels.count().max(1);
        let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buf.copy_interleaved_ref(decoded);
        for frame in buf.samples().chunks(channels) {
            samples.push(frame.iter().sum::<f32>() / channels as f32);
        }
    }
    anyhow::ensure!(rate > 0, "unknown sample rate");
    Ok(Pcm { samples, sample_rate: rate })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_roundtrip() {
        let pcm = Pcm { samples: vec![0.0, 0.5, -0.5, 0.25], sample_rate: 16_000 };
        let back = decode_wav(&pcm.to_wav()).unwrap();
        assert_eq!(back.sample_rate, 16_000);
        assert_eq!(back.samples.len(), 4);
        assert!((back.samples[1] - 0.5).abs() < 1e-3);
    }

    #[test]
    fn resample_length() {
        let pcm = Pcm { samples: vec![0.0; 24_000], sample_rate: 24_000 };
        let out = pcm.resample(16_000).samples.len() as i64;
        assert!((out - 16_000).abs() < 32, "got {out}");
    }

    #[test]
    fn decode_any_wav() {
        let pcm = Pcm { samples: vec![0.1; 2400], sample_rate: 24_000 };
        let back = decode_any(&pcm.to_wav(), Some("wav")).unwrap();
        assert_eq!(back.sample_rate, 24_000);
    }
}
