#!/usr/bin/env python3
"""Short real inference checks of an unpacked native package; never install into Paseo.

By default downloads only the four pinned built-ins under --models-dir. To use existing
weights without downloads, pass --no-downloads --reuse-dir /path/to/existing/models.
CPU is intentional for portable CI; use --accelerator auto --expect-gpu on real GPU hosts.
"""
import argparse
import array
import io
import json
import os
from pathlib import Path
import queue
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import wave

WHISPER = "whisper-base-q5_1"
ASR = "qwen3-asr-0.6b-int8"
SUPER = "supertonic-3"
QWEN = "qwen3-tts-0.6b-gguf-q4"
LARGE_QWEN = "qwen3-tts-1.7b-gguf-q8"
ENGLISH = "Hello, this is a speech test."
CHINESE = "你好，这是一个语音测试。"


def wav_info(data):
    with wave.open(io.BytesIO(data)) as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise RuntimeError("Expected mono PCM16 speech")
        rate, frames = wav.getframerate(), wav.getnframes()
        samples = array.array("h", wav.readframes(frames))
        if sys.byteorder != "little":
            samples.byteswap()
    if rate <= 0 or not 0.2 < frames / rate < 30 or not samples or max(map(abs, samples)) < 100:
        raise RuntimeError("Empty, silent or invalid speech output")
    return {"seconds": frames / rate, "sampleRate": rate}


class Server:
    def __init__(self, config, phase, recognizer, voice_model):
        self.config, self.phase = config, phase
        self.recognizer, self.voice_model = recognizer, voice_model
        self.process = None
        self.log = None
        self.token = secrets.token_urlsafe(24)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def remaining(self, limit=60):
        left = self.config.deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("Real-model smoke test exceeded its time budget")
        return min(left, limit)

    def __enter__(self):
        args = [str(self.config.exe), "serve", "--models-dir", str(self.config.models_dir),
                "--port", "0", "--token=" + self.token, "--stt-model", self.recognizer,
                "--tts-model", self.voice_model, "--accelerator", self.config.accelerator,
                "--onnx-provider", "cpu", "--threads", "2", "--coreml", "false",
                "--language", "request", "--exit-on-stdin-eof"]
        if not self.config.no_downloads:
            args.append("--auto-pull")
        for folder in self.config.reuse_dir:
            args += ["--reuse-dir", str(folder)]
        self.log = open(self.config.output / (self.phase + ".log"), "w", encoding="utf-8")
        try:
            self.process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=self.log, start_new_session=os.name != "nt",
                                            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0)
            first = queue.Queue()
            threading.Thread(target=lambda: first.put(self.process.stdout.readline()), daemon=True).start()
            line = first.get(timeout=self.remaining(20))
            if not line:
                raise RuntimeError(f"Native server exited before its startup handshake; see {self.phase}.log")
            hello = json.loads(line)
            if hello.get("event") != "listening":
                raise RuntimeError("Invalid native startup handshake")
            self.base = "http://127.0.0.1:" + str(hello["port"])
            while True:
                state = self.json("/voicekit/status")
                wanted = ([next((e for e in state["stt"] if e["model"] == self.recognizer), None)] if self.recognizer else []) + [state["tts"]]
                if all(e and e.get("available") for e in wanted):
                    break
                for engine in wanted:
                    if engine and engine.get("state") == "failed":
                        raise RuntimeError(engine.get("error") or "Model load failed")
                    if self.config.no_downloads and engine and engine.get("state") == "missing":
                        raise RuntimeError("Required model is not installed and downloads are disabled: " + engine["model"])
                for download in state.get("downloads", {}).values():
                    if download.get("error"):
                        raise RuntimeError("Model download failed: " + download["error"])
                self.remaining()
                time.sleep(0.5)
            return self
        except BaseException:
            self.close()
            raise

    def request(self, path, data=None, content_type="application/json"):
        request = urllib.request.Request(self.base + path, data=data,
            headers={"Authorization": "Bearer " + self.token, "Content-Type": content_type})
        try:
            with self.opener.open(request, timeout=self.remaining()) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"{self.phase}: HTTP {error.code}: {error.read(2048).decode(errors='replace')}") from error

    def json(self, path, data=None):
        return json.loads(self.request(path, json.dumps(data).encode() if data is not None else None))

    def speak(self, text, voice, language, speed=1):
        return self.request("/v1/audio/speech", json.dumps({"input": text, "voice": voice,
            "language": language, "speed": speed, "response_format": "wav"}).encode())

    def transcribe(self, audio, language):
        boundary = "voicekit-" + secrets.token_hex(12)
        body = bytearray()
        for name, value in [("model", self.recognizer), ("language", language)]:
            body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode())
        body.extend(audio)
        body.extend(f'\r\n--{boundary}--\r\n'.encode())
        return json.loads(self.request("/v1/audio/transcriptions", bytes(body), "multipart/form-data; boundary=" + boundary))["text"]

    def device(self, model):
        state = self.json("/voicekit/status")
        engine = next((e for e in [*state["stt"], state["tts"]] if e and e["model"] == model), None)
        device = engine.get("accelerator") if engine else None
        if not engine or engine.get("state") != "ready" or not engine.get("available"):
            raise RuntimeError("Model did not remain ready after real inference: " + model)
        expected_gpu = self.config.expect_gpu and model in (WHISPER, QWEN, LARGE_QWEN)
        if expected_gpu and device not in ("metal", "cuda", "vulkan"):
            raise RuntimeError("Expected actual GPU inference, got: " + str(device))
        if (self.config.accelerator == "cpu" or model in (ASR, SUPER)) and device != "cpu":
            raise RuntimeError("Expected actual CPU inference, got: " + str(device))
        return device

    def close(self):
        process = self.process
        if process:
            if process.stdin:
                process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False)
                else:
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            if process.stdout:
                process.stdout.close()
        if self.log:
            self.log.close()

    def __exit__(self, *_):
        self.close()


