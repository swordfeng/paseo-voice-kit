// Voice Kit's UI text in the Paseo app's language (Settings > Appearance > Language, including
// System). Paseo resolves the language; English fills in anything a locale lacks. This is the UI
// language only: the speech Language setting is separate and unaffected.
import { defineTranslations, useTranslation } from "@getpaseo/plugin/client";
import type { Notice, Reason } from "../shared/rpc";
import { LANGUAGES } from "../shared/languages";
import { ar } from "./locales/ar";
import { en } from "./locales/en";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";
import { ptBR } from "./locales/pt-BR";
import { ru } from "./locales/ru";
import { zhCN } from "./locales/zh-CN";

/** The app UI languages Paseo offers (besides System, which resolves to one of these). */
export const UI_LOCALES = ["en", "ar", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-CN"] as const;

export const messages = defineTranslations({
  resources: { en, ar, es, fr, ja, ko, "pt-BR": ptBR, ru, "zh-CN": zhCN },
});

export function useText() {
  return useTranslation(messages);
}
export type Translate = ReturnType<typeof useText>["t"];

/** Built-in model ids and their message keys. Custom models keep the name the user gave them. */
export const CATALOG_KEYS = {
  "whisper-large-v3-turbo-q5_0": "whisperTurbo",
  "qwen3-asr-0.6b-int8": "qwen3",
  "parakeet-tdt-0.6b-v3-int8": "parakeet",
  "whisper-small-q5_1": "whisperSmall",
  "dolphin-small-int8": "dolphin",
  "sensevoice-int8": "senseVoice",
  "whisper-base-q5_1": "whisperBase",
  "supertonic-3": "supertonic",
  "qwen3-tts-0.6b-gguf-q4": "qwen06Gguf",
  "qwen3-tts-1.7b-gguf-q8": "qwen17Gguf",
} as const satisfies Record<string, keyof typeof en.catalog>;

function catalogKey(id: string): keyof typeof en.catalog | undefined {
  return (CATALOG_KEYS as Record<string, keyof typeof en.catalog>)[id];
}

export function modelLabel(t: Translate, model: { id: string; label: string }): string {
  const key = catalogKey(model.id);
  return key ? t(`catalog.${key}.label`) : model.label;
}

export function modelDescription(t: Translate, model: { id: string; description: string }): string {
  const key = catalogKey(model.id);
  return key ? t(`catalog.${key}.description`) : model.description;
}

type DisplayNames = { of(code: string): string | undefined };
const displayNames = new Map<string, DisplayNames | null>();

/** A language's name in the UI language, when the platform can name it (Hermes may not). */
function localizedName(code: string, locale: string): string | undefined {
  if (!displayNames.has(locale)) {
    let names: DisplayNames | null = null;
    try {
      if (typeof Intl.DisplayNames === "function") names = new Intl.DisplayNames([locale], { type: "language", fallback: "none" });
    } catch {
      names = null;
    }
    displayNames.set(locale, names);
  }
  const bcp47 = code === "jw" ? "jv" : code === "zh" ? "zh" : code;
  try {
    const name = displayNames.get(locale)?.of(bcp47);
    if (name && name.toLowerCase() !== bcp47.toLowerCase()) return name;
  } catch {
    // Unknown code for this platform.
  }
  return undefined;
}

/** A language's name for the UI: in the UI language, falling back to English, then the code. */
export function languageName(code: string, locale: string): string {
  if (locale === "en" || locale.startsWith("en-")) return LANGUAGES[code]?.english ?? code;
  return localizedName(code, locale) ?? LANGUAGES[code]?.english ?? code;
}

/**
 * Speech language choices: the language in its own name, plus its name in the UI language when
 * that differs ("日本語 · Japanese", "Español · 西班牙语"). English keeps Latin-script names alone.
 */
export function languageOptionLabel(code: string, locale: string): string {
  const l = LANGUAGES[code];
  if (!l) return code;
  const english = locale === "en" || locale.startsWith("en-");
  const other = english ? l.english : localizedName(code, locale) ?? l.english;
  if (other === l.native) return l.native;
  if (english && /^[\p{Script=Latin}\s\p{P}]+$/u.test(l.native)) return l.native;
  return l.native + " · " + other;
}

/** Sentences in a row: spaced in most languages, unspaced in Chinese and Japanese. */
export function sentences(t: Translate, ...parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p).reduce((a, b) => t("common.sentences", { a, b }));
}

/** "a, b and c" in the UI language. */
export function joinList(t: Translate, items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return t("common.and", { a: items.slice(0, -1).join(t("common.listSeparator")), b: items[items.length - 1] });
}

function gender(t: Translate, value: string): string | null {
  return value === "female" ? t("common.female") : value === "male" ? t("common.male") : null;
}

/**
 * A voice's label in the UI language. Persona names (Mia, Leo, …) and voice names (Maple, …)
 * stay; the descriptive parts are translated. Unknown labels are shown as they are.
 */
