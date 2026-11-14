"""Voice Kit's private, offline MLX worker. Framed stdout is reserved for IPC."""
import os
import sys
import json
import struct
import time
import array

output = sys.stdout.buffer
sys.stdout = sys.stderr
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"


def send(event, pcm=b"", **fields):
    header = json.dumps({"event": event, "bytes": len(pcm), **fields}).encode()
    output.write(struct.pack("<I", len(header)))
    output.write(header)
    output.write(pcm)
    output.flush()


try:
    import mlx.core as mx
    from pathlib import Path
    from mlx_audio.tts.utils import load_model

    if not mx.metal.is_available():
        raise RuntimeError("MLX Metal GPU is unavailable")
    mx.set_default_device(mx.gpu)
    model = load_model(Path(sys.argv[1]))
    config = json.loads((Path(sys.argv[1]) / "config.json").read_text())
    send("ready", device="metal", model_size=config.get("tts_model_size"),
         quantization_bits=config.get("quantization", {}).get("bits"))
except Exception as error:
    send("error", error=str(error))
    sys.exit(1)

languages = {"zh": "chinese", "en": "english", "ja": "japanese", "ko": "korean",
             "de": "german", "fr": "french", "ru": "russian", "pt": "portuguese",
             "es": "spanish", "it": "italian"}
voices = {"vivian", "serena", "uncle_fu", "dylan", "eric", "ryan", "aiden", "ono_anna", "sohee"}

for line in sys.stdin:
    try:
        request = json.loads(line)
        voice = request.get("voice", "serena").lower()
        if voice not in voices:
            voice = "serena"
        started = time.monotonic()
        first = True
        generated_tokens = 0
        # Incremental decoding avoids the old service's batch path. The native API may
        # still collect the chunks; do not describe model first-chunk time as app latency.
        for result in model.generate(
            request["text"], voice=voice,
            lang_code=languages.get(request.get("language"), "auto"),
            stream=True, streaming_interval=0.4, max_tokens=1200, verbose=False,
        ):
            generated_tokens += result.token_count
            if generated_tokens >= 1200:
                raise RuntimeError("Qwen speech token limit reached; refusing truncated audio")
            mx.eval(result.audio)
            pcm = array.array("h", (mx.clip(result.audio, -1, 1) * 32767).astype(mx.int16).tolist())
            if sys.byteorder != "little":
                pcm.byteswap()
            if pcm:
                send("audio", pcm.tobytes(), rate=result.sample_rate,
                     first_ms=(time.monotonic() - started) * 1000 if first else None)
                first = False
        send("done")
    except Exception as error:
        send("error", error=str(error))
