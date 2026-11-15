import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import { DEFAULT_CPU_STT_MODEL, DEFAULT_GPU_STT_MODEL, type Preferences } from "../shared/settings";
import type { ResolvedBinary } from "./binary";
import { paths } from "./paths";

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("Listening initialization cancelled"), { name: "AbortError" });
}

/** One initial choice per installation; upgrades and later hardware settings do not change it. */
export class DefaultSttModel {
  private model: string | null = null;
  private pending: Promise<string> | null = null;
  constructor(private file = join(paths.data, "stt-default.json")) {}

  get(select: () => Promise<string>, signal?: AbortSignal): Promise<string> {
    throwIfCancelled(signal);
    if (this.model) return Promise.resolve(this.model);
    if (this.pending) return this.pending;
    const pending = (async () => {
      try {
        const stored = JSON.parse(await readFile(this.file, "utf8"));
        throwIfCancelled(signal);
        if (typeof stored.model !== "string" || !stored.model.trim()) throw new Error("Invalid default speech model");
        return this.model = stored.model;
      } catch (error) {
        // Permission errors and corrupt files must not silently replace an existing choice.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const model = await select();
      throwIfCancelled(signal);
      if (!model.trim()) throw new Error("Default speech model is empty");
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ model }), { mode: 0o600 });
        throwIfCancelled(signal);
        await rename(temp, this.file);
      } finally { await rm(temp, { force: true }).catch(() => undefined); }
      return this.model = model;
    })().finally(() => { this.pending = null; });
    this.pending = pending;
    return pending;
  }
}

/** Fill only unselected features. Explicit choices are always left alone. */
export function withDefaultSttModels(values: Preferences, model: string): Preferences {
  return { ...values, dictationModel: values.dictationModel || model, voiceInputModel: values.voiceInputModel || model };
}

export function needsDefaultStt(values: Preferences): boolean {
  return values.enabled && (values.useForDictation && !values.dictationModel || values.useForVoiceInput && !values.voiceInputModel);
}

export class DefaultSttSelectionPending extends Error {}

/** Inconclusive GPU checks in a row after which the CPU model becomes the default. */
export const INCONCLUSIVE_CHECKS = 3;

/**
 * The default to store after a failed selection, if any: the CPU model once the GPU check was
 * inconclusive `INCONCLUSIVE_CHECKS` times in a row (`earlierFailures` counts the ones before).
 */
export function settledDefault(error: unknown, earlierFailures: number): string | null {
  return error instanceof DefaultSttSelectionPending && earlierFailures >= INCONCLUSIVE_CHECKS - 1 ? DEFAULT_CPU_STT_MODEL : null;
}

/**
 * Listening while there is no default yet. A pending GPU check leaves it with Paseo's built-in
 * speech (""), so nothing is downloaded that the check may replace. Other errors (download
 * approval) start the server with the CPU model so they are reported; it is never stored.
 */
export function interimListeningModel(error: unknown): string {
  return error instanceof DefaultSttSelectionPending ? "" : DEFAULT_CPU_STT_MODEL;
}

/** Failed/missing measurements are unknown, not evidence that this computer is CPU-only. */
export function modelFromProbe(report: { fastWhisper?: boolean; gpu?: unknown; accelerator?: string; medianMs?: number; reason?: string }): string {
  if (report.gpu === null && report.fastWhisper === false) return DEFAULT_CPU_STT_MODEL;
  if (report.gpu && report.accelerator && report.accelerator !== "cpu" &&
      Number.isFinite(report.medianMs) && report.medianMs! > 0 && typeof report.fastWhisper === "boolean") {
    return report.fastWhisper ? DEFAULT_GPU_STT_MODEL : DEFAULT_CPU_STT_MODEL;
  }
  throw new DefaultSttSelectionPending(report.reason || "GPU measurement is unavailable");
}

/** Select once for a fresh installation; CPU-only never runs a GPU probe. */
export async function chooseDefaultSttModel(
  values: Preferences,
  prepare: () => Promise<ResolvedBinary>,
  log: (line: string) => void,
  signal?: AbortSignal,
  // Dependency injection keeps platform/probe regressions local and bounded.
  probe = execCommand,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  throwIfCancelled(signal);
  if (values.accelerator === "cpu") return DEFAULT_CPU_STT_MODEL;
  if (platform === "darwin") return DEFAULT_GPU_STT_MODEL;
  // Resolve the runtime before probing. Missing installation consent must not persist a CPU
  // default just because the runtime cannot be downloaded yet.
  const binary = await prepare();
  throwIfCancelled(signal);
  const args = ["probe", "--models-dir", paths.models, "--reuse-dir", paths.paseoModels];
  if (values.autoDownload) args.push("--auto-pull");
  log(`[voice-kit] selecting the initial listening model: ${binary.path} ${args.join(" ")}`);
  try {
    const { stdout } = await probe(binary.path, args, {
      timeout: 10 * 60_000, shell: false, maxBuffer: 4 * 1024 * 1024,
      signal,
      env: { ...process.env, VOICEKIT_LOG: "warn" },
    });
    throwIfCancelled(signal);
    const report = JSON.parse(stdout) as Parameters<typeof modelFromProbe>[0];
    const model = modelFromProbe(report);
    log(`[voice-kit] initial listening model: ${model} (${report.reason ?? "GPU probe"})`);
    return model;
  } catch (error) {
    throwIfCancelled(signal);
    log(`[voice-kit] GPU probe is inconclusive; default selection remains pending: ${String(error).slice(0, 250)}`);
    throw error instanceof DefaultSttSelectionPending ? error : new DefaultSttSelectionPending(String(error));
  }
}
