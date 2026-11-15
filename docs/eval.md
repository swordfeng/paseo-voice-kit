# Speech model evaluation

## Windows Vulkan 0.6B Q4 compatibility check

Native Windows 11 x64, Ryzen 5950X, RTX 5090, NVIDIA 616.56, 2026-11-14.
The 0.1.1 candidate at `55d84e20c2913bc8858468686d0d396f7d1f3a1f`
used qwentts.cpp `f1a6924789883bd92eeb59176793a94af55730b3` and ggml
`0d403add5cb6329935290f02462e1072045aacd2`.

Whisper base and Qwen TTS 1.7B Q8 generated correct speech using Vulkan.
Qwen TTS 0.6B Q4 loaded on Vulkan but exhausted all 1200 frames rather than
ending normally: 2,304,000 samples at 24 kHz, exactly 96 seconds of rejected
audio. The worker's existing error combines empty and token-limited audio;
the sample-count diagnostic establishes that this case was token exhaustion.

Single-variable tests kept the original package, model, input and seed:

| Vulkan setting | Chinese short sentence |
|---|---|
| Default | HTTP 503, token limit reached |
| Disable coopmat2 | Same failure, 18.562s inference wall time |
| Disable F16 | Same failure, 24.032s inference wall time |
| Disable MMVQ | Correct 2.640s speech, 0.907s inference wall time |

This isolates the failing MMVQ execution/activation-conversion path, without
proving a particular shader defect or FP16 overflow. Talker prefill taps and
the first three talker logits were finite in an instrumented control; those
taps do not inspect the code predictor's direct graph. The MMVQ path converts
F32 activation vectors to Q8_1; disabling it retains float-vector matvec on
Vulkan. Flash attention remains enabled.

The compatibility workaround is confined to Windows Qwen workers requesting a
GPU, when talker GGUF metadata identifies a 1024-wide Qwen3-TTS model containing
Q4_K tensors. It is set before backend initialization and does not use filename
matching. Explicit disable/force environment variables are preserved using
ggml's presence-based semantics. The current 1.7B Q8 model is not matched.
This is a bounded workaround verified on this host, not a general kernel fix.

The final native regression (`scripts/smoke-real-models.py --accelerator auto
--expect-gpu --large-qwen --no-downloads`, with explicit model/output paths)
completed in 17.74s. Actual device metadata and native logs confirmed Vulkan
for Whisper and both Qwen GGUF models. Both Qwen models passed English/Chinese
ASR content read-back and byte-identical repeated fixed-seed Chinese output.
The 0.6B Chinese audio was 2.640s at speed 1 and 2.112s at speed 1.25; 1.7B was
2.000s and 1.608s. These are short correctness checks, not benchmark rankings.
Each inference was bounded at 60 seconds and the full run at 300 seconds.
CPU regression retained the original 0.6B WAV output. No microphone or human
playback assessment was performed.

The candidate's sherpa runtime separately reports only CPUExecutionProvider
and falls back to CPU for explicit CUDA/DirectML requests. Those models are
not counted as GPU successes; this worker workaround does not add ONNX GPU
providers. Complete host-specific logs and samples remain in the independent
Windows validation directory rather than the repository or model-selection UI.

## Mac multilingual evaluation

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

### Windows process memory accounting

Mac integration check after merging the Windows fixes with first-use loading:
46 native tests passed (3 fixture tests ignored); the real VAD and missing-detector
recovery fixtures were then run explicitly and passed. Type checking, behavior suites
and plugin package verification passed. Four real-model checks completed in 11.03 s
on Apple M6 with no downloads: Whisper base and Qwen TTS used Metal, Qwen ASR and
Supertonic used CPU. Each server started with its configured engines unloaded but
available; first requests succeeded. Qwen ASR preserved the Chinese fixture after
40 and 100 seconds of leading silence. Qwen TTS speed 1/1.25 and repeated-seed
checks passed. This is a short integration smoke, not a fresh Windows hardware run.

Voice Kit's host status now samples Windows working sets and per-process GPU
memory through read-only CIM queries, without requiring `nvidia-smi`, an
administrator token, or a separate runtime installation. It sums the speech
server's process tree plus the plugin process once, excluding the Paseo daemon,
other agents/plugins and the PowerShell sampler. Creation times reject descendants
whose parent PID has been reused. One hidden, bounded PowerShell process collects
both snapshots; requests share a pending sample and a ten-second cache. A replaced
server PID invalidates both RAM and GPU data.

