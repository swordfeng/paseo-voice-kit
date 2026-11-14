# Speech model evaluation

Measured on Apple M6, 2026-11-13. FLEURS test split pinned to revision
`70bb2e84b976b7e960aa89f1c648e09c59f894dd`: 15 distinct sentences per language,
32 languages, 480 recordings. Exact sentences, clip names, durations and original
peaks are in [eval/sample.jsonl](eval/sample.jsonl). Audio was peak-normalized to
0.5 before transcription because some recordings otherwise trigger the silence gate.

Whisper used Metal with its Neural Engine option off. Sherpa models used CPU.
Some inherited runs overlapped other work; latency is observed performance, not an
isolated hardware ranking. The Omnilingual 1B run was stopped early to avoid more
slow CPU work. Missing cells are unmeasured, never zero error. Moonshine and turbo
q8 were not completed and have no accuracy claims here.

STT uses normalized WER, or CER for Chinese, Cantonese, Japanese, Korean and Thai.
Tables below were scored with Python stdlib only (no optional OpenCC); traditional
versus simplified spelling can therefore count as errors. Percentages can exceed
100 with insertions. Do not compare models' overall averages when they cover
different languages. A small read-speech sample is not a dictation benchmark.

TTS uses five sentences per language/voice where available, synthesized and read
back by Whisper turbo with the language supplied. This measures read-back agreement,
not perceived naturalness. The human-recording column shows that the recognizer
itself is weak for some languages. RTF is synthesis time divided by audio duration.

## Catalog decisions

- Keep Whisper turbo as the GPU default. Parakeet v3 is a CPU alternative for 25
  European languages (English 4.9% WER versus turbo 5.2% on this sample).
- Keep Qwen3 for its different language strengths, including Thai and Cantonese.
  Preserve its advertised language coverage even where this sample scores poorly.
- Add Dolphin small for Asian languages, including Bengali, Nepali and Tamil;
  keep it out of the recommended group because it does not cover European speech.
- SenseVoice becomes an extra choice: Japanese 78.6% CER and Korean 80.5% CER
  here. Whisper base stays available internally for language detection.
- Remove duplicate turbo q8 and int8 Kokoro choices; remove Paraformer, MeloTTS
  and Parakeet v2 from the built-ins. Saved plugin choices map to replacements.
  Turbo q8 was not measured: its removal reduces duplicate choices, not an
  assertion of identical measured accuracy. Custom catalogs can still add models.
- Add optional MMS Thai (25.3% round-trip CER versus previous routing 94.4%) and
  Coqui Bengali (47.9% versus 94.4%; human recording already 38.9%). MMS Thai has
  a noncommercial license, stated on its model card. Each has one shared voice
  across personas. Default and Chinese persona IDs remain stable.
- Related-language pronunciation for Catalan, Tagalog, Swahili and Malay is best
  effort, not native-language coverage. Hebrew and Tamil remain poor TTS choices.

## Run efficiently

Start with three clips per language. `run_stt.sh` defaults to `LIMIT=3`, waits at
most 60 s for model warm-up, and each request times out after 30 s. STT stops after a 60 s per-model budget
(or one final in-flight request) and skips models whose warm-up inference exceeds 5 s. Use one model
at a time to avoid loading all candidates together. Only expand a run after its
speed check passes. `LIMIT=15` explicitly requests the original larger sample.
Use Whisper on Metal (`--coreml false` still uses Metal); do not interpret that
flag as disabling its GPU. Sherpa CoreML must be verified from native logs:
the bundled v2.0.1 library on this machine explicitly falls back to CPU.
A requested provider label alone is not proof of acceleration.

```bash
python3 -I scripts/eval/fetch_fleurs.py /tmp/fleurs --n 15
LIMIT=3 bash scripts/eval/run_stt.sh /tmp/fleurs /tmp/stt.jsonl whisper-large-v3-turbo-q5_0
python3 -I scripts/eval/score_stt.py /tmp/fleurs /tmp/stt.jsonl /tmp/stt-summary.json
python3 -I scripts/eval/score_tts.py /tmp/tts/tts.jsonl /tmp/stt.jsonl /tmp/tts-summary.json
python3 -I scripts/eval/quick_provider.py coreml /tmp/provider-check --data /tmp/fleurs
```

The retained summaries are in [eval/stt-summary.json](eval/stt-summary.json) and
[eval/tts-summary.json](eval/tts-summary.json). Tables include excluded candidates
so their results remain visible. Full raw hypotheses remain in `/tmp/vk-eval` on
the measurement machine; the pinned dataset and exact sample allow fresh reruns.

## Speech recognition

