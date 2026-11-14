"""Transcribe the FLEURS sample with speech recognition models served by a running voicekit.

The server must serve every model named (`--stt-model a,b,c`) and run with `--language request`,
so requests without a language auto-detect and `--hint` requests pass the reference language.

Appends one JSON line per clip to <out> and skips clips already there, so runs can resume.
Latency is voicekit's own `inference` stage (x-voicekit-timing header), after one warm-up request
per model.

Usage: python3 -I scripts/eval/stt_eval.py --url http://127.0.0.1:PORT --token T \
         --data <fleurs-dir> --out results.jsonl --model ID [--langs en,zh] [--hint] [--limit N]
"""

import argparse
import json
import os
import time
import urllib.request
import uuid


def transcribe(url, token, model, path, language=None, timeout=30):
    boundary = uuid.uuid4().hex
    parts = []

    def field(name, value):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())

    field("model", model)
    if language:
        field("language", language)
    with open(path, "rb") as f:
        audio = f.read()
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + audio + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        f"{url}/v1/audio/transcriptions",
        data=b"".join(parts),
        headers={"Authorization": f"Bearer {token}", "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    started = time.monotonic()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.load(resp)
        timing = resp.headers.get("x-voicekit-timing", "")
    wall = (time.monotonic() - started) * 1000
    stages = dict(kv.split("=", 1) for kv in timing.split() if "=" in kv)
    return body.get("text", ""), float(stages.get("inference", wall)), stages


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--langs", default="")
    ap.add_argument("--hint", action="store_true", help="send the reference language")
    ap.add_argument("--limit", type=int, default=3, help="clips per language (0: all)")
    ap.add_argument("--budget-seconds", type=float, default=60, help="per-model time budget (0: unlimited)")
    ap.add_argument("--max-inference-ms", type=float, default=5000, help="skip a model whose warm-up exceeds this (0: unlimited)")
    ap.add_argument("--tag", default="", help="name to record instead of the model id")
    args = ap.parse_args()

    clips = [json.loads(l) for l in open(os.path.join(args.data, "manifest.jsonl"), encoding="utf-8") if l.strip()]
    langs = [l for l in args.langs.split(",") if l]
    if langs:
        clips = [c for c in clips if c["lang"] in langs]
    if args.limit:
        per = {}
        clips = [c for c in clips if per.setdefault(c["lang"], []).append(c) or len(per[c["lang"]]) <= args.limit]
    name = args.tag or args.model
    mode = "hint" if args.hint else "auto"
    done = set()
    if os.path.exists(args.out):
        for l in open(args.out, encoding="utf-8"):
            r = json.loads(l)
            done.add((r["model"], r["mode"], r["file"]))
    todo = [c for c in clips if (name, mode, c["file"]) not in done]
    if not todo:
        return
    # Warm-up (loads the model, first-run allocations).
    started = time.monotonic()
    _, warm_ms, _ = transcribe(args.url, args.token, args.model, os.path.join(args.data, todo[0]["file"]), todo[0]["lang"] if args.hint else None)
    if args.max_inference_ms and warm_ms > args.max_inference_ms:
        print(f"Skipping {name}: warm-up inference {warm_ms:.0f} ms exceeds {args.max_inference_ms:.0f} ms speed budget", flush=True)
        return
    completed = 0
    with open(args.out, "a", encoding="utf-8") as out:
        for c in todo:
            if args.budget_seconds and time.monotonic() - started >= args.budget_seconds:
                print(f"Stopping {name}: per-model time budget reached", flush=True)
                break
            try:
                text, ms, stages = transcribe(args.url, args.token, args.model, os.path.join(args.data, c["file"]), c["lang"] if args.hint else None)
            except Exception as e:  # keep going; the score shows the failure as an empty hypothesis
                text, ms, stages = "", -1.0, {"error": str(e)[:200]}
            out.write(json.dumps({"model": name, "mode": mode, "lang": c["lang"], "file": c["file"], "seconds": c["seconds"], "hyp": text, "ms": ms, "stages": stages}, ensure_ascii=False) + "\n")
            out.flush()
            completed += 1
    print(f"{name} {mode}: {completed} clips", flush=True)


if __name__ == "__main__":
    main()
