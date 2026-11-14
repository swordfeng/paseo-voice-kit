# Architecture

Voice Kit has two parts: a Paseo plugin (`plugin/`) and a native OpenAI-compatible
speech server (`server/`, the `voicekit` binary, written in Rust).

```
Paseo daemon ── features.* = openai @ http://127.0.0.1:47615/v1 (apiKey = token)
     │                                ▲
     │ plugin subprocess              │ HTTP
     ▼                                │
plugin/ (voice-kit) ── supervises ──► server/ (voicekit, Rust)
  install binary + models               POST /v1/audio/transcriptions  whisper.cpp | sherpa-onnx | remote
  health → failover controller          POST /v1/audio/speech          sherpa-onnx | remote
  settings screen, RPCs                 GET  /health, /voicekit/{status,models,voices}
```

The plugin starts `voicekit`, watches its health, and writes Paseo's speech settings
(dictation, voice mode listening, voice mode speaking) to point at it. When a feature's
model isn't ready, it switches that feature to another ready model or back to Paseo's
built-in speech.

## Model catalog

`server/catalog.json` is the built-in catalog, compiled into the server. Each entry
names an engine (`whisper`, `sherpa` with a `family`, `mlx` or `gguf` for Qwen3-TTS, or
`openai` for a remote server), its files by role, downloads with pinned
SHA-256, an optional Core ML encoder, voices, a `tier` (`recommended`, `more` or
`internal`) and `uses` (`dictation`, `voice_input`, `voice_output`). The settings screen
lists recommended models first and the rest under "More models".

Custom models come from extra catalog files (`--catalog`). The plugin writes one from
"Your models" in its settings:

- a Hugging Face repository: the plugin lists its files through the Hub API, recognizes
  Whisper or sherpa-onnx models and the family from file names, pins the commit, and
  uses the Hub's SHA-256 for each large file;
