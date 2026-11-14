#!/usr/bin/env bash
# Build voicekit and install it where the Paseo plugin looks for a local development binary:
#   $PASEO_HOME/plugin-data/voice-kit/bin/local/voicekit
# The plugin prefers this over downloaded release binaries, then reloads with:
#   paseo plugin reload voice-kit
#
# Features (override with CARGO_FEATURES, empty for a plain CPU build):
#   macOS: coreml (Metal is always on; the Neural Engine is used when an encoder is installed).
#   Linux / Windows: vulkan-dl (ggml backends as runtime-loaded libraries next to the binary;
#   needs Vulkan headers and glslc to build, but not to run). The libraries are installed too.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" # Cargo discovers the checked-in platform configuration from its working directory.
HOME_DIR="${PASEO_HOME:-$HOME/.paseo}"
DEST="$HOME_DIR/plugin-data/voice-kit/bin/local"

OS="$(uname -s)"
if [ -z "${CARGO_FEATURES+x}" ]; then
  case "$OS" in
    Darwin) CARGO_FEATURES=coreml ;;
    *) CARGO_FEATURES=vulkan-dl ;;
  esac
fi
# GCC (12 and older) rejects the -march values of ggml's newest arm64 CPU variants; clang works.
if [ "$OS" = Linux ] && [ "$(uname -m)" = aarch64 ] && [ -z "${CC:-}" ] && command -v clang > /dev/null; then
  export CC=clang CXX=clang++
fi
case "$OS-$(uname -m)" in
  Darwin-arm64) BUILD_KEY=darwin-arm64 ;;
  Darwin-x86_64) BUILD_KEY=darwin-x64 ;;
  Linux-aarch64) BUILD_KEY=linux-arm64 ;;
  Linux-x86_64) BUILD_KEY=linux-x64 ;;
  MINGW*-*|MSYS*-*|CYGWIN*-*) BUILD_KEY=win32-x64 ;;
  *) echo "Unsupported native build platform: $OS" >&2; exit 1 ;;
esac
archive_name=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["inputs"]["sherpa-"+sys.argv[2]]["file"])' "$ROOT/build/native-inputs.json" "$BUILD_KEY")
python3 "$ROOT/scripts/fetch-build-input.py" "sherpa-$BUILD_KEY" "$ROOT/server/target/verified-inputs" --source "$ROOT/server/target/sherpa-onnx-prebuilt/$archive_name"
export SHERPA_ONNX_ARCHIVE_DIR="$ROOT/server/target/verified-inputs"
cargo build --locked --release --manifest-path "$ROOT/server/Cargo.toml" ${CARGO_FEATURES:+--features "$CARGO_FEATURES"}
TARGET="${CARGO_TARGET_DIR:-$ROOT/server/target}/release"
QWEN_FLAG=""
case "$OS" in Darwin) ;; *) if [[ "$CARGO_FEATURES" == *vulkan* ]]; then QWEN_FLAG=--vulkan; fi ;; esac
# macOS ships Bash 3.2, where an empty array trips `set -u`.
python3 "$ROOT/scripts/build-qwen-worker.py" --target-dir "$TARGET" ${QWEN_FLAG:+"$QWEN_FLAG"}
mkdir -p "$DEST"
EXE=voicekit
case "$OS" in MINGW*|MSYS*|CYGWIN*) EXE=voicekit.exe ;; esac

# Copy each file to a temp name then rename, so a running server keeps its old inode (a shared
# library overwritten in place would corrupt the process that has it mapped).
install_file() {
  cp "$1" "$DEST/$(basename "$1").new"
  mv -f "$DEST/$(basename "$1").new" "$DEST/$(basename "$1")"
}
shopt -s nullglob
for lib in "$TARGET"/lib*.so.[0-9] "$TARGET"/lib*.so.[0-9][0-9] "$TARGET"/libggml-*.so "$TARGET"/*.dll; do
  install_file "$lib"
done
stage="$(mktemp -d "$DEST/.gguf-runtime.XXXXXX")"
cp -R "$TARGET/gguf-runtime/." "$stage/"
if [ -d "$DEST/gguf-runtime" ]; then mv "$DEST/gguf-runtime" "$DEST/gguf-runtime.rollback.$(date +%s)"; fi
mv "$stage" "$DEST/gguf-runtime"
install_file "$TARGET/$EXE"
chmod +x "$DEST/$EXE"
echo "installed $DEST/$EXE ($("$DEST/$EXE" --version))"
