import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, release } from "node:os";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execCommand, spawnProcess } from "@getpaseo/plugin/server";
import type { MlxRuntime } from "../shared/rpc";
import { paths } from "./paths";

const CHECK = 'import sys; assert sys.version_info[:2] == (3,12), "Python 3.12 is required"; import mlx.core as mx; import mlx_audio; assert mx.metal.is_available(), "Metal GPU unavailable"';
const PYTHON = 'import sys; assert sys.version_info[:2] == (3,12), "Python 3.12 is required"; print(sys.executable)';
type Run = (script: string, python: string, line: (line: string) => void, signal: AbortSignal) => Promise<void>;

interface Options {
  binary: () => string | null;
  installed?: () => void;
  supported?: () => boolean;
  exists?: (path: string) => Promise<boolean>;
  check?: (python: string, runtime: boolean) => Promise<string>;
  run?: Run;
  now?: () => number;
  python?: string;
  external?: string;
  data?: string;
}

/** One explicit setup job per plugin, independent of preference changes and speech requests. */
export class MlxRuntimeInstaller {
  private readonly options: Options;
  private readonly lifetime = new AbortController();
  private job: Promise<void> | null = null;
  private checking: Promise<MlxRuntime> | null = null;
  private checkedAt = -Infinity;
  private snapshot: MlxRuntime;
  private script: string | null = null;
  constructor(options: Options) {
    this.options = options;
    this.snapshot = { phase: "missing", reason: null, path: join(options.data ?? paths.data, "runtime/qwen"), python: null, error: null, lines: [] };
  }
  private exists(path: string) {
    return this.options.exists ? this.options.exists(path) : access(path, constants.R_OK).then(() => true, () => false);
  }
  private async check(python: string, runtime: boolean): Promise<string> {
    if (this.options.check) return this.options.check(python, runtime);
    const result = await execCommand(python, ["-I", "-c", runtime ? CHECK : PYTHON], { shell: false, timeout: 15_000, maxBuffer: 64 * 1024 });
    return result.stdout.trim();
  }
  async status(force = false): Promise<MlxRuntime> {
    if (this.job) return this.copy();
    const now = this.options.now?.() ?? Date.now();
    if (!force && now - this.checkedAt < 30_000) return this.copy();
    if (this.checking) return this.checking;
    this.checking = this.inspect().then(() => { this.checkedAt = now; return this.copy(); }).finally(() => { this.checking = null; });
    return this.checking;
  }
  private async inspect() {
    this.script = null;
    const supported = this.options.supported?.() ?? (process.platform === "darwin" && process.arch === "arm64" && Number(release().split(".")[0]) >= 23);
    if (!supported) { this.set("unavailable", "platform", null); return; }
    const external = this.options.external ?? process.env.VOICEKIT_MLX_PYTHON;
    const runtimePython = external || join(this.snapshot.path, "bin/python");
    if (await this.exists(runtimePython)) {
      try { await this.check(runtimePython, true); this.snapshot.python = runtimePython; this.set("ready", null, null); return; }
      catch (error) { if (external) { this.set("unavailable", "externalRuntime", diagnostic(error)); return; } }
    } else if (external) { this.set("unavailable", "externalRuntime", `Python executable not found: ${external}`); return; }
    try {
      this.snapshot.python = await this.setupPython();
    } catch (error) { this.snapshot.python = null; this.set("unavailable", "pythonRequired", diagnostic(error)); return; }
    const binary = this.options.binary();
    const script = binary ? join(dirname(binary), "qwen-runtime/install-qwen-runtime.sh") : null;
    if (!script || !(await this.exists(script)) || !(await this.exists(join(dirname(script), "qwen-requirements.txt"))) || !(await this.exists(join(dirname(script), "qwen-build-requirements.txt")))) {
      this.set("unavailable", "runtimeRequired", null); return;
    }
    this.script = script;
    if (this.snapshot.phase !== "failed") this.set("missing", null, null);
  }
  private async setupPython(): Promise<string> {
    const specified = this.options.python ?? process.env.VOICEKIT_SETUP_PYTHON;
    if (specified) return this.check(specified, false);
    // Desktop daemons often lack Homebrew or uv-managed Python on PATH. Discover existing
    // interpreters only: never invoke uv's automatic download/bootstrap from a status request.
    const candidates = ["python3.12", "/opt/homebrew/bin/python3.12", "/usr/local/bin/python3.12"];
    const root = process.env.UV_PYTHON_INSTALL_DIR || join(homedir(), ".local/share/uv/python");
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    candidates.push(...entries.filter(e => (e.isDirectory() || e.isSymbolicLink()) && /^cpython-3\.12\.\d+-macos-aarch64-none$/.test(e.name))
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })).map(e => join(root, e.name, "bin/python3.12")));
    for (const python of candidates) {
      try { return await this.check(python, false); } catch { /* Try the next existing installation. */ }
    }
    throw new Error("Python 3.12 was not found. Install it or set VOICEKIT_SETUP_PYTHON to its executable.");
  }
  /** `confirmed` is also enforced as literal true by the RPC input contract. */
  async install(confirmed: boolean): Promise<MlxRuntime> {
    if (!confirmed) throw new Error("MLX runtime installation requires confirmation");
    if (this.lifetime.signal.aborted) throw new Error("Voice Kit is stopping");
    if (this.job) return this.copy();
    // Serialize the short prerequisite check with parallel install clicks too.
    await this.status(true);
    if (this.lifetime.signal.aborted) throw new Error("Voice Kit is stopping");
    if (this.job) return this.copy();
    if (this.snapshot.phase === "ready" || this.snapshot.phase === "unavailable") return this.copy();
    if (!this.script || !this.snapshot.python) throw new Error("MLX setup prerequisites are missing");
    const script = this.script, python = this.snapshot.python;
    this.snapshot.lines = [];
    this.set("installing", null, null);
    this.job = (async () => {
      try {
        await (this.options.run ?? runInstaller)(script, python, line => this.log(line), this.lifetime.signal);
        await this.check(join(this.snapshot.path, "bin/python"), true);
        if (this.lifetime.signal.aborted) return;
        this.snapshot.python = join(this.snapshot.path, "bin/python");
        this.set("ready", null, null);
        this.options.installed?.();
      } catch (error) { if (!this.lifetime.signal.aborted) this.set("failed", null, diagnostic(error)); }
      finally { this.checkedAt = this.options.now?.() ?? Date.now(); this.job = null; }
    })();
    return this.copy();
  }
  private set(phase: MlxRuntime["phase"], reason: MlxRuntime["reason"], error: string | null) {
    this.snapshot = { ...this.snapshot, phase, reason, error };
  }
  private log(line: string) {
    this.snapshot.lines.push(line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").slice(-600));
    if (this.snapshot.lines.length > 60) this.snapshot.lines.shift();
  }
  private copy(): MlxRuntime { return { ...this.snapshot, lines: [...this.snapshot.lines] }; }
  async dispose() { this.lifetime.abort(); await this.job; }
}

