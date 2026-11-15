# Third-party notices

Voice Kit's original code is covered by the [MIT license](LICENSE). Third-party
code, downloaded models and evaluation data keep their upstream licenses.

## Speech engines

| Component | License | Source and notices |
| --- | --- | --- |
| whisper.cpp and its bundled ggml code | MIT | [Upstream](https://github.com/ggml-org/whisper.cpp), [license and copyright notice](licenses/whisper.cpp-MIT.txt) |
| whisper-rs 0.16.0 and whisper-rs-sys 0.15.0 | Unlicense | [Upstream](https://codeberg.org/tazz4843/whisper-rs), [license](licenses/Unlicense.txt) |
| sherpa-onnx and its Rust bindings, version 2.0.1 | Apache-2.0 | [Upstream](https://github.com/k2-fsa/sherpa-onnx/tree/v2.0.1), [license](licenses/Apache-2.0.txt) |
| qwentts.cpp, isolated GGUF speech worker | MIT | [Pinned source](server/vendor/qwen-sources/SOURCES.json), [notice](licenses/qwentts-MIT.txt) |
| GGML bundled with the GGUF worker | MIT | [Pinned source](server/vendor/qwen-sources/SOURCES.json), [notice](licenses/gguf-ggml-MIT.txt) |
| yyjson bundled with the GGUF worker | MIT | [Notice](licenses/yyjson-MIT.txt) |
| ONNX Runtime, included in the sherpa native libraries | MIT | [Upstream](https://github.com/microsoft/onnxruntime), [license and copyright notice](licenses/onnxruntime-MIT.txt) |

The vendored `server/vendor/whisper-rs-sys` adds the `backend-dl` build mode;
Voice Kit's changes in `build.rs` and the SVE dot-product tail fixes in
`ggml/src/ggml-cpu/vec.cpp` and `vec.h` are marked `[voicekit patch]`. The upstream
whisper.cpp license remains in that directory too.

Other Rust dependencies are pinned in `server/Cargo.lock`; plugin development
dependencies are pinned in `plugin/npm-shrinkwrap.json`. Their upstream license
and copyright notices still apply. The Paseo SDK, React and other host-provided
client modules are supplied by Paseo rather than bundled into this plugin.

When distributing native builds, retain the notices required by all included
libraries, including the dependencies inside sherpa's prebuilt native archives.
The native dependency versions and upstream notices are in
[`licenses/native`](licenses/native/README.md). Release archives also include a
Cargo-derived Rust dependency inventory and license files. Symphonia uses MPL-2.0;
its unmodified covered crate sources accompany the archives under `sources/`.

## Downloaded models

Models are downloaded separately from the application. Voice Kit's MIT license
does not license or change the terms of those model weights, voices, tokenizers
or other model assets, and a converted copy keeps the original model's license.
The built-in models, their publishers, licenses and download sources are listed
in [`plugin/MODEL_LICENSES.md`](plugin/MODEL_LICENSES.md), with the license texts
in [`plugin/licenses/models/`](plugin/licenses/models/). Download sources and
checksums are pinned in [`server/catalog.json`](server/catalog.json); the Silero
VAD model used with Whisper is pinned in
[`server/src/speech_filter.rs`](server/src/speech_filter.rs).

Supertonic 3 is licensed under BigScience OpenRAIL-M: its use-based restrictions
(Attachment A) apply to the model and its derivatives, and must be passed on with
any redistribution. SenseVoice is licensed under the FunASR Model License 1.1,
which requires attributing the source and authors and keeping the model's name.

Custom models keep the terms set by their publishers. An engine's license does
not determine a model's license.

## Evaluation data

The evaluation sample in [`docs/eval/sample.jsonl`](docs/eval/sample.jsonl)
contains excerpts and metadata from Google's
[FLEURS dataset](https://huggingface.co/datasets/google/fleurs), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Attribution: the
FLEURS dataset authors, *FLEURS: Few-shot Learning Evaluation of Universal
Representations of Speech* (2022), [paper](https://arxiv.org/abs/2205.12446).

The sample selects 15 distinct sentences per language from the pinned test
split; model error rates and timings are derived measurements. Evaluation audio
was peak-normalized before transcription and is not included in this repository.
See [`docs/eval.md`](docs/eval.md) for the revision, preprocessing and methods.

## Bundled native MLX helper (Apple Silicon)

Apple Silicon native packages include a Swift MLX helper. Its pinned Swift package
inventory, original upstream notices (including nested dependencies), Swift runtime
license and Voice Kit source patches are under `mlx-runtime/notices/`. The patches
respect the requested token budget and make model loading read-only. Any bundled
Swift compatibility dylibs are covered by the included Swift Apache 2.0 license
with runtime exception. Model weights remain separate from the software archive.

The GGUF worker build adds `server/qwen-worker/token-count.inc` to the pinned
qwentts.cpp translation unit, exposing its already-loaded BPE tokenizer through
private IPC. The adapter is included in `gguf-runtime/notices/`. The native MLX
helper includes a small source patch exposing its loaded tokenizer for the same
text-budgeting operation; the patch is in `mlx-runtime/notices/patches/`.
