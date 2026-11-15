import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const SITES = ["dictation", "voiceInput", "voiceOutput"] as const;
export type Site = (typeof SITES)[number];

/**
 * active   Paseo uses Voice Kit for this feature.
 * fallback Wanted, but the server or model is not ready, so Paseo's built-in speech is used.
 * off      Turned off in Voice Kit settings.
 * override The user changed this feature in Settings > Voice; Voice Kit leaves it alone.
 * locked   An environment variable on the daemon controls this feature.
 */
export const SiteStateSchema = z.enum(["active", "fallback", "off", "override", "locked"]);
export type SiteState = z.infer<typeof SiteStateSchema>;

/**
 * Why a feature is in its state, as language-neutral data the client presents in the app's
 * language. `detail` keeps an English sentence for logs.
 */
export const ReasonCodeSchema = z.enum([
  "starting",
  "installing",
  "restarting",
  "stopped",
  "waitingForApp",
  "downloading",
  "notDownloaded",
  "downloadFailed",
  "loadFailed",
  "loading",
  "changedInSettings",
  "changedModelOrVoice",
  "changedWhileOff",
  "lockedByEnv",
  /** No voice model is enabled, so Voice Kit doesn't take over speaking. */
  "noVoiceModels",
]);
export const ReasonSchema = z.object({
  code: ReasonCodeSchema,
  /** Model id the reason is about. */
  model: z.string().optional(),
  percent: z.number().optional(),
  /** Raw diagnostic error, shown as is. */
  error: z.string().optional(),
  /** Environment variable that controls the feature. */
  variable: z.string().optional(),
});
export type Reason = z.infer<typeof ReasonSchema>;

export const SiteStatusSchema = z.object({
  site: z.enum(SITES),
  state: SiteStateSchema,
  model: z.string().nullable(),
  detail: z.string().nullable(),
  reason: ReasonSchema.nullable().default(null),
});
export type SiteStatus = z.infer<typeof SiteStatusSchema>;

export const PhaseSchema = z.enum([
  "disabled",
  "installing",
  "starting",
  "loading",
  "ready",
  "degraded",
  "restarting",
  "failed",
]);
export type Phase = z.infer<typeof PhaseSchema>;

export const DownloadSchema = z.object({
  downloaded: z.number(),
  total: z.number().nullable().optional(),
  phase: z.string(),
  error: z.string().nullable().optional(),
});

export const EngineSchema = z.object({
  model: z.string(),
  state: z.string(),
  available: z.boolean(),
  accelerator: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  p50_ms: z.number().nullable().optional(),
  stages_p50_ms: z.record(z.string(), z.number()).optional(),
});
export type Engine = z.infer<typeof EngineSchema>;

export const CoremlSchema = z
  .object({ state: z.string(), seconds: z.number().optional(), error: z.string().optional() })
  .nullable()
  .optional();

export const DeviceSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** cpu | gpu | igpu | accel */
  type: z.string(),
  backend: z.string(),
  memoryTotal: z.number().nullable().optional(),
});
export type Device = z.infer<typeof DeviceSchema>;

/**
 * A speech request Voice Kit refused or could not finish. unsupported_language: some text is in a
 * language no enabled model speaks (the whole request is refused). model_unavailable: the models
 * that speak it are enabled but not ready (downloading, cooling down, can't run here).
 */
export const TtsErrorSchema = z.object({
  code: z.enum(["unsupported_language", "model_unavailable"]),
  languages: z.array(z.string()).default([]),
  model: z.string().optional(),
  /** Unix milliseconds. */
  at: z.number().optional(),
});
export type TtsError = z.infer<typeof TtsErrorSchema>;

/** Server notices as language-neutral data; `message` keeps the English text. */
export const NoticeSchema = z.object({
  code: z.enum(["portBusy", "checkingGpu", "crashRestarting", "crashGaveUp", "healthCheckFailed", "runtimeDownloadRequired", "serverVersionMismatch"]),
  url: z.string().optional(),
  /** runtimeDownloadRequired: the archive to approve (its SHA-256) and its version. */
  sha256: z.string().optional(),
  /** runtimeDownloadRequired: the archive's version; serverVersionMismatch: the version found. */
  version: z.string().optional(),
  /** serverVersionMismatch: the version this plugin needs, and where the other server came from. */
  required: z.string().optional(),
  source: z.enum(["setting", "local", "release"]).optional(),
  port: z.number().optional(),
  /** Exit code and signal of a crashed server, as reported by the OS. */
  exit: z.string().optional(),
  seconds: z.number().optional(),
  crashes: z.number().optional(),
  error: z.string().optional(),
});
export type Notice = z.infer<typeof NoticeSchema>;

