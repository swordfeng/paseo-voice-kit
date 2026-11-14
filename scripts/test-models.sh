#!/usr/bin/env bash
# Smoke-test catalog models with real audio: transcribe clips with each STT model and synthesize
# a mixed Chinese/English sentence with a TTS model, then transcribe that back with Whisper.
#
# Usage: scripts/test-models.sh <tts-model> <stt-model,...> [wav...]
# Env:   VOICEKIT_BIN, VOICEKIT_MODELS_DIR, EXTRA_REUSE (extra --reuse-dir), CHECK_STT (default whisper turbo)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${VOICEKIT_BIN:-$ROOT/server/target/release/voicekit}"
MD="${VOICEKIT_MODELS_DIR:-$HOME/.paseo/plugin-data/voice-kit/models}"
CHECK_STT="${CHECK_STT:-whisper-large-v3-turbo-q5_0}"
TTS="$1"; STT="$2"; shift 2
PORT=$((49000 + RANDOM % 500))
OUT="$(mktemp -d)"
REUSE=(--reuse-dir "$HOME/.paseo/models/local-speech")
if [ -n "${EXTRA_REUSE:-}" ]; then REUSE+=(--reuse-dir "$EXTRA_REUSE"); fi

VOICEKIT_TOKEN=t "$BIN" serve --port "$PORT" --models-dir "$MD" "${REUSE[@]}" \
  --stt-model "$STT,$CHECK_STT" --tts-model "$TTS" --coreml false </dev/null >"$OUT/out" 2>"$OUT/err" &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; rm -rf "$OUT"' EXIT
for _ in $(seq 1 600); do grep -q '"warm"' "$OUT/out" 2>/dev/null && break; kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if ! grep -q '"warm"' "$OUT/out"; then echo "server did not start:"; tail -5 "$OUT/err"; exit 1; fi

AUTH="Authorization: Bearer t"
curl -s -H "$AUTH" "localhost:$PORT/voicekit/status" | python3 -I -c '
import json, sys
d = json.load(sys.stdin)
for e in d["stt"] + [d["tts"]]:
    print("  " + e["model"] + ": " + e["state"] + " " + (e.get("accelerator") or "") + " " + (e.get("error") or ""))'

IFS=, read -r -a MODELS <<< "$STT"
for m in "${MODELS[@]}"; do
  for f in "$@"; do
    curl -s -o /dev/null -H "$AUTH" -F file=@"$f" -F model="$m" "localhost:$PORT/v1/audio/transcriptions"
    r=$(curl -s -D "$OUT/h" -H "$AUTH" -F file=@"$f" -F model="$m" "localhost:$PORT/v1/audio/transcriptions")
    t=$(grep -io 'inference=[0-9]*' "$OUT/h" || true)
    echo "STT $m $(basename "$f") [$t ms]: $r"
  done
done

TEXT='{"input":"你好，我是你的语音助手。The build passed and all tests are green.","response_format":"wav"}'
curl -s -o /dev/null -H "$AUTH" -H 'content-type: application/json' -d "$TEXT" "localhost:$PORT/v1/audio/speech"
curl -s -D "$OUT/h" -o "$OUT/tts.wav" -H "$AUTH" -H 'content-type: application/json' -d "$TEXT" "localhost:$PORT/v1/audio/speech"
t=$(grep -io 'inference=[0-9]*' "$OUT/h" || true)
back=$(curl -s -H "$AUTH" -F file=@"$OUT/tts.wav" -F model="$CHECK_STT" "localhost:$PORT/v1/audio/transcriptions")
echo "TTS $TTS [$t ms] heard back as: $back"