`memoryBytes` is the sum of resident working sets (RSS-style accounting, not
unique/private bytes). `gpuMemoryBytes` and `gpuSharedMemoryBytes` respectively
sum `DedicatedUsage` and `SharedUsage` from
`Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory`, restricted
to those same owned PIDs across adapters. `gpuMemorySource` identifies the
Windows process counters. Shared GPU system RAM is never presented as dedicated
VRAM or added to RSS. These are OS-reported process counters, not whole-device
usage or guaranteed unique physical allocations; shared allocations can appear
in more than one process, and provider refresh can lag model loading. Missing
providers, failed queries or invalid measurements yield null, whereas a successful
query with no owned GPU allocations yields zero. Other platforms keep their
existing RAM collectors and report GPU process accounting unavailable.

Native Windows 11 / RTX 5090 spot check: idle TTS process tree reported
1,463,795,712 bytes RAM and 270,336 dedicated GPU bytes. A short Chinese Qwen
Vulkan synthesis increased both, and its daemon dictation round trip returned
the complete input. After the counters settled, the plugin returned
2,547,732,480 RAM bytes, 2,218,504,192 dedicated GPU bytes and 17,379,328 shared
GPU bytes. An independent Windows query matched both GPU totals exactly and
reported 2,548,121,600 working-set bytes (sampling-time difference). Two
authenticated clients read identical cached measurements. Type checking and the
behavior suites passed, including process ownership, multiple adapters,
unavailable/empty counters, overflow, coalescing and PID invalidation.

The sidebar keeps devices and memory on separate lines so the figures are not
dropped to fit its 120-pixel status slot. With active GPU execution, measured
Windows dedicated memory and discrete-only device metadata, memory is shown as
dedicated GPU bytes + resident bytes, in that order. iGPU/unified, hybrid or
unknown device metadata, missing GPU counters and CPU-only execution retain one
resident-memory figure; shared GPU memory is never added to it. These are separate
accounting figures, not a newly calculated total. The classification follows the
service host's devices, not the client OS. English/Chinese summary regressions
cover this order and the single-value cases, plus exception-state precedence.

### Qwen3-ASR idle microphone regression (native Windows)

A 2.8-second Chinese fixture asking whether the fix can be pushed was correctly
recognized without padding. With the same weights and input on CPU, 40 seconds
of leading silence produced empty text (4.969 seconds wall time); 100 seconds
produced the literal `language` (8.734 seconds). These are controlled recordings,
not retained microphone audio from the original incident. Session logs showed
104.32 and 47.872 seconds uploaded for speech intervals of about 4.33 and 3.33
seconds; upload duration must not be confused with recognition wall time.

Qwen3-ASR now uses the existing Silero speech filter before recognition, retaining
the first-to-last speech span, all internal pauses and 300 ms boundaries. It does
not change transcript parsing or suppress the ordinary word `language`. Other
Sherpa families are unchanged. The shared dependency predicate covers loading,
installed state and download dependencies, including custom Qwen entries. Startup
downloads notify recovery so an early missing-VAD failure does not remain cached
after the dependency arrives; unused engines remain unloaded. Offline installations need the small
Silero model in the private model directory or a configured reuse directory.

On the same native Windows machine, filtered 40/100-second leading-silence cases
returned the complete Chinese sentence in 1.079/1.531 seconds. Trailing silence,
a partial final VAD block, English, short Chinese/English, quiet speech (peak
0.030 and 0.00897), a three-second internal pause, silence/noise followed by valid
speech, and concurrent requests passed. Missing-detector recovery passed using
installed ASR weights, without restarting the process. The 100-second padding
cases are also covered by `scripts/smoke-real-models.py`.

The final CPU core-model smoke took 18.31 seconds. The GPU regression took 17.59
seconds with actual Vulkan Whisper and Qwen TTS 0.6B/1.7B, repeated-seed and speed
checks; Qwen ASR and Supertonic remained on CPU. The running plugin's real daemon
dictation interface recognized the padded Chinese fixture and English, and its
preview RPC synthesized both languages. No microphone/playback listening test was
performed. This mitigates the recognizer failure; it does not repair Paseo's
recording-buffer lifecycle or remove earlier speech/assistant echo inside a buffer.
Later real-session follow-ups still returned `language` and intermittently stalled
recording/detection. Those issues remain unresolved. A separate cross-client settings
display discrepancy recovered after plugin reload, with no settings-sync code fix.

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

