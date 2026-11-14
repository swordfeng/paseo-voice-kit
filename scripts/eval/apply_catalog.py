"""Copy measured numbers into server/catalog.json (`eval` of each built-in model), so model cards
show them. Reads the summaries written by score_stt.py and score_tts.py.

- Speech recognition: error per language the model lists (all measured languages for models
  listing "multi"), and the median latency for a FLEURS clip (~10 s) from the latency run.
- Voices: round-trip character error per language (mean over the voices measured), and the
  real-time factor.

Usage: python3 -I scripts/eval/apply_catalog.py <catalog.json> <stt-summary.json> <stt-latency.json> <tts-summary.json>
"""

import json
import statistics
import sys


def main():
    catalog_path, stt_path, latency_path, tts_path = sys.argv[1:5]
    catalog = json.load(open(catalog_path, encoding="utf-8"))
    stt = json.load(open(stt_path, encoding="utf-8"))
    latency = json.load(open(latency_path, encoding="utf-8"))
    tts = json.load(open(tts_path, encoding="utf-8"))
    for m in catalog["models"]:
        langs = set(m.get("languages", []))
        if m["kind"] == "stt":
            run = stt.get(m["id"] + "|auto")
            if not run:
                continue
            errors = {l: s["error"] for l, s in sorted(run.items()) if "multi" in langs or l in langs}
            lat = [s["median_ms"] for s in latency.get(m["id"] + "|auto", {}).values() if s.get("median_ms")]
            m["eval"] = {"metric": "wer", "errors": errors}
            if lat:
                m["eval"]["ms"] = round(statistics.median(lat))
        else:
            per_lang, rtfs = {}, []
            for lang, entries in tts.items():
                mine = [e for e in entries if e["model"] == m["id"] and ("multi" in langs or lang in langs)]
                if mine:
                    per_lang[lang] = round(statistics.mean(e["cer"] for e in mine), 1)
                    rtfs += [e["rtf"] for e in mine if e.get("rtf")]
            if per_lang:
                m["eval"] = {"metric": "roundtrip", "errors": dict(sorted(per_lang.items()))}
                if rtfs:
                    m["eval"]["rtf"] = round(statistics.median(rtfs), 3)
    write_catalog(catalog_path, catalog)


def write_catalog(path, catalog):
    """Two-space JSON with lists of plain values and the `errors` maps on one line each."""
    text = json.dumps(catalog, indent=2, ensure_ascii=False)
    out, i = [], 0
    lines = text.split("\n")
    while i < len(lines):
        line = lines[i]
        if line.rstrip().endswith(("[", '"errors": {')):
            j, items = i + 1, []
            close = "]" if line.rstrip().endswith("[") else "}"
            while j < len(lines) and not lines[j].strip().startswith(close):
                items.append(lines[j].strip().rstrip(","))
                j += 1
            simple = all(not it.endswith(("{", "[")) and not it.startswith(("{", "[")) for it in items)
            if simple and j < len(lines):
                out.append(line.rstrip() + ", ".join(items) + lines[j].strip())
                i = j + 1
                continue
        out.append(line)
        i += 1
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")


if __name__ == "__main__":
    main()