| Language | dolphin-base-int8 | dolphin-small-int8 | omnilingual-1b-v2-int8 | omnilingual-300m-v2-int8 | paraformer-zh-int8 | parakeet-tdt-0.6b-v2-int8 | parakeet-tdt-0.6b-v3-int8 | qwen3-asr-0.6b-int8 | sensevoice-int8 | whisper-base-q5_1 | whisper-large-v3-turbo-q5_0 | whisper-large-v3-turbo-q5_0 (lang given) | whisper-small-q5_1 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| en | 98.8 | 99.4 | 9.8 | 16.3 |  | 5.5 | **4.9** | 6.2 | 31.7 | 22.5 | 5.2 | 5.2 | 6.8 |
| zh (CER) | 16.0 | 14.1 | 22.4 | 26.9 | 12.1 |  |  | 9.3 | 12.3 | 33.5 | **8.3** | **8.3** | 21.0 |
| es | 100.3 | 100.0 | 5.6 | 9.8 |  |  | 3.7 | 6.2 |  | 9.6 | **2.8** | **2.8** | 5.6 |
| fr | 100.0 | 100.0 | 16.1 | 23.8 |  |  | 10.7 | 15.9 |  | 32.2 | **9.3** | **9.3** | 16.6 |
| de | 100.0 | 100.0 | 8.2 | 14.6 |  |  | 5.0 | 17.7 |  | 19.6 | **3.2** | **3.2** | 8.2 |
| ja (CER) | 14.4 | 8.1 | 18.1 | 23.1 |  |  |  | 9.3 | 78.6 | 23.3 | **4.6** | **4.6** | 13.1 |
| ko (CER) | 14.6 | 10.3 | 8.5 | 14.5 |  |  |  | 4.8 | 80.5 | 13.4 | **4.3** | **4.3** | 5.3 |
| ru | 52.6 | 62.4 | 17.1 | 30.0 |  |  | 9.1 | 15.3 |  | 19.9 | **5.2** | **5.2** | 10.1 |
| ar | 40.0 | 18.7 | **9.0** | 17.7 |  |  |  | 22.3 |  | 39.4 | **9.0** | **9.0** | 22.9 |
| hi | 30.8 | 49.6 | **14.9** | 22.1 |  |  |  | 32.8 |  | 102.0 | 29.3 | 30.0 | 63.8 |
| pt | 100.0 | 100.0 | 7.3 | 12.9 |  |  | 4.1 | 9.8 |  | 18.3 | **3.4** | **3.4** | 6.8 |
| it | 99.7 | 100.0 | 4.1 | 10.8 |  |  | 3.0 | 8.6 |  | 22.4 | **1.9** | **1.9** | 6.9 |
| vi | 20.0 | 13.8 | 16.1 | 29.4 |  |  |  | 11.3 |  | 41.4 | **7.8** | **7.8** | 21.8 |
| id | 18.9 | 14.8 | 11.1 | 15.2 |  |  |  | 12.1 |  | 35.0 | **6.7** | **6.7** | 13.8 |
| tr | 96.6 | 98.3 | 9.7 | 27.2 |  |  |  | 28.3 |  | 32.4 | **8.6** | **8.6** | 17.6 |
| nl | 100.0 | 100.0 | 15.1 | 33.6 |  |  | 14.5 | 18.8 |  | 49.3 | **9.2** | **9.2** | 23.7 |
| pl | 100.0 | 100.0 | 11.5 | 25.4 |  |  | 11.5 | 47.1 |  | 45.1 | **6.6** | **6.6** | 18.0 |
| uk | 94.9 | 96.5 | 12.9 | 31.0 |  |  | 10.2 | 91.4 |  | 42.7 | **8.2** | **8.2** | 14.9 |
| sv | 100.0 | 100.0 | 23.9 | 36.9 |  |  | 25.7 | 44.8 |  | 53.0 | **10.8** | **10.8** | 28.0 |
| el | 100.0 | 100.0 | 23.6 | 39.6 |  |  | 42.8 | 67.2 |  | 64.2 | **11.9** | **11.9** | 35.2 |
| th (CER) | 10.9 | 13.5 | 16.6 | 21.0 |  |  |  | **9.2** |  | 45.1 | 12.9 | 12.9 | 23.6 |
| fa | 28.8 | 25.3 | 22.4 | 27.5 |  |  |  | 72.8 |  | 81.6 | **19.5** | **19.5** | 50.9 |
| he | 105.3 | 100.0 | 29.6 | 51.4 |  |  |  | 103.3 |  | 70.0 | **27.2** | **27.2** | 43.2 |
| sw | 100.0 | 100.0 | **11.0** | 21.3 |  |  |  | 107.0 |  | 96.6 | 29.9 | 29.9 | 79.3 |
| bn | 39.6 | 29.6 | **20.0** | 36.2 |  |  |  | 106.9 |  | 111.6 | 113.5 | 99.4 | 129.9 |
| ur | 55.5 | 73.2 |  | 89.7 |  |  |  | 100.5 |  | 78.3 | 62.5 | **24.2** | 82.5 |
| ta | 64.8 | 59.8 |  | **50.8** |  |  |  | 137.1 |  | 98.8 | 76.2 | 71.1 | 82.4 |
| ms | 39.7 | 30.3 |  | 35.4 |  |  |  | 35.0 |  | 51.5 | **10.4** | 11.4 | 24.6 |
| tl | 30.9 | 31.5 |  | 21.0 |  |  |  | 47.0 |  | 44.5 | **12.4** | **12.4** | 31.2 |
| yue (CER) | 23.9 | 17.3 |  | 26.8 |  |  |  | **5.8** | 36.6 | 42.5 | 14.1 | 33.4 | 28.2 |
| ca | 100.0 | 99.4 |  | 18.7 |  |  |  | 81.3 |  | 51.2 | 14.6 | **6.6** | 36.4 |
| ne | 64.5 | **44.8** |  | 45.5 |  |  |  | 108.2 |  | 140.5 | 101.4 | 96.4 | 122.9 |

