Voice Kit runs speech recognition and voices on the daemon machine and points Paseo's dictation and voice mode at them. Audio stays on that machine unless you add a remote speech server yourself.

## How it works

Voice Kit starts a small native speech server (voicekit) next to the daemon. When a model is ready, it switches dictation, voice mode listening and voice mode speaking to it. While the server starts, a model downloads, or something fails, Paseo uses its built-in speech, so voice keeps working. Turning Voice Kit off or removing it restores your previous voice settings, including any OpenAI key.

If you change a voice setting yourself in Settings > Voice, Voice Kit stops managing that feature until you choose "Use Voice Kit" on its page.

## Setup

The speech server is a separate native program. Prebuilt servers for macOS (Apple Silicon and Intel), Linux (x64 and arm64) and Windows (x64) are published with the project's v0.1.0 release on GitHub. The first time Voice Kit starts, it asks before downloading the one for your platform, shows where it comes from and checks it against a pinned checksum. Declining turns Voice Kit off and leaves Paseo's built-in speech in place. You can also point the Binary path setting at your own build; installation and build instructions are in the [README](https://github.com/swordfeng/paseo-voice-kit#readme).

The built-in Qwen3-TTS models run in Voice Kit's own native worker. Qwen3-TTS models you add for MLX run in a native MLX helper that comes with the speech server, so there's nothing else to install. They need a Mac with Apple Silicon and macOS 14 or later, and their weights download separately, like other models. The v0.1.0 speech server doesn't include this helper; a newer speech server is needed for MLX models.

Requires Paseo 0.15.4 or later with plugins enabled. Daily use so far is on macOS with Apple Silicon. On every release platform, automated tests build the server, run its native tests, unpack the archive as Voice Kit does and check the speech server with stand-in engines. The source for the upcoming 0.1.1 also passed short checks with real models on the CPU on all five platforms. GPU speech on Windows, Linux and Intel Macs, and full installs there, have not been verified yet.

## Models

The defaults work in many languages without changing anything:

- Listening: Voice Kit picks a default multilingual model for the machine once, used for both dictation and voice mode until you choose another; your choice then stays. On Macs that is Whisper turbo (about 100 languages, with punctuation) on the GPU. On Linux and Windows, Voice Kit checks the GPU once and uses Whisper turbo if it is fast enough, otherwise Qwen3-ASR (about 30 languages) on the CPU. You can choose a different model for dictation and for voice mode.
- Speaking: you choose which voice models to use and in what order; each sentence uses the first enabled model that natively speaks its language. New installs start with Supertonic 3 alone (31 languages, on the CPU). Qwen3-TTS 0.6B and 1.7B speak 10 languages; they are optional, download only after you enable them, use the GPU when available (GPU use tested only on Macs with Apple Silicon; the upcoming 0.1.1 also passed short CPU checks on all five platforms). A reply with text in a language none of your enabled models speaks is refused rather than read with the wrong pronunciation, and the page names a model that could speak it. Pick one of six voices (Mia, Lena, Nora, Leo, Kai, Owen), each pairing a similar voice in every model, or choose voices per model.
- Alternatives: Parakeet v3 for European languages, Dolphin small for Asian and Middle Eastern languages, SenseVoice and Whisper small. Each model card explains what it is good at and its limits.

Models download into `~/.paseo/plugin-data/voice-kit/models` and are checked against pinned checksums. They download as soon as you choose them unless you turn off "Download models automatically". Parakeet v3 and SenseVoice share Paseo's own copies: they download once, both apps show them, and removing them removes them for Paseo too. Downloaded models keep their own licenses, listed in MODEL_LICENSES.md; Supertonic 3's OpenRAIL-M license includes use restrictions.

On Macs you can turn on Neural Engine for Whisper under Advanced, in the experimental options. It speeds up Whisper only; Whisper uses the GPU (Metal) without it. It needs a 1.2 GB download and a one-time setup of several minutes, then makes Whisper about 2.5 times faster. It is off by default.

## Your own models

Under "Your models" you can add a model from Hugging Face (Voice Kit recognizes Whisper and sherpa-onnx models, pins the exact revision and verifies large files), another OpenAI-compatible speech server, a Whisper model file or URL, or a sherpa-onnx model folder or archive. API keys for servers are stored on the daemon host in files readable only by your user, and are shared with connected Paseo apps as plugin settings.

## Settings

Open Voice Kit from its row at the bottom of the sidebar (the dot shows its status), by typing /voicekit, from the Command Center, or from Settings > Plugins. The page follows Paseo's app language.

- Listening: which listening features use Voice Kit, their models, language and vocabulary, then the speech recognition models and your own.
- Speaking: voice mode speaking, the voice, speed and a preview, then the ordered voice model list, language coverage and the voice models you can add.
- Advanced: the sidebar row, acceleration, unloading idle models, port, a custom server binary and the server log. Each model loads when it is first needed and unloads on its own after 10 minutes unused by default.

## Limits

- The server listens only on 127.0.0.1, answers only requests addressed to a loopback host, and requires a token that changes every time it starts.
- To keep voice mode turn detection working, Voice Kit sets `providers.local.modelsDir` in the daemon config to Paseo's default model folder and reloads the daemon config once.
- Environment variables that set Paseo's speech options on the daemon take precedence; those features show as locked.
