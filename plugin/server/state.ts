import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Site } from "../shared/rpc";
import { paths } from "./paths";

/** A raw speech site from config.json (provider plus its fields, apiKey included). */
export type RawSite = Record<string, unknown> & { provider?: string };

export interface PluginState {
  /** What each site looked like before Voice Kit took it over. `null` means it was unset. */
  previous: Partial<Record<Site, RawSite | null>>;
  /**
   * Sites Voice Kit currently owns in Paseo's config, with the model it wrote. `applied` is false
   * between saving the intent and Paseo accepting the write.
   */
  managed: Partial<Record<Site, { model: string; voice?: string; baseUrl: string; applied?: boolean; restoring?: boolean; pending?: { before: RawSite | null; after: RawSite } }>>;
  /** Sites the user took back in Settings > Voice. Voice Kit leaves them alone. */
  overrides: Partial<Record<Site, true>>;
  /** Taken-back sites where the user only changed the model or voice and kept Voice Kit's server. */
  edited: Partial<Record<Site, EditedSite>>;
}

export interface EditedSite {
  /** The user's site without its key (Voice Kit's key changes every time the server starts). */
  site: RawSite;
  /** Voice Kit is unavailable, so the site is on the user's earlier setting until it returns. */
  parked: boolean;
  /** Restoration intent survives a crash before the accepted write is finalized. */
  parking?: boolean;
}

function fresh(): PluginState {
  return { previous: {}, managed: {}, overrides: {}, edited: {} };
}

export async function loadState(): Promise<PluginState> {
  try {
    const parsed = JSON.parse(await readFile(paths.state, "utf8")) as Partial<PluginState>;
    return {
      previous: parsed.previous ?? {},
      managed: parsed.managed ?? {},
      overrides: parsed.overrides ?? {},
      edited: parsed.edited ?? {},
    };
  } catch {
    const state = fresh();
    await saveState(state);
    return state;
  }
}

/** Atomic write, owner-only permissions (the file can hold a previous OpenAI API key). */
export async function saveState(state: PluginState): Promise<void> {
  await mkdir(dirname(paths.state), { recursive: true });
  const tmp = `${paths.state}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, paths.state);
}
