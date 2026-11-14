"""Text normalization and error rates shared by the STT and TTS scorers (stdlib only).

Both reference and hypothesis go through the same normalizer: NFKC, case folding, punctuation and
symbols removed (apostrophes join), whitespace collapsed. Arabic-script and Hebrew text also loses
its optional vowel marks and has Arabic/Persian letter variants unified. Chinese is converted to
simplified characters when the `opencc` module is importable (run with
`uv run --with opencc-python-reimplemented`), so Whisper's occasional traditional output is not
counted as errors.

Character error rate (spaces removed) for languages written without spaces between words.
"""

import unicodedata

CER_LANGS = {"zh", "yue", "ja", "ko", "th", "my", "km", "lo"}
STRIP_MARKS = {"ar", "fa", "ur", "he", "ps", "sd"}
LETTER_MAP = str.maketrans({"ي": "ی", "ى": "ی", "ك": "ک", "ۀ": "ه", "ة": "ه", "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا"})

try:
    import opencc  # type: ignore

    _t2s = opencc.OpenCC("t2s")
except Exception:  # noqa: BLE001
    _t2s = None


def normalize(text: str, lang: str) -> str:
    text = unicodedata.normalize("NFKC", text).casefold()
    if lang in ("zh", "yue") and _t2s is not None:
        text = _t2s.convert(text)
    out = []
    for c in text:
        cat = unicodedata.category(c)
        if c in "'’`ʼ":
            continue
        if cat[0] in "PSZC":
            out.append(" ")
        elif cat == "Mn" and lang in STRIP_MARKS:
            continue
        else:
            out.append(c)
    text = "".join(out)
    if lang in STRIP_MARKS:
        text = text.translate(LETTER_MAP)
    return " ".join(text.split())


def units(text: str, lang: str) -> list[str]:
    norm = normalize(text, lang)
    if lang in CER_LANGS:
        return [c for c in norm if not c.isspace()]
    return norm.split()


def edits(ref: list[str], hyp: list[str]) -> int:
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h))
        prev = cur
    return prev[-1]


def chars(text: str, lang: str) -> list[str]:
    """Characters without spaces: the unit for round-trip CER of speech synthesis."""
    return [c for c in normalize(text, lang) if not c.isspace()]
