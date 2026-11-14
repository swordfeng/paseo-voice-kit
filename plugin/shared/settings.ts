import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Default listening models, chosen once for this computer: Whisper turbo where it runs fast
 * (macOS always; elsewhere when a measured GPU is fast enough, see server/default-stt.ts),
 * Qwen3-ASR on the CPU otherwise. The server keeps that choice fixed (status.defaultSttModel);
 * it never changes a model the user picked.
 */
export const DEFAULT_GPU_STT_MODEL = "whisper-large-v3-turbo-q5_0";
export const DEFAULT_CPU_STT_MODEL = "qwen3-asr-0.6b-int8";

/** The voice string sent to voicekit and written into Paseo's voice settings: a persona or "custom". */
export function voiceSpec(prefs: { voice: string }): string {
  return prefs.voice;
}

/** Default ordered voice model list: Supertonic 3 alone. */
export const DEFAULT_VOICE_MODEL = "supertonic-3";

/**
 * Approximate readings: a language read with a related language's pronunciation. Not native
 * support; used only for languages the user allows (`ttsApproximateLanguages`).
 */
export const APPROXIMATE_LANGUAGES: Record<string, string> = { ca: "es", tl: "id", sw: "id", ms: "id" };

/** Languages read approximately: the user's list, unknown codes dropped. */
export function effectiveApproximateLanguages(prefs: { ttsApproximateLanguages: string[] }): string[] {
  return prefs.ttsApproximateLanguages.filter((l) => l in APPROXIMATE_LANGUAGES);
}

/** Default port. A fixed port keeps the URL written into Paseo's config stable across restarts. */
export const DEFAULT_PORT = 47615;

/** A model the user added: another server, a Whisper file, or a sherpa-onnx folder/archive. */
export const customModelSchema = z.object({
  id: z.string().regex(/^custom-[a-z0-9-]+$/),
  label: z.string().min(1).max(80),
  kind: z.enum(["stt", "tts"]),
  source: z.enum(["server", "whisper", "sherpa", "huggingface"]),
  /** server: OpenAI-compatible base URL (".../v1"). */
  baseUrl: z.string().optional(),
  /** server: model name on that server. */
  model: z.string().optional(),
  /** server: API key, if the server needs one. Stored on the daemon host, not in a vault. */
  apiKey: z.string().optional(),
  /** server TTS: voice to request. */
  voice: z.string().optional(),
  /** whisper / sherpa: local path, or an https URL to download (.bin, .tar.bz2 or .zip). */
  location: z.string().optional(),
  /** sherpa: model family, e.g. sense_voice, paraformer, transducer, qwen3_asr, kokoro, vits. */
  family: z.string().optional(),
  /** Optional checksum for downloads. */
  sha256: z.string().optional(),
  /** huggingface: repository ("owner/name") and the commit it is pinned to. */
  hfRepo: z.string().optional(),
  hfRevision: z.string().optional(),
  /** huggingface Whisper repos: which ggml file to use. */
  hfFile: z.string().optional(),
  /**
   * Languages the model speaks natively (ISO 639-1). Voice models need at least one to join the
   * ordered voice model list; Qwen3-TTS families have their 10 languages fixed.
   */
  languages: z.array(z.string()).optional(),
  /** family "qwen3_tts_gguf": the talker (customvoice) and codec (tokenizer) GGUF files. */
  ggufModelFile: z.string().optional(),
  ggufCodecFile: z.string().optional(),
});
export type CustomModel = z.output<typeof customModelSchema>;

