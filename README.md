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
  Italian; GPU when available, otherwise CPU; GPU use tested only on Apple Silicon, CPU
  checks of the 0.1.1 source on all five platforms) are optional:
  they download only after you enable them. Text in a language none of your enabled
  models speaks isn't read with the wrong pronunciation: the whole reply is refused and
  the page says which model could speak it. Catalan, Tagalog, Swahili and Malay can be
  read approximately with a related language's pronunciation if you allow it. Each voice
  model has its own voice, chosen and previewed on its card. By default Supertonic 3 uses F1
  and Qwen3-TTS uses serena, the closest measured pair, so mixed-language replies sound alike.
- **Other models.** Parakeet v3 (European languages), Dolphin small (Asian and
  Middle Eastern languages), SenseVoice and Whisper small.
  You can also add your own models from Hugging Face, a Whisper or sherpa-onnx
  file, or another OpenAI-compatible speech server. Piper voices aren't supported yet
  (they need a phonemizer that isn't wired up).

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
[v0.1.1 release](https://github.com/swordfeng/paseo-voice-kit/releases/tag/v0.1.1). The
first time Voice Kit needs a server version, it asks before downloading the one for your
platform and shows where it comes from; a plugin update that needs a new server version asks
again. The download is checked against a SHA-256 pinned in the plugin, then unpacked into
`~/.paseo/plugin-data/voice-kit/bin/`. If you decline, Voice Kit turns off and Paseo keeps its
built-in speech. Voice Kit only runs the server version it was written for: a local build or a
Binary path server of another version isn't started, and the status says which version is
needed.

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

Qwen3-TTS MLX models use a native Swift helper bundled with the Apple Silicon speech
server. They need macOS 14 or later; there is no separate Python, virtual environment
or package installation. Model weights are still downloaded separately, following
"Download models automatically", or read from a local model folder. Models load on
first use and release their worker when unloaded.

The helper comes with the 0.1.1 speech server. Only Qwen3-TTS CustomVoice checkpoints
with the preset voices are supported.

Qwen3-TTS voices (GGUF and MLX) follow the Speed setting too: Voice Kit changes the speed of the generated speech afterwards, keeping its
pitch, so the wait for generation stays the same. Other voices set their speed while
generating.

On Linux and Windows, `dev-install.sh` builds with Vulkan support by default, which
needs Vulkan headers and `glslc`. For a CPU-only build, use
`CARGO_FEATURES=cpu-dl scripts/dev-install.sh` (a build with no features at all crashes on
Linux when it loads a model). Details are in
[docs/development.md](docs/development.md).

## Platforms and testing

- **macOS on Apple Silicon** is the platform in daily use. Whisper runs on Metal.
  The other speech models (sherpa-onnx) run on the CPU; requesting Core ML for
  them currently falls back to the CPU. The optional Neural Engine mode for Whisper
  (Advanced, experimental options) is off by default.
- **Release builds** for macOS (Apple Silicon and Intel), Linux (x64 and arm64) and
  Windows (x64) pass CI on each platform: the native tests, unpacking the archive the way
  the plugin does, and a smoke test of the server's HTTP interface with stub engines.
- **Real models on the CPU**: the source for 0.1.1 (not yet released) passed short checks
  with real models on the CPU on all five platforms: Whisper base, Qwen3-ASR, Supertonic 3
  and Qwen3-TTS 0.6B GGUF, plus Qwen3-TTS 1.7B on Linux x64 and Windows. They cover English
  and Chinese round trips and Qwen3-TTS at speed 1 and 1.25, not quality in every language.
  Details are in [docs/eval.md](docs/eval.md).
- **Linux** also runs real Whisper transcription in Docker on Apple Silicon (arm64
  natively, x64 under emulation), including on a software Vulkan driver.
- **Not verified yet**: GPU inference on Windows, Linux and Intel Macs; a full Paseo
  install on Windows, Linux and Intel Macs (a fresh install from Git has been tested on an
  Apple Silicon Mac); and the Paseo app in right-to-left languages.

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
  10 minutes unused by default), port (47615 by default), a custom server binary,
  the server log, and collapsed experimental options: Neural Engine for Whisper on Macs
  (off by default; Whisper uses Metal without it).

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
- API keys for remote servers are stored on the daemon in an owner-only file. Like Paseo's own
  speech settings, they can be entered or replaced but are never sent back to Paseo apps.

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
