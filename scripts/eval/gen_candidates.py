"""Write scripts/eval/candidates.json: models evaluated but not (or not yet) in the built-in catalog.

voicekit loads it with `--catalog`; entries whose id is also built in are ignored there, so the
file can keep listing models after they move into server/catalog.json.

Usage: python3 -I scripts/eval/gen_candidates.py > scripts/eval/candidates.json
"""

import json

GH = "https://github.com/k2-fsa/sherpa-onnx/releases/download"


def archive(release, name, sha256, size):
    return [{"url": f"{GH}/{release}/{name}.tar.bz2", "sha256": sha256, "size": size, "unpack": "tar.bz2"}]


models = [
    {
        "id": "parakeet-tdt-0.6b-v3-int8", "kind": "stt", "label": "Parakeet v3", "engine": "sherpa", "family": "transducer",
        "dir": "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        "files": {"encoder": "encoder.int8.onnx", "decoder": "decoder.int8.onnx", "joiner": "joiner.int8.onnx", "tokens": "tokens.txt"},
        "options": {"model_type": "nemo_transducer"},
        "download": archive("asr-models", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9", 487211443),
    },
    {
        "id": "dolphin-small-int8", "kind": "stt", "label": "Dolphin small", "engine": "sherpa", "family": "dolphin",
        "dir": "sherpa-onnx-dolphin-small-ctc-multi-lang-int8-2025-04-02",
        "files": {"model": "model.int8.onnx", "tokens": "tokens.txt"},
        "download": archive("asr-models", "sherpa-onnx-dolphin-small-ctc-multi-lang-int8-2025-04-02", "7346b00ffe42396fff5c96d11892f0d4d72ac11418d47c5a8ada2b0f6ac8d27b", 191534345),
    },
    {
        "id": "dolphin-base-int8", "kind": "stt", "label": "Dolphin base", "engine": "sherpa", "family": "dolphin",
        "dir": "sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02",
        "files": {"model": "model.int8.onnx", "tokens": "tokens.txt"},
        "download": archive("asr-models", "sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02", "6f23da2303c3c2e5fa6445c450fa2a7133cd57e3da070ae5f97ab9e0dfbb4a54", 80671385),
    },
    {
        "id": "omnilingual-300m-v2-int8", "kind": "stt", "label": "Omnilingual ASR 300M", "engine": "sherpa", "family": "omnilingual",
        "dir": "sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-v2-int8-2026-02-05",
        "files": {"model": "model.int8.onnx", "tokens": "tokens.txt"},
        "download": archive("asr-models", "sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-v2-int8-2026-02-05", "951b32409aade32bd525310bb39e9666773ba3fc611a39e817f620936d76c631", 292313120),
    },
    {
        "id": "omnilingual-1b-v2-int8", "kind": "stt", "label": "Omnilingual ASR 1B", "engine": "sherpa", "family": "omnilingual",
        "dir": "sherpa-onnx-omnilingual-asr-1600-languages-1B-ctc-v2-int8-2026-02-05",
        "files": {"model": "model.int8.onnx", "tokens": "tokens.txt"},
        "download": archive("asr-models", "sherpa-onnx-omnilingual-asr-1600-languages-1B-ctc-v2-int8-2026-02-05", "f4deae6e6cbf4ca785b89eaa3836156581208bf977ea2e6d7ae84d7efcfc3a40", 787296506),
    },
]

# Moonshine v2 (quantized): one model per language.
MOONSHINE = {
    ("base", "en"): ("43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891", 111266225),
    ("tiny", "en"): ("9ec31b342d8fa3240c3b81b8f82e1cf7e3ac467c93ca5a999b741d5887164f8d", 29858559),
    ("base", "es"): ("850c3dcc5dfccc8b1feb10bb221b11d6039b6f5c626241729f46863771016383", 50846902),
    ("base", "ar"): ("4d3f16fe354d8536d3323d3eaf4c12fafb1976b5dc0a12862ab25934da94285b", 119143068),
    ("base", "ja"): ("c66eb87d229a52d43bbe3b7c52a1d23f6208c0fd7c2e81802ecbda83b192798a", 104162109),
    ("base", "uk"): ("d8489b159afabf4cfb734002ae8a5361781ff8a381fa18d284d32d1eeb1c0376", 111037143),
    ("base", "vi"): ("97b53f5fb75a2a9dd6327440a34f45fc06c927ed2fa7217e5ebe54058e269416", 106719129),
    ("base", "zh"): ("6495d4240f66bcdd2bbbbfefaa687c463150d467854001270934e88940b733c1", 99905420),
    ("tiny", "ko"): ("d3b6c5390a7859c9ef20ff4f20b0766fcbad1dc06c0f509fe4840a3a302112dc", 49153415),
}
for (size, lang), (sha, nbytes) in MOONSHINE.items():
    name = f"sherpa-onnx-moonshine-{size}-{lang}-quantized-2026-02-27"
    models.append({
        "id": f"moonshine-{size}-{lang}", "kind": "stt", "label": f"Moonshine {size} ({lang})", "languages": [lang],
        "engine": "sherpa", "family": "moonshine", "dir": name,
        "files": {"encoder": "encoder_model.ort", "merged_decoder": "decoder_model_merged.ort", "tokens": "tokens.txt"},
        "download": archive("asr-models", name, sha, nbytes),
    })

# Voices for languages Supertonic 3 does not speak. MMS (facebook/mms-tts) conversions exist in
# sherpa-onnx's releases only for deu, eng, fra, nan, rus, spa, tha and ukr; Thai is the only one
# Supertonic lacks. Coqui (Bengali) and a Cantonese VITS read characters too. Piper voices (fa, sw,
# ur, ne, ca) need espeak-ng, which sherpa-onnx 2.x no longer bundles, so they cannot speak here.
def vits(id_, label, lang, gender, name, model, sha, size, extra=None):
    files = {"model": model, "tokens": "tokens.txt"}
    files.update(extra or {})
    return {
        "id": id_, "kind": "tts", "label": label, "languages": [lang], "engine": "sherpa", "family": "vits", "dir": name,
        "files": files,
        "voices": [{"id": id_, "label": label, "language": lang, "gender": gender, "sid": 0, "featured": True}],
        "download": archive("tts-models", name, sha, size),
    }


models.append(vits("mms-tha", "MMS Thai", "th", "male", "vits-mms-tha", "model.onnx", "e774f69a873806d5be445f107e72c9b3bd828188e1d5002f8ece8886d5528fa5", 107763751))
models.append(vits("coqui-bn", "Coqui Bengali", "bn", "female", "vits-coqui-bn-custom_female", "model.onnx", "a03292d7da03650e892bb1989b40dc2c62574c0d6c34c8bef185fbb3151417a1", 108053596))
models.append(vits("vits-yue", "Cantonese VITS", "yue", "female", "vits-cantonese-hf-xiaomaiiwn", "vits-cantonese-hf-xiaomaiiwn.onnx",
                   "bf3013cd4be34f531b7e514e708d835584dd60c9ad6eaf467ac1402005c04e46", 107995442, {"lexicon": "lexicon.txt", "rule_fsts": "rule.fst"}))

print(json.dumps({"models": models}, indent=2, ensure_ascii=False))
