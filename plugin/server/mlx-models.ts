import { createHash } from "node:crypto";
import type { HfFile } from "./huggingface";

export const QWEN_LANGUAGES = ["zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"];
export const QWEN_VOICES = [
  ["vivian", "Vivian", "zh", "female"], ["serena", "Serena", "zh", "female"],
  ["uncle_fu", "Uncle Fu", "zh", "male"], ["dylan", "Dylan", "zh", "male"],
  ["eric", "Eric", "zh", "male"], ["ryan", "Ryan", "en", "male"],
  ["aiden", "Aiden", "en", "male"], ["ono_anna", "Ono Anna", "ja", "female"],
  ["sohee", "Sohee", "ko", "female"],
].map(([id, label, language, gender]) => ({ id, label, language, gender, featured: id !== "dylan" && id !== "eric" }));

export function qwenMetadata(config: Buffer, files: HfFile[]) {
  const value = JSON.parse(config.toString("utf8"));
  if (value.model_type !== "qwen3_tts" || value.tts_model_type !== "custom_voice") {
    throw new Error("This MLX backend supports Qwen3-TTS CustomVoice models only");
  }
  if(value.vocab_pruning?.has_token_map)throw new Error("This MLX adapter does not support pruned text vocabularies");
  if (!files.some((f) => f.path.endsWith(".safetensors") && !f.path.includes("/")) || !files.some((f) => f.path.startsWith("speech_tokenizer/") && f.path.endsWith(".safetensors"))) {
    throw new Error("The Qwen model or its speech tokenizer is missing");
  }
  return {
    engine: "mlx", family: "qwen3_tts", languages: QWEN_LANGUAGES,
    voices: QWEN_VOICES, default_voice: "vivian",
    files: Object.fromEntries(files.map((f, i) => ["file" + i, f.path])),
    configSha256: createHash("sha256").update(config).digest("hex"),
  };
}
