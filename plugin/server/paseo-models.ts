// Exact shared ONNX artifacts. All transfers/deletes go through Paseo's one model library.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { paths } from "./paths";

export const PASEO_MODELS = {
  "parakeet-tdt-0.6b-v3-int8": { id: "parakeet-tdt-0.6b-v3-int8", dir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", files: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"] },
  "sensevoice-int8": { id: "sense-voice-int8", dir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09", files: ["model.int8.onnx", "tokens.txt"] },
} as const;
type SharedId = keyof typeof PASEO_MODELS;
export function isPaseoModel(id: string): id is SharedId { return Object.hasOwn(PASEO_MODELS, id); }
export interface PaseoModelState {
  id: string; status: string; inUse: boolean; receivedBytes?: number; totalBytes?: number; error?: string;
}
interface ModelClient {
  listLocalSpeechModels(): Promise<PaseoModelState[]>;
  downloadLocalSpeechModel(id: string): Promise<void>;
  deleteLocalSpeechModel(id: string): Promise<void>;
  close(): Promise<void>;
}
export interface SharedProgress { downloaded: number; total: number | null; phase: string; error: string | null; }

async function config() {
  const value = JSON.parse(await readFile(paths.config, "utf8"));
  return value as { daemon?: { listen?: string }; providers?: { local?: { modelsDir?: string } } };
}
export async function paseoModelsDir(): Promise<string | null> {
  try {
    const value = process.env.PASEO_LOCAL_MODELS_DIR || (await config()).providers?.local?.modelsDir || paths.paseoModels;
    // The installed daemon passes this path through as-is. Guessing its cwd or expanding
    // a relative '~' differently would create a second cache. Disable sharing until resolved.
    return isAbsolute(value) ? value : null;
  } catch { return null; }
}
async function connect(): Promise<ModelClient> {
  const { createHostClient } = await import("@getpaseo/client/node");
  let address = (await config()).daemon?.listen ?? "127.0.0.1:6767";
  address = address.replace(/^0\.0\.0\.0:/, "127.0.0.1:").replace(/^\[::\]:/, "[::1]:");
  const client = createHostClient(address, {
    clientId: "voicekit-model-cache-" + randomUUID(), clientType: "cli", connectTimeoutMs: 3000,
    localCredential: async () => (await readFile(join(paths.home, "local-credential"), "utf8")).trim(),
    reconnect: { enabled: true },
  });
  try { await client.connect(); return client; }
  catch (error) { await client.close(); throw error; }
}
async function present(root: string, files: readonly string[]) {
  return (await Promise.all(files.map(async file => {
    try { const s = await stat(join(root, file)); return s.isFile() && s.size > 0; } catch { return false; }
  }))).every(Boolean);
}
async function digest(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Resolve existing ancestors too: a missing destination can sit under a symlink. */
async function physicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const absolute = resolve(path), parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await physicalPath(parent), relative(parent, absolute));
  }
}
function contains(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part === "" || (!part.startsWith(".." + sep) && part !== ".." && !isAbsolute(part));
}
async function independentDirectories(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([physicalPath(a), physicalPath(b)]);
  if (contains(left, right) || contains(right, left)) return false;
  const [sa, sb] = await Promise.all([stat(a), stat(b).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  })]);
  return !sb || sa.dev !== sb.dev || sa.ino !== sb.ino;
}