| Model | Languages run | Median ms per clip | Real-time factor |
|---|---|---|---|
| dolphin-base-int8 | 32 | 138 | 0.012 |
| dolphin-small-int8 | 32 | 324 | 0.028 |
| omnilingual-1b-v2-int8 | 25 | 2729 | 0.24 |
| omnilingual-300m-v2-int8 | 32 | 1033 | 0.091 |
| paraformer-zh-int8 | 1 | 139 | 0.016 |
| parakeet-tdt-0.6b-v2-int8 | 1 | 499 | 0.047 |
| parakeet-tdt-0.6b-v3-int8 | 12 | 507 | 0.047 |
| qwen3-asr-0.6b-int8 | 32 | 1428 | 0.124 |
| sensevoice-int8 | 5 | 224 | 0.021 |
| whisper-base-q5_1 | 32 | 148 | 0.018 |
| whisper-large-v3-turbo-q5_0 | 32 | 768 | 0.081 |
| whisper-large-v3-turbo-q5_0 (lang given) | 32 | 778 | 0.076 |
| whisper-small-q5_1 | 32 | 296 | 0.03 |

## Speech synthesis

| Language | Human recording | Model · voice: round-trip CER % (real-time factor) |
|---|---|---|
| en | 2.3 | supertonic-3 · M1: 1.5 (0.136); supertonic-3 · F1: 2.6 (0.182); multilingual-voice · female-higher: 2.6 (0.14); kokoro-multi-lang-v1_1 · en-maple: 9.6 (0.218); kokoro-multi-lang-v1_1 · zh-f14: 10.2 (0.21); melo-tts-zh-en · melo: 22.2 (0.185) |
| zh | 6.7 | kokoro-multi-lang-v1_1 · zh-f14: 9.7 (0.224); multilingual-voice · female-higher: 9.7 (0.228); kokoro-multi-lang-v1_1 · zh-m06: 10.3 (0.238); kokoro-int8-multi-lang-v1_1 · zh-f14: 10.3 (0.709); kokoro-int8-multi-lang-v1_1 · zh-m06: 10.3 (0.664); melo-tts-zh-en · melo: 11.3 (0.178) |
| es | 0.3 | supertonic-3 · F1: 0.0 (0.172); multilingual-voice · female-higher: 0.3 (0.134); supertonic-3 · M1: 0.9 (0.133) |
| fr | 5.0 | supertonic-3 · M1: 0.7 (0.134); supertonic-3 · F1: 2.0 (0.168) |
| de | 0.3 | supertonic-3 · M1: 0.2 (0.134); supertonic-3 · F1: 0.5 (0.159) |
| ja | 6.4 | supertonic-3 · F1: 1.2 (0.151); multilingual-voice · female-higher: 1.6 (0.137); supertonic-3 · M1: 3.6 (0.135) |
| ko | 3.9 | supertonic-3 · M1: 1.7 (0.133); supertonic-3 · F1: 2.6 (0.151) |
| ru | 0.0 | supertonic-3 · F1: 0.0 (0.148); supertonic-3 · M1: 0.0 (0.133) |
| ar | 2.7 | supertonic-3 · F1: 7.6 (0.149); supertonic-3 · M1: 9.4 (0.13) |
| hi | 9.7 | supertonic-3 · F1: 5.8 (0.136); supertonic-3 · M1: 7.2 (0.131) |
| pt | 3.1 | supertonic-3 · F1: 1.2 (0.141); supertonic-3 · M1: 1.9 (0.127) |
| it | 0.2 | supertonic-3 · F1: 0.2 (0.139); supertonic-3 · M1: 0.2 (0.133) |
| vi | 2.6 | supertonic-3 · F1: 18.8 (0.138); supertonic-3 · M1: 40.5 (0.13) |
| id | 1.9 | supertonic-3 · M1: 0.2 (0.134); supertonic-3 · F1: 0.7 (0.144) |
| tr | 2.8 | supertonic-3 · F1: 1.3 (0.136); supertonic-3 · M1: 2.5 (0.134) |
| nl | 1.3 | supertonic-3 · M1: 0.4 (0.134); supertonic-3 · F1: 1.7 (0.137) |
| pl | 4.1 | supertonic-3 · F1: 2.7 (0.136); supertonic-3 · M1: 3.1 (0.131) |
| uk | 4.5 | supertonic-3 · F1: 3.3 (0.133); supertonic-3 · M1: 4.0 (0.132) |
| sv | 8.4 | supertonic-3 · M1: 4.8 (0.131); supertonic-3 · F1: 5.6 (0.135) |
| el | 3.2 | supertonic-3 · F1: 1.3 (0.132); supertonic-3 · M1: 4.8 (0.128) |
| th | 18.3 | mms-tha · mms-tha: 25.3 (0.119); multilingual-voice · female-higher: 94.4 (0.144) |
| fa | 7.9 | multilingual-voice · female-higher: 19.7 (0.138); supertonic-3 · F1@en: 20.5 (0.234); supertonic-3 · F1@ar: 23.7 (0.159) |
| he | 6.9 | supertonic-3 · F1@ar: 83.6 (0.169); multilingual-voice · female-higher: 83.8 (0.142) |
| sw | 8.1 | supertonic-3 · F1@id: 5.6 (0.173); supertonic-3 · F1@en: 7.5 (0.169); multilingual-voice · female-higher: 9.4 (0.145) |
| bn | 38.9 | coqui-bn · coqui-bn: 47.9 (0.169); multilingual-voice · female-higher: 94.4 (0.143) |
| ur | 9.0 | multilingual-voice · female-higher: 36.2 (0.142); supertonic-3 · F1@ar: 39.6 (0.162); supertonic-3 · F1@hi: 40.3 (0.158); supertonic-3 · F1@en: 40.9 (0.162) |
| ta | 13.3 | supertonic-3 · F1@hi: 91.3 (0.166); multilingual-voice · female-higher: 94.7 (0.138) |
| ms | 2.5 | multilingual-voice · female-higher: 3.1 (0.139); supertonic-3 · F1@id: 3.1 (0.163); supertonic-3 · F1@en: 3.1 (0.168) |
| tl | 3.8 | supertonic-3 · F1@id: 6.5 (0.165); supertonic-3 · F1@es: 7.7 (0.164); multilingual-voice · female-higher: 12.0 (0.14); supertonic-3 · F1@en: 13.8 (0.165) |
| yue | 32.9 | multilingual-voice · female-higher: 42.4 (0.214); vits-yue · vits-yue: 52.5 (0.167) |
| ca | 4.6 | supertonic-3 · F1@es: 7.4 (0.165); supertonic-3 · F1@en: 9.4 (0.164); multilingual-voice · female-higher: 10.0 (0.142) |
| ne | 25.8 | supertonic-3 · F1@en: 15.1 (0.173); supertonic-3 · F1@hi: 15.5 (0.167); multilingual-voice · female-higher: 16.6 (0.149) |

