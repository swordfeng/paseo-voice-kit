import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { release } from "node:os";
import type { MlxRuntime } from "../shared/rpc";

interface Options {
  binary: () => string | null;
  supported?: () => boolean;
  exists?: (path: string) => Promise<boolean>;
  manifest?: (path: string) => Promise<unknown>;
  worker?: string;
}

/** Availability is a filesystem check: never launch a worker or load a model here. */
export class MlxRuntimeMonitor {
  constructor(private readonly options: Options) {}
  async status(): Promise<MlxRuntime> {
    const binary = this.options.binary();
    const override = this.options.worker ?? process.env.VOICEKIT_MLX_WORKER;
    const path = override ? dirname(override) : binary ? join(dirname(binary), "mlx-runtime") : "";
    const worker = override || join(path, "voicekit-mlx-worker");
    const result: MlxRuntime = { phase: "unavailable", reason: "runtimeRequired", path, worker: null, error: null };
    const supported = this.options.supported?.() ?? (process.platform === "darwin" && process.arch === "arm64" && Number(release().split(".")[0]) >= 23);
    if (!supported) return { ...result, reason: "platform" };
    if (!binary && !override) return result;
    const exists = this.options.exists ?? (async (file: string) => {
      try {
        await access(file, constants.R_OK | (file === worker ? constants.X_OK : 0));
        return (await stat(file)).isFile();
      } catch { return false; }
    });
    try {
      const data = this.options.manifest ? await this.options.manifest(join(path, "runtime.json"))
        : JSON.parse(await readFile(join(path, "runtime.json"), "utf8"));
      const manifest = data as { backend?: unknown; protocol?: unknown; files?: unknown };
      if (manifest?.backend !== "swift-mlx" || manifest.protocol !== 1 || !Array.isArray(manifest.files)) return result;
      const files = manifest.files;
      if (!files.includes("voicekit-mlx-worker") || !files.includes("mlx.metallib")) return result;
      if (!(await exists(worker))) return result;
      for (const file of files) {
        if (typeof file !== "string" || isAbsolute(file) || file.split(/[\\/]/).includes("..") || !(await exists(join(path, file)))) return result;
      }
      return { ...result, phase: "ready", reason: null, worker };
    } catch { return result; }
  }
}
