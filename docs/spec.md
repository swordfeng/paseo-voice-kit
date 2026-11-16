# Voice Kit behavior spec

Status: the 0.1.1 release spec, first reverse-engineered from the implementation and then used
to fix it (branch `release-spec-fixes`, 2026-11-15). Rules describe the implemented behavior
unless they carry a `GAP` tag.
It describes what Voice Kit must do as the user and Paseo see it. The structure lives in
[architecture.md](architecture.md). Benchmarks live in [eval.md](eval.md).

Each rule has an ID and a verification tag:

- `T:<suite>`: covered by a regression suite in `scripts/run-behavior-tests.mjs` or
  `scripts/test-*.py`.
- `N:<module>`: covered by the Rust unit tests in `server/src/<module>` (`cargo test`).
- `+T`: should get an automated test before release.
- `M`: manual check on the release checklist (end of this file).
- `(Decided, Qn)`: a behavior chosen by the maintainer (see [Decisions](#decisions)).
- `Qn`: still open (see [Decisions](#decisions)).
- `GAP-En`: a limitation outside Voice Kit, in Paseo.
- `GAP-n`: the current code does not meet the rule (see [Known gaps](#known-gaps)).

Server rules are mapped to the Rust unit tests that cover them. `+T` means no automated test
covers the rule yet; the list is at the end of the [Release checklist](#release-checklist).

## 0. Scope

- S-0 Nothing has been released to users. The 0.1.0 tag exists, but the only
  installations are the maintainer's two test machines. No rule needs migration code for
  earlier settings or files.
- S-1 The release is the plugin from the default branch plus the native `voicekit` server
  for darwin-arm64, darwin-x64, linux-x64, linux-arm64 and win32-x64.
- S-2 macOS, Windows and Linux are all officially supported in 0.1.1, none experimental.
  So the checks in the release checklist that cover Windows and Linux block the release:
  a full Paseo install, and GPU use where acceleration is offered. They are not
  release-note caveats. (Decided, Q1.)
- S-3 Qwen3-TTS MLX models use the bundled Swift helper (Apple Silicon, macOS 14 or later)
  and are part of 0.1.1. There is no Python runtime. (Decided, Q1.)

## 1. Server binary and installation

- INST-1 The plugin resolves the server in this order: the "Binary path" setting, then a
  local build at `plugin-data/voice-kit/bin/local/voicekit`, then the pinned release for
  this platform. `T:supervisor`
- INST-2 The plugin does not download a release server until the user approves it. The
  approval card shows the source URL. Declining turns Voice Kit off, and Paseo keeps its
  built-in speech. `T:supervisor` `M`
- INST-3 A release download is checked against the SHA-256 pinned in
  `plugin/shared/release.ts`. It is unpacked into a staging folder and moved into place, so
  a partial install is never used. `T:supervisor`
- INST-4 Concurrent resolutions share one installation. Cancelling one caller does not
  cancel an installation another caller needs. `T:supervisor`
- INST-5 An installed release needs no new approval or download. `T:supervisor`
- INST-6 When the pinned version changes, Voice Kit installs it into a new version folder.
  The previous version folder stays on disk. Approval is for one archive: the settings keep
  its SHA-256 (`approvedServerArchive`), so a new version or platform build shows the card,
  with its source, again. (Decided, Q2.) `T:supervisor`
- INST-7 The plugin declares the server version it needs (`SERVER_VERSION` in
  `plugin/shared/release.ts`, tested equal to `server/Cargo.toml`). Voice Kit refuses to start
  a server of another version, whether it comes from "Binary path", a local build or the
  pinned release, and never downloads a pinned release of another version. The status names
  the version needed and how to get it, and Paseo keeps its built-in speech. There is no
  partial compatibility with older servers. (Decided, Q7.) `T:supervisor`
- INST-7a A plugin change that needs a new server lands on the default branch together
  with a published server release and an updated `release.ts`. Users install the plugin
  from the default branch, so otherwise INST-7 would refuse to start for every user until
  the release exists. `scripts/release-manifest.mjs` refuses to pin a release whose version
  isn't `SERVER_VERSION`. `M`
- INST-8 On a platform with no published build, the status names the platform and points
  to `dev-install.sh` or "Binary path".

## 2. Server supervision

- SUP-1 The server binds to 127.0.0.1. If the configured port is busy, it uses a free port
  and the status says so. Paseo's settings follow the actual port. `T:supervisor`
- SUP-2 Each start creates a new token, passed in the environment and never on the command
  line. `T:speech-switch` (key refresh)
- SUP-3 After a crash, the server restarts with a backoff of 1 s doubling to 30 s. After
  5 crashes within 5 minutes, it stops trying and shows "failed" until the user restarts
  it, or a settings change restarts it. It does not try again on its own later.
  (Decided, Q3.) `T:supervisor`
- SUP-4 Two health check misses in a row mark the server degraded, and every feature falls
  back. Probing continues. `T:supervisor`
- SUP-5 A settings change that needs a restart lets in-flight requests finish for at most
  15 s, then kills the old server. The wait ends as soon as nothing is in flight; model
  loading isn't involved. Plugin shutdown waits at most 1.5 s, then kills the server.
  (Decided, Q8.) `T:supervisor`
- SUP-6 On start, the plugin stops servers left behind by an earlier plugin process that
  serve its models folder, matching that folder exactly. Processes are listed with `ps` on
  macOS and Linux and with `Get-CimInstance` on Windows. `T:supervisor` (listing) `M`
  `GAP-P4` (not yet run on Windows)
- SUP-7 The server exits when its stdin closes, so it never outlives a killed plugin
  process. `M`

## 3. Paseo speech settings

Voice Kit manages three settings in Paseo: dictation, voice-mode listening and voice-mode
speaking.

- SITE-1 While its model is ready, Voice Kit points each enabled setting at its server:
  provider `openai`, the current base URL and token, the model and, for speaking, the
  voice. `T:speech-switch`
- SITE-2 Before taking a setting over, Voice Kit saves the user's exact previous value,
  API key included. It restores that value verbatim when it gives the setting back. If the
  setting was unset, it restores `local`. `T:speech-switch`
- SITE-3 While a setting's model is not ready (server starting, model downloading or
  loading, load failed, server down), the setting falls back. Listening first tries the
  other configured listening model, then the user's previous value. `T:speech-switch`
  `T:empty-voices`
- SITE-4 If the user changes the provider in Settings > Voice, Voice Kit stops managing
  that setting and shows it as changed by the user. "Use Voice Kit" takes it back.
  `T:speech-switch`
- SITE-5 If the user changes only the model and keeps Voice Kit's server, that choice is
  kept. Voice Kit keeps its URL and token current. While the server is down, the user's
  earlier value is used. Voices are chosen per model in Voice Kit (VOI-1), so Voice Kit
  writes a fixed `voice` value to Paseo. Changing the voice in Settings > Voice is not a
  takeover, and Voice Kit doesn't rewrite it. `T:speech-switch`
- SITE-6 Voice Kit saves its intent before patching Paseo. A crash at any step can be
  recovered on the next pass without losing the user's previous value. `T:speech-switch`
- SITE-7 A setting locked by an environment variable on the daemon shows as locked, and
  Voice Kit never writes to it. `T:speech-switch`
- SITE-8 Turning Voice Kit off, or stopping the plugin, restores every managed setting.
  `T:speech-switch` `M`
- SITE-9 Removing the plugin restores every managed setting through the plugin's cleanup,
  which Paseo runs before stopping the plugin. Cleanup restores Paseo's settings before it
  stops the server. If Paseo ends the process before that finishes, Voice Kit does not try
  to repair the settings afterwards. This is a known limitation. (Decided, Q11.) `M`
- SITE-10 Before the first takeover, Voice Kit sets `providers.local.modelsDir` to Paseo's
  default and runs `paseo reload` once, so voice-mode turn detection keeps working. It
  never restarts the daemon. `M`
- SITE-11 Voice Kit writes Paseo's settings only after a Paseo app has connected. Until
  then, every setting shows "Waiting for a Paseo app to connect". Changes the user makes in
  Settings > Voice are noticed within 15 s. As far as we know, nothing in Paseo uses speech
  before an app connects. Revisit this if that changes. (Decided, Q6.)
- SITE-12 If `state.json` can't be read, Voice Kit stays off, leaves Paseo's settings alone and
  says why. If it is damaged, it is kept as `state.json.corrupt-*` and replaced. A Paseo
  setting still pointing at some Voice Kit server (a `vk_` token on a loopback `/v1` address)
  is never saved as the user's own setting, and it goes back to Paseo's built-in speech when
  Voice Kit doesn't want it. `T:speech-switch`

## 4. Listening

- STT-1 The first time the plugin starts on a computer, it picks a default listening model
  and keeps it: Whisper turbo on macOS, Qwen3-ASR when "CPU only" is set, and elsewhere
  the result of a GPU speed probe. A failed or inconclusive probe never stores a CPU
  default by itself; it is retried with a backoff of 1 min to 10 min, and after three
  inconclusive probes Qwen3-ASR is stored. `T:default-stt`
- STT-2 Until the user picks a model, dictation and voice-mode listening use that default.
  A model the user picks is never changed. `T:default-stt`
- STT-3 While the default is pending, listening stays with Paseo's built-in speech and no
  listening model is downloaded, so the probe can't make a download wasted. Other startup
  errors (download approval) still start the server with a temporary model, so they are
  reported; that model is never stored. `T:default-stt`
- STT-4 Dictation and voice-mode listening may use different models. The server loads
  only the listening models of the features that are on. `T:empty-voices`
- STT-5 Every local recognizer gets Silero VAD preprocessing. Audio without speech returns
  empty text. Leading and trailing silence is trimmed, keeping 300 ms at each edge.
  Remote servers get the original audio. `N:speech_filter` `N:runtime`
- STT-5a VAD must not drop quiet or short speech that worked before it was added, such as
  a single short word, or speech close to the 0.008 peak gate. VAD needs the Silero model.
  Without it, a local listening model is unavailable and says why, also when offline or
  with automatic downloads off. Once the VAD download finishes, the model recovers without
  a server restart. `N:speech_filter` `N:runtime` (Windows: 40 s and 100 s leading silence, quiet and short speech,
  internal pauses and concurrent requests passed on 2026-11-14.)
- STT-5b Paseo's voice mode can upload far more audio than was spoken. On Windows, a
  4.3 s utterance arrived as 104 s of audio. Before VAD, Qwen3-ASR returned the word
  "language" for it. VAD trims only the edges: earlier speech or an echo of the assistant
  inside the recording stays, so one 71.7 s upload kept 45.1 s. The buffering is in
  Paseo's recording pipeline, not Voice Kit, and is a known limitation to report upstream.
  `GAP-E1`
- STT-6 Whisper uses Whisper base to detect the language when base is installed, and the
  large model's own detection when confidence is below 0.7. `M`
- STT-7 A fixed Language setting overrides detection. Vocabulary goes to Whisper as a
  prompt and to Qwen3-ASR as hotwords. `M`
- STT-8 Undecodable audio is a client error: 400 `invalid_audio`. Silent audio returns empty
  text only when the listening model is installed. `T:http-api`
- STT-9 Transcripts never contain model control text, such as Qwen3-ASR's language header.
  The header is removed by its format, not by deleting the word "language" wherever it
  appears. `N:engine::sherpa`

## 5. Speaking

- TTS-1 The voice model list is ordered. A new install starts with Supertonic 3 alone. An
  empty list leaves speaking to Paseo and does not count as a failure.
  `T:voice-chain` `T:tts-chain` `T:feature-phase`
- TTS-2 Text is split into sentences, and each sentence's language is detected. Each run
  goes to the user's first choice for that language, if one is set, and otherwise to the
  first enabled model that speaks the language natively. `T:voice-chain` `N:engine::chain` `N:lang` `T:voice-chain`
- TTS-3 If any non-empty run is in a language no enabled model speaks, the whole request
  is refused with `unsupported_language` and nothing is spoken. The page names a model
  that could speak it. This refusal does not put any model into an error cooldown. `N:engine::chain`
- TTS-4 Catalan, Tagalog, Swahili and Malay are read with a related language's
  pronunciation only when the user allows it. `T:voice-chain`
- TTS-5 A model that is cooling down after an error, downloading, or unable to run on this
  computer is skipped in favor of the next model that speaks the language. If none is
  ready, the request fails with `model_unavailable`. `N:engine::chain` `N:runtime`
- TTS-6 Errors are handled by kind (Decided, Q5):
  - Request errors (the worker or remote server rejects this input) fail only that request.
    The model stays loaded, its worker keeps running, and there is no cooldown.
  - Timeouts kill the worker, since it may be stuck, and count as a runtime failure. The
    next request starts a new worker.
  - Runtime failures (worker crash, worker that doesn't start, load failure, unreachable
    remote server) count toward a cooldown. The model cools down only after 2 runtime
    failures in a row, starting at 30 s and doubling up to 16 min. A success resets the
    count. Nothing restarts a worker in the background.
  - In the voice list, a failed run moves on to the next model that speaks its language,
    whatever the kind of error.
  `N:engine::chain` `N:engine::route` `N:engine::mlx`
- TTS-6a Text the API accepts doesn't fail by design. A Qwen request gets 60 s per chunk plus
  30 s, and each chunk is bounded by its frame cap (WRK-5a), so long text doesn't time out
  for being long. `N:engine::qwen`
- TTS-7 Voice Kit detects the language of what it reads. Paseo's OpenAI voice provider
  sends only `model`, `voice`, `input` and `response_format` (checked in Paseo's app
  bundle, 2026-11-15), and the preview sends no language either, so no request language
  needs to be respected. If Paseo starts sending one, it should be respected only if
  correct. (Decided, Q4.)
- TTS-7a Short text must not be refused because its language was misdetected. Replies such
  as "OK.", "Sí." or a bare name or number have to be read, not refused with
  `unsupported_language`. `N:engine::chain`
- TTS-8 Each enabled voice model reads with the voice chosen for it (VOI-1), whatever voice the
  request names. There are no personas spanning models, and no voice matching between
  models. A voice the model doesn't have falls back to the model's default voice.
  `N:engine::chain` `T:tts-chain`
- TTS-9 The Speed setting (0.5–2) applies to every model. Qwen3-TTS changes the tempo
  after generation and keeps the pitch. `N:audio`
- TTS-10 Input is limited to 20 000 characters and output to 10 minutes. There is no overall
  voice-list cutoff: each engine bounds its own work, so a long request completes or fails
  clearly, never dropping the speech already made. `M`
- TTS-11 Paseo receives PCM. The preview receives WAV.

## 6. Models

### Catalog and lifecycle

- MOD-1 Models load on their first request, not at startup. Downloading a model does not
  load it. Each model unloads after being idle for the configured time (10 min by default,
  0 = never), but never while it is serving a request. `N:engine::chain` `N:runtime`
- MOD-2 A model that fails to load is retried after a backoff of 30 s, doubling up to 240 s.
  Voice-list routes follow TTS-6 instead: only two failures in a row start a cooldown.
  `N:runtime` `N:engine::route`
- MOD-3 A model serves one request at a time, and all voice requests share one queue. A
  request waits at most 3 minutes behind another and 10 minutes for a model that is loading
  (a first Core ML compile can take minutes), then fails as busy. `N:runtime` `GAP-S12` (work for
  a client that disconnected still runs to the end)

### Downloads

- DL-1 With "Download models automatically" on, every configured model that is missing is
  downloaded in the background, one at a time. With it off, models download only when the
  user asks. `N:runtime`
- DL-2 Every built-in file is checked against a pinned SHA-256, and a file that fails the
  check is deleted. Files from Hugging Face use the Hub's SHA-256 when one exists. `N:download`
- DL-3 Downloads resume after an interruption. For a model made of several files, finished
  files are kept while the entry's downloads stay the same, and partial files are named by
  their position in the entry (`<id>~<n>~<name>.part`), so files with the same name in
  different folders never share one. `N:download`
- DL-4 A download fails if connecting takes over 15 s or the connection sends nothing for
  60 s, and it can then be retried. `N:download`
- DL-5 A failed download shows its error, and pulling the model retries it. A download that
  finishes but leaves the model incomplete is a failure like any other. A failed automatic
  download is retried after 5 minutes, not on every request. `N:download`
- DL-6 Removing a model that is downloading is refused (409 `download_in_progress`). `T:http-api`
- DL-7 A model's partial files are deleted when it installs or is removed. At startup, before
  any download, partial files untouched for 7 days and files in the old naming are deleted.
  `N:download`
- DL-8 Pulling a model that is already installed or downloading starts nothing new. Pulling
  the voice list skips models that can't run on this computer. `T:http-recovery`

### Deleting models

- DEL-1 A model in use (configured, part of the voice list, or the language detector)
  cannot be removed.
- DEL-2 Voice Kit never deletes or writes files it reads from elsewhere: Paseo's reuse
  folder and the user's own model folders. Models there get no Core ML encoder, since it
  would be unpacked next to them. `N:catalog`

### Models shared with Paseo

- SHR-1 Parakeet v3 and SenseVoice live once, in Paseo's model folder, and are downloaded
  and removed through Paseo's model manager over the local daemon connection.
  `T:paseo-models`
- SHR-2 Removing a shared model is refused while Paseo or Voice Kit uses it, and while it
  is downloading. `T:paseo-models`
- SHR-3 An earlier private copy is moved into Paseo's folder, or deleted once its files
  are verified to match; a copy that differs is kept. Removing the model removes Voice Kit's
  private copy too. Voice Kit never re-adopts a model that was removed through Paseo.
  `T:paseo-models`
- SHR-4 If Paseo's model folder is not an absolute path, sharing is disabled rather than
  guessed. `T:paseo-models`

### Custom models

- CUS-1 A user can add a Hugging Face repository (pinned to a commit), another
  OpenAI-compatible server, a Whisper `.bin` file (path or URL), a sherpa-onnx folder or
  archive, a GGUF Qwen3-TTS pair, or an MLX Qwen3-TTS model. `T:mlx-catalog` `M`
- CUS-2 An incomplete or invalid custom model still shows, as unavailable with its reason.
  It never breaks the server's startup or the other models. `N:runtime`
- CUS-3 Custom models are written to an owner-only catalog file. A change restarts the
  server. A custom model's id cannot replace a built-in model. `N:catalog` `T:model-keys`
- CUS-4 A voice model joins the voice list only with the languages it speaks. Qwen3-TTS
  always has its 10. `T:tts-chain`
- CUS-1a The custom model families the server supports, the ones the add form offers, and
  the ones the docs list are the same set. A family that can't work here is refused when
  the model is added, with the reason. It is not accepted and then left to fail at
  synthesis. (Decided, Q12.)
  - Listening: all 10 sherpa-onnx families, which passed short Chinese and English checks
    on Windows on 2026-11-15. The form adds Moonshine and Omnilingual, which the server
    already runs.
  - Voices: Kokoro multilingual, VITS models that come with their lexicon (such as
    MeloTTS), and Supertonic. Models that need a phonemizer are refused in 0.1.1: Piper,
    Kokoro English-only, and any VITS or Kokoro model without a lexicon for its language.
    sherpa-onnx 2.0 dropped espeak-ng and expects the caller to phonemize. Matcha is
    refused too: on Windows, zh-en read Chinese but lost English text, probably for the
    same reason.
  - Later, outside 0.1.1: phonemization through a separate helper process, so these
    families can work (see [Later work](#later-work)).
  Refused at Hugging Face lookup and at load, with the reason. `M` `T:hf-lookup`
- CUS-1b Picking the files of a sherpa-onnx folder or archive ignores files under 1 KB, such
  as Git LFS pointers. A MeloTTS package contains a 133-byte `model.int8.onnx` pointer that
  detection used to pick over the real model. Moonshine (v1 and v2 layouts) is detected
  too. `N:catalog`
- CUS-5 A remote server receives the audio and text for its model, with the user's API
  key. For listening and speaking alike, transport errors and 401/403/404/408/429/502/503/504
  mark the model unavailable (a runtime failure, TTS-6); other errors fail only that
  request. `N:runtime` `N:engine::remote`

### Acceleration

- ACC-1 Under "Automatic", the GPU is used only by these engines: Whisper (Metal on macOS,
  Vulkan on Windows and Linux), Qwen3-TTS GGUF (Metal or Vulkan) and Qwen3-TTS MLX (Metal).
  Every sherpa-onnx engine runs on the CPU on all platforms, including Qwen3-ASR,
  Supertonic 3, Parakeet and SenseVoice. CUDA and DirectML are not offered. The docs and
  the UI must not suggest otherwise. `M`
- ACC-2 Status shows the backend that actually runs, never the one requested. The bundled
  sherpa-onnx builds run on the CPU everywhere, so every sherpa-onnx model reports `cpu`,
  also when Core ML, CUDA or DirectML was requested. `M`

## 7. Worker processes (GGUF and MLX)

- WRK-1 Qwen3-TTS GGUF and MLX run in child processes, connected over stdin and stdout
  with no listening port. Unloading the model or stopping the server ends the process.
- WRK-2 A worker must report ready within 90 s (GGUF) or 30 s (MLX). Errors, timeouts
  and crashes are handled as in TTS-6. `N:engine::mlx`
- WRK-3 MLX models are offered only on Apple Silicon running macOS 14 or later, with
  acceleration not set to "CPU only", and only when the bundled helper (`mlx-runtime/` with
  `runtime.json` protocol 1) is present. Otherwise the model shows why it can't run.
  `T:mlx-runtime`
- WRK-4 Checking whether MLX is available never starts a worker or loads a model.
  `T:mlx-runtime`
- WRK-5 Nothing restarts a worker in the background: after any cooldown, the next request
  starts it, so no GPU memory is held while nobody is waiting for speech. `N:engine::mlx`
- WRK-5a Qwen3-TTS generation ends normally. Sampling is temperature 0.4 and seed 42 on
  both backends (0.2 often never reached the end token; eval.md). Each chunk's frame cap
  follows its token count (0.8 s per token plus 4 s, at most 1200 frames), so a generation
  that doesn't end fails within seconds with `token_limit`. It is then retried once with
  another fixed seed at the same temperature. Windows Vulkan 0.6B Q4 also bypasses MMVQ
  (`8462720`); that workaround's root cause is unknown and covers Windows only. Linux Vulkan
  and AMD/Intel GPUs are unchecked. `N:engine::qwen` `M` (Decided 2026-11-15.)
- WRK-6 No released build used a Python MLX runtime, so Voice Kit neither looks for nor
  migrates one. The only one, on the development Mac, was moved to the Trash on 2026-11-15.
  (Decided, Q9.)

### Speaking settings

- VOI-1 Voices are chosen on each enabled voice model's card, from that model's own voices.
  Language and gender are shown where the model provides them, and frequently used voices
  come first. A list of more than 12 voices (Kokoro v1.1 has 103) gets language and gender
  filters. `M`
- VOI-2 A model with one voice (MeloTTS) shows that voice as text, not as a picker; a remote
  server's voice is changed in its model settings. Voices the catalog lists (Supertonic,
  Qwen3-TTS) show right away. Other models' voices are known once the model has loaded:
  until then the card says one preview loads them, and the server remembers them from then
  on (`.voices.json` in the models folder), also while the model is unloaded and after a
  restart. A model that isn't downloaded yet says its voices come after the download.
  `N:runtime` `M`
- VOI-3 Default voices for new installs: Supertonic F1 and Qwen3-TTS serena. Serena's
  closest Supertonic voice is F1 in every measured sentence (eval.md, "Serena follow-up"),
  so a mixed-language reply sounds like one speaker by default. This replaces the
  former "Mia" default (F1 and vivian). A custom model starts with its default voice, or
  else its first. (Decided 2026-11-15.)
- VOI-4 Each enabled card has a play button. It reads one line with this model, the voice
  picked on the card (before the choice is saved) and the current speed, without the voice
  list's routing. The language is the speech Language setting if the model speaks it, or
  else the model's first language. Models that aren't enabled have no play button in
  0.1.1. `N:engine::chain` `M`
- VOI-5 The top of the Speaking tab has only Speed, which applies to every model, and "Try a
  reply": a text field with its play button right after it (empty text reads a sample
  line), run through the whole voice list. Afterwards it says which model and voice read
  each part. `M`
- VOI-6 Removed: the persona picker, the `custom` pairing mode and the "show all voices"
  switch.
- VOI-7 Server: the voice list takes a model → voice map (`options.model_voices`) instead of
  personas. A speech request can name one model of the list (`voicekit_route`) for a card
  preview, and every voice-list response reports which model, voice and language read each
  part (`x-voicekit-runs`, ids only). `N:engine::chain`
- VOI-8 No migration: nothing has been released to users (S-0). Old `voice` and
  `modelVoices` values are dropped by the new schema, and the two test machines are reset
  by hand.
- VOI-9 UI text for these changes is written in all nine app languages. Per AGENTS.md,
  Claude writes UI changes and copy. README, architecture.md and eval.md drop the persona
  description and keep the measured voice pairings as the defaults' rationale.

## 8. Settings and status

- SET-1 Saving settings never silently loses an edit. Quick edits merge in order. A save
  rejected because of a stale revision is retried once on the latest revision, and
  otherwise reported. `T:settings-writer`
- SET-2 Saved settings are plain JSON, with no `undefined`. `T:settings-json`
- SET-3 The overall status shows ready, degraded or loading based on the features that are
  on. A feature that is off cannot degrade it. `T:feature-phase`
- SET-4 Each feature shows why it is falling back, as a language-neutral code the UI
  translates. `T:empty-voices`
- SET-5 The UI follows Paseo's app language. Anything missing appears in English. `M`
- SET-6 Memory figures cover Voice Kit's own processes: the plugin process, the current server
  and its model workers (nothing else on the machine). They are measured on macOS, Linux and
  Windows; on Windows from the working set plus dedicated and shared GPU memory. A machine
  with a discrete GPU shows dedicated GPU memory and RAM as two values. Unified memory, or
  an unknown memory layout, shows one value. A counter that isn't available shows as
  unavailable, never as the whole GPU's usage. `T:memory` `T:sidebar-memory` `M` (Windows:
  matched the system counters within 4 KiB, 2026-11-16)
- SET-7 A settings change made on one client, or stored on the host, shows on every other
  client without a plugin reload, as Paseo's persisted settings promise. A Mac client
  viewing the Windows host once showed "CPU only" after the host had saved "Automatic",
  until the plugin was reloaded. The probable cause, not reproduced: a save that never
  answered kept its value on screen. Saves now time out after 15 s, are reported, and the
  host's values show again. `T:settings-writer` `M`

## 9. Server HTTP interface and security

- API-1 Every request whose `Host` is not a loopback host is rejected with 421. `T:http-api`
- API-2 Every endpoint except `/health` requires the bearer token, compared in constant
  time. `T:http-api`
- API-3 Errors use OpenAI's error format, including rejections of malformed requests and
  unknown routes, which also get the loopback check. A speech request without
  `response_format` gets a 400 that names pcm and wav. `T:http-api`
- API-4 Paseo's `config.json`, `state.json` and the custom model catalog are written
  owner-only (`0600`), atomically.
- API-5 Keys can be written but not read back, as in Paseo, whose speech settings show
  clients only `hasApiKey`.
  - Voice Kit's server token changes on every start and goes only into Paseo's speech
    settings, where Paseo already hides it from clients.
  - The API keys of remote servers added as custom models are never stored in the plugin
    settings. They live on the daemon in an owner-only (`0600`) file, and the settings keep
    only `hasApiKey`.
  - A dedicated RPC sets or clears a model's key. The form says whether a key is saved and
    can replace or clear it, but never shows it.
  - The server catalog gets the key from that file. Keys in existing test settings are
    re-entered by hand; there is no migration (S-0).
  (Decided, Q10.) `T:model-keys`

---

## Decisions

Decided on 2026-11-15:

- **Q1** The Swift MLX helper is part of 0.1.1. macOS, Windows and Linux are all officially
  supported (S-2, S-3).
- **Q2** Each server version needs its own approval (INST-6). Paseo's publishing guidelines
  require that a plugin "explain what it installs and its source, and require explicit
  user confirmation before the download" (https://paseo.sh/docs/plugins/publishing.md).
  A new version is a new download from a new source URL. Approving a plugin update covers
  the plugin's code, not the separate binary it downloads.
- **Q3** No automatic retry after giving up. A manual restart or a settings change starts
  the server again (SUP-3).
- **Q5** Errors are handled by kind (TTS-6, TTS-6a).
- **Q7** Voice Kit refuses a server that doesn't match the plugin and says what to update
  (INST-7). Plugin updates are manual and need approval
  (https://paseo.sh/docs/plugins.md), so updating the server by hand is acceptable.

- **Q4** Paseo sends no language with speech requests, so detection decides (TTS-7).
  Misdetecting short text is a separate rule (TTS-7a).
- **Q6** Not handled. Nothing is known to use speech before an app connects (SITE-11).
- **Q8** Wait at most 15 s for in-flight requests before restarting (SUP-5).
- **Q9** No migration of an old Python runtime (WRK-6).
- **Q10** Keys can be written but not read back, as in Paseo's own speech settings (API-5).
- **Q11** Rely on Paseo running the plugin's cleanup; no later repair (SITE-9).

- **Q12** Offer only the custom families that pass checks; refuse, when they are added,
  the ones that need a phonemizer, and Matcha (CUS-1a). Phonemization comes later, in a
  separate helper.

No questions are open.

## Known gaps

Each gap was found by reading the code, so severity is an estimate. Before the release,
each one should be either fixed or recorded as a known limitation. As of 2026-11-15 every row is marked
with its status. Still open: P4 (needs a run on Windows), S12's work after a client
disconnects, S21 outside the measured models, and E1 (Paseo). **P** is the plugin,
**S** is the server.

| ID | Gap | Severity |
| --- | --- | --- |
| P1 | `loadState` treats an unreadable or corrupt `state.json` as a fresh install and overwrites it. The user's saved previous settings (API keys included) are lost, and managed settings stay pointed at Voice Kit and are never restored (`plugin/server/state.ts`). **Fixed:** an unreadable file keeps Voice Kit off and reports why; a damaged one is kept as `state.json.corrupt-*`, and sites still holding a Voice Kit `vk_` token on a loopback address are never saved as the user's setting and go back to built-in speech when Voice Kit doesn't want them. | High |
| P2 | No plugin/server compatibility check. The default branch's plugin runs with the pinned 0.1.0 server. Also, a leftover local build always takes precedence over the release. **Fixed:** `SERVER_VERSION` in `release.ts` (tested equal to `server/Cargo.toml`); a server of another version from any source isn't started, a pinned release of another version isn't downloaded, and `release-manifest.mjs` refuses to pin one. | Medium |
| P3 | The approval for downloading the server is one boolean, `runtimeDownloadApproved`, which covers every future version (INST-6). **Fixed:** approval is the archive's SHA-256 (`approvedServerArchive`). | Medium |
| P4 | Windows: leftover servers are never found or stopped (`findOurServers` returns `[]`). The new server moves to a random port, and the old one keeps its memory. Windows is officially supported, so this has to be fixed. **Fixed in code:** Windows lists `voicekit.exe` processes with `Get-CimInstance`; the folder must match exactly (this also fixed a prefix match on every platform). Not yet run on Windows. | High |
| P5 | While the default listening model is pending, Qwen3-ASR is used and, with automatic downloads, downloaded. When the probe later picks Whisper, the first download was unnecessary. **Fixed:** while the GPU check is pending, listening stays with built-in speech (nothing is downloaded); after three inconclusive checks the CPU model becomes the default. | Low |
| P6 | Remote-server API keys are stored in the plugin settings (`customModels[].apiKey`), so every connected Paseo app can read them in plain text. `secureTextEntry` only hides typing. **Fixed:** keys live in `model-keys.json` (0600) and reach only the server catalog; settings keep `hasApiKey`; the add form and the editor send keys through `voicekit.models.set-key`; keys of removed models are deleted. | High |
| P7 | A settings change didn't reach another client until the plugin was reloaded (SET-7). The cause is unknown and could be in Paseo. **Probable cause fixed (not reproduced):** a save that never answered kept its old value on screen forever; saves now time out after 15 s, are reported, and the host's values show again. | Medium |
| P8 | Voices are chosen through personas that pair voices across models. Only Supertonic and Qwen3-TTS are paired. Every other model gets an empty voice for all six personas, so the server falls back to speaker 0: for Kokoro v1.1 an English female voice, even for male personas and Chinese text. To be replaced by per-model voices (VOI-1 to VOI-9). **Fixed:** per-model voices on each enabled card (filters for long lists, a preview per card), "Try a reply" listing the models and voices used, defaults F1 / serena, and a fixed `voice` in Paseo whose edits aren't a takeover. | High |
| S1 | Model downloads have no timeout. A stalled transfer stays "downloading" forever and can't be cancelled (`download.rs` `fetch`). **Fixed:** 15 s connect timeout; a connection that sends nothing for 60 s fails and can be retried. | High |
| S2 | When a download succeeds but the model is still incomplete, progress is marked done with no error. On every voice request, `lazy_route` starts the download again (`download.rs` `ensure`, `runtime.rs` `lazy_route`). **Fixed:** recorded as a failed download, not retried on every request. | High |
| S3 | Removing a model during its download either lets the download reinstall it, or allows a second, parallel download into the same files. **Fixed:** removal is refused (409 `download_in_progress`) while the model downloads. | Medium |
| S4 | A retry wipes `.partial/<id>.dir`, discarding files that already finished. Only the file in progress resumes. **Fixed:** finished files are kept across attempts while the entry's downloads are unchanged. | Medium |
| S5 | `.part` names are `<id>-<basename>`, so two files with the same name in different folders (for example two `config.json`) collide. Without a checksum, a corrupt file can install. **Fixed:** partial names include the download's position (`<id>~<n>~<name>`). | Medium |
| S6 | `.part` files and unpack folders left by failed downloads are never cleaned up. **Fixed:** a model's partial files are deleted when it installs or is removed; at startup, partial files untouched for 7 days and files with the old naming are deleted. | Medium |
| S7 | After an automatic download fails, it is never retried automatically, only by an explicit pull or a restart. **Fixed:** failed automatic downloads are retried after 5 minutes. | Medium |
| S8 | Any synthesis error, including one caused by a single request, kills the worker or cools the model down for 60 s or more. The longest input the API accepts can exceed the worker's deadline. **Fixed (2026-11-15):** worker-reported errors are `RequestFailure`s that keep the worker and the voice-list route loaded with no cooldown; crashes, failed starts and timeouts drop the worker, and only two in a row start a cooldown (30 s, doubling to 16 min) for the engines and for voice-list routes. Still open: the 180 s worker deadline vs. the longest accepted input (TTS-6a, S9). | High |
| S9 | Once the voice list's 180 s deadline passes, the remaining runs fail with `model_unavailable` and the speech already generated is discarded. Each engine call has its own deadline, so the total time is not bounded either. **Fixed:** no voice-list cutoff; each engine bounds its own work, and Qwen requests get 60 s per chunk plus 30 s. | Medium |
| S10 | A single Sherpa voice, used outside the voice list, reads text in a language it doesn't support with English pronunciation. The plugin always uses the voice list, so this isn't reachable from Paseo. **Fixed:** such text is refused (`unsupported_language`), never read as English. | Low |
| S11 | Undecodable audio returns 503. Malformed requests get plain-text 4xx bodies. A missing `response_format` defaults to mp3, which is rejected. Remote voice failures never mark the model unavailable. **Fixed:** undecodable audio is 400 `invalid_audio`; malformed pull and transcription requests get OpenAI-shaped errors; a missing `response_format` gets a clear 400; remote speech failures are classed as `Unavailable` or as request failures, as for recognition; unknown routes get the loopback check. | Medium |
| S12 | Waits for a model to load, and queued requests, have no timeout. Work keeps running after the client disconnects. **Mostly fixed:** waits behind a busy model are capped at 3 min, and behind a loading model at 10 min. Work for a client that disconnected still runs to the end. | Medium |
| S13 | `GET /voicekit/voices` loads the voice model (for GGUF, it can wait up to 90 s for the worker) just to list voices. **Fixed:** voices come from a loaded engine, the voice list or the catalog, without loading a model just to list them. | Low |
| S14 | Background retries respawn GGUF and MLX workers, using GPU memory, when no request is waiting. **Fixed:** no background respawn; the next request starts the worker, after any cooldown. | Low |
| S15 | Core ML encoders are unpacked next to the model, which can be a borrowed, read-only folder. **Fixed:** models in borrowed folders get no Core ML encoder. | Medium |
| S16 | Model ids `.` and `..` pass catalog validation, and removing such a model would delete a parent folder. Only hand-written catalogs can do this; the plugin restricts ids. **Fixed:** ids must start with a letter or digit; file paths must be relative. | Low |
| S18 | Pulling the voice list always returns 202 and starts a new task, including downloads of models that can't run on this computer. **Fixed:** pulling the list starts nothing when every missing model is already downloading, and skips models that can't run here. | Low |
| S19 | Silent audio returns 200 with empty text even when the listening model is missing or unknown. **Fixed:** silence returns empty text only when the listening model is installed. | Low |
| S20 | A model's status shows the requested accelerator (CUDA, DirectML) even after a fallback to the CPU (ACC-2). **Fixed:** sherpa-onnx models report `cpu`. | Medium |
| S21 | Qwen3-TTS 0.6B Q4 runs to the 1200-frame cap on Windows Vulkan, and also on macOS Metal (sohee and serena on short English sentences at temperature 0.2, seed 42; see eval.md). It is worked around, not fixed, and the workaround covers Windows only. A sampler fed non-finite values can fall through to the last token and never reach EOS (WRK-5a). **Fixed (2026-11-15):** temperature 0.4 (0.2 caused most of it), a frame cap from each chunk's token count so a generation that never ends fails in seconds, and one retry with another seed at the same temperature; reported as `token_limit`. In the eval.md sample every case finished after the retry; it isn't guaranteed. | Medium |
| S22 | Sherpa file detection prefers `model.int8.onnx` without checking that it is a real model, so it can pick a Git LFS pointer (CUS-1b). **Fixed:** files under 1 KB are never picked as a model. | Medium |
| S23 | Kokoro English-only, Piper and Matcha models are accepted, then fail or drop text because they need a phonemizer. The docs mention only Piper. The add form also lacks Moonshine and Omnilingual (CUS-1a). **Fixed:** phonemizer models (Kokoro without a lexicon, Piper) and Matcha are refused at Hugging Face lookup and at load, with the reason; the add form offers Moonshine and Omnilingual. | Medium |
| S24 | A Linux build with no Cargo features (sherpa-onnx, ONNX Runtime and whisper.cpp all static) aborts with `free(): invalid pointer` at the first model load, inside ONNX Runtime's `std::regex`. Reproduced on WSL at `c0d8cb5`, before this branch. Release builds use `vulkan-dl` and aren't affected. **Mitigated:** the new `cpu-dl` feature builds CPU-only in the release layout, and the README and development.md point to it; not yet run on Linux. | Medium |
| E1 | External (Paseo): voice-mode recordings can accumulate long silences and earlier speech between turns (STT-5b). Voice detection also sometimes stopped responding until voice mode was stopped and restarted, and the layer at fault is unknown. | Medium |

## Later work

Not in 0.1.1:

- **Phonemizer helper.** Piper, Kokoro English-only and Matcha (CUS-1a) need text turned
  into phonemes and passed as `phoneme_codepoints`. The usual library is
  `piper-phonemize`, which embeds espeak-ng and is GPL-3.0-or-later. Linking it into
  `voicekit` would make the distributed server GPL. Run it instead as a separate helper
  (`voicekit-phonemize`, GPL-3.0) that talks to `voicekit` over stdin and stdout, like the
  MLX worker, so `voicekit` stays MIT. Download the helper only when a model that needs it
  is enabled, with the same approval as the server (INST-2, INST-6). Ship it on all five
  platforms. Then check which approximate-reading languages (TTS-4) Piper can read
  natively, and whether Matcha's English recovers.

## Release checklist

Per AGENTS.md, keep each run short: start with a small sample, put a time limit on each
step, and confirm GPU use wherever acceleration is expected.

1. Automated: `node scripts/run-behavior-tests.mjs`, `scripts/test-http-api.py`,
   `scripts/test-http-recovery.py` and the other Python checks in `scripts/`,
   `cargo test` in `server/`, and the CI native package checks on all five platforms.
2. Clean install (Apple Silicon, empty `plugin-data/voice-kit`): the approval card, then
   declining (Voice Kit off, built-in speech kept), then approving (download, checksum,
   start). The default listening model downloads. Dictation round trip
   (`scripts/e2e-dictation.mjs`). Voice-mode round trip (`scripts/e2e-voice.mjs`).
3. Reinstall over an earlier 0.1.1 build on the two test machines: settings, models and a
   custom model survive, and the new server version installs (INST-6, INST-7).
4. Settings ownership: switch Voice Kit off and on, and confirm Paseo's settings are
   restored exactly, keys included. Edit in Settings > Voice, then use "Use Voice Kit". A
   setting locked by an environment variable. Remove the plugin (SITE-8, SITE-9).
5. Failures: `kill -9` the server (fallback, restart, recovery). Busy port. Health checks
   failing. Offline first start. Interrupted model download, then resume. Low disk space.
6. Shared models: install and remove Parakeet v3 and SenseVoice from both settings pages,
   and try to remove one while it is in use.
7. Custom models: one of each source type, including an invalid one (CUS-2).
8. Speaking: mixed-language text, an unsupported language refused, an allowed approximate
   reading, speeds 0.5, 1 and 2, idle unload and the next load.
9. MLX: the helper is detected, a CustomVoice model loads on the
   GPU, Activity Monitor or the server's device report shows the GPU in use, and unloading
   ends the worker.
10. Windows and Linux (blocking, S-2):
    - a full Paseo install from Git, with the clean install and upgrade from steps 2 and 3;
      a fresh Paseo has plugins switched off, which the install docs must mention;
    - a CPU smoke test with Whisper base, Qwen3-ASR and Supertonic 3 (as in eval.md);
    - on Vulkan, Whisper and both Qwen3-TTS models (0.6B Q4 and 1.7B Q8): Chinese and
      English, generation ending normally, the content read back by speech recognition,
      and the native log showing the Vulkan device. Windows was checked on 2026-11-14 with
      the MMVQ workaround; Linux Vulkan has not been checked (WRK-5a);
    - on Windows, a leftover server is stopped (P4) and memory figures match the system's
      own counters (SET-6);
    - voice mode end to end through Paseo: long pauses between turns, and whether voice
      detection keeps responding without a restart (E1).
11. Intel Mac: Whisper turbo on Metal (the default there) actually uses the GPU and is
    fast enough. Otherwise its default listening model needs the same GPU probe as Linux
    and Windows.

### Results on the Mac (Apple Silicon, 2026-11-15)

Run on the maintainer's Mac with the local 0.1.1 build at `71aebbd` plus the run-report change.
The live installation was used only for steps 4 and 5, after backing up `config.json`, `state.json`
and the plugin settings; the other steps used an isolated server (own port, token and catalog,
the installed models read in place).

| Step | Result |
| --- | --- |
| 1 Automated | Pass: 72 Rust tests, 138 plugin checks, typecheck, Python unit tests, `test-http-api.py`, `test-http-recovery.py`, the npm artifact check and the darwin-arm64 archive check (2028 files, `voicekit 0.1.1`). CI on the other platforms not run. |
| 2 Clean install | Not run: the pinned release is still 0.1.0, which INST-7 refuses, so a clean install has to wait for the 0.1.1 release (INST-7a). The approval and download path is covered by `T:supervisor`. Dictation (`e2e-dictation.mjs`) and the voice-mode round trip (`e2e-voice.mjs`: "Round trip successful.") pass on the installed build. |
| 3 Reinstall over 0.1.1 | Pass: redeployed several times; settings, models, the custom Kokoro and MLX models and the remembered voices survived. |
| 4 Settings ownership | Pass: off restores all three Paseo settings exactly as saved before the takeover; on takes them over again and keeps the saved originals. Environment locks and Settings > Voice edits by `T:speech-switch`; removing the plugin not run (it deletes the plugin's settings). |
| 5 Failures | Pass: `kill -9` of the server was noticed, the server restarted and every feature was active again in 1.4 s, then speech worked. Busy port, missed health checks, stalled and interrupted downloads by automated tests; offline start and low disk space not run. |
| 6 Shared models | Pass (read-only): SenseVoice shows installed and Parakeet v3 not, matching Paseo's folder, with no private duplicate. Installing and removing them not run, since removal deletes Paseo's own copy; covered by `T:paseo-models`. |
| 7 Custom models | Partly: the custom Kokoro (sherpa-onnx) and MLX Qwen3-TTS models work; refusals by `T:hf-lookup`, remote servers by `N:engine::remote` and `N:runtime`. No new model of each source type was added by hand. |
| 8 Speaking | Pass: a mixed English and Chinese reply used Supertonic then Qwen; Thai was refused; Catalan was read as Spanish (reported `read_as`); speeds 0.5, 1 and 2 changed the length; a 13-sentence reply completed; Qwen's worker ended after a minute idle and the next request loaded it again. |
| 9 MLX | Pass: the custom MLX CustomVoice model read on Metal with the bundled helper (no Python), and unloading ended the worker. |
| STT-6, STT-7, ACC-1, ACC-2 | Pass: Whisper transcribed the Chinese part of a mixed clip; the vocabulary changes Whisper's output (see eval.md); Whisper reports `metal` and Supertonic `cpu`. |
| 10 Windows (2026-11-16, RTX 5090) | Mostly pass. Builds; plugin deployed at `bfa879b` (ready, 0.1.1); P4 stops a leftover server for the models folder and leaves another folder's alone; off/on restores Paseo's settings exactly; recovery after the server is killed in 2.1 s; Whisper and both Qwen3-TTS models on Vulkan0 with correct read-back; 0.6B 42/42 with no cap hit, 1.7B 42/42 with one cap hit recovered by the seed retry; memory matches the system counters. Found and fixed afterwards: Windows-only test failures (a directory opened for `set_modified`, POSIX mode bits, `select()` on pipes, an ESM import by drive path, `/` in a test fixture), a deep build path for the Qwen worker, `paseo.cmd` in `e2e-voice.mjs`, and a 503 instead of 400 for a language a single voice doesn't speak. The voice-mode round trip didn't complete because Claude isn't signed in on the PC (not Voice Kit); rerun with `E2E_PROVIDER`. |
| 10 Linux (WSL, Ubuntu 22.04) | Partly: CPU and Vulkan builds pass all automated tests (72 Rust, 138 plugin, HTTP 14/14 and 1/1); the `vulkan-dl` build reads real models on the CPU. The no-feature build crashes (S24). WSL's Vulkan offers only llvmpipe (Mesa 23.2 without the D3D12 driver), so GPU use on Linux is not verified; no Paseo daemon there, so no plugin-level checks. |
| 11 Intel Mac | Not run: no Intel Mac available. |

### Rules without an automated test

Every rule has an automated test or a manual check on this list (`M`) as of 2026-11-15.
