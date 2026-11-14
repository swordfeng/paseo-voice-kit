// The ordered voice model list: which models are enabled, in what order, and which languages they
// cover. Each sentence uses the first enabled model that natively speaks its language (after a
// per-language first choice); languages no enabled model speaks are refused, not guessed.
import type { Model } from "../shared/rpc";
import { APPROXIMATE_LANGUAGES, type Preferences } from "../shared/settings";

/** The chain the server builds from the ordered list (not a catalog model). */
export const CHAIN_ROUTER_ID = "voicekit-tts-chain";

/** Voice models you can enable: the built-in ones and your own (not the server's chain entry). */
export function isVisibleVoiceModel(m: Model): boolean {
  return m.kind === "tts" && m.engine !== "chain" && m.tier !== "internal";
}

/** Languages a model speaks natively. */
export function nativeLanguages(m: Model): string[] {
  return m.languages.filter((l) => l !== "multi");
}

export interface Coverage {
  /** Natively covered languages and the enabled models that speak each, in the order they'd be tried. */
  rows: { language: string; models: Model[]; first: string | null }[];
  /** Languages that can be read approximately with a covered related language. */
  approximate: { language: string; via: string; allowed: boolean }[];
}

export function coverage(chain: Model[], values: Pick<Preferences, "ttsLanguageModels">, allowedApproximate: string[]): Coverage {
  const speakers = new Map<string, Model[]>();
  for (const m of chain) for (const l of nativeLanguages(m)) speakers.set(l, [...(speakers.get(l) ?? []), m]);
  const rows = [...speakers].map(([language, models]) => {
    const choice = values.ttsLanguageModels[language];
    const first = choice && models.some((m) => m.id === choice) ? choice : null;
    // The per-language first choice goes first; the rest keep list order.
    const ordered = first ? [models.find((m) => m.id === first)!, ...models.filter((m) => m.id !== first)] : models;
    return { language, models: ordered, first };
  });
  const approximate = Object.entries(APPROXIMATE_LANGUAGES)
    .filter(([language, via]) => !speakers.has(language) && speakers.has(via))
    .map(([language, via]) => ({ language, via, allowed: allowedApproximate.includes(language) }));
  return { rows, approximate };
}

/** Move an item one place up or down. */
export function move(list: string[], id: string, delta: -1 | 1): string[] {
  const i = list.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
