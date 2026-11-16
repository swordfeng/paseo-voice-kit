#!/usr/bin/env bash
# Package a built voicekit for release.
#   scripts/package-release.sh <platform-key> <target-dir> <out-dir>
# e.g. scripts/package-release.sh linux-x64 server/target/release dist
#
# Every platform: <out>/voicekit-<key>.tar.gz holding voicekit-<key>/ with the executable, notices and
# ggml libraries it loads (libwhisper/libggml/libggml-base, one ggml-cpu module per CPU level, and
# ggml-vulkan). Prints the archive path on stdout.
set -euo pipefail
key="$1"
target="$2"
out="$3"
notices="${VOICEKIT_NOTICES:-$target/release-notices}"
if [ ! -f "$notices/LICENSE" ] || [ ! -f "$notices/RUST_DEPENDENCIES.md" ]; then
  echo "missing release notices: run scripts/collect-licenses.py first" >&2
  exit 1
fi
mkdir -p "$out"

exe=voicekit
case "$key" in win32-*) exe=voicekit.exe ;; esac
stage="$out/voicekit-$key"
if [ -e "$stage" ]; then
  echo "package staging directory already exists: $stage (use a new output directory)" >&2
  exit 1
fi
mkdir "$stage"
cp "$target/$exe" "$stage/"
if [ ! -d "$target/gguf-runtime" ]; then echo "missing GGUF runtime; run scripts/build-qwen-worker.py first" >&2; exit 1; fi
cp -R "$target/gguf-runtime" "$stage/"
mkdir -p "$stage/gguf-runtime/notices/sources"
script_root="$(cd "$(dirname "$0")/.." && pwd)"
cp "$script_root"/server/vendor/qwen-sources/* "$stage/gguf-runtime/notices/sources/"
cp -R "$notices/." "$stage/"
if [ "$key" = darwin-arm64 ]; then
  if [ ! -f "$target/mlx-runtime/runtime.json" ]; then echo "missing native MLX worker; run scripts/build-mlx-worker.py first" >&2; exit 1; fi
  cp -R "$target/mlx-runtime" "$stage/"
fi
shopt -s nullglob
if [[ "$key" != darwin-* ]]; then
if [ "$exe" = voicekit.exe ]; then
  libs=("$target"/*.dll)
else
  # SONAME-named shared libraries and the backend modules (no unversioned dev symlinks).
  libs=("$target"/lib*.so.[0-9] "$target"/lib*.so.[0-9][0-9] "$target"/libggml-*.so)
fi
if [ "${#libs[@]}" -eq 0 ]; then
  echo "no ggml libraries next to $target/$exe (build with --features vulkan-dl)" >&2
  exit 1
fi
cp "${libs[@]}" "$stage/"
# Fail early if a backend is missing from the package.
ls "$stage" | grep -q 'ggml-cpu' || { echo "no ggml-cpu modules packaged" >&2; exit 1; }
ls "$stage" | grep -q 'ggml-vulkan' || { echo "no ggml-vulkan module packaged" >&2; exit 1; }
fi
tar -czf "$out/voicekit-$key.tar.gz" -C "$out" "voicekit-$key"
echo "$out/voicekit-$key.tar.gz"