export const StatusSchema = z.object({
  phase: PhaseSchema,
  message: z.string().nullable(),
  notice: NoticeSchema.nullable().default(null),
  connected: z.boolean(),
  binary: z.object({ path: z.string().nullable(), version: z.string().nullable(), source: z.string().nullable() }),
  baseUrl: z.string().nullable(),
  restarts: z.number(),
  stt: z.array(EngineSchema),
  tts: EngineSchema.nullable(),
  downloads: z.record(z.string(), DownloadSchema),
  sites: z.array(SiteStatusSchema),
  /** Neural Engine encoder state per Whisper model (macOS). */
  coreml: z.record(z.string(), CoremlSchema).default({}),
  install: z.object({ downloaded: z.number(), total: z.number().nullable() }).nullable(),
  /** Compute devices the server detected (ggml): CPU, GPU (Metal, Vulkan), accelerators. */
  devices: z.array(DeviceSchema).default([]),
  /** This computer's default listening model, chosen once; used while a listening model setting is empty. */
  defaultSttModel: z.string().nullable(),
  /** The ordered voice model list in effect. */
  ttsModels: z.array(z.string()),
  /** Per-language first choices in effect. */
  ttsLanguageModels: z.record(z.string(), z.string()),
  /** The last speech request that could not be read, if any. */
  ttsLastError: TtsErrorSchema.nullable().optional(),
  /**
   * Resident memory of Voice Kit's plugin server, speech server and the workers it owns, combined
   * (not all of Paseo). Null where it can't be measured.
   */
  memoryBytes: z.number().nullable(),
  /** Dedicated GPU bytes attributed to Voice Kit's processes; null when unavailable. */
  gpuMemoryBytes: z.number().nullable().default(null),
  /** GPU shared system memory, reported separately from dedicated GPU memory. */
  gpuSharedMemoryBytes: z.number().nullable().default(null),
  gpuMemorySource: z.literal("windows-process-counters").nullable().default(null),
});
export type Status = z.infer<typeof StatusSchema>;

/**
 * Measured quality and speed of a built-in model (docs/eval.md, FLEURS test sample, Apple M6).
 * Speech recognition: word error rate per language in percent (character error rate for
 * zh/yue/ja/ko/th). Voices: character error rate of Whisper transcribing the voice back.
 */
export const EvalSchema = z.object({
  /** "wer" (recognition) or "roundtrip" (voices). */
  metric: z.string(),
  errors: z.record(z.string(), z.number()),
  /** Recognition: median milliseconds for a ~10 s clip. */
  ms: z.number().optional(),
  /** Voices: synthesis time / audio duration. */
  rtf: z.number().optional(),
});
export type Eval = z.infer<typeof EvalSchema>;

export const ModelSchema = z.object({
  id: z.string(),
  kind: z.enum(["stt", "tts"]),
  engine: z.string(),
  family: z.string().nullable().optional(),
  tier: z.string(),
  uses: z.array(z.string()),
  label: z.string(),
  description: z.string(),
  languages: z.array(z.string()),
  sizeBytes: z.number(),
  installed: z.boolean(),
  shared: z.boolean().nullable().optional(),
  active: z.boolean(),
  /** Needed by a model in use, e.g. "Language detection". */
  usedBy: z.string().nullable().optional(),
  download: DownloadSchema.nullable().optional(),
  coreml: CoremlSchema,
  /** Measured on FLEURS (docs/eval.md). */
  eval: EvalSchema.nullable().optional(),
  /** In the effective ordered voice model list (enabled). */
  configured: z.boolean().optional(),
  /**
   * The files are Paseo's own model cache, shared exactly (same files for both). Removing them
   * removes them for Paseo too. Not set for files borrowed from elsewhere.
   */
  sharedWithPaseo: z.boolean().optional(),
  /** Paseo itself is using these shared files right now. */
  paseoInUse: z.boolean().optional(),
  /** Why a custom model can't be used (its folder is gone, its config is invalid), as reported. */
  unavailable: z.string().nullable().optional(),
});
export type Model = z.infer<typeof ModelSchema>;

export const VoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  language: z.string(),
  gender: z.string(),
  featured: z.boolean().default(false),
});
export type Voice = z.infer<typeof VoiceSchema>;

const Empty = z.object({});
const Ok = z.object({ ok: z.boolean() });

/** Bundled native MLX helper availability; checking never starts a model. */
export const MlxRuntimeSchema = z.object({
  phase: z.enum(["ready", "unavailable"]),
  reason: z.enum(["platform", "runtimeRequired"]).nullable(),
  path: z.string(),
  worker: z.string().nullable(),
  error: z.string().nullable(),
});
export type MlxRuntime = z.infer<typeof MlxRuntimeSchema>;
export const mlxRuntimeRpc = defineRpc({ name: "voicekit.mlx.status", input: Empty, output: MlxRuntimeSchema });


