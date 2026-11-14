"""Score speech synthesis round trips from tts_eval.py: character error rate of Whisper turbo's
transcript of the synthesized audio against the sentence, and synthesis speed. As a floor, the same
check on the human FLEURS recordings of those sentences (from the STT results, language given).

Usage: uv run --with opencc-python-reimplemented python -I scripts/eval/score_tts.py \
         <tts.jsonl> <stt.jsonl> <summary.json>
"""

import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from score_stt import LANG_ORDER  # noqa: E402
from textnorm import chars, edits  # noqa: E402


def main():
    tts_path, stt_path, summary_path = sys.argv[1:4]
    rows = [json.loads(l) for l in open(tts_path, encoding="utf-8")]
    human = {}
    if os.path.exists(stt_path):
        for l in open(stt_path, encoding="utf-8"):
            r = json.loads(l)
            if r["model"] == "whisper-large-v3-turbo-q5_0" and r["mode"] == "hint":
                human[r["file"]] = r["hyp"]
    agg = {}
    for r in rows:
        a = agg.setdefault((r["model"], r["voice"], r["lang"]), {"err": 0, "n": 0, "ms": [], "audio": 0.0, "files": [], "failed": 0})
        ref = chars(r["text"], r["lang"])
        a["err"] += edits(ref, chars(r["hyp"], r["lang"]))
        a["n"] += len(ref)
        a["files"].append(r["file"])
        if r["ms"] < 0:
            a["failed"] += 1
        else:
            a["ms"].append(r["ms"])
            a["audio"] += r["audio_s"]
    summary = {}
    for (model, voice, lang), a in agg.items():
        h_err = h_n = 0
        for f in a["files"]:
            if f in human:
                ref = chars(next(r["text"] for r in rows if r["file"] == f), lang)
                h_err += edits(ref, chars(human[f], lang))
                h_n += len(ref)
        summary.setdefault(lang, []).append({
            "model": model, "voice": voice, "cer": round(100 * a["err"] / max(1, a["n"]), 1),
            "human_cer": round(100 * h_err / h_n, 1) if h_n else None, "sentences": len(a["files"]), "failed": a["failed"],
            "median_ms": round(statistics.median(a["ms"])) if a["ms"] else None,
            "rtf": round(sum(a["ms"]) / 1000 / a["audio"], 3) if a["audio"] else None,
        })
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=1, ensure_ascii=False, sort_keys=True)

    print("| Language | Human recording | Model · voice: round-trip CER % (real-time factor) |")
    print("|---|---|---|")
    for lang in [l for l in LANG_ORDER if l in summary]:
        entries = sorted(summary[lang], key=lambda e: e["cer"])
        human_cer = next((e["human_cer"] for e in entries if e["human_cer"] is not None), None)
        cells = "; ".join(f"{e['model']} · {e['voice']}: {e['cer']:.1f} ({e['rtf']})" for e in entries)
        print(f"| {lang} | {'' if human_cer is None else f'{human_cer:.1f}'} | {cells} |")


if __name__ == "__main__":
    main()
