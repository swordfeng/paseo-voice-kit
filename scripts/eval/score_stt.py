"""Score speech recognition results from stt_eval.py: WER (CER for zh/yue/ja/ko/th) per model and
language, plus latency. Prints markdown tables and writes a JSON summary.

Usage: uv run --with opencc-python-reimplemented python -I scripts/eval/score_stt.py \
         <fleurs-dir> <results.jsonl> <summary.json> [model ...]
"""

import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from textnorm import CER_LANGS, edits, units  # noqa: E402

LANG_ORDER = ["en", "zh", "es", "fr", "de", "ja", "ko", "ru", "ar", "hi", "pt", "it", "vi", "id", "tr",
              "nl", "pl", "uk", "sv", "el", "th", "fa", "he", "sw", "bn", "ur", "ta", "ms", "tl", "yue", "ca", "ne"]


def main():
    data, results, summary_path = sys.argv[1:4]
    order = sys.argv[4:]
    refs = {}
    for l in open(os.path.join(data, "manifest.jsonl"), encoding="utf-8"):
        c = json.loads(l)
        refs[c["file"]] = c
    agg = {}
    for l in open(results, encoding="utf-8"):
        r = json.loads(l)
        key = (r["model"], r["mode"], r["lang"])
        a = agg.setdefault(key, {"err": 0, "n": 0, "ms": [], "secs": 0.0, "clips": 0, "failed": 0})
        ref = units(refs[r["file"]]["raw"], r["lang"])
        hyp = units(r["hyp"], r["lang"])
        a["err"] += edits(ref, hyp)
        a["n"] += len(ref)
        a["clips"] += 1
        if r["ms"] < 0:
            a["failed"] += 1
        else:
            a["ms"].append(r["ms"])
            a["secs"] += r["seconds"]
    summary = {}
    for (model, mode, lang), a in agg.items():
        summary.setdefault(f"{model}|{mode}", {})[lang] = {
            "error": round(100 * a["err"] / max(1, a["n"]), 1),
            "unit": "CER" if lang in CER_LANGS else "WER",
            "clips": a["clips"],
            "failed": a["failed"],
            "median_ms": round(statistics.median(a["ms"])) if a["ms"] else None,
            "rtf": round(sum(a["ms"]) / 1000 / a["secs"], 3) if a["secs"] else None,
        }
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=1, sort_keys=True)

    runs = order or sorted(summary)
    runs = [r if "|" in r else r + "|auto" for r in runs]
    runs = [r for r in runs if r in summary]
    langs = [l for l in LANG_ORDER if any(l in summary[r] for r in runs)]
    print("| Language | " + " | ".join(r.replace("|auto", "").replace("|hint", " (lang given)") for r in runs) + " |")
    print("|---|" + "---|" * len(runs))
    for lang in langs:
        cells = []
        vals = [summary[r][lang]["error"] for r in runs if lang in summary[r]]
        best = min(vals) if vals else None
        for r in runs:
            s = summary[r].get(lang)
            if not s:
                cells.append("")
                continue
            v = f"{s['error']:.1f}"
            cells.append(f"**{v}**" if s["error"] == best else v)
        print(f"| {lang}{' (CER)' if lang in CER_LANGS else ''} | " + " | ".join(cells) + " |")
    print()
    print("| Model | Languages run | Median ms per clip | Real-time factor |")
    print("|---|---|---|---|")
    for r in runs:
        ms = [s["median_ms"] for s in summary[r].values() if s["median_ms"]]
        rtf = [s["rtf"] for s in summary[r].values() if s["rtf"]]
        print(f"| {r.replace('|auto', '').replace('|hint', ' (lang given)')} | {len(summary[r])} | {round(statistics.median(ms)) if ms else ''} | {round(statistics.median(rtf), 3) if rtf else ''} |")


if __name__ == "__main__":
    main()