export function voiceLabel(t: Translate, locale: string, voice: { label: string; language: string; gender: string }): string {
  const g = gender(t, voice.gender);
  if (!g) return voice.label;
  let m = /^(.+) · (female|male)$/.exec(voice.label);
  if (m) return t("voices.persona", { name: m[1], gender: g });
  m = /^(Female|Male) (\d+)$/.exec(voice.label);
  if (m) return t(m[1] === "Female" ? "voices.numbered.female" : "voices.numbered.male", { n: m[2] });
  m = /^(.+) \(([^,()]+), (female|male)\)$/.exec(voice.label);
  if (m) {
    const language =
      m[2] === "British English"
        ? t("voices.britishEnglish")
        : m[2] === "Beijing dialect"
          ? t("voices.dialect.beijing")
          : m[2] === "Sichuan dialect"
            ? t("voices.dialect.sichuan")
            : LANGUAGES[voice.language] && !(locale === "en" || locale.startsWith("en-"))
              ? languageName(voice.language, locale)
              : m[2];
    return t("voices.named", { name: m[1], language, gender: g });
  }
  m = /^(\S+) \((female|male)\)$/.exec(voice.label);
  if (m && LANGUAGES[voice.language]) return t("voices.single", { language: languageName(voice.language, locale), gender: g });
  return voice.label;
}

/** The server's "Part of …" / "Language detection" badges, translated. */
export function usedByLabel(t: Translate, usedBy: string, labelByEnglish: (label: string) => string): string {
  if (usedBy === "Language detection") return t("models.languageDetection");
  const m = /^Part of (.+)$/.exec(usedBy);
  if (m) return t("models.partOf", { name: labelByEnglish(m[1]) });
  return usedBy;
}

/** Errors with known wording are translated; anything else is a diagnostic, shown as is. */
export function errorText(t: Translate, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Repository not found, or it is private or gated.") return t("form.errors.repoNotFound");
  if (message === "Enter a Hugging Face repository like owner/name or its URL.") return t("form.errors.enterRepo");
  if (message === "The Voice Kit server is not running.") return t("form.errors.serverNotRunning");
  return message;
}

/** Why a feature waits, overrides or is locked. Model ids become their labels. */
export function reasonText(t: Translate, reason: Reason, labelOf: (id: string) => string): string {
  const model = reason.model ? labelOf(reason.model) : "";
  switch (reason.code) {
    case "starting":
    case "installing":
    case "restarting":
    case "waitingForApp":
    case "changedInSettings":
    case "changedModelOrVoice":
    case "changedWhileOff":
      return t(`reason.${reason.code}`);
    case "stopped":
      return t("reason.stopped");
    case "downloading":
      return reason.percent !== undefined ? t("reason.downloadingPercent", { model, percent: reason.percent }) : t("reason.downloading", { model });
    case "notDownloaded":
      return t("reason.notDownloaded", { model });
    case "downloadFailed":
      return t("reason.downloadFailed", { error: reason.error ?? "" });
    case "loadFailed":
      return reason.error ?? t("reason.loadFailed", { model });
    case "loading":
      return t("reason.loading", { model });
    case "lockedByEnv":
      return t("reason.lockedByEnv", { variable: reason.variable ?? "" });
    case "noVoiceModels":
      return t("reason.noVoiceModels");
  }
}

export function noticeText(t: Translate, notice: Notice): string {
  switch (notice.code) {
    case "portBusy":
      return t("notice.portBusy", { port: notice.port ?? 0 });
    case "checkingGpu":
      return t("notice.checkingGpu");
    case "crashRestarting":
      return t("notice.crashRestarting", { exit: notice.exit ?? "", seconds: notice.seconds ?? 0 });
    case "crashGaveUp":
      return t("notice.crashGaveUp", { exit: notice.exit ?? "", crashes: notice.crashes ?? 0 });
    case "healthCheckFailed":
      return t("notice.healthCheckFailed", { error: notice.error ?? "" });
    case "runtimeDownloadRequired":
      return t("consent.status");
    case "serverVersionMismatch": {
      const vars = { required: notice.required ?? "", found: notice.version ?? t("notice.unknownVersion") };
      return t(notice.source === "local" ? "notice.versionLocal" : notice.source === "setting" ? "notice.versionSetting" : "notice.versionRelease", vars);
    }
  }
}

/** "github.com" from a download URL, for saying where the server comes from. */
export function urlHost(url: string | undefined): string | null {
  return /^https?:\/\/([^/?#]+)/i.exec(url ?? "")?.[1] ?? null;
}

/** Device names for "Running on …" chips and engine lines. */
export const DEVICE_NAMES: Record<string, string> = {
  metal: "Metal",
  mlx: "Metal",
  vulkan: "Vulkan",
  cuda: "CUDA",
  cpu: "CPU",
  coreml: "Core ML",
  "neural-engine": "Neural Engine",
};

/**
 * Whether this machine is a Mac with Apple Silicon, from the devices the server found. Null when
 * the server has not reported devices, so nothing is ruled out early.
 */
export function appleSilicon(devices: { backend: string; description: string }[] | undefined): boolean | null {
  if (!devices || devices.length === 0) return null;
  return devices.some((d) => d.backend === "Metal" && /^Apple\b/.test(d.description));
}
