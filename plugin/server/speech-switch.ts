import { readFile, rename, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { SITES, type Reason, type Site, type SiteStatus } from "../shared/rpc";
import { reloadDaemonConfig } from "./paseo-cli";
import { paths } from "./paths";
import { saveState, type PluginState, type RawSite } from "./state";

/** Where each site lives in Paseo's config: `features.<feature>.<kind>`. */
export const SITE_PATH: Record<Site, { feature: "dictation" | "voiceMode"; kind: "stt" | "tts" }> = {
  dictation: { feature: "dictation", kind: "stt" },
  voiceInput: { feature: "voiceMode", kind: "stt" },
  voiceOutput: { feature: "voiceMode", kind: "tts" },
};

export interface Desired {
  /** Voice Kit should own this site when its model is available. */
  wanted: Record<Site, boolean>;
  /** Model to write for each site, or null when no suitable model is ready yet. */
  model: Record<Site, string | null>;
  /** Why a wanted site has no model yet (shown in the UI). */
  waiting: Record<Site, Reason | null>;
  voice: string;
  /** voicekit's OpenAI base URL, or null while the server is not healthy. */
  baseUrl: string | null;
  token: string;
}

type SpeechPatch = { dictation?: Record<string, unknown>; voiceMode?: Record<string, unknown> };

async function readPersistedConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;
}

function rawSite(config: Record<string, unknown>, site: Site): RawSite | null {
  const { feature, kind } = SITE_PATH[site];
  const features = config.features as Record<string, Record<string, unknown> | undefined> | undefined;
  const value = features?.[feature]?.[kind];
  return value && typeof value === "object" ? { ...(value as RawSite) } : null;
}

function envLock(envOverrides: Record<string, string> | undefined, site: Site): string | null {
  const { feature, kind } = SITE_PATH[site];
  return envOverrides?.[`features.${feature}.${kind}.provider`] ?? null;
}

function setSite(patch: SpeechPatch, site: Site, value: Record<string, unknown>) {
  const { feature, kind } = SITE_PATH[site];
  patch[feature] = { ...(patch[feature] ?? {}), [kind]: value };
}

/** Same engine and choices (keys aside). */
function sameSite(a: RawSite | null, b: Record<string, unknown>): boolean {
  return ["provider", "baseUrl", "model", "voice"].every((k) => (a?.[k] ?? null) === (b[k] ?? null));
}

function withoutKey(site: RawSite): RawSite {
  const { apiKey: _key, ...rest } = site;
  return rest;
}

/**
 * A site written by some Voice Kit server: its per-start `vk_` token on a loopback `/v1` address.
 * Such a value is never the user's own setting, even when Voice Kit's state no longer records it
 * (the state file was lost or damaged), so it is never saved as the setting to restore.
 */
export function isVoiceKitSite(site: RawSite | null | undefined): boolean {
  return (
    site?.provider === "openai" &&
    typeof site.apiKey === "string" &&
    site.apiKey.startsWith("vk_") &&
    typeof site.baseUrl === "string" &&
    /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(site.baseUrl)
  );
}

/** The user's previous site, or Paseo's built-in local engine when there was none. */
function restoreValue(previous: RawSite | null | undefined): Record<string, unknown> {
  return previous && typeof previous.provider === "string" ? { ...previous } : { provider: "local" };
}

/** Same-provider config patches merge; null explicitly removes fields absent in the snapshot. */
function restorePatch(previous: RawSite | null | undefined, current: RawSite | null): Record<string, unknown> {
  const target = restoreValue(previous);
  return { ...Object.fromEntries(Object.keys(current ?? {}).filter((key) => !(key in target)).map((key) => [key, null])), ...target };
}

/**
 * Owns Paseo's speech sites while Voice Kit is healthy and gives them back, exactly as they
 * were (API keys included), when it is not. Sites the user changes by hand are left alone.
 */
export class SpeechSwitch {
  private paseo: PaseoApi | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private desired: Desired | null = null;
  private statuses: SiteStatus[] = SITES.map((site) => ({ site, state: "off", model: null, detail: null, reason: null }));
  private lastError: string | null = null;

  constructor(private readonly state: PluginState) {}

  get connected(): boolean {
    return this.paseo !== null;
  }

  get siteStatuses(): SiteStatus[] {
    return this.statuses;
  }

  get error(): string | null {
    return this.lastError;
  }