Linux arm64: ggml's SVE dot products dropped accumulated tail lanes, which made Whisper
repeat words on CPUs with SVE. A diagnostic run before the fix (43600845463) showed the
cause: with the same archive and weights, the SVE build transcribed the English sample as
"Hello, this is Speech Speech Speech …", while forcing the non-SVE `armv8.0_1` variant
passed all four checks with the exact English text, and an exact dot product of length 1500
returned 1304 instead of 1500. `6ef5128` keeps the tail lanes, and `scripts/test-sve-dots.py --require-sve` checks the
packaged kernels against exact scalar results: 3 compatible variants (armv8.2_3,
armv8.6_1, armv8.6_2), 22 checks each, 16-byte SVE width, none skipped.

These were separate manual runs, not one all-green run. The first full run failed: a
Windows test fixture read a non-blocking accepted socket (fixed in `55d84e2`, a
test-only change), and an Intel Mac model download timed out before inference. Both then
passed in focused runs. The tagged 0.1.1 release must pass its own gates. The checks are
short content and timing checks in English and Chinese, not quality scores for every
language, and the times are from shared CI runners.
## First-use model loading (2026-11-14)

Local Apple M6 check with the release build (`coreml` feature, Neural Engine disabled,
automatic acceleration): installed models remain unloaded at startup and are available
to receive their first request. Status queries, download completion, recovery ticks and
optional encoder completion leave unused models unloaded. Existing idle unloading remains.
The native suite passed 46 tests (2 local fixture tests ignored).

An isolated server with Whisper turbo Q5 and Supertonic 3 stayed unloaded through status
queries and a two-second idle check. Server RSS was 42.6 MB. One short English synthesis
followed by transcription returned the expected sentence; Whisper used Metal. First
recognition took 0.83 s including 147 ms loading. This is one smoke sample, not a latency
benchmark.

After deploying the same binary and reloading the live plugin, total reported RSS was
342 MB (plugin process plus speech server and owned workers), with STT and TTS unloaded
and all three speech sites active. Plugin preview plus the configured dictation endpoint
completed an English round trip; first recognition took 1.32 s including 201 ms loading,
using Metal. Preferences were unchanged. The plugin was reloaded again after verification
to leave the installation unloaded; its final reported total was 305 MB, with all three
speech sites active. These observations do not revalidate other platforms.

## Shared ASR speech filtering (2026-11-14)

Silero filtering wraps local whole-utterance recognizers at the runtime boundary,
rather than being duplicated inside Whisper and Qwen's Sherpa adapter. It initially
used a family whitelist, then was made the default for all local ASR (Whisper and
every Sherpa ASR family, including custom models). The whitelist reflected limited
test coverage, not an observed incompatibility. Remote services keep their original
input. Existing 300 ms edge padding and internal pauses are unchanged. The filter
shares its recognizer's first-use load and idle unload. Native dependency checks
cover all catalogued local ASR, unknown custom families, and exclusion of TTS,
remote services and the internal VAD resource. Actual model checks below cover
Whisper, Qwen ASR, SenseVoice and Paraformer; other models were not inferred anew.

Apple M6, no downloads: compared the previous unfiltered SenseVoice int8 and custom
Paraformer zh-small against the wrapped recognizers using the same local TTS WAVs.
Seven baseline cases covered Chinese, a quiet Chinese copy rescaled to peak 0.03,
short Chinese “可以。”, and English on SenseVoice. All seven normalized transcripts
matched after filtering. Four additional checks passed: each model recognized the
Chinese clip with 40 seconds leading and 10 seconds trailing silence, and the short
clip with 10 seconds leading and 2 seconds trailing silence. Each isolated server
started with recognition unloaded but available. The run had a 120-second budget
and normal request timeouts; no transfer, timeout or microphone capture occurred.

The 46 native tests passed (3 fixture tests ignored). Real VAD/adapter and Qwen
missing-dependency recovery fixtures were also run explicitly and passed. The adapter
fixture verifies that silence/noise skip the recognizer, speech still passes after
rejection, language/prompt and accelerator are retained, and timing stages survive.
These short synthetic-speech samples do not establish recall for every language,
whispered speech, brief interjections or difficult background noise.

