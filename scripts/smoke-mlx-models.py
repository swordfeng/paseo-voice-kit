#!/usr/bin/env python3
"""Short native-HTTP MLX check with existing weights; never changes Paseo settings."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import time
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("core_smoke", ROOT / "scripts/smoke-real-models.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


def run(args):
    args.output.mkdir(parents=True, exist_ok=True)
    model = args.model.resolve()
    def snapshot():
        return sorted((str(p.relative_to(model)), p.stat().st_size, p.stat().st_mtime_ns)
                      for p in model.rglob("*") if p.is_file())
    before = snapshot()
    catalog = args.output / "catalog.json"
    model_id = "native-mlx-smoke"
    catalog.write_text(json.dumps({"models": [{
        "id": model_id, "kind": "tts", "label": "Native MLX smoke", "engine": "mlx",
        "family": "qwen3_tts", "languages": ["en", "zh"], "path": str(model),
        "files": {"weights": ",".join(str(p.relative_to(model)) for p in sorted(model.rglob("*.safetensors"))),
                  "config": "config.json", "vocab": "vocab.json", "merges": "merges.txt"},
        "voices": [{"id": "serena", "label": "Serena"}], "default_voice": "serena",
    }]}))
    config = SimpleNamespace(exe=args.exe.resolve(), models_dir=args.output / "models",
        reuse_dir=args.reuse_dir, accelerator="auto", expect_gpu=True, no_downloads=True,
        output=args.output, deadline=time.monotonic() + 120, catalogs=[catalog],
        env={**os.environ, "PATH": "/usr/bin:/bin", "VOICEKIT_MLX_PYTHON": "/nonexistent/python-is-not-used"})
    result = {}
    with core.Server(config, "native-mlx", core.ASR, model_id) as server:
        initial = server.json("/voicekit/status")
        assert initial["tts"]["state"] == "unloaded" and initial["tts"]["available"], initial
        english = server.speak(core.ENGLISH, "serena", "en")
        repeated = server.speak(core.ENGLISH, "serena", "en")
        assert english == repeated, "default seed must be reproducible"
        fast = server.speak(core.ENGLISH, "serena", "en", 1.25)
        chinese = server.speak(core.CHINESE, "serena", "zh")
        result["english"] = core.wav_info(english)
        result["fast"] = core.wav_info(fast)
        result["chinese"] = core.wav_info(chinese)
        assert abs(result["fast"]["seconds"] - result["english"]["seconds"] / 1.25) < 0.08
        result["english"]["transcript"] = server.transcribe(english, "en")
        result["chinese"]["transcript"] = server.transcribe(chinese, "zh")
        assert all(word in result["english"]["transcript"].lower() for word in ("speech", "test")), result
        assert all(word in result["chinese"]["transcript"] for word in ("语音", "测试")), result
        result["device"] = server.device(model_id)
        assert result["device"] == "metal"
        result["initiallyUnloaded"] = True
        result["repeatIdentical"] = True
        for name, data in [("en", english), ("zh", chinese), ("en-fast", fast)]:
            (args.output / (name + ".wav")).write_bytes(data)
    result["serverExited"] = server.process.returncode == 0
    assert snapshot() == before, "model files must remain unchanged"
    result["modelFilesUnchanged"] = True
    (args.output / "report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--reuse-dir", type=Path, action="append", default=[])
    parser.add_argument("--output", type=Path, required=True)
    run(parser.parse_args())
