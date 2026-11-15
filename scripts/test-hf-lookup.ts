// CUS-1a: repositories are recognized by their files, and voices that can't speak in this version
// (they need an espeak-ng phonemizer, or are Matcha) are refused when added, with the reason.
import assert from "node:assert/strict";
import { suggest, unsupportedReason } from "../plugin/server/huggingface";

const tree = (repo: string, paths: string[]) => ({ repo, revision: "0".repeat(40), files: paths.map((path) => ({ path, size: 2048, sha256: null })) });
const check = (repo: string, paths: string[]) => {
  const t = tree(repo, paths);
  return { suggestion: suggest(t), refused: unsupportedReason(t, suggest(t)) };
};

const kokoroMulti = check("csukuangfj/kokoro-multi-lang-v1_1", ["model.onnx", "voices.bin", "tokens.txt", "lexicon-zh.txt", "lexicon-us-en.txt", "espeak-ng-data/phontab"]);
assert.equal(kokoroMulti.suggestion.family, "kokoro");
assert.equal(kokoroMulti.refused, null, "Kokoro with a lexicon works");

const kokoroEn = check("csukuangfj/kokoro-en-v0_19", ["model.onnx", "voices.bin", "tokens.txt", "espeak-ng-data/phontab"]);
assert.match(kokoroEn.refused ?? "", /phonemizer/, "English-only Kokoro needs espeak-ng");

const piper = check("csukuangfj/vits-piper-en_US-amy-low", ["en_US-amy-low.onnx", "tokens.txt", "espeak-ng-data/phontab"]);
assert.equal(piper.suggestion.family, "vits");
assert.match(piper.refused ?? "", /phonemizer/, "Piper needs espeak-ng");

const melo = check("csukuangfj/vits-melo-tts-zh_en", ["model.onnx", "lexicon.txt", "tokens.txt", "dict/jieba.dict.utf8"]);
assert.equal(melo.refused, null, "MeloTTS has a lexicon");

const matcha = check("csukuangfj/matcha-icefall-zh-en", ["model-steps-3.onnx", "vocos-16khz-univ.onnx", "lexicon.txt", "tokens.txt"]);
assert.match(matcha.refused ?? "", /Matcha/);

assert.equal(check("csukuangfj/sherpa-onnx-moonshine-base-en-int8", ["encode.int8.onnx", "preprocess.onnx", "tokens.txt"]).suggestion.family, "moonshine");
assert.equal(check("csukuangfj/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8", ["model.int8.onnx", "tokens.txt"]).suggestion.family, "omnilingual");
assert.equal(check("csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue", ["model.int8.onnx", "tokens.txt"]).refused, null, "speech recognition is never refused for a phonemizer");
console.log("PASS supported families are recognized; phonemizer voices and Matcha are refused with the reason");
