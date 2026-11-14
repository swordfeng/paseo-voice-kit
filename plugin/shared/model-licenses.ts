/**
 * Licenses of the built-in models, from their publishers (see plugin/MODEL_LICENSES.md and
 * plugin/licenses/models/). Names are proper names and are not translated. Your own models
 * have no entry: their publishers set their terms.
 */
export interface ModelLicense {
  name: string;
  /** The publisher's license or model card. */
  url: string;
  /** A term the settings page states next to the model. */
  note?: "useRestrictions" | "attribution";
}

const WHISPER: ModelLicense = { name: "MIT", url: "https://github.com/openai/whisper/blob/main/LICENSE" };

export const MODEL_LICENSES: Record<string, ModelLicense> = {
  "whisper-large-v3-turbo-q5_0": WHISPER,
  "whisper-small-q5_1": WHISPER,
  "whisper-base-q5_1": WHISPER,
  "qwen3-asr-0.6b-int8": { name: "Apache-2.0", url: "https://huggingface.co/Qwen/Qwen3-ASR-0.6B" },
  "parakeet-tdt-0.6b-v3-int8": { name: "CC BY 4.0", url: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3" },
  "dolphin-small-int8": { name: "Apache-2.0", url: "https://huggingface.co/DataoceanAI/dolphin-small" },
  "sensevoice-int8": { name: "FunASR Model License", url: "https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE", note: "attribution" },
  "supertonic-3": { name: "OpenRAIL-M", url: "https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE", note: "useRestrictions" },
  "qwen3-tts-0.6b-gguf-q4": { name: "Apache-2.0", url: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice" },
  "qwen3-tts-1.7b-gguf-q8": { name: "Apache-2.0", url: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" },
};
