# Voice Kit for Paseo

Voice Kit gives [Paseo](https://paseo.sh) local speech recognition and voices. It
is a Paseo plugin plus a small native speech server (`voicekit`). The plugin runs
the server on the daemon machine and points Paseo's dictation and voice mode at it.
If Voice Kit isn't ready, Paseo uses its built-in speech instead.

## What you get

- **Listening (dictation and voice mode).** Voice Kit picks a default multilingual
  model for the machine once. On macOS that is Whisper turbo (about 100 languages,
  with punctuation) running on the GPU through Metal. On Linux and Windows, Voice Kit
  checks the GPU speed once. If the GPU is fast enough, it uses Whisper turbo;
  otherwise it uses Qwen3-ASR (about 30 languages) on the CPU. The default doesn't
  change afterwards, and a model you choose stays your choice.
- **Speaking.** You choose which voice models to use and in what order. Each
  sentence uses the first enabled model that natively speaks its language. New installs
  start with Supertonic 3 alone (31 languages, on the CPU). Qwen3-TTS 0.6B and 1.7B
  (Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish and
  Italian; GPU when available, otherwise CPU; tested only on Apple Silicon) are optional:
  they download only after you enable them. Text in a language none of your enabled
  models speaks isn't read with the wrong pronunciation: the whole reply is refused and
  the page says which model could speak it. Catalan, Tagalog, Swahili and Malay can be
  read approximately with a related language's pronunciation if you allow it. Pick one
  of six voices (Mia, Lena, Nora, Leo, Kai, Owen); each pairs a similar voice in every
  model, or choose voices per model yourself.
- **Other models.** Parakeet v3 (European languages), Dolphin small (Asian and
  Middle Eastern languages), SenseVoice and Whisper small.
  You can also add your own models from Hugging Face, a Whisper or sherpa-onnx
  file, or another OpenAI-compatible speech server.

Measured accuracy and speed are in [docs/eval.md](docs/eval.md).

## Install

You need Paseo 0.15.4 or later with plugins enabled. Install the plugin from this
repository's `plugin/` directory (the default branch):

```bash
paseo plugin add git:swordfeng/paseo-voice-kit:plugin
```

You can also paste `git:swordfeng/paseo-voice-kit:plugin` into Settings > Plugins >
Plugin source. Voice Kit isn't in the Paseo plugin registry or on npm.

The speech server (`voicekit`) is a separate native program. Prebuilt servers for macOS
(Apple Silicon and Intel), Linux (x64 and arm64) and Windows (x64) are published with the
[v0.1.0 release](https://github.com/swordfeng/paseo-voice-kit/releases/tag/v0.1.0). The
first time Voice Kit starts, it asks before downloading the one for your platform and
shows where it comes from. The download is checked against a SHA-256 pinned in the plugin,
then unpacked into `~/.paseo/plugin-data/voice-kit/bin/`. If you decline, Voice Kit turns
off and Paseo keeps its built-in speech.

Speech models are separate downloads of about 100 MB to 2 GB each, checked against pinned
checksums. They download when you choose a model, unless you turn off "Download models
automatically", and keep their own licenses (see [License](#license)).

### Build from source

To build the server yourself, you also need Node.js with npm, a Rust toolchain, CMake and
a C/C++ compiler (Xcode Command Line Tools on macOS). A local build is used instead of the
downloaded server and needs no confirmation. From a checkout of this repository:

```bash
scripts/dev-install.sh                    # build voicekit, install to ~/.paseo/plugin-data/voice-kit/bin/local
(cd plugin && npm ci && npm run typecheck)
paseo plugin install "$PWD/plugin"        # once
```

After changing the code, rebuild with `scripts/dev-install.sh` and reload the plugin
with `paseo plugin reload voice-kit`; this doesn't restart the Paseo daemon. Check
the plugin with `node scripts/rpc.mjs voicekit.status`.

### MLX voice models (optional, Apple Silicon)

The built-in Qwen3-TTS models are GGUF files that run in Voice Kit's own native worker; they
need no Python. Qwen3-TTS models you add for MLX run in a separate Python environment with
MLX, which needs a Mac with Apple Silicon, macOS 14 or later and Python 3.12. Voice Kit
doesn't install Python packages by itself: set it up once with
`scripts/install-qwen-runtime.sh` (native releases include it as
`qwen-runtime/install-qwen-runtime.sh`; `VOICEKIT_SETUP_PYTHON` picks the Python 3.12 to
use). It installs from two SHA-256-locked requirement files, the build tools first and
then the runtime, into Voice Kit's plugin data. You can also point `VOICEKIT_MLX_PYTHON` at
an existing compatible Python. Qwen3-TTS voices speak at normal speed; the Speed setting applies to the
other voices.

On Linux and Windows, `dev-install.sh` builds with Vulkan support by default, which
needs Vulkan headers and `glslc`. For a CPU-only build, use
`CARGO_FEATURES= scripts/dev-install.sh`. Details are in
[docs/development.md](docs/development.md).

## Platforms and testing

- **macOS on Apple Silicon** is the platform in daily use. Whisper runs on Metal.
  The other speech models (sherpa-onnx) run on the CPU; requesting Core ML for
  them currently falls back to the CPU. The optional Neural Engine mode for Whisper
  is off by default.
- **Release builds** for macOS (Apple Silicon and Intel), Linux (x64 and arm64) and
  Windows (x64) pass CI on each platform: the native tests, unpacking the archive the way
  the plugin does, and a smoke test of the server's HTTP interface with stub engines.
- **Linux** also runs real Whisper transcription in Docker on Apple Silicon (arm64
  natively, x64 under emulation), including on a software Vulkan driver.
- **Not verified yet**: real speech recognition and voices on Windows, Intel Macs and
  Linux GPUs; the Paseo app in right-to-left languages; and a fresh install from start to
  finish.

## Everyday settings

Open Voice Kit from its row at the bottom of the sidebar, by typing `/voicekit`, from
the Command Center (⌘K), or from Settings > Plugins.

- **Listening**: dictation and voice mode listening, language (detected automatically by
  default) and vocabulary, then the speech recognition model cards, where you choose
  the model for each feature, and your own models.
- **Speaking**: voice mode speaking, the voice, speed and a preview, then the ordered
  voice model list, language coverage, other voice models and your own.
- **Advanced**: acceleration (Automatic or CPU only; CPU only skips MLX models),
  automatic model downloads, unloading idle models (each model unloads on its own after
  10 minutes unused by default), port (47615 by default), a custom server binary and
  the server log.

The Voice Kit switch at the top turns everything on or off.

A managed speech server download requires your confirmation; local builds do not.
Declining keeps Paseo’s built-in speech. Model weights download separately.

Models are stored in `~/.paseo/plugin-data/voice-kit/models`. Parakeet v3 and
SenseVoice, which Paseo uses in exactly the same form, are kept once in Paseo's own model
folder and downloaded or removed through Paseo, so both show the same state; removing one
removes it for both. Files Voice Kit reads from elsewhere, such as your own model folders,
are never deleted.

## When Voice Kit isn't available

- While the server starts, a model downloads, or something fails, the affected
  feature uses another ready Voice Kit model or Paseo's built-in speech.
- Turning Voice Kit off or removing the plugin restores your previous voice
  settings.
- If you change a feature in Paseo's Settings > Voice, Voice Kit stops managing it
  until you choose "Use Voice Kit" on its page.
- Environment variables that set Paseo's speech options on the daemon take
  precedence, and those features show as locked.
- To keep voice mode turn detection working, Voice Kit sets
  `providers.local.modelsDir` in Paseo's config to Paseo's default model folder and
  reloads the daemon config once.

## Privacy and security

- Audio and text are processed on the daemon machine. Network access is used to
  download models, and to look up Hugging Face repositories you add. If you add a
  remote speech server, audio and text for that model go to that server.
- The server listens on 127.0.0.1 only, rejects requests not addressed to a loopback
  host, and requires a token that changes every time it starts.
- Built-in model downloads are checked against pinned SHA-256 checksums.
- API keys for remote servers are stored in owner-only plain files on the daemon
  and are included in plugin settings sent to connected Paseo clients.

More detail is in [docs/architecture.md](docs/architecture.md).

## Documentation

- [docs/architecture.md](docs/architecture.md): how the plugin, server and Paseo fit
  together, the model catalog, and security details.
- [docs/development.md](docs/development.md): building, running the server on its
  own, GPU backends, and publishing releases.
- [docs/performance.md](docs/performance.md): latency notes from development.
- [docs/eval.md](docs/eval.md): multilingual accuracy and speed measurements.

## License

Voice Kit is released under the [MIT License](LICENSE). Bundled third-party code is
listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Speech models are downloaded separately and keep their own licenses: MIT (Whisper,
Silero VAD), Apache-2.0 (Qwen3-ASR, Qwen3-TTS, Dolphin), CC BY 4.0 (Parakeet v3), the
FunASR Model License (SenseVoice) and OpenRAIL-M with use restrictions (Supertonic 3).
See [plugin/MODEL_LICENSES.md](plugin/MODEL_LICENSES.md) for publishers, sources and the
license texts. Models you add yourself keep their publishers' terms.