## Short acceleration check after takeover

On the same English clip, SenseVoice took 211/211/223 ms with CPU and
211/212/219 ms when CoreML was requested. The latter run explicitly logged
`Fallback to cpu!`; these are two CPU runs, not a GPU speed comparison.
Logs and outputs were saved under `/tmp/voicekit-provider-check`.

A separate three-request smoke check confirmed Whisper turbo's actual `metal`
accelerator on English, Mandarin and Spanish: 735, 717 and 743 ms. The multilingual
English/Spanish voice reply synthesized in 587 ms. These checks used a temporary
server and existing model files, with no downloads or live-server changes.

## Qwen tempo and sampling smoke check (2026-11-14)

Apple Silicon M6, existing Qwen3-TTS 0.6B CustomVoice GGUF Q4 weights, Serena,
explicit Chinese, with the native worker reporting Metal. The input was
“你好，我们用同一个声音，平静地读完这句话。” No model downloads were needed.

WSOLA 0.3.0 is compiled into the server for GGUF and MLX output only. A speed of
1 bypasses it and retains the exact original PCM allocation. Synthetic tone
checks covered 0.5, 0.8, 1.2, 1.5 and 2: sample rate stayed at 24 kHz, the
220 Hz test tone stayed within 5 Hz, duration stayed within an 80 ms boundary
tolerance, and the final sound survived. Silence, tiny fragments and invalid
parameters were checked separately.

