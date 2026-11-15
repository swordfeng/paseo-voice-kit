#!/usr/bin/env python3
"""Bounded, standalone Metal smoke test; never changes the running plugin."""
import argparse
import json
import os
from pathlib import Path
import queue
import signal
import struct
import subprocess
import threading
import time
import wave


def exact(stream, size):
    data = bytearray()
    while len(data) < size:
        part = stream.read(size - len(data))
        if not part:
            raise EOFError("worker output closed")
        data.extend(part)
    return bytes(data)


def read_frames(process, events):
    try:
        while True:
            size = struct.unpack("<I", exact(process.stdout, 4))[0]
            if not 0 < size <= 65536:
                raise ValueError("invalid frame header length")
            header = json.loads(exact(process.stdout, size))
            size = header.get("bytes", 0)
            if not isinstance(size, int) or not 0 <= size <= 16 * 1024 * 1024:
                raise ValueError("invalid PCM length")
            events.put((header, exact(process.stdout, size)))
    except BaseException as error:
        events.put(error)


def receive(events, deadline):
    event = events.get(timeout=max(0.001, deadline - time.monotonic()))
    if isinstance(event, BaseException):
        raise event
    if event[0]["event"] == "error":
        raise RuntimeError(event[0])
    return event


def rss(process):
    return int(subprocess.check_output(
        ["ps", "-o", "rss=", "-p", str(process.pid)], timeout=3)) * 1024


def run(args):
    repo = Path(__file__).resolve().parents[2]
    if args.backend == "swift":
        command = [str(args.binary.resolve()), str(args.model.resolve())]
    else:
        # Preserve the venv launcher path; resolving its symlink loses pyvenv.cfg.
        command = [str(args.python.absolute()), "-I", "-u", "-c",
                   (repo / "server/src/engine/mlx_worker.py").read_text(),
                   str(args.model.resolve())]
    args.output.mkdir(parents=True, exist_ok=True)
    result = {"backend": args.backend, "model": args.model.name, "requests": []}
    process = None
    try:
        with (args.output / "worker.log").open("wb") as log:
            started = time.monotonic()
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=log, start_new_session=True)
            events = queue.Queue()
            threading.Thread(target=read_frames, args=(process, events), daemon=True).start()
            ready, _ = receive(events, started + 60)
            if ready["event"] != "ready" or ready.get("device") != "metal":
                raise RuntimeError("worker did not select Metal: " + repr(ready))
            result.update(ready=ready, loadSeconds=time.monotonic() - started,
                          loadedRssBytes=rss(process))
            print(json.dumps({"ready": result}, ensure_ascii=False), flush=True)
            samples = [("en", "Hello, this is a speech test."),
                       ("zh", "你好，这是一个语音测试。")]
            if args.language:
                samples = [(code, text) for code, text in samples if code == args.language]
            for language, text in samples[:1] if args.single else samples:
                started = time.monotonic()
                request = {"text": text, "voice": "serena", "language": language}
                process.stdin.write((json.dumps(request) + "\n").encode())
                process.stdin.flush()
                pcm, first, chunks = bytearray(), None, 0
                while True:
                    header, data = receive(events, started + 60)
                    if header["event"] == "done":
                        break
                    if header["event"] != "audio" or header.get("rate") != 24000:
                        raise RuntimeError("unexpected audio frame: " + repr(header))
                    if first is None:
                        first = time.monotonic() - started
                    pcm.extend(data)
                    chunks += 1
                    if len(pcm) >= 24000 * 2 * 30:
                        raise RuntimeError("short sample generated excessive audio")
                if not 2400 < len(pcm) < 24000 * 2 * 30 or len(pcm) % 2:
                    raise RuntimeError("invalid or empty PCM")
                with wave.open(str(args.output / (language + ".wav")), "wb") as audio:
                    audio.setnchannels(1)
                    audio.setsampwidth(2)
                    audio.setframerate(24000)
                    audio.writeframes(pcm)
                row = {"language": language, "text": text, "seconds": len(pcm) / 48000,
                       "firstChunkSeconds": first, "totalSeconds": time.monotonic() - started,
                       "chunks": chunks, "rssBytes": rss(process), "done": header}
                result["requests"].append(row)
                print(json.dumps(row, ensure_ascii=False), flush=True)
            process.stdin.close()
            process.wait(timeout=10)
            if process.returncode != 0:
                raise RuntimeError("worker failed while exiting: " + str(process.returncode))
            result.update(exitCode=process.returncode, exitedOnEOF=True)
    except BaseException as error:
        result["error"] = repr(error)
    finally:
        if process is not None:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
            process.stdout.close()
            if not process.stdin.closed:
                process.stdin.close()
        (args.output / "report.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    if "error" in result:
        raise RuntimeError(result["error"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backend", choices=["swift", "python"])
    parser.add_argument("--model", type=Path, required=True, help="private, disposable model copy")
    parser.add_argument("--binary", type=Path, default=Path(__file__).parent / ".build/release/voicekit-mlx-worker")
    parser.add_argument("--python", type=Path, help="existing private mlx-audio Python interpreter")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--single", action="store_true", help="English only")
    parser.add_argument("--language", choices=["en", "zh"], help="test one language only")
    args = parser.parse_args()
    if args.backend == "python" and args.python is None:
        parser.error("--python is required for the Python baseline")
    run(args)