The existing four-core-model integration smoke also passed in 10.77 seconds:
Whisper base and Qwen TTS used actual Metal, Qwen ASR and Supertonic used CPU.
Qwen ASR's 40/100-second silence regressions, TTS repeated seed and speed checks
passed. This was a local Mac check, not a new Windows or Linux hardware run.

## Native Swift MLX worker experiment (2026-11-14)

`server/mlx-worker` is a standalone feasibility experiment, not the production
MLX engine. It reuses the framed stdin/stdout protocol with a persistent Swift
process. Rust worker selection, installation, dependency notices and the Python
setup flow have not been migrated. No running plugin or user settings changed.

The build pins `Neywa-Labs/mlx-audio-swift` to
`209e1cb45498c5b7b4b96d417f9b15fe71d440f5`, MLX Swift to 0.33.0, and transitive
dependencies in `Package.resolved`. It built in release mode with Xcode 27.2 /
Swift 6.4.2 and the Metal Toolchain on the local Apple M6 Mac. The native worker
does not launch Python. MLX's generated Metal resource bundle must accompany it.

All weights were already installed. Tests used private APFS clones because the
upstream Swift loader may write tokenizer files or clear a malformed cache
directory. The user's model folders were not passed to that loader. The worker
validates the speech-tokenizer directory before loading. A malformed-directory
fixture returned a framed error and preserved its sentinel/tokenizer files.
The worker requires MLX's GPU
default device, reports Apple M6 / `metal`, and completed real GPU inference;
creating a Metal device alone was not treated as a successful test.

`server/mlx-worker/smoke.py` runs one owned worker at a time, with a 60-second
startup budget, 60 seconds per utterance and 10 seconds to exit on stdin EOF.
Failure terminates that worker's process group. It saves framed-protocol results,
WAVs and stderr. Swift and the existing private Python worker (`mlx-audio` 0.6.5)
used the same 0.6B 4-bit CustomVoice weights, Serena, explicit English/Chinese,
0.4-second chunk intervals and a 1200-token ceiling. Sampling settings were
temperature 0.9, top-k 50, top-p 1 and repetition penalty 1.05. No seed or
bit-identical parity was assumed. Swift additionally requires the configured EOS
token: the upstream text-length-dependent generation cap must not silently
produce a successful truncated clip.

The phrases were “Hello, this is a speech test.” and “你好，这是一个语音测试。”.
Both workers' saved WAVs were transcribed correctly by an isolated native
Qwen3-ASR server with the shared VAD filter. Swift also passed one English sample
with 0.6B 8-bit and 1.7B 4-bit weights. Every tested worker exited successfully on
EOF; repeated Swift launches completed without retaining the old worker process.

These are single short observations, not a statistically controlled benchmark.
The 0.6B 4-bit comparison after the first Swift execution was:

| Worker | Language | Audio seconds | First PCM chunk seconds | Complete PCM seconds |
| --- | --- | ---: | ---: | ---: |
| Python | English | 3.12 | 0.299 | 1.263 |
| Python | Chinese | 2.72 | 0.165 | 0.995 |
| Swift | English | 2.88 | 0.215 | 1.487 |
| Swift | Chinese | 3.28 | 0.203 | 1.323 |

Python startup was 2.081 seconds; the restarted Swift worker took 0.259 seconds.
After these requests, Python RSS was about 1.95 GB and Swift RSS about 1.83 GB.
RSS is not total unified-memory use: Swift separately reported about 2.41 GB peak
MLX active allocation, and these counters must not be added together. First-chunk
time is worker output timing, not application playback latency. Output lengths
differ because sampling and implementation differ.

The **first-ever Swift execution** was substantially slower: 2.018 seconds to
load, 8.457 seconds to first PCM and 10.414 seconds to complete a 5.76-second
English clip. A later fresh-process check using the retained smoke harness also
took 6.352 seconds to first PCM and 7.533 seconds to finish a 2.88-second clip,
despite loading in 0.548 seconds. Its Python counterpart took 0.184 seconds to
first PCM and 1.004 seconds to finish a different, 2.64-second sample. Swift's
startup/request latency therefore remains inconsistent. Cache state was not
controlled and the source of these stalls was not traced; the faster observation
must not be advertised as representative cold-start latency.
The additional 0.6B 8-bit and 1.7B 4-bit English clips took 1.755 and 1.049
seconds to finish, respectively, with different generated durations. These
samples do not establish a performance ranking between model sizes.