function diagnostic(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(-2000); }

/** Isolate the install's process group so pip/build children cannot outlive plugin cleanup. */
export async function runInstaller(script: string, python: string, line: (line: string) => void, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("MLX runtime installation cancelled");
  // Keep shell/user pip configuration from redirecting the install outside this environment.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PIP_") && !key.startsWith("PYTHON")));
  const child: ChildProcessWithoutNullStreams = spawnProcess("/bin/bash", [script], {
    stdio: "pipe", detached: true, cwd: dirname(script),
    env: { ...inherited, PASEO_HOME: paths.home, VOICEKIT_SETUP_PYTHON: python,
      PIP_CONFIG_FILE: "/dev/null", PIP_INDEX_URL: "https://pypi.org/simple", PIP_EXTRA_INDEX_URL: "", PIP_FIND_LINKS: "", PIP_TRUSTED_HOST: "", PIP_NO_INPUT: "1", PYTHONNOUSERSITE: "1" },
  });
  child.stdin.end();
  const stop = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => { if (settled) return; settled = true; error ? reject(error) : resolve(); };
      child.once("error", error => finish(error));
      child.once("close", (code, sig) => finish(code === 0 ? undefined : new Error(`MLX installer stopped (${sig ?? code}). Check installation output.`)));
      for (const stream of [child.stdout, child.stderr]) {
        let pending = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          pending += chunk;
          const lines = pending.split(/[\r\n]/); pending = lines.pop()!.slice(-4096);
          for (const value of lines) if (value.trim()) line(value);
        });
        stream.on("end", () => { if (pending.trim()) line(pending); });
      }
      timer = setTimeout(() => { stop(); finish(new Error("MLX runtime installation timed out after 15 minutes")); }, 15 * 60_000);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    stop();
  }
}