  /** RPC handlers pass their daemon session here; the first one enables switching. */
  attach(paseo: PaseoApi) {
    if (this.paseo === paseo) return;
    this.paseo = paseo;
    void this.reconcile();
  }

  setDesired(desired: Desired) {
    this.desired = desired;
    void this.reconcile();
  }

  async reclaim(site: Site) {
    delete this.state.overrides[site];
    delete this.state.edited[site];
    await saveState(this.state);
    await this.reconcile();
  }

  /** Serialized; concurrent callers coalesce into one follow-up pass. */
  reconcile(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass(this.desired);
        } while (this.again);
        this.lastError = null;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        console.error(`[voice-kit] could not update Paseo voice settings: ${this.lastError}`);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Give every site back to Paseo. Used when the plugin stops or is turned off. */
  async releaseAll(): Promise<void> {
    this.desired = null;
    if (this.running) await this.running.catch(() => undefined);
    await this.pass(null);
  }

  private async pass(desired: Desired | null): Promise<void> {
    const paseo = this.paseo;
    if (!paseo) {
      this.statuses = SITES.map((site) => ({
        site,
        state: desired?.wanted[site] ? "fallback" : "off",
        model: null,
        detail: desired?.wanted[site] ? "Waiting for a Paseo app to connect" : null,
        reason: desired?.wanted[site] ? { code: "waitingForApp" } : null,
      }));
      return;
    }

    const { config } = await paseo.config.get();
    const envOverrides = (config as { envOverrides?: Record<string, string> }).envOverrides;
    const persisted = await readPersistedConfig();
    const patch: SpeechPatch = {};
    const statuses: SiteStatus[] = [];
    let dirty = false;
    let switchingIn = false;
    const wrote: Site[] = [];
    // State changes that hold only once Paseo accepted the patch.
    const afterPatch: Array<() => void> = [];

    for (const site of SITES) {
      const current = rawSite(persisted, site);
      let managed = this.state.managed[site];
      // The daemon accepted restoration, but we crashed before finalizing the saved intent.
      if (managed?.restoring && sameSite(current, restoreValue(this.state.previous[site]))) {
        delete this.state.managed[site];
        delete this.state.previous[site];
        managed = undefined;
        dirty = true;
      }
      const atUrl = (url: unknown) => current?.provider === "openai" && typeof url === "string" && current.baseUrl === url;
      const pointsHere = !!managed && atUrl(managed.baseUrl);
      const pendingUnchanged = managed?.applied === false && !!managed.pending && isDeepStrictEqual(current, managed.pending.before);
      const pendingTakeover = pendingUnchanged && !pointsHere;
      const pendingAccepted = managed?.pending && isDeepStrictEqual(current, managed.pending.after);
      const externalPendingEdit = managed?.applied === false && !!managed.pending && !pendingUnchanged && !pendingAccepted;
      // A crash may happen after acceptance but before saving applied=true.
      if (managed?.applied === false && pendingAccepted) {
        managed.applied = true;
        delete managed.pending;
        dirty = true;
      }
      // Model changed in Settings > Voice, still on Voice Kit's server. Judged only after Paseo
      // accepted Voice Kit's own write, so a failed write is not taken for a user edit. Voices are
      // chosen per model in Voice Kit, so a voice changed there is not a takeover.
      const edited =
        !!managed &&
        pointsHere &&
        (managed.applied !== false || externalPendingEdit) &&
        current?.model !== managed.model;
      const ours = pointsHere && !edited && !externalPendingEdit;

      if (managed && !ours && !pendingTakeover) {
        // Changed in Settings > Voice while Voice Kit owned it: the user's choice wins.
        delete this.state.managed[site];
        this.state.overrides[site] = true;
        // Kept on Voice Kit's server: keep the earlier setting, for when Voice Kit is unavailable.
        if (edited && current) this.state.edited[site] = { site: withoutKey(current), parked: false };
        else delete this.state.previous[site];
        dirty = true;
      }

      const locked = envLock(envOverrides, site);
      const override = this.state.overrides[site] === true;
      const model = desired?.model[site] ?? null;
      const kitReady = !!desired && desired.wanted[site] && !locked && !!model && !!desired.baseUrl && !!desired.token;
      const want = kitReady && !override;

      const mine = override ? this.state.edited[site] : undefined;
      if (mine) {
        if (mine.parking && sameSite(current, restoreValue(this.state.previous[site]))) {
          mine.parked = true;
          delete mine.parking;
          dirty = true;
        }
        const stillMine = mine.parked ? sameSite(current, restoreValue(this.state.previous[site])) : atUrl(mine.site.baseUrl);
        if (!stillMine) {
          // Changed again by hand, away from Voice Kit: fully the user's now.
          delete this.state.edited[site];
          delete this.state.previous[site];
          dirty = true;
        } else {
          if (!mine.parked && current && !sameSite(mine.site, current)) {
            mine.site = withoutKey(current);
            dirty = true;
          }
          if (kitReady && desired?.baseUrl) {
            if (mine.parking) {
              delete mine.parking;
              dirty = true;
            }
            // Keep the user's model and voice working: current address and key.
            if (mine.parked || current?.apiKey !== desired.token || current?.baseUrl !== desired.baseUrl) {
              const next = { ...mine.site, baseUrl: desired.baseUrl };
              setSite(patch, site, { ...next, apiKey: desired.token });
              afterPatch.push(() => {
                mine.site = next;
                mine.parked = false;
              });
            }
            statuses.push({ site, state: "override", model: null, detail: "You changed the model or voice in Settings > Voice.", reason: { code: "changedModelOrVoice" } });
          } else {
            // Voice Kit stopped: the user's earlier setting until it is back.
            if (!mine.parked) {
              mine.parking = true;
              dirty = true;
              setSite(patch, site, restorePatch(this.state.previous[site], current));
              afterPatch.push(() => { mine.parked = true; delete mine.parking; });
            }
            statuses.push({
              site,
              state: "override",
              model: null,
              detail: "You changed this in Settings > Voice. Your earlier setting is used while Voice Kit is off.",
              reason: { code: "changedWhileOff" },
            });
          }
          continue;
        }
      }

      if (want && desired && model && desired.baseUrl) {
        const voice = site === "voiceOutput" ? desired.voice : undefined;
        // The voice Paseo sends is ignored (each model has its own), so a different one there is
        // left alone rather than rewritten.
        const upToDate =
          ours &&
          current?.model === model &&
          current?.baseUrl === desired.baseUrl &&
          current?.apiKey === desired.token;
        if (!ours) {
          // Remember the user's own configuration exactly before taking the site over (never a
          // site that already points at Voice Kit: its earlier setting is kept from before, or,
          // if Voice Kit's state was lost, is unknown and restores Paseo's built-in speech).
          if (!atUrl(desired.baseUrl) && !isVoiceKitSite(current)) this.state.previous[site] = current;
          switchingIn = true;
        }
        if (!upToDate) {
          const next: RawSite = {
            provider: "openai",
            baseUrl: desired.baseUrl,
            apiKey: desired.token,
            model,
            ...(voice ? { voice } : {}),
          };
          setSite(patch, site, next);
          const after = current?.provider === next.provider ? { ...current, ...next } : next;
          this.state.managed[site] = { model, voice, baseUrl: desired.baseUrl, applied: false, pending: { before: current, after } };
          wrote.push(site);
          dirty = true;
        } else if (managed?.restoring) {
          // The engine recovered before restoration succeeded; this is an active site again.
          delete managed.restoring;
          dirty = true;
        }
        statuses.push({ site, state: "active", model, detail: null, reason: null });
        continue;
      }

      if (ours) {
        setSite(patch, site, restorePatch(this.state.previous[site], current));
        managed!.restoring = true;
        afterPatch.push(() => {
          delete this.state.managed[site];
          delete this.state.previous[site];
        });
        dirty = true;
      } else if (pendingTakeover) {
        // No write was accepted, and the user still has the saved original setting.
        delete this.state.managed[site];
        delete this.state.previous[site];
        dirty = true;
      } else if (!managed && !override && isVoiceKitSite(current)) {
        // Left pointing at a Voice Kit server that no record owns (state lost): it can't work
        // with a stale token, and the user's earlier setting is unknown.
        setSite(patch, site, restorePatch(null, current));
      }

      if (locked) statuses.push({ site, state: "locked", model: null, detail: `Set by ${locked} on the Paseo daemon`, reason: { code: "lockedByEnv", variable: locked } });
      else if (override) statuses.push({ site, state: "override", model: null, detail: "You changed this in Settings > Voice.", reason: { code: "changedInSettings" } });
      else if (!desired?.wanted[site]) statuses.push({ site, state: "off", model: null, detail: null, reason: null });
      else {
        const reason = desired.waiting[site] ?? { code: "starting" as const };
        statuses.push({ site, state: "fallback", model: null, detail: describeReason(reason), reason });
      }
    }

    // Persist intent before touching Paseo, so a crash mid-way can still restore the user's sites.
    if (dirty) await saveState(this.state);
    if (patch.dictation || patch.voiceMode) {
      if (switchingIn && (await ensureLocalTurnDetection())) {
        // The daemon applies patches on top of its in-memory config; make it re-read the file
        // so the new modelsDir (and with it, local turn detection) is part of the next apply.
        if (!(await reloadDaemonConfig())) {
          console.error("[voice-kit] could not run `paseo reload`; voice-mode turn detection returns after the next daemon restart");
        }
      }
      await paseo.config.patch({ features: patch } as Parameters<PaseoApi["config"]["patch"]>[0]);
      console.log(`[voice-kit] updated Paseo voice settings: ${describePatch(patch)}`);
      for (const site of wrote) {
        const managed = this.state.managed[site];
        if (managed) { managed.applied = true; delete managed.pending; }
      }
      for (const apply of afterPatch) apply();
      if (wrote.length || afterPatch.length) await saveState(this.state);
    }
    this.statuses = statuses;
  }
}

