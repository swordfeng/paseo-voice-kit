#!/usr/bin/env bash
# Benchmark voicekit engines against real clips.
# Usage: scripts/bench.sh <stt-model> <tts-model> <onnx-provider> <threads> [wav...]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${VOICEKIT_BIN:-$ROOT/server/target/release/voicekit}"
MD="${VOICEKIT_MODELS_DIR:-$HOME/.paseo/plugin-data/voice-kit/models}"
STT="$1"; TTS="$2"; PROV="$3"; THREADS="$4"; shift 4
PORT=$((48000 + RANDOM % 1000))
OUT="$(mktemp -d)"

VOICEKIT_TOKEN=bench "$BIN" serve --port "$PORT" --models-dir "$MD" \
  --reuse-dir "$HOME/.paseo/models/local-speech" \
  --stt-model "$STT" --tts-model "$TTS" --onnx-provider "$PROV" --threads "$THREADS" ${VOICEKIT_ARGS:-} \
  </dev/null >"$OUT/out" 2>"$OUT/err" &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; rm -rf "$OUT"' EXIT

for _ in $(seq 1 240); do grep -q '"warm"' "$OUT/out" 2>/dev/null && break; sleep 0.5; done
if ! grep -q '"warm"' "$OUT/out"; then tail -5 "$OUT/err"; exit 1; fi

AUTH="Authorization: Bearer bench"
now_ms() { python3 -I -c 'import time; print(int(time.time() * 1000))'; }
TEXT='{"model":"x","voice":"zh-f01","input":"你好，我是你的语音助手。The build passed and all tests are green.","response_format":"pcm"}'

curl -s -o /dev/null -H "$AUTH" -H 'content-type: application/json' -d "$TEXT" "localhost:$PORT/v1/audio/speech"
a=$(now_ms)
curl -s -o "$OUT/p.pcm" -H "$AUTH" -H 'content-type: application/json' -d "$TEXT" "localhost:$PORT/v1/audio/speech"
b=$(now_ms)
secs=$(python3 -I -c "import os, sys; print(round(os.path.getsize(sys.argv[1]) / 48000, 2))" "$OUT/p.pcm")
echo "TTS $TTS provider=$PROV threads=$THREADS: $((b - a)) ms for ${secs}s of audio"

for f in "$@"; do
  curl -s -o /dev/null -H "$AUTH" -F file=@"$f" -F model=x "localhost:$PORT/v1/audio/transcriptions"
  a=$(now_ms)
  r=$(curl -s -H "$AUTH" -F file=@"$f" -F model=x "localhost:$PORT/v1/audio/transcriptions")
  b=$(now_ms)
  echo "STT $STT: $((b - a)) ms $(basename "$f"): $r"
done