One existing speech sample was processed without rerunning the model:

| Speed | Audio duration | Processing time |
| --- | --- | --- |
| 1 | 4.240 s | bypass |
| 0.8 | 5.300 s | 32.3 ms |
| 1.25 | 3.392 s | 20.4 ms |

These are single local spot checks, not cross-platform performance promises.
Changing tempo does not reduce model generation time. The sped-up and slowed
samples both transcribed to the complete original words with the already-running
Whisper recognizer; this is a content smoke check, not a listening-quality score.

For sampling, the worker passed `speaker=serena` and `language=chinese` throughout.
Main-talker temperatures 0.9 and 0.7 with seed 42, and 0.7 with seed 43, all
produced the original words when transcribed. Repeating 0.7/42 after the other
requests produced byte-identical PCM. The GGUF worker now uses main-talker
temperature 0.7 and seed 42 by default; the acoustic sub-talker keeps its upstream
settings. MLX sampling is unchanged. Deterministic repeats do not establish that
speaker identity stays equally stable across different texts or languages; that
still needs listening evaluation.

## Real-model CPU checks for 0.1.1 (2026-11-14)

`scripts/smoke-real-models.py` runs short real inference against an unpacked native
package, never installed into Paseo, with `--accelerator cpu`. It downloads only the pinned
built-ins it uses. CPU is intentional for portable CI; on Macs, CPU workers now skip Metal
initialization, so every report entry says `device=cpu`. GPU inference is not covered.

Models on every platform: Whisper base (Q5_1), Qwen3-ASR 0.6B (int8), Supertonic 3 and
Qwen3-TTS 0.6B GGUF (Q4). Linux x64 and Windows also run Qwen3-TTS 1.7B GGUF (Q8). Checks:
mono 16-bit audio that isn't silent; an English Whisper round trip; Qwen3-TTS 0.6B Chinese
at speed 1 and 1.25 (duration); Qwen3-ASR English and Chinese content with no control
markers in the text; and, on the two x64 platforms, a Qwen3-TTS 1.7B Chinese tempo and ASR
round trip. Qwen3-ASR decodes a `language …<asr_text>` header before the transcript; since
`3d1ae47` the server keeps only the text after it (for that family only), and the checks
require no such marker.

| Platform | Source | Model checks | Model suite time |
| --- | --- | --- | --- |
| darwin-arm64 | `6ef5128` | 4 | 169.61 s |
| linux-arm64 | `6ef5128` | 4 | 134.44 s |
| linux-x64 | `6ef5128` | 5 | 129.95 s |
| win32-x64 | `55d84e2` | 5 | 134.31 s |
| darwin-x64 | `55d84e2` | 4 | 235.89 s |

Qwen3-TTS 0.6B durations at speed 1 and 1.25: darwin-arm64 3.12 → 2.496 s, linux-arm64
3.04 → 2.432 s, linux-x64 2.4 → 1.92 s, win32-x64 2.72 → 2.176 s, darwin-x64 2.64 →
2.112 s. Qwen3-TTS 1.7B: linux-x64 2.16 → 1.728 s, win32-x64 2.56 → 2.062 s (the check
allows 80 ms). The Whisper base transcript on Linux arm64 was "Hello, this is as a speech
test.", close to but not exactly the input; the earlier repeated-word output didn't recur.

Linux arm64: ggml's SVE dot products dropped accumulated tail lanes, giving wrong results on
CPUs with SVE. `6ef5128` keeps them, and `scripts/test-sve-dots.py --require-sve` checks the
packaged kernels against exact scalar results: 3 compatible variants (armv8.2_3,
armv8.6_1, armv8.6_2), 22 checks each, 16-byte SVE width, none skipped.

These were separate manual runs, not one all-green run. The first full run failed: a
Windows test fixture read a non-blocking accepted socket (fixed in `55d84e2`, a
test-only change), and an Intel Mac model download timed out before inference. Both then
passed in focused runs. The tagged 0.1.1 release must pass its own gates. The checks are
short content and timing checks in English and Chinese, not quality scores for every
language, and the times are from shared CI runners.