The experiment establishes that a separate native Swift worker can reuse these
weights and remove Python from this inference path. It does not establish
voice-quality parity, long-text reliability, every speaker/language, minimum-OS
compatibility or production packaging. The community Qwen implementation remains
a dependency to pin and validate; this result is not a claim of library maturity.
Follow-up instrumentation and a controlled cold-compilation comparison are
recorded below.

### Existing GGUF versus Python MLX: fresh-worker spot check

A subsequent bounded comparison used the installed production GGUF worker and
the existing Python MLX worker, one at a time on the same M6, with 0.6B
CustomVoice 4-bit models, Serena and the same English/Chinese phrases above.
Both workers reported actual Metal. Each was newly launched, but OS file and
shader caches were not cleared. The first request was English, followed by
Chinese in the same worker. These are production defaults: GGUF uses temperature
0.7 / seed 42, while Python MLX uses its existing sampling configuration.
Q4_K_M and MLX affine 4-bit are different quantizations, and their codec weights
also differ; this does not isolate framework overhead alone.

| Worker | Load seconds | First English complete seconds, excluding load | Load plus first English seconds | English audio seconds | RSS after English |
| --- | ---: | ---: | ---: | ---: | ---: |
| GGUF C++ | 1.553 | 1.271 | 2.824 | 2.96 | 2.866 GB |
| Python MLX | 1.297 | 1.028 | 2.325 | 2.80 | 1.950 GB |

The Chinese requests took 1.151 seconds (GGUF, 2.88 seconds of audio) and 1.164
seconds (Python MLX, 3.20 seconds of audio). Python MLX emitted its first English
PCM chunk after 0.178 seconds excluding load. The current GGUF wrapper emits one
complete PCM frame after synthesis, so its first-chunk and completion times are
effectively identical. The application currently collects full MLX audio too;
worker first-chunk timing is not user playback latency.

Memory uses the same `ps` RSS counter for each worker alone, in decimal GB,
excluding the common plugin/server overhead. These snapshots are not peak or
unique physical/unified-memory measurements and must not be added to GPU
allocation counters. GGUF logged a 4096-position talker KV cache of 896 MB before
any request, illustrating why a smaller quantized file need not have lower
runtime RSS. No cache configuration was changed. Both workers exited on EOF.

A separate Qwen3-ASR read-back matched both Chinese samples and the Python
English sample. It rendered the GGUF English sample as “Hello. This is output
speech test.”; this round trip was not exact and does not identify whether TTS
or ASR caused the discrepancy. These timings are not a speech-quality comparison.

In this single fresh-worker sample, Python MLX completed the first utterance
slightly sooner and had lower RSS. This does not establish a universal speed or
memory ranking, nor does it reproduce the separate Swift first-request stalls.

Source inspection clarified the cache comparison: the GGUF talker allocates
FP32 K/V tensors for 4096 positions and immediately clears the entire backend
buffer. The selected shared Metal path implements this as `memset` over the whole
allocation, so it is not merely an untouched virtual-address reservation. Reset
only rewinds sequence length; it does not release this buffer. The log labels
896 "MB", but its divisor is 1024 squared: the capacity is actually 896 MiB.

The installed Python MLX implementation grows KV capacity in 256-position blocks
and preserves the incoming tensor dtype. A separate GPU prefill-only probe
(30-second process budget, deliberately stopped at the first KV update) observed
both K and V as **bfloat16**, shape `[1, 8, 19, 128]`. This verified dtype without
generating a long utterance. At equal batch, architecture and 4096 positions,
raw talker K/V payload would therefore be 896 MiB for the current FP32 GGUF
implementation and 448 MiB for BF16 MLX. This is a tensor-size calculation, not a
measured full-context process-memory comparison. Equal dtype and dimensions
would give equal raw KV payload, independent of the framework.

Valid-token occupancy, live allocation, allocator-reusable cache, and OS RSS are
different concepts. The 0.916 GB RSS difference above does not establish an
intrinsic 32% memory advantage for MLX at every sequence length, nor was its
entire difference attributed experimentally to KV alone.

### Swift follow-up: cold Metal compilation and token budget

