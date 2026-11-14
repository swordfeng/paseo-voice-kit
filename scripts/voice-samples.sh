#!/usr/bin/env bash
# Render a sample of every voice of a TTS model into a folder (for voice matching and previews).
# Usage: scripts/voice-samples.sh <tts-model> <out-dir> <text> [extra reuse dir]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${VOICEKIT_BIN:-$ROOT/server/target/release/voicekit}"
MD="${VOICEKIT_MODELS_DIR:-$HOME/.paseo/plugin-data/voice-kit/models}"
TTS="$1"; OUT_DIR="$2"; TEXT="$3"; EXTRA="${4:-}"
PORT=$((49600 + RANDOM % 300))
LOG="$(mktemp -d)"
REUSE=(--reuse-dir "$HOME/.paseo/models/local-speech")
if [ -n "$EXTRA" ]; then REUSE+=(--reuse-dir "$EXTRA"); fi
mkdir -p "$OUT_DIR"

VOICEKIT_TOKEN=s "$BIN" serve --port "$PORT" --models-dir "$MD" "${REUSE[@]}" \
  --stt-model sensevoice-int8 --tts-model "$TTS" --coreml false </dev/null >"$LOG/out" 2>"$LOG/err" &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 240); do grep -q '"warm"' "$LOG/out" 2>/dev/null && break; sleep 0.5; done

VOICES=$(curl -s -H "Authorization: Bearer s" "localhost:$PORT/voicekit/voices" | python3 -I -c 'import json,sys; print(" ".join(v["id"] for v in json.load(sys.stdin)["voices"]))')
for v in $VOICES; do
  BODY=$(python3 -I -c 'import json,sys; print(json.dumps({"input": sys.argv[1], "voice": sys.argv[2], "response_format": "wav", "language": sys.argv[3]}))' "$TEXT" "$v" "${LANG_CODE:-en}")
  curl -s -o "$OUT_DIR/$v.wav" -H "Authorization: Bearer s" -H 'content-type: application/json' -d "$BODY" "localhost:$PORT/v1/audio/speech"
done
echo "rendered $(ls "$OUT_DIR" | wc -l | tr -d ' ') voices of $TTS into $OUT_DIR"
