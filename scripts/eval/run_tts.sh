#!/usr/bin/env bash
# Run the speech synthesis round trip for one voice model: start a voicekit with that model and
# Whisper turbo on a free port, speak FLEURS sentences per language and voice, transcribe back.
#
# Usage: scripts/eval/run_tts.sh <fleurs-dir> <results.jsonl> <wav-dir> <tts-model> <lang:voice,...>
# Env: VOICEKIT_BIN, EVAL_MODELS_DIR, EVAL_REUSE, N (sentences per language, default 5)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="${VOICEKIT_BIN:-$ROOT/server/target/release/voicekit}"
MD="${EVAL_MODELS_DIR:-/tmp/vk-eval/models}"
DATA="$1"; OUT="$2"; WAVS="$3"; TTS="$4"; PAIRS="$5"
REUSE=()
IFS=: read -r -a dirs <<< "${EVAL_REUSE:-$HOME/.paseo/plugin-data/voice-kit/models:$HOME/.paseo/models/local-speech}"
for d in "${dirs[@]}"; do REUSE+=(--reuse-dir "$d"); done

LOG="$(mktemp -d)"
VOICEKIT_TOKEN=eval "$BIN" serve --port 0 --models-dir "$MD" "${REUSE[@]}" --catalog "$ROOT/scripts/eval/candidates.json" \
  --stt-model whisper-large-v3-turbo-q5_0 --tts-model "$TTS" --language request --coreml false </dev/null >"$LOG/out" 2>"$LOG/err" &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do grep -q '"warm"' "$LOG/out" 2>/dev/null && break; kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if ! grep -q '"warm"' "$LOG/out"; then echo "server did not start:"; tail -5 "$LOG/err"; exit 1; fi
PORT=$(python3 -I -c 'import json,sys
for l in open(sys.argv[1]):
    d = json.loads(l)
    if "port" in d: print(d["port"]); break' "$LOG/out")
python3 -I "$ROOT/scripts/eval/tts_eval.py" --url "http://127.0.0.1:$PORT" --token eval --data "$DATA" --out "$OUT" \
  --wav-dir "$WAVS" --tag "$TTS" --pairs "$PAIRS" --n "${N:-5}"