def run(config):
    results = []
    started = time.monotonic()
    config.deadline = started + config.timeout
    config.output.mkdir(parents=True, exist_ok=True)
    def checkpoint():
        (config.output / "progress.json").write_text(json.dumps({"models": results}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"completed": [r["model"] for r in results]}), flush=True)
    with Server(config, "supertonic-whisper", WHISPER, SUPER) as server:
        english = server.speak(ENGLISH, "F1", "en")
        (config.output / "english.wav").write_bytes(english)
        info = wav_info(english)
        text = server.transcribe(english, "en")
        (config.output / "whisper-english.json").write_text(json.dumps({"text": text}, ensure_ascii=False) + "\n", encoding="utf-8")
        if "test" not in text.lower() or not any(word in text.lower() for word in ("hello", "speech")):
            raise RuntimeError("English round trip failed: " + text)
        results += [{"model": SUPER, "device": server.device(SUPER), **info},
                    {"model": WHISPER, "device": server.device(WHISPER), "text": text}]
    checkpoint()
    with Server(config, "qwen-tts", "", QWEN) as server:
        chinese = server.speak(CHINESE, "serena", "zh")
        (config.output / "chinese.wav").write_bytes(chinese)
        repeat = server.speak(CHINESE, "serena", "zh")
        (config.output / "chinese-repeat.wav").write_bytes(repeat)
        if repeat != chinese:
            raise RuntimeError("Qwen fixed-seed speech was not reproducible")
        qwen_english = server.speak(ENGLISH, "serena", "en")
        (config.output / "qwen-english.wav").write_bytes(qwen_english)
        wav_info(qwen_english)
        fast = server.speak(CHINESE, "serena", "zh", 1.25)
        (config.output / "chinese-fast.wav").write_bytes(fast)
        normal, changed = wav_info(chinese), wav_info(fast)
        if abs(changed["seconds"] - normal["seconds"] / 1.25) > 0.08:
            raise RuntimeError("Qwen tempo did not match the requested speed")
        results.append({"model": QWEN, "device": server.device(QWEN), **normal, "fasterSeconds": changed["seconds"], "fixedSeedIdentical": True})
    checkpoint()
    with Server(config, "qwen-asr", ASR, SUPER) as server:
        en = server.transcribe(english, "en")
        zh = server.transcribe(chinese, "zh")
        qwen_en = server.transcribe(qwen_english, "en")
        (config.output / "qwen-asr.json").write_text(json.dumps({"english": en, "chinese": zh}, ensure_ascii=False) + "\n", encoding="utf-8")
        if any(marker in text for text in (en, zh, qwen_en) for marker in ("<asr_text>", "<|im_end|>", "<|endoftext|>")):
            raise RuntimeError("Qwen3-ASR returned unprocessed control tokens: " + repr((en, zh)))
        if "test" not in en.lower() or not any(word in zh for word in ("你好", "语音", "测试")):
            raise RuntimeError("Qwen3-ASR round trip failed: " + repr((en, zh)))
        if "test" not in qwen_en.lower() or "speech" not in qwen_en.lower():
            raise RuntimeError("Qwen English synthesis round trip failed: " + qwen_en)
        # Reproduce idle microphone accumulation without recording a microphone.
        with wave.open(io.BytesIO(chinese), "rb") as clip:
            rate = clip.getframerate()
            pcm = clip.readframes(clip.getnframes())
        idle_checks = []
        for leading in (40, 100):
            buf = io.BytesIO()
            with wave.open(buf, "wb") as padded:
                padded.setnchannels(1)
                padded.setsampwidth(2)
                padded.setframerate(rate)
                padded.writeframes(bytes(leading * rate * 2) + pcm)
            audio = buf.getvalue()
            (config.output / f"chinese-idle-{leading}.wav").write_bytes(audio)
            text = server.transcribe(audio, "zh")
            if not any(word in text for word in ("你好", "语音", "测试")) or any(marker in text for marker in ("<asr_text>", "<|")):
                raise RuntimeError(f"Qwen3-ASR lost speech after {leading}s idle audio: {text!r}")
            idle_checks.append({"leadingSilenceSeconds": leading, "text": text})
        results.append({"model": ASR, "device": server.device(ASR), "english": en, "chinese": zh, "idleAudio": idle_checks})
    checkpoint()
    # Expand only after the small/default models work. Limit this to runners with enough RAM.
    if config.large_qwen:
        with Server(config, "qwen-tts-large", "", LARGE_QWEN) as server:
            large = server.speak(CHINESE, "serena", "zh")
            (config.output / "chinese-large.wav").write_bytes(large)
            repeat = server.speak(CHINESE, "serena", "zh")
            (config.output / "chinese-large-repeat.wav").write_bytes(repeat)
            if repeat != large:
                raise RuntimeError("Large Qwen fixed-seed speech was not reproducible")
            large_english = server.speak(ENGLISH, "serena", "en")
            (config.output / "large-english.wav").write_bytes(large_english)
            wav_info(large_english)
            fast = server.speak(CHINESE, "serena", "zh", 1.25)
            normal, changed = wav_info(large), wav_info(fast)
            if abs(changed["seconds"] - normal["seconds"] / 1.25) > 0.08:
                raise RuntimeError("Large Qwen tempo did not match the requested speed")
            results.append({"model": LARGE_QWEN, "device": server.device(LARGE_QWEN), **normal, "fasterSeconds": changed["seconds"], "fixedSeedIdentical": True})
        with Server(config, "qwen-asr-large-roundtrip", ASR, SUPER) as server:
            text = server.transcribe(large, "zh")
            if not any(word in text for word in ("你好", "语音", "测试")):
                raise RuntimeError("Large Qwen round trip failed: " + text)
            results[-1]["text"] = text
            en = server.transcribe(large_english, "en")
            if "test" not in en.lower() or "speech" not in en.lower():
                raise RuntimeError("Large Qwen English round trip failed: " + en)
            results[-1]["english"] = en
        checkpoint()
    report = {"platform": sys.platform, "acceleratorMode": config.accelerator, "seconds": round(time.monotonic() - started, 2), "models": results}
    (config.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--models-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reuse-dir", type=Path, action="append", default=[])
    parser.add_argument("--no-downloads", action="store_true")
    parser.add_argument("--accelerator", choices=["cpu", "auto"], default="cpu")
    parser.add_argument("--expect-gpu", action="store_true")
    parser.add_argument("--large-qwen", action="store_true", help="After the core models pass, also check 1.7B GGUF Q8 (about 2.3 GB extra download)")
    parser.add_argument("--timeout", type=float, default=540)
    config = parser.parse_args()
    config.exe = config.exe.resolve()
    config.models_dir = config.models_dir.resolve()
    config.output = config.output.resolve()
    if config.expect_gpu and config.accelerator != "auto":
        parser.error("--expect-gpu requires --accelerator auto")
    run(config)


if __name__ == "__main__":
    main()
