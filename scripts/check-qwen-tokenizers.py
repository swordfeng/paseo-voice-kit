#!/usr/bin/env python3
"""Bounded private-IPC check of the tokenizers used by the two Qwen workers."""
import argparse
import json
from pathlib import Path
import queue
import struct
import subprocess
import threading
import time

TEXTS = ["Hello, this is a speech test.", "你好，这是一个语音测试。", "こんにちは、音声のテストです。",
         "When I leave the house in the morning I walk along the river and look at the trees " * 5]


def check(command, label, output, deadline):
    frames = queue.Queue()
    with (output / (label + ".log")).open("wb") as log:
        process = subprocess.Popen([str(p) for p in command], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
        def read():
            def exact(n):
                data = bytearray()
                while len(data) < n:
                    block = process.stdout.read(n - len(data))
                    if not block:
                        raise RuntimeError("worker output closed")
                    data.extend(block)
                return data
            try:
                while True:
                    size, = struct.unpack("<I", exact(4))
                    if not 0 < size <= 65_536:
                        raise RuntimeError("invalid frame size")
                    header = json.loads(exact(size))
                    if header.get("bytes") != 0:
                        raise RuntimeError("token counting unexpectedly produced audio")
                    frames.put(header)
            except Exception as error:
                frames.put(error)
        threading.Thread(target=read, daemon=True).start()
        def receive():
            value = frames.get(timeout=max(0.1, deadline - time.monotonic()))
            if isinstance(value, Exception):
                raise value
            if value.get("event") == "error":
                raise RuntimeError(value)
            return value
        try:
            ready = receive()
            assert ready["event"] == "ready", ready
            counts = []
            for text in [*TEXTS, TEXTS[0]]:
                process.stdin.write((json.dumps({"op": "count_tokens", "text": text}) + "\n").encode())
                process.stdin.flush()
                response = receive()
                assert response["event"] == "text_tokens", response
                count = response.get("count")
                assert isinstance(count, int) and 0 < count < 65_536, response
                counts.append(count)
            assert counts[0] == counts[-1], "counting changed tokenizer state"
            assert counts[-2] > 64, "fixture must exceed the production text budget"
            return {"device": ready["device"], "counts": counts[:-1], "characters": list(map(len, TEXTS)), "stateless": True}
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-dir", type=Path, required=True)
    parser.add_argument("--gguf-model", type=Path, required=True)
    parser.add_argument("--gguf-codec", type=Path, required=True)
    parser.add_argument("--mlx-model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + args.timeout
    root = args.runtime_dir.resolve()
    results = {}
    for label, command in [("gguf", [root / "gguf-runtime/voicekit-qwen-worker", args.gguf_model.resolve(), args.gguf_codec.resolve(), "auto"]),
                           ("mlx", [root / "mlx-runtime/voicekit-mlx-worker", args.mlx_model.resolve()])]:
        results[label] = check(command, label, args.output, deadline)
        print(json.dumps({label: results[label]}, ensure_ascii=False), flush=True)
    (args.output / "report.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
