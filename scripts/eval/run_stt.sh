#!/usr/bin/env bash
# Run the speech recognition evaluation: start a voicekit serving the given models on a free
# port with its own models dir, transcribe the FLEURS sample with each, stop the server.
#
# Usage: scripts/eval/run_stt.sh <fleurs-dir> <results.jsonl> <model[:langs][:hint]>...
#   langs: comma-free list joined with '+', e.g. moonshine-base-es:es  or  sensevoice-int8:zh+en+ja+ko+yue
#   hint:  also send the reference language (auto-detect otherwise)
# Env: VOICEKIT_BIN, EVAL_MODELS_DIR (default /tmp/vk-eval/models), EVAL_REUSE (colon separated
#      read-only model dirs), EVAL_ARGS (extra serve args), LIMIT (clips per language)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="${VOICEKIT_BIN:-$ROOT/server/target/release/voicekit}"
MD="${EVAL_MODELS_DIR:-/tmp/vk-eval/models}"
DATA="$1"; OUT="$2"; shift 2
REUSE=()
IFS=: read -r -a dirs <<< "${EVAL_REUSE:-$HOME/.paseo/plugin-data/voice-kit/models:$HOME/.paseo/models/local-speech}"
for d in "${dirs[@]}"; do REUSE+=(--reuse-dir "$d"); done

ids=()
for spec in "$@"; do ids+=("${spec%%:*}"); done
STT=$(IFS=,; echo "${ids[*]}")
LOG="$(mktemp -d)"
VOICEKIT_TOKEN=eval "$BIN" serve --port 0 --models-dir "$MD" "${REUSE[@]}" --catalog "$ROOT/scripts/eval/candidates.json" \
  --stt-model "$STT" --tts-model supertonic-3 --language request --coreml false ${EVAL_ARGS:-} </dev/null >"$LOG/out" 2>"$LOG/err" &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do grep -q '"warm"' "$LOG/out" 2>/dev/null && break; kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if ! grep -q '"warm"' "$LOG/out"; then echo "server did not start:"; tail -5 "$LOG/err"; exit 1; fi
PORT=$(python3 -I -c 'import json,sys
for l in open(sys.argv[1]):
    d = json.loads(l)
    if "port" in d: print(d["port"]); break' "$LOG/out")
echo "voicekit on port $PORT (log $LOG)"
for spec in "$@"; do
  id="${spec%%:*}"; rest="${spec#"$id"}"; langs=""; hint=()
  IFS=: read -r -a parts <<< "${rest#:}"
  for p in ${parts[@]+"${parts[@]}"}; do
    case "$p" in hint) hint=(--hint) ;; "") ;; *) langs="${p//+/,}" ;; esac
  done
  python3 -I "$ROOT/scripts/eval/stt_eval.py" --url "http://127.0.0.1:$PORT" --token eval --data "$DATA" --out "$OUT" \
    --model "$id" --langs "$langs" --limit "${LIMIT:-3}"
  if [ ${#hint[@]} -gt 0 ]; then
    python3 -I "$ROOT/scripts/eval/stt_eval.py" --url "http://127.0.0.1:$PORT" --token eval --data "$DATA" --out "$OUT" \
      --model "$id" --langs "$langs" --limit "${LIMIT:-3}" --hint
  fi
done
