# Model licenses

Voice Kit's built-in models are downloaded separately from the plugin and the speech
server, from the sources below (pinned in `server/catalog.json` with SHA-256). Voice
Kit's MIT license does not cover them; each model keeps the terms its publisher set, and a
converted copy (sherpa-onnx, ggml, GGUF) keeps the original model's license. The license
texts are in [`licenses/models/`](licenses/models/).

| Model in Voice Kit | Original model and publisher | License | Downloaded from |
| --- | --- | --- | --- |
| Whisper turbo, Whisper small, Whisper base | [Whisper](https://github.com/openai/whisper) large-v3-turbo, small and base, OpenAI | MIT ([text](licenses/models/openai-whisper-MIT.txt)) | ggml conversions in [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) |
| Qwen3-ASR | [Qwen3-ASR-0.6B](https://huggingface.co/Qwen/Qwen3-ASR-0.6B), Qwen team, Alibaba Cloud | Apache-2.0 ([text](licenses/models/Apache-2.0.txt)) | sherpa-onnx int8 conversion, [k2-fsa/sherpa-onnx releases](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) |
| Parakeet v3 | [parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), NVIDIA | CC BY 4.0 ([text](licenses/models/CC-BY-4.0.txt)) | sherpa-onnx int8 conversion, k2-fsa/sherpa-onnx releases |
| Dolphin small | [Dolphin small](https://huggingface.co/DataoceanAI/dolphin-small), DataoceanAI | Apache-2.0 ([text](licenses/models/Apache-2.0.txt)) | sherpa-onnx int8 conversion, k2-fsa/sherpa-onnx releases |
| SenseVoice | [SenseVoiceSmall](https://huggingface.co/FunAudioLLM/SenseVoiceSmall), FunAudioLLM / Alibaba Group | FunASR Model License 1.1 ([text](licenses/models/FunASR-MODEL_LICENSE.txt), [source](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)) | sherpa-onnx int8 conversion, k2-fsa/sherpa-onnx releases |
| Supertonic 3 | [Supertonic 3](https://huggingface.co/Supertone/supertonic-3), Supertone Inc. | BigScience OpenRAIL-M ([text](licenses/models/supertonic-3-OpenRAIL-M.txt), [source](https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE)) | sherpa-onnx int8 conversion, [k2-fsa/sherpa-onnx releases](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models) |
| Qwen3-TTS 0.6B, Qwen3-TTS 1.7B | [Qwen3-TTS-12Hz-0.6B-CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice) and [1.7B-CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice), Qwen team, Alibaba Cloud | Apache-2.0 ([text](licenses/models/Apache-2.0.txt)) | GGUF conversions by [Serveurperso](https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF/tree/b7ee2e8c7459c3bea99da23e3d178125a7d1713c), pinned revision |
| Silero VAD (speech detection for Whisper) | [Silero VAD](https://github.com/snakers4/silero-vad), Silero Team | MIT ([text](licenses/models/silero-vad-MIT.txt)) | k2-fsa/sherpa-onnx releases |

Copyright and attribution: Whisper, Copyright (c) 2022 OpenAI. Silero VAD, Copyright
(c) 2020-present Silero Team. Supertonic 3, Copyright (c) 2026 Supertone Inc. SenseVoice
and the FunASR models, Copyright (C) 2023-2028 Alibaba Group. Parakeet v3 is published by
NVIDIA under CC BY 4.0.

## Terms to be aware of

- **Supertonic 3 (OpenRAIL-M).** Use of the model and of its derivatives is subject to the
  use-based restrictions in Attachment A of its license, for example no use that violates
  the law, harms minors, impersonates people without their consent, or presents generated
  content as not machine generated. Anyone who redistributes the model or a derivative must
  pass these restrictions on and include a copy of the license. Read the
  [full text](licenses/models/supertonic-3-OpenRAIL-M.txt).
- **SenseVoice (FunASR Model License 1.1).** Using, copying, modifying or sharing the model
  requires attributing its source and authors and keeping the model's name. The license
  also covers liability, community conduct and termination; read the
  [full text](licenses/models/FunASR-MODEL_LICENSE.txt).
- **Parakeet v3 (CC BY 4.0).** Sharing the model or adapted versions requires attribution
  to NVIDIA, a link to the license and an indication of changes.
- **MIT and Apache-2.0 models.** Keep the copyright and license notices when you
  redistribute them; Apache-2.0 also requires noting changes and keeping any NOTICE file.

These summaries are not legal advice and don't replace the license texts.

## Your own models

Models you add under "Your models" (from Hugging Face, a file, a folder or another server)
keep the terms set by their publishers. Check a model's license before you use it,
especially for commercial use.
