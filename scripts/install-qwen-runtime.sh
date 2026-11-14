#!/usr/bin/env bash
# Explicit setup for the optional Apple Silicon MLX backend. Never run by speech requests.
set -euo pipefail
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "Qwen's MLX runtime requires an Apple Silicon Mac." >&2
  exit 1
fi
if [ "$(sw_vers -productVersion | cut -d. -f1)" -lt 14 ]; then
  echo "Qwen's pinned MLX runtime requires macOS 14 or later." >&2
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASEO_DATA="${PASEO_HOME:-$HOME/.paseo}/plugin-data/voice-kit"
QWEN_ENV="$PASEO_DATA/runtime/qwen"
QWEN_PYTHON="${VOICEKIT_SETUP_PYTHON:-python3.12}"
"$QWEN_PYTHON" -c 'import sys; assert sys.version_info[:2] == (3,12), "Python 3.12 is required"'
mkdir -p "$PASEO_DATA/runtime"
if [ ! -x "$QWEN_ENV/bin/python" ]; then
  "$QWEN_PYTHON" -m venv "$QWEN_ENV"
fi
"$QWEN_ENV/bin/python" -m pip install --disable-pip-version-check --require-hashes --only-binary=:all: -r "$SCRIPT_DIR/qwen-build-requirements.txt"
"$QWEN_ENV/bin/python" -m pip install --disable-pip-version-check --require-hashes --no-build-isolation -r "$SCRIPT_DIR/qwen-requirements.txt"
"$QWEN_ENV/bin/python" -c 'import mlx.core as mx; import mlx_audio; assert mx.metal.is_available(), "Metal GPU unavailable"; print("MLX speech runtime ready:", mx.default_device())'
echo "Runtime installed at $QWEN_ENV. Models download separately when used."
