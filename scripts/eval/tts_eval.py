"""Round-trip speech synthesis check: speak FLEURS sentences with a running voicekit's voice model,
transcribe the audio back with Whisper turbo (language given), and record both for scoring.

The server must serve the voice model being tested and `whisper-large-v3-turbo-q5_0` for
recognition, with `--language request`.

Usage: python3 -I scripts/eval/tts_eval.py --url URL --token T --data <fleurs-dir> --out tts.jsonl \
         --wav-dir DIR --tag MODEL --pairs en:F1,es:F1,... [--n 5]
"""

import argparse
import json
import os
import struct
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stt_eval import transcribe  # noqa: E402

CHECK_MODEL = "whisper-large-v3-turbo-q5_0"


def speak(url, token, text, voice, lang):
    body = json.dumps({"input": text, "voice": voice, "language": lang, "response_format": "wav"}).encode()
    req = urllib.request.Request(f"{url}/v1/audio/speech", data=body, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    started = time.monotonic()
    with urllib.request.urlopen(req, timeout=30) as resp:
        audio = resp.read()
        timing = resp.headers.get("x-voicekit-timing", "")
    wall = (time.monotonic() - started) * 1000
    stages = dict(kv.split("=", 1) for kv in timing.split() if "=" in kv)
    return audio, float(stages.get("inference", wall))


def wav_seconds(audio: bytes) -> float:
    # voicekit writes a plain 44-byte RIFF header, mono s16.
    rate = struct.unpack_from("<I", audio, 24)[0]
    data = struct.unpack_from("<I", audio, 40)[0]
    return data / 2 / rate


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--wav-dir", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--pairs", required=True, help="lang:voice,...")
    ap.add_argument("--n", type=int, default=3)
    args = ap.parse_args()

    clips = [json.loads(l) for l in open(os.path.join(args.data, "manifest.jsonl"), encoding="utf-8") if l.strip()]
    done = set()
    if os.path.exists(args.out):
        for l in open(args.out, encoding="utf-8"):
            r = json.loads(l)
            done.add((r["model"], r["voice"], r["file"]))
    os.makedirs(args.wav_dir, exist_ok=True)
    # "fa@ar:F1": Persian sentences, sent to the model as Arabic (the voice is recorded as "F1@ar").
    pairs = [p.split(":", 1) for p in args.pairs.split(",") if p]
    warmed = False
    with open(args.out, "a", encoding="utf-8") as out:
        for spec, voice in pairs:
            lang, _, speak_as = spec.partition("@")
            speak_as = speak_as or lang
            label = voice + ("@" + speak_as if speak_as != lang else "")
            sentences = [c for c in clips if c["lang"] == lang][: args.n]
            for c in sentences:
                if (args.tag, label, c["file"]) in done:
                    continue
                if not warmed:
                    try:
                        speak(args.url, args.token, c["raw"], voice, speak_as)
                    except Exception:  # noqa: BLE001 - the measured request records the error
                        pass
                    warmed = True
                try:
                    audio, ms = speak(args.url, args.token, c["raw"], voice, speak_as)
                    secs = wav_seconds(audio)
                    name = f"{args.tag}-{label}-{os.path.basename(c['file'])}".replace("/", "_").replace(":", "_")
                    path = os.path.join(args.wav_dir, name)
                    with open(path, "wb") as f:
                        f.write(audio)
                    hyp, _, _ = transcribe(args.url, args.token, CHECK_MODEL, path, lang)
                except Exception as e:  # noqa: BLE001
                    hyp, ms, secs, name = "", -1.0, 0.0, f"error: {str(e)[:200]}"
                out.write(json.dumps({"model": args.tag, "voice": label, "lang": lang, "file": c["file"], "text": c["raw"], "hyp": hyp, "ms": ms, "audio_s": round(secs, 2), "wav": name}, ensure_ascii=False) + "\n")
                out.flush()
            print(f"{args.tag} {lang} {label}", flush=True)


if __name__ == "__main__":
    main()
