"""Fetch a small, reproducible FLEURS test sample per language (stdlib only).

For each language it reads test.tsv, then streams audio/test.tar.gz from the pinned dataset
revision and keeps the first N clips (in archive order) with distinct sentence ids, stopping the
download as soon as it has them (a few MB per language instead of the whole archive).

Writes <out>/<config>/<id>.wav (16-bit PCM, scaled to a peak of 0.5) and <out>/manifest.jsonl.
Rerunning gives the same clips.

Usage: python3 -I scripts/eval/fetch_fleurs.py <out-dir> [--n 15] [config ...]
"""

import argparse
import csv
import io
import json
import os
import struct
import sys
import tarfile
import urllib.request

REVISION = "70bb2e84b976b7e960aa89f1c648e09c59f894dd"
BASE = f"https://huggingface.co/datasets/google/fleurs/resolve/{REVISION}/data"

# FLEURS config -> ISO 639-1 code used by voicekit (zh for Mandarin, yue for Cantonese).
CONFIGS = {
    "en_us": "en", "cmn_hans_cn": "zh", "es_419": "es", "fr_fr": "fr", "de_de": "de",
    "ja_jp": "ja", "ko_kr": "ko", "ru_ru": "ru", "ar_eg": "ar", "hi_in": "hi",
    "pt_br": "pt", "it_it": "it", "vi_vn": "vi", "id_id": "id", "tr_tr": "tr",
    # More languages, several of them lower-resource.
    "nl_nl": "nl", "pl_pl": "pl", "uk_ua": "uk", "sv_se": "sv", "el_gr": "el",
    "th_th": "th", "fa_ir": "fa", "he_il": "he", "sw_ke": "sw", "bn_in": "bn",
    "ur_pk": "ur", "ta_in": "ta", "ms_my": "ms", "fil_ph": "tl", "yue_hant_hk": "yue",
    "ca_es": "ca", "ne_np": "ne",
}

csv.field_size_limit(sys.maxsize)

# Every clip is scaled to this peak and written as 16-bit PCM. Some FLEURS recordings are very
# quiet (en_us has clips peaking at -44 dBFS), below voicekit's silence gate (peak 0.008), which
# would make every model look as if it heard nothing.
TARGET_PEAK = 0.5


def wav_samples(data: bytes) -> tuple[int, list[float]]:
    """Sample rate and mono samples of a PCM16 or float32 WAV."""
    pos, fmt, rate, bits, payload = 12, 1, 16000, 16, b""
    while pos + 8 <= len(data):
        cid, size = data[pos:pos + 4], struct.unpack_from("<I", data, pos + 4)[0]
        body = data[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            fmt, _channels, rate = struct.unpack_from("<HHI", body)
            bits = struct.unpack_from("<H", body, 14)[0]
        elif cid == b"data":
            payload = body
        pos += 8 + size + (size & 1)
    if fmt == 3 or bits == 32:
        return rate, list(struct.unpack(f"<{len(payload) // 4}f", payload[: len(payload) // 4 * 4]))
    return rate, [s / 32768 for s in struct.unpack(f"<{len(payload) // 2}h", payload[: len(payload) // 2 * 2])]


def normalized_wav(data: bytes) -> tuple[bytes, float]:
    rate, samples = wav_samples(data)
    peak = max((abs(s) for s in samples), default=0.0)
    gain = TARGET_PEAK / peak if peak > 0 else 1.0
    pcm = struct.pack(f"<{len(samples)}h", *(max(-32768, min(32767, round(s * gain * 32767))) for s in samples))
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(pcm))
    return header + pcm, peak


def fetch_config(config: str, out: str, n: int) -> list[dict]:
    tsv = urllib.request.urlopen(f"{BASE}/{config}/test.tsv").read().decode("utf-8")
    rows = {}
    for r in csv.reader(io.StringIO(tsv), delimiter="\t", quoting=csv.QUOTE_NONE):
        # id, file name, raw transcription, normalized transcription, characters, samples, gender
        if len(r) >= 7:
            rows[r[1]] = {"sentence_id": r[0], "raw": r[2], "normalized": r[3], "samples": int(r[5]), "gender": r[6]}
    os.makedirs(os.path.join(out, config), exist_ok=True)
    picked, seen = [], set()
    with urllib.request.urlopen(f"{BASE}/{config}/audio/test.tar.gz") as resp:
        with tarfile.open(fileobj=resp, mode="r|gz") as tar:
            for member in tar:
                if not member.isfile():
                    continue
                name = os.path.basename(member.name)
                row = rows.get(name)
                if row is None or row["sentence_id"] in seen:
                    continue
                # Untrusted archive: only read bytes, write under a name we choose.
                data, peak = normalized_wav(tar.extractfile(member).read())
                clip_id = "".join(c for c in name.removesuffix(".wav") if c.isalnum() or c in "-_")
                path = os.path.join(out, config, clip_id + ".wav")
                with open(path, "wb") as f:
                    f.write(data)
                seen.add(row["sentence_id"])
                picked.append({
                    "config": config, "lang": CONFIGS[config], "file": f"{config}/{clip_id}.wav",
                    "fleurs_file": name, "sentence_id": row["sentence_id"], "gender": row["gender"],
                    "seconds": round(row["samples"] / 16000, 2), "original_peak": round(peak, 4), "raw": row["raw"], "normalized": row["normalized"],
                })
                if len(picked) >= n:
                    break
    return picked


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--n", type=int, default=15)
    ap.add_argument("configs", nargs="*")
    args = ap.parse_args()
    configs = args.configs or list(CONFIGS)
    manifest = os.path.join(args.out, "manifest.jsonl")
    existing = []
    if os.path.exists(manifest):
        existing = [json.loads(l) for l in open(manifest, encoding="utf-8") if l.strip()]
    keep = [e for e in existing if e["config"] not in configs]
    for config in configs:
        clips = fetch_config(config, args.out, args.n)
        print(f"{config}: {len(clips)} clips, {sum(c['seconds'] for c in clips):.0f} s", flush=True)
        keep += clips
    with open(manifest, "w", encoding="utf-8") as f:
        for e in keep:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