export class PaseoModels {
  private client: Promise<ModelClient> | null = null;
  private entries: PaseoModelState[] = [];
  private refreshed = 0;
  private refreshing: Promise<PaseoModelState[]> | null = null;
  private pending = new Map<string, Promise<void>>();
  private errors = new Map<string, string>();
  private lifetime = new AbortController();
  constructor(private options: {
    connect?: () => Promise<ModelClient>; root?: () => Promise<string | null>; localDir?: string;
    changed?: () => void; installed?: (id: string) => Promise<void>;
  } = {}) {}
  root() { return (this.options.root ?? paseoModelsDir)(); }
  private history(id: string) { return join(this.options.localDir ?? paths.models, ".paseo-shared-history", id); }
  private async mark(id: string) {
    const file = this.history(id);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, "Paseo is the canonical source; never re-adopt after deletion.\n", { flag: "wx", mode: 0o600 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  }
  private getClient() {
    if (!this.client) this.client = (this.options.connect ?? connect)().catch(error => { this.client = null; throw error; });
    return this.client;
  }
  async list(force = false): Promise<PaseoModelState[]> {
    if (!force && Date.now() - this.refreshed < 4000) return this.entries;
    if (!this.refreshing) this.refreshing = this.getClient().then(c => c.listLocalSpeechModels()).then(entries => {
      this.entries = entries; this.refreshed = Date.now();
      for (const id of Object.keys(PASEO_MODELS)) if (this.state(id)?.status === "installed") this.errors.delete(id);
      this.options.changed?.(); return entries;
    }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  state(id: string) { return isPaseoModel(id) ? this.entries.find(e => e.id === PASEO_MODELS[id].id) : undefined; }
  progress(): Record<string, SharedProgress> {
    const out: Record<string, SharedProgress> = {};
    for (const id of Object.keys(PASEO_MODELS)) {
      const s = this.state(id), error = this.errors.get(id) ?? s?.error;
      if (error || s?.status === "downloading" || s?.status === "extracting") out[id] = {
        downloaded: s?.receivedBytes ?? 0, total: s?.totalBytes ?? null,
        phase: s?.status === "extracting" ? "unpacking" : "downloading", error: error ?? null,
      };
    }
    return out;
  }
  /** Move private copies into the canonical cache; discard only verified duplicate weights. */
  async adopt() {
    const root = await this.root(), local = this.options.localDir ?? paths.models;
    if (!root) return;
    for (const [id, spec] of Object.entries(PASEO_MODELS)) {
      const privateCopy = join(local, spec.dir), target = join(root, spec.dir);
      const canonical = await present(target, spec.files);
      if (canonical) await this.mark(id);
      if (privateCopy === target || !(await present(privateCopy, spec.files))) continue;
      if (!canonical && await stat(this.history(id)).then(() => true).catch(() => false)) continue;
      if ((await lstat(privateCopy)).isSymbolicLink()) continue;
      // Equal spelling, parent aliases and nested roots are all the same ownership domain.
      if (!(await independentDirectories(privateCopy, target))) continue;
      await this.list(true);
      if (["downloading", "extracting"].includes(this.state(id)?.status ?? "")) continue;
      const archive = join(root, ".downloads", spec.dir + ".tar.bz2");
      if (await stat(archive).then(s => s.size > 0).catch(() => false)) continue;
      if (!(await present(target, spec.files))) {
        // Leave incomplete canonical artifacts to Paseo's downloader instead of replacing them.
        if (await lstat(target).then(() => true).catch(() => false)) continue;
        await this.mark(id);
        await mkdir(dirname(target), { recursive: true });
        try { await rename(privateCopy, target); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          const staged = target + ".voicekit-" + randomUUID();
          try { await cp(privateCopy, staged, { recursive: true, errorOnExist: true, force: false }); await rename(staged, target); }
          finally { await rm(staged, { recursive: true, force: true }); }
        }
      }
      if (await present(privateCopy, spec.files)) {
        const equal = (await Promise.all(spec.files.map(async file => (await digest(join(privateCopy, file))) === (await digest(join(target, file)))))).every(Boolean);
        if (equal && await independentDirectories(privateCopy, target)) {
          // Only these files were compared. Preserve unique metadata/sidecars in the old folder.
          for (const file of spec.files) await unlink(join(privateCopy, file));
          await rmdir(privateCopy).catch(error => {
            if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          });
        }
        else console.warn("[voice-kit] private/shared model files differ; retained private copy: " + id);
      }
      this.refreshed = 0;
    }
  }
  ensure(id: string): Promise<void> {
    if (!isPaseoModel(id)) return Promise.reject(new Error("Not a shared Paseo model: " + id));
    const existing = this.pending.get(id); if (existing) return existing;
    const task = (async () => {
      this.errors.delete(id);
      try {
        if (!(await this.root())) throw new Error("Paseo shared model directory is unavailable");
        await this.list(true);
        if (this.state(id)?.status !== "installed") await (await this.getClient()).downloadLocalSpeechModel(PASEO_MODELS[id].id);
        for (;;) {
          if (this.lifetime.signal.aborted) throw new Error("Shared model client closed");
          await this.list(true);
          const state = this.state(id);
          if (state?.status === "installed") break;
          if (!state || state.status === "failed" || state.status === "not_installed") throw new Error(state?.error ?? "Shared model download did not start: " + id);
          await delay(1000, undefined, { signal: this.lifetime.signal });
        }
        await this.adopt().catch(error => console.warn("[voice-kit] shared model duplicate cleanup deferred", error));
        // File installation succeeded even if the speech server is restarting meanwhile.
        await this.options.installed?.(id).catch(error => console.warn("[voice-kit] shared model recovery deferred", error));
      } catch (error) {
        if (!this.lifetime.signal.aborted) this.errors.set(id, error instanceof Error ? error.message : String(error));
        throw error;
      } finally { this.pending.delete(id); this.options.changed?.(); }
    })();
    this.pending.set(id, task); return task;
  }
  async remove(id: string) {
    if (!isPaseoModel(id)) throw new Error("Not a shared Paseo model: " + id);
    await this.list(true);
    if (this.state(id)?.inUse) throw new Error("Model is in use by Paseo; switch models first");
    if (this.pending.has(id) || ["downloading", "extracting"].includes(this.state(id)?.status ?? "")) throw new Error("Model download is in progress");
    await this.mark(id);
    await (await this.getClient()).deleteLocalSpeechModel(PASEO_MODELS[id].id);
    this.errors.delete(id); await this.list(true);
  }
  async dispose() {
    this.lifetime.abort(); // The daemon owns transfers; closing this client does not cancel them.
    const client = await this.client?.catch(() => null); await client?.close();
  }
}
