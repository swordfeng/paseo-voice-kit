# Native MLX worker experiment

This standalone macOS executable evaluates Qwen3-TTS CustomVoice using
`mlx-audio-swift` at an immutable revision. It is not selected by the production
Rust engine or installed by Voice Kit. Production MLX requests still use Python.

Build on Apple Silicon with Xcode (including its Metal Toolchain):

```sh
swift build --package-path server/mlx-worker -c release --product voicekit-mlx-worker -j 8
```

Keep the complete build product directory when running the executable: MLX also
needs the generated Metal resource bundle. `Package.resolved` pins transitive
Swift dependencies.

Pass a **disposable, private copy** of a compatible MLX CustomVoice model folder:

```sh
cp -cR /path/to/model /private/tmp/voicekit-mlx-model-copy
server/mlx-worker/.build/release/voicekit-mlx-worker /private/tmp/voicekit-mlx-model-copy
```

The upstream loader can write tokenizer files and has a cache-cleanup branch.
Never point this experiment at the user's only copy of their model. The worker
also rejects a missing or malformed speech-tokenizer directory before loading.
It loads local weights, requires the MLX GPU device, and preserves the existing
framed-stdio protocol; upstream console output goes to stderr. Requests are
newline-delimited JSON with `text`, `voice` and `language` fields. EOF exits the
process and releases its model and Metal allocations.

This is a feasibility experiment, not a production replacement. Packaging,
minimum-OS compatibility, license bundling, Rust worker selection, application
latency and the existing Python setup flow have not been migrated. Generation
must emit the configured speech-end token; token-cap truncation is an error.
The upstream implementation has different generation internals from Python, so
matching sampling parameters do not imply identical audio.

Run the bounded stdio smoke test against the private model copy:

```sh
python3 server/mlx-worker/smoke.py swift --model /private/tmp/voicekit-mlx-model-copy --output /private/tmp/voicekit-swift-smoke
python3 server/mlx-worker/smoke.py python --python /path/to/venv/bin/python --model /private/tmp/voicekit-mlx-model-copy --output /private/tmp/voicekit-python-smoke
```

The run has bounded load, request and exit deadlines. Failure terminates only the
owned worker process group. It saves WAVs, stderr and a JSON report. Transcribe or listen to the saved
WAVs separately: successful framing alone does not establish correct speech.

Measurements and validation results belong in [docs/eval.md](../../docs/eval.md).