function describePatch(patch: SpeechPatch): string {
  const parts: string[] = [];
  for (const site of SITES) {
    const { feature, kind } = SITE_PATH[site];
    const value = patch[feature]?.[kind] as Record<string, unknown> | undefined;
    if (value) parts.push(`${site} -> ${value.provider}${value.model ? `:${value.model}` : ""}`);
  }
  return parts.join(", ");
}

/**
 * Paseo builds its local speech runtime, which includes voice-mode turn detection, only when a
 * site uses the local provider or `providers.local.modelsDir` is set. Before every site points
 * at Voice Kit, set modelsDir to Paseo's own default location (no change in behavior for Paseo)
 * so turn detection keeps working. The SDK cannot set this key, so edit config.json in place.
 */
/** The daemon has re-read config.json since this process last needed it to. */
let daemonSawModelsDir = false;

/** Returns true when the daemon must re-read config.json before the next speech patch. */
async function ensureLocalTurnDetection(): Promise<boolean> {
  const config = await readPersistedConfig();
  const providers = (config.providers ?? {}) as Record<string, Record<string, unknown> | undefined>;
  if (typeof providers.local?.modelsDir === "string") {
    // Present on disk, but a daemon that started before it was written has not loaded it.
    const needed = !daemonSawModelsDir;
    daemonSawModelsDir = true;
    return needed;
  }
  daemonSawModelsDir = true;
  config.providers = { ...providers, local: { ...(providers.local ?? {}), modelsDir: paths.paseoModels } };
  const tmp = `${paths.config}.voice-kit.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, paths.config);
  return true;
}

/** English text for a reason, kept in `detail` for diagnostic logs. */
export function describeReason(reason: Reason): string {
  switch (reason.code) {
    case "starting":
      return "Voice Kit is starting";
    case "installing":
      return "Installing the Voice Kit server";
    case "restarting":
      return "Voice Kit is restarting";
    case "stopped":
      return reason.error ?? "Voice Kit stopped working";
    case "waitingForApp":
      return "Waiting for a Paseo app to connect";
    case "downloading":
      return `Downloading ${reason.model}…${reason.percent !== undefined ? ` ${reason.percent}%` : ""}`;
    case "notDownloaded":
      return `${reason.model} isn't downloaded yet`;
    case "downloadFailed":
      return `Download failed: ${reason.error}`;
    case "loadFailed":
      return reason.error ?? `${reason.model} failed to load`;
    case "loading":
      return `Loading ${reason.model}`;
    case "changedInSettings":
      return "You changed this in Settings > Voice.";
    case "changedModelOrVoice":
      return "You changed the model or voice in Settings > Voice.";
    case "changedWhileOff":
      return "You changed this in Settings > Voice. Your earlier setting is used while Voice Kit is off.";
    case "lockedByEnv":
      return `Set by ${reason.variable} on the Paseo daemon`;
    case "noVoiceModels":
      return "No voice model is enabled";
  }
}
