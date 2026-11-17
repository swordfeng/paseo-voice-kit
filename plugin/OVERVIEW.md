Voice Kit runs speech recognition and voices on the computer where the Paseo daemon runs, and Paseo's dictation and voice mode use them.

## How it works

Voice Kit runs a speech server, voicekit, on the same computer as the daemon. When a model is ready, Voice Kit switches dictation, voice mode listening and voice mode speaking to it. While the server starts or a model downloads, and when something fails, Paseo goes back to your previous voice settings, or to its built-in speech if you had none. Turning Voice Kit off or removing it restores your previous voice settings, including any OpenAI key.

If you change a voice setting yourself in Settings > Voice, Voice Kit stops managing that feature until you choose "Use Voice Kit" on its page.

## Setup

The speech server is a separate program. Ready-made servers for macOS (Apple Silicon and Intel), Linux (x64 and arm64) and Windows (x64) come from the project's v0.1.1 release on GitHub. Before Voice Kit downloads a server version, it asks you, shows where the download comes from, and checks it against a fixed checksum. A plugin update that needs a new server version asks again. The same prompt says that the speech models chosen for this computer, about 1 GB in all, download right after you install; to prevent that, turn off "Download models automatically" in Advanced before you install. If you decline, nothing is downloaded, Voice Kit turns off, and your voice settings stay as they were. You can also point the "Binary path" setting at your own build; build instructions are in the [README](https://github.com/swordfeng/paseo-voice-kit#readme).

The built-in Qwen3-TTS models run in a helper program that comes with the speech server. Qwen3-TTS models you add for MLX run in another helper that comes with it too; they need a Mac with Apple Silicon and macOS 14 or later. Their weights download separately, like other models.

Voice Kit needs Paseo 0.15.4 or later with plugins enabled. Version 0.1.1 was checked by hand on Macs with Apple Silicon and on Windows with an NVIDIA GPU, including a fresh install on both, and on Linux on the CPU and with an NVIDIA GPU under WSL. Automated checks with real models run on the CPU for every release platform. On Linux, the ready-made server needs glibc 2.34 and the C++ runtime of GCC 12 or later (Ubuntu 22.04, Debian 12, Fedora 36 or later); a Vulkan driver is needed only for the GPU. GPU speech on Intel Macs, on native Linux GPU drivers and on AMD or Intel GPUs hasn't been checked.

## Where your data goes

Your speech is turned into text on that computer, and replies are read aloud there. Voice Kit sends nothing to an outside speech service unless you add one yourself. What it turns into text still goes into Paseo as your message, and from there to your agent's provider, as it would if you typed it.

If you add a remote speech server under "Your models", that server receives the audio or text it handles, your vocabulary hints, and the API key you entered for it.

## Models

The defaults work in many languages without changing anything.

Listening:

- Voice Kit picks one multilingual model for the computer, for both dictation and voice mode, until you choose another. On Macs that is Whisper turbo (about 100 languages, with punctuation) on the GPU. On Linux and Windows, Voice Kit tests the GPU once and uses Whisper turbo if it is fast enough, otherwise Qwen3-ASR (about 30 languages) on the CPU.
- You can choose a different model for dictation and for voice mode.
- Other models: Parakeet v3 for European languages, Dolphin small for Asian and Middle Eastern languages, SenseVoice and Whisper small. Each model's card says what it is good at and where it falls short.

Speaking:

- You choose which voice models to use and in what order. By default, each sentence uses the first enabled model that speaks its language natively. You can choose a different first choice for a language, or let a language be read approximately by a model that doesn't speak it natively.
- Without those settings, Voice Kit doesn't read a reply that contains a language none of your enabled models speaks, so nothing is read with the wrong pronunciation. The page names a model that could speak it. Very short text in Latin letters whose language can't be detected is read as English.
- New installs start with Supertonic 3 alone: 31 languages, on the CPU. Qwen3-TTS 0.6B and 1.7B speak 10 languages. They are optional, download only after you enable them, and use the GPU when they can (checked on Apple Silicon Macs and NVIDIA GPUs). If the GPU can't run them, they run on the CPU and the model's card says so.
- Each voice model has its own voice, chosen and previewed on its card. By default Supertonic 3 and Qwen3-TTS use two similar voices, so replies that mix languages sound alike.

Built-in models download from Hugging Face and GitHub into Voice Kit's data folder (`~/.paseo/plugin-data/voice-kit/models` by default) and are checked against fixed checksums. The models chosen for this computer download right after you install the server, and others as soon as you choose them, unless you turn off "Download models automatically". Parakeet v3 and SenseVoice use Paseo's own copies: they download once, both Voice Kit and Paseo show them, and removing them removes them for Paseo too. Each model has its own license; built-in models link to theirs on their cards and are listed in MODEL_LICENSES.md; using a model means following its license. Supertonic 3, enabled by default, uses the OpenRAIL-M license, which has use restrictions; the install prompt says so before anything downloads.

On Macs you can turn on Neural Engine for Whisper under Advanced, among the experimental options. It speeds up Whisper only; without it Whisper uses the GPU. It needs a 1.2 GB download and a one-time setup that takes several minutes. It is off by default.

## Your own models

Under "Your models" you can add a Whisper or sherpa-onnx model from Hugging Face (Voice Kit keeps it at the version you added and checks its large files), another OpenAI-compatible speech server, a Whisper model file or URL, or a sherpa-onnx model folder or archive. API keys for servers are stored on the daemon's computer, in a file only your user account can read. You can enter or replace a key, but it is never sent back to Paseo apps.

## Settings

Open Voice Kit from its entry at the bottom of the sidebar (the dot shows its status), by typing /voicekit, from the Command Center, or from Settings > Plugins. The page uses Paseo's app language.

- Listening: which listening features use Voice Kit, their models, language and vocabulary, then the speech recognition models, including your own.
- Speaking: voice mode speaking, speed and "Try a reply", then your voice models in order, each with its voice and preview, the languages they cover, and the voice models you can add.
- Advanced: the sidebar entry, acceleration, unloading idle models, port, your own server binary and the server log. Each model loads when it is first needed and, by default, unloads after 10 minutes unused.

## Limits

- The speech server listens only on 127.0.0.1 and answers only requests addressed to this computer. Every request except a health check needs a token that changes each time the server starts.
- So that voice mode turn detection keeps working, Voice Kit sets `providers.local.modelsDir` in the daemon config to Paseo's default model folder if it isn't set, and may reload the daemon config once when it starts.
- Environment variables that set Paseo's speech options on the daemon take precedence; those features show as locked.