- another OpenAI-compatible server;
- a Whisper `.bin` file (path or URL);
- a sherpa-onnx folder or archive (files are found by the family's naming conventions).

The server supports these sherpa-onnx families: speech recognition `sense_voice`,
`paraformer`, `transducer`, `nemo_ctc`, `fire_red_asr`, `fire_red_asr_ctc`, `dolphin`,
`moonshine`, `qwen3_asr`; voices `kokoro`, `vits`, `matcha`, `supertonic`.

### Files shared with Paseo

Models that Paseo's own local speech uses in exactly the same form (currently Parakeet v3 and
SenseVoice, the same ONNX archives) live once in Paseo's model folder. Voice Kit downloads and
removes them through Paseo's model manager, over a private connection to the same daemon using
its existing local credential (`plugin/server/paseo-models.ts`, through the SDK's
`@getpaseo/client/node`; never another host or the cloud), so transfers aren't duplicated and
both settings pages show the same files. Removing such a model removes it for Paseo too, and isn't offered while Paseo uses
it. Models only Voice Kit uses, and different formats or versions of a model Paseo also has
(Whisper GGML versus Paseo's ONNX, Dolphin small versus base), stay in
Voice Kit's own folder. Files borrowed from elsewhere, including custom model folders, are read
only.

## Listening

Voice Kit picks a default listening model for the computer once: Whisper turbo where it runs
fast and Qwen3-ASR otherwise (see
[development.md](development.md#default-listening-model-on-linux-and-windows) for the GPU
check). The plugin keeps that choice fixed and reports it as `defaultSttModel`. Dictation and
voice mode use it until the user picks a model, which then stays as chosen. A request's OpenAI `model` field picks among the models a server is
serving, so dictation and voice mode can use different models.

Whisper first runs a small Silero VAD model on the uploaded audio. It rejects clips
without detected speech and removes leading and trailing idle audio, retaining
300 ms at both edges and all pauses between speech segments. This prevents long
microphone waiting periods from reaching language detection and decoding. The VAD
model reuses Paseo's local copy or downloads with Whisper; it unloads with the
Whisper engine. Audio is not saved unless the server's debug capture flag is used.

Whisper base then detects the spoken language, and the large model's
own detection is used when confidence is below 0.7. The Vocabulary setting is passed to
Whisper as a prompt and to Qwen3-ASR as hotwords.

## Speaking

Speech uses an ordered list of enabled voice models (`ttsModels` in the plugin settings). The
plugin hands it to the server, which builds a chain (`voicekit-tts-chain`, engine `chain`) from it:

- Text is split into sentences and each sentence's language is detected (script rules for CJK,
  whatlang for the rest).
- Each run goes to the first enabled model that natively speaks its language, after an
  optional per-language first choice (`ttsLanguageModels`). A model that is cooling down after
  an error, downloading, or can't run here is skipped for the next one that speaks the language.
- Before synthesis the request is checked: if any non-empty run is in a language no enabled
  model speaks, the whole request fails with `unsupported_language` (listing the languages)
  rather than dropping text or reading it with another language's pronunciation. This is a
  configuration error: it doesn't put any model into its error cooldown. Paseo doesn't replay
  a refused reply with its built-in voice. `model_unavailable` means models that speak the
  language are enabled but none is ready.
- Approximate readings (Catalan, Tagalog, Swahili and Malay with a related language's
  pronunciation) are used only for languages the user allows (`ttsApproximateLanguages`).
- New installs enable Supertonic 3 only. Qwen3-TTS 0.6B and 1.7B (GGUF, qwentts.cpp) are
  optional and download only after they are enabled. They use the GPU when available,
  otherwise the CPU; only Apple Silicon has been tested.
- Custom voice models join the list only with the languages they speak (`languages`); Qwen3-TTS
  models have their 10 languages fixed. Custom GGUF Qwen3-TTS models use a talker and a codec
  file (`ggufModelFile`, `ggufCodecFile`); a Hugging Face lookup downloads only that pair.

Custom MLX Qwen3-TTS models run in a separate MLX Python worker that Voice Kit starts on first use and talks to over stdin and stdout, with no
listening port. The Python comes from
`VOICEKIT_MLX_PYTHON`, then `<plugin-data>/runtime/qwen/bin/python` (installed by
`scripts/install-qwen-runtime.sh`, shipped in native releases as
`qwen-runtime/install-qwen-runtime.sh`; it needs Apple Silicon, macOS 14 or later and
Python 3.12, and installs `qwen-build-requirements.txt` and then `qwen-requirements.txt`,
both locked with SHA-256 hashes). The settings page can run the same installation after
the user confirms (`voicekit.mlx.status` and `voicekit.mlx.install`); it needs an existing
Python 3.12, installs only Python packages, and is never started by adding a model or by a
speech request. Voice Kit never deletes model files it reads from
outside its own and Paseo's shared model folders. MLX Qwen3-TTS models are added as custom
models from Hugging Face or a local folder (engine `mlx`, family `qwen3_tts`). Only
CustomVoice models with the 9 preset voices are supported; Base and VoiceDesign models aren't.
Requests never install packages. Qwen3-TTS has no speed control upstream, so its voices
speak at normal speed; the Speed setting applies to the other models.

Personas (`options.personas` of the chain) pair similar voices across the enabled models.
Supertonic's voices were chosen by speaker-embedding similarity (3D-Speaker CAM++,
`server/examples/voice_embed.rs`) and pitch, over samples from `scripts/voice-samples.sh`.
Each persona's Qwen3-TTS voice was chosen by gender and voice description, not measured.
Qwen3-TTS's two dialect voices (Beijing, Sichuan) are not used by any persona. The voice
`custom` uses the voice chosen for each model (`modelVoices`).

## UI language

