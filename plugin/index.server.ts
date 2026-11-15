import type { PaseoApi } from "@getpaseo/client";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  attachRpc,
  hfLookupRpc,
  logsRpc,
  modelsRpc,
  previewRpc,
  pullModelRpc,
  reclaimRpc,
  removeModelRpc,
  restartRpc,
  statusRpc,
  voicesRpc,
  mlxRuntimeRpc,
  type Engine,
  type Reason,
  type Model,
  type Site,
  type Status,
  type RouteVoices,
  type Voice,
} from "./shared/rpc";
import { PREVIEW_LINES } from "./shared/languages";
import { DEFAULT_CPU_STT_MODEL, preferences, voiceSpec, type Preferences } from "./shared/settings";
import { DefaultSttModel, DefaultSttSelectionPending, chooseDefaultSttModel, needsDefaultStt, withDefaultSttModels } from "./server/default-stt";
import { SpeechSwitch, type Desired } from "./server/speech-switch";
import { loadState, type PluginState } from "./server/state";
import { effectiveTts, TTS_CHAIN_ID } from "./server/tts-chain";
import { PaseoModels, isPaseoModel } from "./server/paseo-models";
import { MemorySampler } from "./server/memory";
import { Supervisor, type ServerConfig, type SupervisorSnapshot } from "./server/supervisor";
import { voicekit, voicekitJson } from "./server/voicekit-api";
import { writeCustomCatalog } from "./server/custom-models";
import { lookup as hfLookup } from "./server/huggingface";
import { MlxRuntimeMonitor } from "./server/mlx-runtime";
import { featurePhase } from "./server/feature-phase";

/**
 * Preview reads the selected speech language's line, or English when it is automatic.
 */
function defaultPreview(prefs: Preferences | null): string {
  const chosen = prefs && prefs.language !== "auto" && prefs.language !== "request" ? prefs.language : null;
  return (chosen && PREVIEW_LINES[chosen]) || PREVIEW_LINES.en;
}

function serverConfig(prefs: Preferences, catalog: { path: string; hash: string; ttsModel?: string }, sharedModelsDir: string | null): ServerConfig | null {
  if (!prefs.enabled) return null;
  const stt: string[] = [];
  if (prefs.useForDictation && prefs.dictationModel) stt.push(prefs.dictationModel);
  if (prefs.useForVoiceInput && prefs.voiceInputModel && !stt.includes(prefs.voiceInputModel)) stt.push(prefs.voiceInputModel);
  if (stt.length === 0 && !prefs.useForVoiceOutput) return null;
  return {
    binaryPath: prefs.binaryPath,
    port: prefs.port,
    sttModels: stt,
    ttsModel: catalog.ttsModel ?? TTS_CHAIN_ID,
    voice: voiceSpec(prefs),
    speed: prefs.speed,
    language: prefs.language,
    vocabulary: prefs.vocabulary,
    accelerator: prefs.accelerator,
    autoDownload: prefs.autoDownload,
    runtimeDownloadApproved: prefs.runtimeDownloadApproved,
    idleUnloadMinutes: prefs.idleUnloadMinutes,
    neuralEngine: prefs.neuralEngine,
    catalogPath: catalog.path,
    catalogHash: catalog.hash,
    sharedModelsDir,
  };
}

type Downloads = NonNullable<SupervisorSnapshot["health"]>["downloads"];

function describeWait(engine: Engine | undefined, downloads: Downloads | undefined): Reason {
  if (!engine) return { code: "starting" };
  const model = engine.model;
  const d = downloads?.[model];
  if (d && !d.error && d.phase !== "done") {
    return d.total ? { code: "downloading", model, percent: Math.floor((d.downloaded / d.total) * 100) } : { code: "downloading", model };
  }
  if (engine.state === "missing") return engine.error || d?.error ? { code: "downloadFailed", model, error: engine.error || d?.error || "" } : { code: "notDownloaded", model };
  if (engine.state === "failed") return engine.error ? { code: "loadFailed", model, error: engine.error } : { code: "loadFailed", model };
  return { code: "loading", model };
}