The earlier stalls were investigated rather than treated as evidence that Swift
cannot run the model. This remained an isolated experiment on the M6; the live
plugin and its Python runtime were not switched. Its Python MLX version is
0.32.4, while the Swift package uses MLX 0.33.0, so neither runtime nor cache
history was identical in the earlier cross-framework comparison.

Opt-in worker diagnostics now record first token, audio arrival and generation
time on stderr without logging request text. `VOICEKIT_MLX_SEED=42` explicitly
seeds the MLX random state before each request. The pinned Qwen Swift path does
not itself forward `GenerateParameters.seed`, so setting that field alone would
not provide controlled sampling. The persistent worker still processes requests
serially and exits on EOF.

A real failure also appeared during profiling: the Chinese short phrase hit
exactly 75 generated tokens without EOS. Upstream silently reduced the caller's
1200-token budget to `min(maxTokens, max(75, textTokenCount * 6))`. The worker
correctly reported truncation. The tracked
`respect-requested-token-limit.patch` removes this text-length heuristic and
honors the explicit caller budget. The build helper checks the immutable source
revision and applies this patch idempotently. The 1200-token ceiling, EOS guard
and parent process deadlines remain; removing the heuristic does not guarantee
that every possible input will terminate correctly or retain speech quality.

An optional C++ diagnostic patch timed MLX Metal source-library compilation and
slow pipeline creation. To exercise a cold source-cache path without deleting
shared system caches, it added a process-unique comment to runtime-generated
Metal source. Kernel operations, weights, prompt and seed were unchanged. This
was a deliberate cache-miss experiment, **not normal production timing**.

| Fixed-seed English experiment | Metal compilation logged after request | First PCM seconds | Complete PCM seconds | Audio seconds |
| --- | ---: | ---: | ---: | ---: |
| Existing source cache | 0.017 s | 0.172 | 1.024 | 2.80 |
| Unique-comment cold source | 5.701 s | 5.850 | 6.735 | 2.80 |

Both saved WAV files were byte-identical (SHA256
`350dc732b9e1f42931a8b2d7e6e93f167f50ac4f6cb2ff5345614730af4cff21`).
The cold run spent about 3.73 seconds before its first generated token; additional
decoder kernels compiled before the first audio chunk. Thus cold Metal
compilation demonstrably causes a stall of the same scale as the earlier
observations, without changing the output. The historical slow runs had no such
trace, so this is strong support for that explanation rather than proof that
every earlier or future stall has the same cause. Shared OS caches were left
intact. Disabling MLX graph compilation was also tried: first PCM was 0.496 s and
completion 1.357 s in that check, with new unfused-kernel compilation; it did not
improve the measured first request and was not adopted.

The diagnostic C++ changes were then reversed, the original MLX checkout was
verified clean, and the normal worker was rebuilt with only the token-budget
patch. Two fresh worker processes, each seeded 42 per request, completed:

| Normal build | Load seconds | English first / complete seconds | Chinese first / complete seconds |
| --- | ---: | ---: | ---: |
| Process A | 0.656 | 0.165 / 0.954 | 0.137 / 1.180 |
| Process B | 0.285 | 0.194 / 1.199 | 0.174 / 1.389 |

Both used actual Metal, produced byte-identical corresponding WAVs across
processes, and exited on EOF. Qwen3-ASR read the English and Chinese samples back
correctly. Post-request worker RSS was about 1.83 GB. Model weights were private
copies; no download, global cache purge or long-model stress run occurred.

This supports continuing with a native persistent Swift worker. Cold compilation
cost remains possible after a cache miss or version/device change; ordinary
fixed-seed fresh-process requests in the final checks were fast. No model warmup
was added to application startup. Production packaging, runtime selection and
removal of the Python setup flow remain separate implementation work.

## Bundled native MLX migration (2026-11-15)

The production MLX path now uses the bundled Swift worker. The Python worker and
installer were removed. Native packages include the Metal library, resource
bundles, relocated Swift compatibility dylibs and upstream notices. Model weights
remain separate. The pinned loader additionally constructs tokenizers in memory
and never writes or removes model directories. Generation defaults to seed 42.