export const SHERPA_FAMILIES: { value: string; label: string; kind: "stt" | "tts" }[] = [
  { value: "sense_voice", label: "SenseVoice", kind: "stt" },
  { value: "paraformer", label: "Paraformer", kind: "stt" },
  { value: "transducer", label: "Transducer (Zipformer, Parakeet)", kind: "stt" },
  { value: "qwen3_asr", label: "Qwen3-ASR", kind: "stt" },
  { value: "fire_red_asr", label: "FireRedASR", kind: "stt" },
  { value: "fire_red_asr_ctc", label: "FireRedASR CTC", kind: "stt" },
  { value: "nemo_ctc", label: "NeMo CTC", kind: "stt" },
  { value: "dolphin", label: "Dolphin", kind: "stt" },
  { value: "kokoro", label: "Kokoro", kind: "tts" },
  { value: "vits", label: "VITS (MeloTTS, Piper)", kind: "tts" },
  // Runs in the MLX runtime, not sherpa-onnx; listed here because it is added the same way.
  { value: "qwen3_tts", label: "Qwen3-TTS (MLX, Apple Silicon)", kind: "tts" },
  // Runs with qwentts.cpp (GGUF): a talker and a codec file.
  { value: "qwen3_tts_gguf", label: "Qwen3-TTS (GGUF)", kind: "tts" },
];

/** Families that need the MLX runtime on Apple Silicon. */
export const MLX_FAMILY_VALUES = new Set(["qwen3_tts"]);

/** Qwen3-TTS GGUF (qwentts.cpp): a talker and a codec file. */
export const GGUF_QWEN_FAMILY = "qwen3_tts_gguf";

/** The 10 languages every Qwen3-TTS model speaks; fixed, not entered by the user. */
export const QWEN_TTS_LANGUAGES = ["zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"];

export const preferencesSchema = z.object({
  /** Master switch. Off stops the server and gives every voice feature back to Paseo. */
  enabled: z.boolean().default(true),
  /** A Voice Kit row at the bottom of the app sidebar. */
  showInSidebar: z.boolean().default(true),
  useForDictation: z.boolean().default(true),
  useForVoiceInput: z.boolean().default(true),
  useForVoiceOutput: z.boolean().default(true),
  /** Model for dictation. Empty until the user picks one: this computer's default (status.defaultSttModel) is used. */
  dictationModel: z.string().default(""),
  /** Model for voice-mode turns. Empty until the user picks one, as for dictation. */
  voiceInputModel: z.string().default(""),
  /**
   * Enabled voice models in order of preference. Each sentence uses the first enabled model that
   * natively speaks its language (after `ttsLanguageModels`). Models not listed are disabled; an
   * empty list leaves reading replies aloud to Paseo.
   */
  ttsModels: z.array(z.string()).default([DEFAULT_VOICE_MODEL]),
  /** Per-language first choice among enabled models that speak it: language -> model id. */
  ttsLanguageModels: z.record(z.string(), z.string()).default({}),
  /** Custom voice per model (voice "custom"): model id -> voice id. */
  modelVoices: z.record(z.string(), z.string()).default({}),
  /** Languages the user allows to be read approximately (see APPROXIMATE_LANGUAGES). */
  ttsApproximateLanguages: z.array(z.string()).default([]),
  /**
   * A persona id (similar voices paired across the enabled models), or "custom" to use
   * `modelVoices`.
   */
  voice: z.string().default("female-higher"),
  speed: z.number().min(0.5).max(2).default(1),
  /** "auto" detects the spoken language; otherwise an ISO 639-1 code. */
  language: z.string().default("auto"),
  /** Words and names to bias recognition towards (Whisper only). */
  vocabulary: z.string().default(""),
  accelerator: z.enum(["auto", "cpu"]).default("auto"),
  /**
   * macOS: download and use Neural Engine encoders for Whisper (about 1.2 GB; dictation about
   * 2.5x faster). Off by default: macOS optimizes the encoder once per machine, which takes
   * several minutes of heavy CPU and memory.
   */
  neuralEngine: z.boolean().default(false),
  customModels: z.array(customModelSchema).default([]),
  /** Download missing models automatically. */
  autoDownload: z.boolean().default(true),
  /** Explicit consent for downloading and installing the separately distributed native runtime. */
  runtimeDownloadApproved: z.boolean().default(false),
  /** Free model memory after this many idle minutes. 0 keeps models loaded. */
  idleUnloadMinutes: z.number().int().min(0).max(1440).default(10),
  port: z.number().int().min(1024).max(65535).default(DEFAULT_PORT),
  /** Use this voicekit binary instead of the managed one. */
  binaryPath: z.string().default(""),
});

export type Preferences = z.output<typeof preferencesSchema>;

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: preferencesSchema,
});