/** What Paseo should use for each site, given preferences and live server health. */
export function computeDesired(prefs: Preferences | null, snap: SupervisorSnapshot, baseUrl: string | null, token: string): Desired {
  const wanted: Record<Site, boolean> = {
    dictation: !!prefs?.enabled && !!prefs.useForDictation,
    voiceInput: !!prefs?.enabled && !!prefs.useForVoiceInput,
    voiceOutput: !!prefs?.enabled && !!prefs.useForVoiceOutput,
  };
  const health = snap.health;
  const healthy = !!health && (snap.phase === "ready" || snap.phase === "degraded" || snap.phase === "loading");
  const stt = (id: string | undefined) => health?.stt.find((e) => e.model === id);
  const usable = (id: string | undefined) => (healthy && stt(id)?.available ? id! : null);

  const phaseWait: Reason | null =
    snap.phase === "failed" ? (snap.message ? { code: "stopped", error: snap.message } : { code: "stopped" }) :
    snap.phase === "restarting" ? { code: "restarting" } :
    snap.phase === "installing" ? { code: "installing" } :
    !healthy ? { code: "starting" } : null;

  // Prefer each site's own model; fall back to the other configured one while it downloads.
  const dictation = usable(prefs?.dictationModel) ?? usable(prefs?.voiceInputModel);
  const voiceInput = usable(prefs?.voiceInputModel) ?? usable(prefs?.dictationModel);
  const hasVoiceModels = !!prefs && effectiveTts(prefs).models.length > 0;
  const voiceOutput = hasVoiceModels && healthy && health?.tts?.available ? health.tts.model : null;

  return {
    wanted,
    model: { dictation, voiceInput, voiceOutput },
    waiting: {
      dictation: dictation ? null : phaseWait ?? describeWait(stt(prefs?.dictationModel), health?.downloads),
      voiceInput: voiceInput ? null : phaseWait ?? describeWait(stt(prefs?.voiceInputModel), health?.downloads),
      voiceOutput: !hasVoiceModels ? { code: "noVoiceModels" } : voiceOutput ? null : phaseWait ?? describeWait(health?.tts ?? undefined, health?.downloads),
    },
    voice: prefs ? voiceSpec(prefs) : "female-higher",
    baseUrl: healthy ? baseUrl : null,
    token,
  };
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  let prefs: Preferences | null = null;
  let state: PluginState | null = null;
  let speech: SpeechSwitch | null = null;
  let lastDesired = "";
  let stopped = false;

  const supervisor = new Supervisor((snap) => publish(snap));
  const memory = new MemorySampler();
  const listeningDefault = new DefaultSttModel();
  const mlxRuntime = new MlxRuntimeMonitor({
    binary: () => supervisor.state.binary?.path ?? null,

  });
  let defaultSttModel: string | null = null;
  const sharedModels = new PaseoModels({
    changed: () => publish(),
    installed: async id => {
      await voicekit(supervisor, "/voicekit/pull", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    },
  });
  function sharedSnapshot(snap: SupervisorSnapshot): SupervisorSnapshot {
    const phase = featurePhase(prefs, snap);
    return snap.health ? { ...snap, phase, message: phase === "ready" ? null : snap.message, health: { ...snap.health, downloads: { ...snap.health.downloads, ...sharedModels.progress() } } } : snap;
  }

  function publish(snap: SupervisorSnapshot = supervisor.state) {
    if (!speech || !state || stopped) return;
    const desired = computeDesired(prefs, sharedSnapshot(snap), supervisor.baseUrl, supervisor.token ?? "");
    const key = JSON.stringify(desired);
    if (key === lastDesired) return;
    lastDesired = key;
    speech.setDesired(desired);
  }

  let prefsRevision = 0;
  let pendingPrefs: Promise<void> = Promise.resolve();
  let prefsAbort = new AbortController();
  let defaultRetry: ReturnType<typeof setTimeout> | null = null;
  let defaultFailures = 0;

  function applyPrefs(values: Preferences, forceRestart = false): Promise<void> {
    if (defaultRetry) clearTimeout(defaultRetry);
    defaultRetry = null;
    const revision = ++prefsRevision;
    prefsAbort.abort();
    prefsAbort = new AbortController();
    const signal = prefsAbort.signal;
    const next = pendingPrefs.catch(() => undefined).then(async () => {
      await initialized;
      await applyPrefsNow(values, revision, forceRestart, signal);
    });
    pendingPrefs = next;
    return next;
  }

  async function applyPrefsNow(values: Preferences, revision: number, forceRestart: boolean, signal: AbortSignal) {
    if (revision !== prefsRevision || stopped) return;
    let nextPrefs = values;
    if (needsDefaultStt(values)) {
      try {
        defaultSttModel = await listeningDefault.get(async () => {
          const model = await chooseDefaultSttModel(values,
            () => supervisor.prepareBinary(values.binaryPath, "Checking this machine's GPU", { code: "checkingGpu" }, values.runtimeDownloadApproved, signal),
            line => supervisor.note(line), signal);
          if (revision !== prefsRevision || stopped) throw new Error("Speech preferences changed during initialization");
          return model;
        }, signal);
        nextPrefs = withDefaultSttModels(values, defaultSttModel);
        defaultFailures = 0;
      } catch (error) {
        if (signal.aborted) return;
        supervisor.note(`[voice-kit] default listening model initialization pending: ${String(error)}`);
        if (error instanceof DefaultSttSelectionPending) {
          const delay = Math.min(10 * 60_000, 60_000 * 2 ** Math.min(defaultFailures++, 4));
          defaultRetry = setTimeout(() => {
            defaultRetry = null;
            if (!stopped && revision === prefsRevision) void applyPrefs(values).catch(error => supervisor.note(`[voice-kit] listening retry failed: ${String(error)}`));
          }, delay);
        }
        // Let normal startup report runtime installation/consent errors. This temporary value
        // is never persisted as the default when the runtime could not be prepared.
        nextPrefs = withDefaultSttModels(values, DEFAULT_CPU_STT_MODEL);
      }
    }
    if (revision !== prefsRevision || stopped) return;
    if (!state || stopped) return;
    const catalog = await writeCustomCatalog(values.customModels,nextPrefs);
    if (revision !== prefsRevision || stopped) return;
    prefs = nextPrefs;
    const config = serverConfig(prefs, catalog, await sharedModels.root());
    await supervisor.apply(config, forceRestart, signal);
    if (config && !stopped && revision === prefsRevision) {
      await sharedModels.adopt().catch(error => console.error("[voice-kit] shared model adoption failed", error));
      if (values.autoDownload) for (const id of config.sttModels.filter(isPaseoModel)) {
        void sharedModels.ensure(id).catch(error => console.error("[voice-kit] shared model unavailable", error));
      }
    }
    publish();
  }

  const initialized = (async () => {
    state = await loadState();
    speech = new SpeechSwitch(state);
  })();
  const ready = (async () => {
    await initialized;
    const revision = prefsRevision;
    const initial = await settings.read();
    if (revision !== prefsRevision || stopped) return;
    if (initial.status === "ready") await applyPrefs(initial.values);
    else console.error(`[voice-kit] settings are invalid: ${initial.error}`);
  })().catch((error) => console.error("[voice-kit] startup failed", error));

  const unsubscribe = settings.subscribe(async (next) => {
    // Invalidate an in-flight first selection immediately, before waiting on startup work.
    if (next.status === "ready") await applyPrefs(next.values);
  });

  // Notice changes the user makes in Settings > Voice even when nothing else changes.
  const sweep = setInterval(() => void speech?.reconcile(), 15_000);

  /** Every handler call carries a daemon session; it is how the backend reaches Paseo. */
  async function withSession(context: PluginHandlerContext) {
    await ready;
    speech?.attach(context.paseo as PaseoApi);
  }

  server.handle(attachRpc, async (_input, context) => {
    await withSession(context);
    return { ok: true };
  });

  server.handle(mlxRuntimeRpc, async () => mlxRuntime.status());

  server.handle(statusRpc, async (_input, context): Promise<Status> => {
    await withSession(context);
    const snap = sharedSnapshot(supervisor.state);
    const health = snap.health;
    const pid = supervisor.childPid;
    const usage = await memory.sampleUsage(pid);
    const currentMemory = supervisor.childPid === pid;
    return {
      phase: snap.phase,
      memoryBytes: currentMemory ? usage.memoryBytes : null,
      gpuMemoryBytes: currentMemory ? usage.gpuMemoryBytes : null,
      gpuSharedMemoryBytes: currentMemory ? usage.gpuSharedMemoryBytes : null,
      gpuMemorySource: currentMemory ? usage.gpuMemorySource : null,
      message: speech?.error ?? snap.message,
      notice: speech?.error ? null : snap.notice,
      connected: speech?.connected ?? false,
      binary: { path: snap.binary?.path ?? null, version: snap.binary?.version ?? null, source: snap.binary?.source ?? null },
      baseUrl: supervisor.baseUrl,
      restarts: snap.restarts,
      stt: health?.stt ?? [],
      tts: health?.tts ?? null,
      ttsModels: prefs ? effectiveTts(prefs).models : [],
      ttsLanguageModels: prefs?.ttsLanguageModels ?? {},
      ttsLastError: health?.ttsLastError ?? null,
      downloads: Object.fromEntries(
        Object.entries(health?.downloads ?? {}).map(([id, d]) => [id, { downloaded: d.downloaded, total: d.total ?? null, phase: d.phase, error: d.error ?? null }]),
      ),
      sites: speech?.siteStatuses ?? [],
      coreml: health?.coreml ?? {},
      install: snap.install ? { downloaded: snap.install.downloaded, total: snap.install.total } : null,
      defaultSttModel,
      devices: (health?.hardware?.devices ?? []).map((d) => ({
        name: d.name,
        description: d.description,
        type: d.type,
        backend: d.backend,
        memoryTotal: d.memoryTotal ?? null,
      })),
    };
  });

  server.handle(restartRpc, async (_input, context) => {
    await withSession(context);
    // Re-resolve custom paths/metadata so a repaired folder can recover on this action.
    const current = await settings.read();
    if (current.status === "ready") await applyPrefs(current.values, true);
    else await supervisor.restart();
    return { ok: true };
  });

  server.handle(modelsRpc, async (_input, context) => {
    await withSession(context);
    const body = await voicekitJson<{ models: Model[]; coremlSupported: boolean }>(supervisor, "/voicekit/models");
    const sharedStateAvailable = await sharedModels.list().then(() => true).catch(error => { console.error("[voice-kit] could not query Paseo models", error); return false; });
    for (const model of body.models.filter(m => m.sharedWithPaseo)) {
      const state = sharedModels.state(model.id);
      model.paseoInUse = state?.inUse ?? false;
      model.download = sharedModels.progress()[model.id] ?? null;
      if (sharedStateAvailable) model.installed = model.installed && state?.status === "installed";
    }
    return { models: body.models, coremlSupported: body.coremlSupported };
  });

  server.handle(pullModelRpc, async ({ id }, context) => {
    await withSession(context);
    if (isPaseoModel(id)) {
      void sharedModels.ensure(id).catch(error => console.error("[voice-kit] shared model download failed", error));
      return { ok: true };
    }
    await voicekit(supervisor, "/voicekit/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    return { ok: true };
  });

  server.handle(removeModelRpc, async ({ id }, context) => {
    await withSession(context);
    if (isPaseoModel(id)) {
      const { models } = await voicekitJson<{ models: Model[] }>(supervisor, "/voicekit/models");
      if (models.find(m => m.id === id)?.active) throw new Error("Model is in use by Voice Kit; switch models first");
      await sharedModels.remove(id);
      return { ok: true };
    }
    await voicekit(supervisor, `/voicekit/models/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { ok: true };
  });

  server.handle(voicesRpc, async (_input, context) => {
    await withSession(context);
    const body = await voicekitJson<{ voices: Voice[]; routes?: RouteVoices[] }>(supervisor, "/voicekit/voices", { timeoutMs: 60_000 });
    return { voices: body.voices, routes: body.routes ?? [] };
  });

  server.handle(previewRpc, async ({ voice, text }, context) => {
    await withSession(context);
    const started = Date.now();
    const response = await voicekit(supervisor, "/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: TTS_CHAIN_ID, voice: voice ?? (prefs ? voiceSpec(prefs) : undefined), input: text?.trim() || defaultPreview(prefs), response_format: "wav" }),
      timeoutMs: 60_000,
    });
    const audio = Buffer.from(await response.arrayBuffer());
    return { base64: audio.toString("base64"), mimeType: "audio/wav", ms: Date.now() - started };
  });

  server.handle(reclaimRpc, async ({ site }, context) => {
    await withSession(context);
    await speech?.reclaim(site);
    return { ok: true };
  });

  server.handle(hfLookupRpc, async ({ repo }, context) => {
    await withSession(context);
    return hfLookup(repo);
  });

  server.handle(logsRpc, async (_input, context) => {
    await withSession(context);
    return { lines: supervisor.logTail() };
  });

  return async () => {
    stopped = true;
    prefsAbort.abort();
    if (defaultRetry) clearTimeout(defaultRetry);
    clearInterval(sweep);
    unsubscribe();
    await sharedModels.dispose();
    await ready;
    await pendingPrefs.catch(() => undefined);
    // Hand every voice feature back to Paseo before the server goes away.
    await speech?.releaseAll().catch((error) => console.error("[voice-kit] could not restore Paseo voice settings", error));
    await supervisor.dispose();
  };
}
