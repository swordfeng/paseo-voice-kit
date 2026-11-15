# Native MLX speech worker

Voice Kit uses this persistent Swift executable for Qwen3-TTS CustomVoice on
Apple Silicon with macOS 14 or later. Rust launches it on first use, exchanges
framed JSON/PCM over stdio, and owns timeout, retry and unload behavior. There is
no Python inference process or runtime installation step.

Build and stage the complete payload with Xcode / Swift 6.2 or later and its
Metal Toolchain:

```sh
python3 scripts/build-mlx-worker.py --target-dir server/target/release
```

Python is a developer build/test tool here. The resulting `mlx-runtime` folder
contains the executable, explicit `mlx.metallib`, Swift compatibility dylibs when
needed, resource bundles, an inventory manifest and dependency notices. Its
non-system dylib references are made relative and development-toolchain rpaths
are removed. Distribute the complete folder beside `voicekit`; the release and
development installers do this automatically. Users install nothing separately.

The build verifies the pinned upstream revision, applies the tracked patches
idempotently, and respects a build deadline. `Package.resolved` pins transitive
Swift dependencies. The patches honor the caller's token budget and construct
tokenizers in memory; model directories are read-only and are never removed.
The worker accepts only CustomVoice checkpoints with the nine preset speakers.
Generation uses seed 42 by default and must emit EOS; budget exhaustion is an
error. Upstream console output goes to stderr, preserving framed stdout.

Run the bounded native protocol or HTTP check using already-downloaded weights:

```sh
python3 server/mlx-worker/smoke.py --binary server/target/release/mlx-runtime/voicekit-mlx-worker --model /path/to/model --output /private/tmp/voicekit-mlx-stdio
python3 scripts/smoke-mlx-models.py --exe server/target/release/voicekit --model /path/to/model --reuse-dir /path/to/existing/asr/models --output /private/tmp/voicekit-mlx-http
```

These checks never install into Paseo or change its settings. See
[docs/eval.md](../../docs/eval.md) for budgets, coverage, results and limitations.

`VOICEKIT_MLX_PROFILE=1` records text-free timing on stderr.
`VOICEKIT_MLX_SEED` overrides the per-request seed for controlled diagnostics.
`diagnostics/metal-compile-timers.patch` is an optional probe for the MLX C++
submodule; the normal build does not apply it. It can intentionally create cold
source-cache entries and is not part of the distributed runtime.
