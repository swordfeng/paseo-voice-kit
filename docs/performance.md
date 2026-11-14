# Performance notes

Latency measured during development on an Apple M6, using the `x-voicekit-timing`
response header. These are spot checks of single requests, not a benchmark; the
multilingual accuracy and speed measurements are in [eval.md](eval.md).

| Path | Latency | Notes |
| --- | --- | --- |
| Whisper turbo, Neural Engine encoder | ~0.27 s | encoder 217 ms, language detection 35 ms, decoder 5–35 ms |
| Whisper turbo, Metal only | ~0.68 s | encoder 640 ms |
| Whisper turbo, before optimizations | ~1.3 s | whisper.cpp's own language detection ran a second encoder pass |
| SenseVoice | 60–270 ms | CPU |
| Qwen3-ASR | 0.4–1.1 s | CPU |
| Supertonic 3 | 0.4–0.6 s per sentence | CPU |
| Paseo's own overhead per request | ~30 ms | |

## Acceleration

- Whisper runs on Metal on macOS. The plugin's default is Metal without the Neural Engine.
- The sherpa-onnx models (Qwen3-ASR, Parakeet, Dolphin, SenseVoice and the voices) run
  on the CPU. The bundled sherpa-onnx library on this Mac logs a fallback to CPU when
  Core ML is requested, so requesting it gives no speedup.
- The Neural Engine mode for Whisper is opt-in (plugin setting, or `--coreml` when running
  the server directly). The first load compiles the encoder for the machine, which takes
  several minutes; Apple's compiler service used up to 7 GB of memory and 2–4 cores here.
  macOS then caches the result. With the mode off, whisper.cpp loads the model through a
  differently named link, so it never picks up an encoder that is on disk.