/** Called by every client entry on load. Gives the backend its daemon session. */
export const attachRpc = defineRpc({ name: "voicekit.attach", input: Empty, output: Ok });
export const statusRpc = defineRpc({ name: "voicekit.status", input: Empty, output: StatusSchema });
export const restartRpc = defineRpc({ name: "voicekit.restart", input: Empty, output: Ok });
export const modelsRpc = defineRpc({
  name: "voicekit.models",
  input: Empty,
  output: z.object({ models: z.array(ModelSchema), coremlSupported: z.boolean() }),
});
/** Save or clear (null) the API key of a custom remote server. Keys can't be read back. */
export const setModelKeyRpc = defineRpc({
  name: "voicekit.models.set-key",
  input: z.object({ id: z.string().regex(/^custom-[a-z0-9-]+$/), apiKey: z.string().max(4096).nullable() }),
  output: Ok,
});
export const pullModelRpc = defineRpc({ name: "voicekit.models.pull", input: z.object({ id: z.string() }), output: Ok });
export const removeModelRpc = defineRpc({
  name: "voicekit.models.remove",
  input: z.object({ id: z.string() }),
  output: Ok,
});
/** Each enabled voice model's voices, for the custom choice per model. */
export const RouteVoicesSchema = z.object({
  route: z.string(),
  label: z.string(),
  model: z.string(),
  voices: z.array(VoiceSchema),
  /** Persona id -> this route's voice in that persona. */
  persona_voices: z.record(z.string(), z.string()).default({}),
  /** Every persona uses this one voice on this route (single-speaker model): nothing to pick. */
  shared_voice: z.string().nullable().optional(),
  /** True while this route's model is loaded in memory (models load on first use). */
  ready: z.boolean().default(true),
  /** Whether this route's model files are on disk. */
  installed: z.boolean(),
  /** Device this route's model actually runs on ("metal", "cpu"), or null until it has been used. */
  accelerator: z.string().nullable().optional(),
  /** Ordered model chain: languages this model natively speaks (route is then the model id). */
  languages: z.array(z.string()).optional(),
  /** In the enabled list. */
  enabled: z.boolean().optional(),
  /** Can run here now (installed or downloadable, supported hardware, not cooling down). */
  available: z.boolean().optional(),
  /** Last load or synthesis error, as reported. */
  error: z.string().nullable().optional(),
  /** Seconds until a failed model is tried again. */
  retryAfterSeconds: z.number().nullable().optional(),
});
export type RouteVoices = z.infer<typeof RouteVoicesSchema>;

export const voicesRpc = defineRpc({
  name: "voicekit.voices",
  input: Empty,
  output: z.object({ voices: z.array(VoiceSchema), routes: z.array(RouteVoicesSchema).default([]) }),
});
/** Which model and voice read one part of a reply, and in which language. */
export const SpokenRunSchema = z.object({
  model: z.string(),
  voice: z.string(),
  language: z.string().nullable().default(null),
  /** The pronunciation used, when it isn't `language`'s (an allowed approximate reading). */
  read_as: z.string().nullable().default(null),
});
export type SpokenRun = z.infer<typeof SpokenRunSchema>;

/** Speak text: through the whole voice list, or (with `model`) with that one model and `voice`. */
export const previewRpc = defineRpc({
  name: "voicekit.preview",
  input: z.object({ voice: z.string().optional(), text: z.string().max(400).optional(), model: z.string().optional() }),
  output: z.object({ base64: z.string(), mimeType: z.string(), ms: z.number(), runs: z.array(SpokenRunSchema).default([]) }),
});
export const reclaimRpc = defineRpc({
  name: "voicekit.reclaim",
  input: z.object({ site: z.enum(SITES) }),
  output: Ok,
});
export const HfLookupSchema = z.object({
  repo: z.string(),
  /** Commit the model is pinned to. */
  revision: z.string(),
  suggestion: z.object({
    /** "mlx": a Qwen3-TTS CustomVoice model for the MLX runtime (Apple Silicon); `family` says which. */
    source: z.enum(["whisper", "sherpa", "mlx", "gguf"]).nullable(),
    kind: z.enum(["stt", "tts"]).nullable(),
    family: z.string().nullable(),
    whisperFiles: z.array(z.string()),
    /** source "gguf": candidate talker (customvoice) and codec (tokenizer) files, and their sizes. */
    ggufModelFiles: z.array(z.string()).optional(),
    ggufCodecFiles: z.array(z.string()).optional(),
    ggufFileSizes: z.record(z.string(), z.number()).optional(),
  }),
  sizeBytes: z.number(),
  fileCount: z.number(),
});
export type HfLookup = z.infer<typeof HfLookupSchema>;

/** Inspect a Hugging Face repository: what kind of model it holds and how big it is. */
export const hfLookupRpc = defineRpc({ name: "voicekit.hf.lookup", input: z.object({ repo: z.string().min(1) }), output: HfLookupSchema });

export const logsRpc = defineRpc({
  name: "voicekit.logs",
  input: Empty,
  output: z.object({ lines: z.array(z.string()) }),
});