The settings screen, sidebar row, Command Center items and slash command follow the Paseo app's
UI language (Settings > Appearance > Language, including System) through Paseo's plugin
translation API. Messages live in `plugin/client/locales/` for every app language (en, ar, es,
fr, ja, ko, pt-BR, ru, zh-CN); English fills in anything missing. Built-in model names and
descriptions are translated by model ID, and the English text must match `server/catalog.json`.
The server reports feature states as language-neutral codes (`reason`, `notice`)
next to its English `detail` and `message`. The speech Language setting is separate and is not
affected by the UI language.

## Idle unloading

Every model loads on its first request, not at startup; downloading a model doesn't load it.
In the voice model list each model loads only when a sentence goes to it, and
Qwen3-TTS's 10 languages share one loaded model. Each model unloads on its own after going
unused for the idle time (10 minutes by default, set by the plugin's Advanced setting or
`--idle-unload-mins`; 0 keeps models loaded), even while other models stay in use. Unloading
Qwen3-TTS, or stopping the server, ends its worker process. The next request to an unloaded
model loads it again.

## Security

- The server binds to 127.0.0.1 only and rejects requests whose `Host` isn't a loopback
  host, which blocks DNS rebinding.
- Every endpoint except `/health` (which only reports up or down) needs a bearer token,
  compared in constant time. The plugin creates a new token each time it starts the server
  and passes it in the environment, not on the command line.
- Paseo's `config.json` and the plugin's state and custom-model files are written
  owner-only (`0600`). Anything running as your user can read them; a local server can't
  protect against that.
- Downloads use HTTPS with pinned SHA-256 for every built-in model and for release
  binaries.

## Paseo behaviors this relies on

Verified against Paseo 0.15.4:

- The `openai` speech provider uses the OpenAI SDK: `baseUrl` must end in `/v1` and an
  `apiKey` is required.
- Dictation uploads mono PCM16 WAV at 24 kHz. TTS always requests
  `response_format: "pcm"` (24 kHz s16le mono).
- Speech settings patched through `paseo.config.patch({ features })` apply live, without
  a daemon restart.
- Changing a feature's provider drops its other fields, so the plugin snapshots the raw
  setting from `config.json` and restores it verbatim.
- Voice mode turn detection needs Paseo's local speech runtime, which exists only if some
  feature is `local` or `providers.local.modelsDir` is set. The plugin sets `modelsDir` to
  Paseo's default and runs `paseo reload` once.
- Plugin backends only get a daemon session inside RPC handlers, so the client entry calls
  `voicekit.attach` on load.

## Repository layout

| Path | What |
| --- | --- |
| `plugin/` | Paseo plugin `voice-kit`: supervisor, failover controller, settings UI. |
| `server/` | `voicekit` server: whisper.cpp through whisper-rs, sherpa-onnx, and a forwarding engine for remote servers. |
| `server/catalog.json` | Built-in model catalog. |
| `server/vendor/whisper-rs-sys` | whisper-rs-sys 0.15.0 with one addition, the `backend-dl` build mode (lines marked `[voicekit patch]` in `build.rs`), wired with `[patch.crates-io]`. |
| `scripts/dev-install.sh` | Build the server and install it where the plugin looks for a local build. |
| `scripts/rpc.mjs` | Call the plugin's RPCs (status, reclaim, preview, settings) from the shell. |
| `scripts/e2e-dictation.mjs` | Stream a WAV through the local daemon's dictation pipeline. |
| `scripts/e2e-voice.mjs` | Voice mode round trip: spoken request → Paseo STT → a throwaway agent calls `speak` → Paseo TTS → transcribe the reply. Cleans up its agent and workspace. |
| `scripts/test-models.sh` | Transcribe clips with given models, and read a voice's output back through Whisper. |
| `scripts/bench.sh` | Latency benchmark for a model combination against WAV clips. |
| `scripts/eval/` | Bounded multilingual evaluation; see [eval.md](eval.md). |
| `scripts/package-release.sh` | Package a build for release. |
| `scripts/release-manifest.mjs` | Pin a GitHub release's binaries in `plugin/shared/release.ts`. |