47 native tests passed (3 local-fixture tests ignored), as did plugin typechecking,
behavior checks, four Python build tests, plugin-package compilation and native
archive extraction/dependency checks. The four-core-model smoke passed in 12.51 s;
Whisper and GGUF used Metal. The new bounded native HTTP check passed from both
the relocated archive and installed binaries with Python paths disabled: English
and Chinese round trips, repeat-identical audio, and speed 1.25 (2.80 to 2.24 s).
The model began unloaded. A private model clone without tokenizer.json had
read-only permissions and its file inventory/metadata remained unchanged.
Additional single English samples from 0.6B 8-bit and 1.7B 4-bit weights ran on
Metal and transcribed correctly. The first newly packaged run still showed cold
compilation delay; no startup model warmup was introduced.

Dyld diagnostics confirmed the compatibility dylib loaded from the extracted
package, with no toolchain dylib dependency. The locally built archive was about
32 MB. This was tested on M6/macOS 27; the target minimum remains macOS 14, without
a new real-device macOS 14 or remote CI run. Claude checked real client components
in a temporary harness at desktop/compact widths and light/dark themes, including
ready/error states; this was not a native-app installation E2E on other platforms.

The packaged binary and plugin sources were deployed locally with rollback copies.
The live plugin reported running, all three speech sites active, and the native
MLX helper ready. Installed-binary MLX HTTP checks and live preview/Whisper Metal
recognition passed. Plugin preferences were unchanged. A final plugin reload left
all configured models unloaded. No Paseo daemon restart, push or release occurred.

### MLX sampling adjustment (2026-11-15)

MLX initially retained temperature 0.9 while GGUF's main sampler used 0.7; both
used seed 42. After a report of added laughter/playful delivery, short MLX tests
compared temperature 0.7 and the user-approved fallback 0.6, keeping seed 42.
Both passed native Metal synthesis, repeat-identical audio, tempo and read-only
model checks. English read-back matched. Chinese read-back at 0.7 added a final
“啊”; at 0.6 it rendered “您好” rather than the input “你好”. These differences
do not distinguish synthesis errors from ASR errors, nor assess laughter.
The deployed MLX default is now 0.6/42 for audition; GGUF main sampling remains
0.7/42. Listening is required to judge whether expressiveness has improved.
The native helper was replaced with rollback retained and only the plugin was
reloaded. Existing plugin preferences were unchanged.

### Shared Qwen sampling policy (2026-11-15)

For the user's next audition, both GGUF and MLX now receive temperature 0.2 and
seed 42 from one shared request builder in `server/src/engine/mod.rs`. Workers
require those IPC fields rather than maintaining independent defaults; the MLX
seed environment override is removed. GGUF's acoustic talker now follows the same
temperature as its main talker, matching MLX's use of the generation temperature
for both. Both retain top-k 50, top-p 1 and repetition penalty 1.05.

47 native tests passed (3 local-fixture tests ignored). Short real Metal runs
passed for both backends, with identical repeated English audio in each backend.
MLX's English and Chinese read-back matched the test phrases, and tempo, initial
unloaded state and unchanged model files passed. GGUF generated valid English and
Chinese PCM; that short run did not transcribe them. These checks establish
function, not whether the lower temperature improves delivery. Both workers and
the server were deployed together with rollback copies retained; only Voice Kit
was reloaded, and saved preferences were preserved.

### Long-reply generation at temperature 0.2 (2026-11-15)

The live MLX readout of the 235-character Chinese weekend paragraph failed with
`speech token or audio limit reached`. The speech server remained up; its worker
error rejected the response rather than returning truncated audio. MLX previously
grouped up to 240 characters per generation, GGUF 160. An isolated 80-character
policy passed that paragraph on MLX but still hit the 1200-token/96-second limit
on GGUF at the same 0.2/42 sampling policy.

Both backends now share sentence-by-sentence generation with an 80-character
ceiling, clause/whitespace breaks for oversized sentences, and complete PCM
assembly. Token/audio limits and 0.2/42 are unchanged. The exact previously failed
paragraph passed on real Metal with both engines: MLX 53.04 seconds of audio,
GGUF 52.08 seconds. Read-back of each first/last 12-second excerpt included the
opening morning scene and the final weekend sentence. This checks endpoints,
not word-for-word correctness of the entire paragraph; the full clip exceeded
this Qwen-ASR ONNX export's 512-token audio context. 47 native tests passed,
3 local fixtures ignored. The server was deployed with rollback retained and
only the plugin reloaded; saved preferences were preserved.
