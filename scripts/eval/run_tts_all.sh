#!/usr/bin/env bash
# The speech synthesis runs behind docs/eval.md. Results append to <out-dir>/tts.jsonl.
# Usage: scripts/eval/run_tts_all.sh <fleurs-dir> <out-dir>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="$1"; OUT="$2"
mkdir -p "$OUT/wavs"
run() { bash "$ROOT/scripts/eval/run_tts.sh" "$DATA" "$OUT/tts.jsonl" "$OUT/wavs" "$@"; }
pairs() { local voice="$1"; shift; local out=""; for l in "$@"; do out+="$l:$voice,"; done; echo "${out%,}"; }

SUPERTONIC_LANGS=(en es fr de ja ko ru ar hi pt it vi id tr nl pl uk sv el)
run supertonic-3 "$(pairs F1 "${SUPERTONIC_LANGS[@]}"),$(pairs M1 "${SUPERTONIC_LANGS[@]}")"
run kokoro-multi-lang-v1_1 "zh:zh-f14,zh:zh-m06,en:en-maple,en:zh-f14"
# Languages Supertonic does not speak: dedicated single-language voices...
run mms-tha "th:mms-tha"
# Piper voices (fa, sw, ur, ne, ca) were candidates too, but sherpa-onnx 2.x no longer bundles
# espeak-ng, so they fail to synthesize ("phoneme_codepoints is empty, no lexicon, and no
# frontend available"). MMS and Coqui models read characters and still work.
run coqui-bn "bn:coqui-bn"
run vits-yue "yue:vits-yue"
# Additional candidate voices.
run kokoro-int8-multi-lang-v1_1 "zh:zh-f14,zh:zh-m06"
run melo-tts-zh-en "zh:melo,en:melo"
# Supertonic reading languages it lacks with a related language's rules ("fa@ar": Persian text,
# language tag ar). Evaluates explicitly allowed approximate readings.
run supertonic-3 "fa@ar:F1,fa@en:F1,ur@ar:F1,ur@en:F1,ur@hi:F1,ca@es:F1,ca@en:F1,ne@hi:F1,ne@en:F1,tl@es:F1,tl@id:F1,tl@en:F1,sw@en:F1,sw@id:F1,ms@id:F1,ms@en:F1,he@ar:F1,ta@hi:F1"
