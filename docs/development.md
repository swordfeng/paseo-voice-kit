# Development

## Build and install

```bash
scripts/dev-install.sh                       # build voicekit (+ ggml libraries on Linux/Windows) and install it
(cd plugin && npm ci && npm run typecheck)
paseo plugin install "$PWD/plugin"           # once
paseo plugin reload voice-kit                # after plugin or server changes
node scripts/rpc.mjs voicekit.status         # inspect
NODE_PATH=plugin/node_modules node scripts/e2e-dictation.mjs clip.wav   # dictation through Paseo -> voicekit
```

`dev-install.sh` installs to `~/.paseo/plugin-data/voice-kit/bin/local/` (or under
`$PASEO_HOME`). The plugin prefers this local build over a downloaded release. Files are
copied to a temporary name and renamed, so a running server keeps its old file until the
reload.

Default Cargo features are `coreml` on macOS (Metal is always on) and `vulkan-dl` on
Linux and Windows. Override them with `CARGO_FEATURES`; use `cpu-dl` for a CPU-only build
in the release layout (an empty value builds fully static, which crashes on Linux at the first
model load: whisper.cpp and ONNX Runtime both instantiate `std::regex`). On Windows the Qwen
worker builds in a short folder under the temp directory when the checkout path is long
(CMake's object path limit), or in `VOICEKIT_QWEN_BUILD_DIR`. If `sccache` fails in a sandbox, run with `RUSTC_WRAPPER=`.

## Plugin dependencies and packaging

The plugin's dependencies are locked in `plugin/npm-shrinkwrap.json`, the only lock file;
use `npm ci` so installs match it. Installing from a Git checkout uses the checked-in
manifest, whose build step runs `npm ci --omit=dev --ignore-scripts`. To make an npm
package, run `node scripts/pack-plugin.mjs [output-dir]` (default `dist/`): it stages
the files npm would pack, drops that Git install build step from the staged manifest and
runs `npm pack` there, so npm installs don't install the dependencies a second time.
`node scripts/verify-plugin-package.mjs <output-dir>` inspects the resulting `.tgz`
without installing it. The package carries the shrinkwrap, `MODEL_LICENSES.md` and
`licenses/`, including the model license texts in `licenses/models/`. Nothing is
published to npm.

## Run the server by itself

```bash
VOICEKIT_TOKEN=dev server/target/release/voicekit serve --port 47615 \
  --models-dir ~/.paseo/plugin-data/voice-kit/models --reuse-dir ~/.paseo/models/local-speech \
  --stt-model whisper-large-v3-turbo-q5_0,parakeet-tdt-0.6b-v3-int8 --tts-model supertonic-3 --auto-pull
```

Each request's OpenAI `model` field picks among the served speech recognition models.
`voicekit serve --help` lists the other options, including `--idle-unload-mins`
(default 10) and `--coreml` for the Neural Engine. Responses carry an
`x-voicekit-timing` header with per-stage times.

## GPU backends on Linux and Windows

Builds there use ggml's backend modules (`--features vulkan-dl`). `voicekit` links only
`libwhisper`, `libggml` and `libggml-base` (found next to it through an `$ORIGIN` runpath
on Linux; Windows searches the executable's folder). At startup it loads backend modules
from its own folder with `ggml_backend_load_all_from_path(<exe dir>)`, never from the
current directory.

ggml keeps the CPU module that best fits the running CPU (x86: SSE4.2 up to
AVX-512/AMX; arm64: armv8.0 up to armv9.2 with SVE/SME). Only the Vulkan module links the
Vulkan loader, so without a loader, driver or GPU it doesn't load and Whisper runs on the
CPU. ggml skips CPU-type Vulkan devices such as lavapipe unless `GGML_VK_VISIBLE_DEVICES`
selects them.

`voicekit devices` prints the backends and devices as JSON, and the status endpoint
includes them. Whisper's accelerator label is the backend of the GPU device it uses
(`vulkan`, `metal`) or `cpu`.

Building with `vulkan-dl` needs recent Vulkan headers (ggml-vulkan uses
`VK_EXT_layer_settings`; Debian 12's 1.3.239 is too old), a Vulkan loader to link the
module against, and `glslc`. Running needs none of them. On Linux arm64 with GCC 12 or
older, `dev-install.sh` uses clang, because GCC rejects the `-march` values of ggml's
newest arm64 variants.

## Default listening model on Linux and Windows

The default listening model is Whisper turbo only where it is fast; otherwise it is Qwen3-ASR
on the CPU. On macOS it is always Whisper turbo. With Acceleration set to CPU only, it is
Qwen3-ASR without any check. The check runs once, when the default is first chosen.

`voicekit probe` answers without downloading anything when there is no GPU device.
Otherwise it times Whisper base's encoder (a full 30 s window; the ~60 MB model is needed
for language detection anyway) on the GPU and multiplies by 20, the turbo/base ratio
measured on Apple Metal. Whisper turbo is chosen when that estimate is at most 1000 ms.
On lavapipe (software Vulkan in arm64 Docker), base took 9.0 s, predicting 180 s for turbo
against 134–245 s measured, so the default there is Qwen3-ASR.

The probe stops after one timed pass if that pass is five times over the limit, and runs
as its own process, so a crashing GPU driver only fails the check (the default is then
Qwen3-ASR). The plugin keeps the chosen default in its plugin data, so it doesn't change
afterwards.

## Releases

v0.1.1 is published on [GitHub Releases](https://github.com/swordfeng/paseo-voice-kit/releases/tag/v0.1.1)
and pinned in `plugin/shared/release.ts`. Its tag passed CI on all five platforms, the
published archives match `SHA256SUMS`, and the darwin-arm64 archive was unpacked and checked
(`voicekit 0.1.1`, both workers built for macOS 14). Platform results, including GPU checks
on Windows and on Linux through WSL, are in the spec's release checklist
([spec.md](spec.md)) and in [eval.md](eval.md). Intel Macs, native Linux GPU drivers and
AMD/Intel GPUs remain unchecked.

`plugin/shared/release.ts` pins each platform's archive URL and SHA-256; a local build
(`dev-install.sh`) or the Binary path setting takes precedence over it.

The release workflow (`.github/workflows/release.yml`) builds darwin-arm64, darwin-x64,
linux-x64, linux-arm64 and win32-x64 with `GGML_NATIVE=OFF`, so binaries don't depend on
the build machine's CPU. macOS links Metal and Core ML statically and ships an archive with the
executable and license notices, `voicekit-darwin-<arch>.tar.gz`. Linux and Windows build with `vulkan-dl` and ship
`voicekit-<platform>-<arch>.tar.gz`, holding the executable, the ggml libraries, one
`ggml-cpu-*` module per CPU level, and `ggml-vulkan`. The plugin checks the archive's
SHA-256, unpacks it into `plugin-data/voice-kit/bin/<version>/` and runs the executable
named in the manifest.

CI on Linux takes Vulkan headers, loader and `glslc` from conda-forge and builds with clang
and Ninja; Windows uses the LunarG SDK. On every platform CI runs the native tests
(`cargo test`), unpacks the archive the way the plugin does
(`scripts/verify-native-package.mjs`) and runs a smoke test from the unpacked asset:
`--version`, `devices`, and the HTTP server with stub engines (health, a speech request,
and a request without the token being refused). It also checks that the Linux executable
has no `libvulkan` dependency and that Windows needs no unpackaged Visual C++ runtime.
All five platforms passed for v0.1.0. For 0.1.1, CI also runs `scripts/smoke-real-models.py`
on the unpacked asset with `--accelerator cpu` (short real-model checks, see
[eval.md](eval.md#real-model-cpu-checks-for-011-2026-11-14)), and on Linux arm64
`scripts/test-sve-dots.py --require-sve`, which checks the packaged SVE dot-product kernels
against exact scalar results.

CI doesn't redo work whose inputs haven't changed:

- Before building, CI hashes every file the native builds and their checks read, by Git
  object ID. A platform that already built and passed every check from the same inputs is
  skipped. This covers a rerun, a pull request that only changes docs or `plugin/client/`, and
  a merge whose native inputs were already tested. Each platform records its pass in a small
  cache entry (`native-ok-<platform>-<hash>`).
- When a platform does build, the Qwen worker and the MLX helper are restored from caches
  keyed by their sources, build scripts, the Vulkan toolchain pins, the OS and the C compiler's
  version (plus Xcode for MLX). The Rust cache also keeps the vendored whisper-rs-sys build (a
  workspace member for this reason), and files under `server/` get their last commit's time so
  Cargo rebuilds only what changed. CI pins the Rust toolchain (1.92.0) so the cache stays
  valid and releases use a known compiler. The smoke test's model downloads are cached once for
  all platforms, keyed by `server/catalog.json`.
- CI also runs on pushes to main. Pull requests can only restore caches from their own branch
  or the default branch, so this keeps every pull request's caches warm. A new push to a pull
  request cancels its running checks.

Release tags use none of this: every platform is built from source and tested against fresh
downloads.

Tested beyond CI: Linux arm64 in Docker on Apple Silicon with the CI recipe (Ubuntu 22.04,
clang 14), including real Whisper transcription with and without a Vulkan loader, and
lavapipe; Linux x64 the same way under emulation, running `devices` and a Whisper encoder
pass. Not verified yet: GPU inference on Windows, Linux and Intel Macs; a full Paseo
install on Windows, Linux and Intel Macs (a fresh Git install was tested on an Apple Silicon
Mac); and the Paseo app in right-to-left languages.

To publish, push a `v*` tag. CI builds every platform's asset and publishes them with
`SHA256SUMS`. Then pin them for the plugin:

```bash
node scripts/release-manifest.mjs v0.1.1
```

## Packaging a local build

Releases are published from `swordfeng/paseo-voice-kit`. CI uses macOS 26 ARM runners
(the MLX helper needs Swift 6.3) and macOS 15 Intel runners, asserts the architecture, and
builds the Linux/Windows variants. Every macOS binary targets macOS 14 or earlier
(`build-qwen-worker.py` checks the Qwen worker's), so a newer runner doesn't raise the minimum. Every
platform ships a `.tar.gz` archive with its executable and license notices; Linux and
Windows also include the ggml backend libraries. Apple Silicon archives also include
the native Swift MLX helper, its Metal resources, compatibility libraries and notices.
Build it with `python3 scripts/build-mlx-worker.py --target-dir server/target/release`;
no Python environment is required on the end-user machine.

Before packaging a local build, collect the notices from its Cargo metadata:

```bash
cargo metadata --locked --format-version 1 --features coreml --manifest-path server/Cargo.toml > /tmp/voicekit-metadata.json
python3 scripts/collect-licenses.py /tmp/voicekit-metadata.json /tmp/voicekit-notices
VOICEKIT_NOTICES=/tmp/voicekit-notices bash scripts/package-release.sh darwin-arm64 server/target/release /tmp/voicekit-package
```

Use a new notices/output directory each time. Notice collection includes the
Rust dependency inventory, upstream native notices and unmodified MPL-covered
crate sources. `scripts/release-manifest.mjs` pins the published assets after a
successful release.

The first managed speech-server download requires an affirmative installation choice.
Already-installed, custom and local development binaries need no additional
confirmation. Declining retains Paseo's fallback and installs no runtime.
Model weights remain separate downloads controlled by the model-download setting.

The user has postponed the clean end-to-end installation test. Build checks,
small isolated HTTP/download regressions, artifact-content checks and verification
of the existing live installation can run; they do not establish that a fresh
registry installation works. Do that final installation test before publication.
