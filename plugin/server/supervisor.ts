import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { execCommand, spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { Engine, Phase, Notice } from "../shared/rpc";
import { resolveBinary, settleBinaryInstalls, RuntimeDownloadRequired, ServerVersionMismatch, type InstallProgress, type ResolvedBinary } from "./binary";
import { paths } from "./paths";
import { SERVER_VERSION } from "../shared/release";

export interface ServerConfig {
  binaryPath: string;
  port: number;
  sttModels: string[];
  ttsModel: string;
  voice: string;
  speed: number;
  language: string;
  /** Vocabulary hints for recognition engines that support them. */
  vocabulary: string;
  accelerator: "auto" | "cpu";
  autoDownload: boolean;
  /** SHA-256 of the server archive the user approved downloading, or "". */
  approvedServerArchive: string;
  idleUnloadMinutes: number;
  neuralEngine: boolean;
  /** Custom models catalog file, and a hash of its content (so edits restart the server). */
  catalogPath: string;
  catalogHash: string;
  sharedModelsDir: string | null;
}

export interface Health {
  ttsLastError?: import("../shared/rpc").TtsError | null;
  status: string;
  stt: Engine[];
  tts: Engine | null;
  downloads: Record<string, { downloaded: number; total?: number | null; phase: string; error?: string | null }>;
  coreml?: Record<string, { state: string; seconds?: number; error?: string } | null>;
  /** ggml compute backends and devices; null until the server has initialized them. */
  hardware?: Hardware | null;
}

export interface Device {
  name: string;
  description: string;
  type: "cpu" | "gpu" | "igpu" | "accel";
  backend: string;
  memoryFree?: number;
  memoryTotal?: number;
}

export interface Hardware {
  backends: string[];
  devices: Device[];
  backendDir?: string;
}

export interface SupervisorSnapshot {
  phase: Phase;
  message: string | null;
  /** The message as language-neutral data, when it is one the client can present itself. */
  notice: Notice | null;
  binary: ResolvedBinary | null;
  port: number | null;
  restarts: number;
  health: Health | null;
  install: InstallProgress | null;
}

const LOG_LINES = 300;
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 5 * 60_000;

function sameConfig(a: ServerConfig | null, b: ServerConfig | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: "127.0.0.1", exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Runs one voicekit process: install, spawn, health-check, restart with backoff. */
export class Supervisor {
  get childPid(): number | null { return this.child?.pid ?? null; }
  private config: ServerConfig | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private snapshot: SupervisorSnapshot = {
    phase: "disabled",
    message: null,
    notice: null,
    binary: null,
    port: null,
    restarts: 0,
    health: null,
    install: null,
  };
  private crashes: number[] = [];
  private healthFailures = 0;
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  private healthRequest: AbortController | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private operations: Promise<void> = Promise.resolve();
  private pidOperations: Promise<void> = Promise.resolve();
  private lifetime = new AbortController();
  private readonly logs: string[] = [];
  private runToken: string | null = null;
  /** How long a restart lets in-flight requests finish (SUP-5); shorter in tests. */
  private drainMs = 15_000;

  constructor(private readonly onChange: (snapshot: SupervisorSnapshot) => void) {}

  get state(): SupervisorSnapshot {
    return this.snapshot;
  }

  get baseUrl(): string | null {
    return this.snapshot.port ? `http://127.0.0.1:${this.snapshot.port}/v1` : null;
  }

  /** Token of the running server. A new one is minted for every start, so a token captured
   * while the port was briefly free (after a crash) is useless against the next server. */
  get token(): string | null {
    return this.child ? this.runToken : null;
  }

  logTail(): string[] {
    return [...this.logs];
  }

  /** Add a line to the server log shown in settings. */
  note(line: string) {
    this.log(line);
  }

  /**
   * Resolve (installing if needed) the binary a coming start will use, before the server runs:
   * The initial listening model selection may measure this machine with it first.
   * Shows install progress while nothing runs.
   */
  async prepareBinary(binaryPath: string, message: string | null = null, notice: Notice | null = null, approvedArchive = "", signal?: AbortSignal): Promise<ResolvedBinary> {
    // Leave the phase alone while a server runs or a crash restart is pending.
    const idle = !this.child && !this.restartTimer;
    if (idle) this.update({ phase: "installing", message, notice, install: null });
    const waiting = signal ?? this.lifetime.signal;
    const binary = await resolveBinary(binaryPath, (install) => idle && !waiting.aborted && !this.lifetime.signal.aborted && this.update({ install }), this.lifetime.signal, approvedArchive, waiting);
    if (idle && !waiting.aborted && !this.lifetime.signal.aborted) this.update({ install: null, binary });
    return binary;
  }

  private log(line: string) {
    this.logs.push(line);
    if (this.logs.length > LOG_LINES) this.logs.splice(0, this.logs.length - LOG_LINES);
  }

  private update(patch: Partial<SupervisorSnapshot>) {
    // A new message replaces the notice unless the caller gives one.
    if ("message" in patch && !("notice" in patch)) patch = { ...patch, notice: null };
    this.snapshot = { ...this.snapshot, ...patch };
    this.onChange(this.snapshot);
  }

  /** Apply a desired configuration. `null` stops the server. Restarts only when it changed. */
  private serialize(operation: () => Promise<void>): Promise<void> {
    // stopChild invalidates actual transitions. A no-op apply must leave the current
    // child's exit/health handlers valid so crash recovery continues to work.
    const next = this.operations.catch(() => undefined).then(operation);
    this.operations = next;
    return next;
  }

  apply(config: ServerConfig | null, forceRestart = false, signal?: AbortSignal): Promise<void> {
    return this.serialize(() => signal?.aborted ? Promise.resolve() : this.applyNow(config, forceRestart, signal));
  }

  private async applyNow(config: ServerConfig | null, forceRestart = false, signal?: AbortSignal): Promise<void> {
    if (!forceRestart && sameConfig(config, this.config) && (config === null || this.child || this.restartTimer)) return;
    this.config = config;
    this.crashes = [];
    await this.stopChild(config !== null);
    if (!config) {
      this.update({ phase: "disabled", message: null, port: null, health: null, install: null });
      return;
    }
    await this.start(signal);
  }

  restart(): Promise<void> {
    return this.serialize(async () => {
      this.crashes = [];
      await this.stopChild();
      if (this.config) await this.start();
    });
  }

  async dispose(): Promise<void> {
    this.lifetime.abort();
    await settleBinaryInstalls(this.lifetime.signal);
    await this.serialize(async () => {
      this.config = null;
      await this.stopChild();
      await this.pidOperations.catch(() => undefined);
      this.update({ phase: "disabled", message: null, port: null, health: null, install: null });
    });
  }

  private async start(waitSignal: AbortSignal = this.lifetime.signal): Promise<void> {
    const config = this.config;
    if (!config) return;
    const generation = ++this.generation;
    this.healthFailures = 0;
    this.healthRequest?.abort();
    this.healthRequest = null;
    const stale = () => generation !== this.generation || this.lifetime.signal.aborted;
    const cancelledBeforeSpawn = () => stale() || waitSignal.aborted;

    this.update({ phase: "installing", message: null, health: null, install: null });
    let binary: ResolvedBinary;
    try {
      binary = await resolveBinary(config.binaryPath, (install) => !cancelledBeforeSpawn() && this.update({ install }), this.lifetime.signal, config.approvedServerArchive, waitSignal);
    } catch (error) {
      if (cancelledBeforeSpawn()) return;
      this.update({ phase: "failed", message: error instanceof Error ? error.message : String(error), notice: startNotice(error), install: null });
      return;
    }
    if (cancelledBeforeSpawn()) return;

    await this.killOrphan();
    const port = (await portFree(config.port)) ? config.port : 0;
    await mkdir(paths.models, { recursive: true });
    if (cancelledBeforeSpawn()) return;
    const args = [
      "serve",
      "--port", String(port),
      "--models-dir", paths.models,
      "--reuse-dir", paths.paseoModels,
      "--paseo-model-manager",
      "--stt-model", config.sttModels.join(","),
      "--tts-model", config.ttsModel,
      "--voice", config.voice,
      "--speed", String(config.speed),
      "--language", config.language,
      "--accelerator", config.accelerator,
      "--idle-unload-mins", String(config.idleUnloadMinutes),
      "--catalog", config.catalogPath,
      "--coreml", String(config.neuralEngine),
      "--exit-on-stdin-eof",
    ];
    if (config.autoDownload) args.push("--auto-pull");
    if (config.sharedModelsDir) args.push("--shared-models-dir", config.sharedModelsDir);
    if (config.vocabulary.trim()) args.push("--stt-prompt", config.vocabulary.trim());

    this.update({ phase: "starting", binary, install: null, message: port === 0 ? `Port ${config.port} is busy; using a free port.` : null, notice: port === 0 ? { code: "portBusy", port: config.port } : null });
    this.log(`[voice-kit] starting ${binary.path} (${binary.source}) on port ${port || "auto"}`);
    const token = `vk_${randomBytes(24).toString("base64url")}`;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(binary.path, args, {
        stdio: "pipe",
        env: { ...process.env, VOICEKIT_TOKEN: token, VOICEKIT_LOG: "info" },
      });
    } catch (error) {
      this.log(`[voice-kit] spawn error: ${String(error)}`);
      if (!stale()) this.onCrash(String(error));
      return;
    }
    this.child = child;
    this.runToken = token;
    let finished = false;
    const finish = (exit: string) => {
      if (finished) return;
      finished = true;
      if (this.child !== child) return;
      this.child = null;
      this.healthRequest?.abort();
      this.healthRequest = null;
      this.clearHealth();
      void this.clearPidFile(child.pid);
      if (stale() || !this.config) return;
      this.log(`[voice-kit] voicekit stopped (${exit})`);
      this.onCrash(exit);
    };
    // Register before any await: even an immediate exec failure or exit must be observed.
    child.on("error", (error) => {
      this.log(`[voice-kit] spawn error: ${error.message}`);
      if (!child.pid) finish(error.message);
      else if (this.child === child && !finished) {
        // A post-spawn process error must not leave a live predecessor behind a replacement.
        void terminateProcess(child, "SIGKILL").catch(killError => {
          if (this.child === child) this.update({ phase: "failed", message: String(killError), health: null });
        });
      }
    });
    child.on("exit", (code, signal) => finish(`${code ?? "none"}${signal ? `, ${signal}` : ""}`));
    child.on("close", (code, signal) => finish(`${code ?? "none"}${signal ? `, ${signal}` : ""}`));

    let stdoutBuf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as { event?: string; port?: number };
          if (event.event === "listening" && typeof event.port === "number" && !stale() && !finished && this.child === child) {
            this.update({ port: event.port, phase: "loading" });
            this.scheduleHealth(250);
          }
        } catch {
          this.log(line);
        }
      }
    });
    let stderrBuf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
      let nl: number;
      while ((nl = stderrBuf.indexOf("\n")) >= 0) {
        const line = stderrBuf.slice(0, nl).trimEnd();
        stderrBuf = stderrBuf.slice(nl + 1);
        if (!line) continue;
        this.log(compactLogLine(line));
        if (/"level":"(ERROR|WARN)"/.test(line)) console.error(`[voicekit] ${compactLogLine(line)}`);
      }
    });
    if (child.pid) {
      await this.withPidFile(async () => {
        if (!finished && this.child === child) await writeFile(paths.pidFile, String(child.pid));
      }).catch(() => undefined);
      if (finished || this.child !== child) await this.clearPidFile(child.pid);
    }
  }

  private async clearPidFile(pid: number | undefined): Promise<void> {
    if (!pid) return;
    await this.withPidFile(async () => {
      try {
        if ((await readFile(paths.pidFile, "utf8")).trim() === String(pid)) await rm(paths.pidFile, { force: true });
      } catch { /* Already removed. */ }
    });
  }

  private withPidFile(operation: () => Promise<void>): Promise<void> {
    const next = this.pidOperations.catch(() => undefined).then(operation);
    this.pidOperations = next;
    return next;
  }

  private onCrash(exit: string) {
    const reason = `The speech server stopped unexpectedly (exit code ${exit})`;
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (this.crashes.length >= MAX_CRASHES) {
      this.update({
        phase: "failed",
        message: `${reason}. Gave up after ${MAX_CRASHES} crashes in 5 minutes.`,
        notice: { code: "crashGaveUp", exit, crashes: MAX_CRASHES },
        health: null,
        port: null,
      });
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** (this.crashes.length - 1));
    const seconds = Math.round(delay / 1000);
    this.update({
      phase: "restarting",
      message: `${reason}. Restarting in ${seconds}s.`,
      notice: { code: "crashRestarting", exit, seconds },
      health: null,
      restarts: this.snapshot.restarts + 1,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, delay);
  }

  private scheduleHealth(ms: number) {
    this.clearHealth();
    this.healthTimer = setTimeout(() => void this.checkHealth(), ms);
  }

  private clearHealth() {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = null;
  }

  private async checkHealth(): Promise<void> {
    const generation = this.generation;
    const child = this.child;
    const port = this.snapshot.port;
    const token = this.token;
    const stale = () => this.lifetime.signal.aborted || generation !== this.generation || child !== this.child;
    if (!child || !port || !token || stale()) return;
    const request = new AbortController();
    this.healthRequest?.abort();
    this.healthRequest = request;
    const timer = setTimeout(() => request.abort(), 3000);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/voicekit/status`, {
        headers: { authorization: `Bearer ${token}` },
        signal: request.signal,
      });
      if (stale() || this.healthRequest !== request) return;
      if (!response.ok) throw new Error(`status ${response.status}`);
      const health = (await response.json()) as Health;
      if (stale() || this.healthRequest !== request) return;
      const phase: Phase =
        health.status === "ready" ? "ready" : health.status === "degraded" ? "degraded" : health.status === "failed" ? "failed" : "loading";
      const message = phase === "failed" ? firstError(health) : null;
      this.healthFailures = 0;
      this.update({ health, phase, message });
      this.scheduleHealth(phase === "ready" ? 5000 : 1000);
    } catch (error) {
      if (stale() || this.healthRequest !== request) return;
      // One slow answer is not an outage. After two misses in a row treat the server as
      // unhealthy so Paseo falls back to built-in speech, and keep probing.
      this.healthFailures++;
      if (this.healthFailures >= 2) {
        const detail = error instanceof Error ? error.message : String(error);
        this.update({ phase: "degraded", message: `Health check failed: ${detail}`, notice: { code: "healthCheckFailed", error: detail }, health: null });
      }
      this.scheduleHealth(this.healthFailures >= 2 ? 2000 : 500);
    } finally {
      clearTimeout(timer);
      if (this.healthRequest === request) this.healthRequest = null;
    }
  }

  private async stopChild(drain = false): Promise<void> {
    this.generation++;
    this.healthRequest?.abort();
    this.healthRequest = null;
    this.healthFailures = 0;
    this.clearHealth();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    this.snapshot = { ...this.snapshot, port: null, health: null };
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    if(drain)this.update({phase:"restarting",message:null,health:null,port:null});
    child.stdin.end(); // voicekit exits on stdin EOF (works on every OS)
    if (process.platform !== "win32") child.kill("SIGTERM");
    // Paseo may end this plugin process soon after cleanup starts, so do not wait long.
    // Configuration updates let current requests finish for at most 15 s (usually far less:
    // the server exits as soon as nothing is in flight), then the old server is stopped.
    // Cleanup still stays short because Paseo can end a plugin subprocess immediately.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer=setTimeout(() => resolve("timeout"), drain ? this.drainMs : 1500); });
    const result=await Promise.race([exited, timeout]);
    if(timer)clearTimeout(timer);
    if (result === "timeout") {
      await terminateProcess(child, "SIGKILL").catch(() => undefined);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
    }
    await this.clearPidFile(child.pid);
  }

  /** A voicekit left behind by a crashed plugin process would hold the port. */
  /**
   * Stop servers left behind by an earlier plugin process (e.g. Paseo ended it before cleanup
   * finished). Matches every voicekit serving this plugin's models folder, not just the last
   * pid file, and force-kills ones that do not exit (a server stuck in a model load).
   */
  private async killOrphan(): Promise<void> {
    const pids = new Set<number>();
    try {
      const pid = Number((await readFile(paths.pidFile, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 1 && pidAlive(pid) && (await looksLikeVoicekit(pid))) pids.add(pid);
    } catch {
      // No pid file.
    }
    for (const pid of await findOurServers()) pids.add(pid);
    pids.delete(process.pid);
    if (this.child?.pid) pids.delete(this.child.pid);
    for (const pid of pids) {
      this.log("[voice-kit] stopping leftover voicekit (pid " + pid + ")");
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        continue;
      }
      for (let i = 0; i < 10 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      if (pidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    await rm(paths.pidFile, { force: true }).catch(() => undefined);
  }
}

/** Every `voicekit.exe` with its pid and command line, one per line (Windows has no `ps`). */
const WINDOWS_PROCESS_LIST =
  "Get-CimInstance Win32_Process -Filter \"Name='voicekit.exe'\" | ForEach-Object { [string]$_.ProcessId + ' ' + $_.CommandLine }";

/** voicekit servers (any binary) started for this plugin's models folder. */
async function findOurServers(): Promise<number[]> {
  try {
    const options = { timeout: 10_000, shell: false, maxBuffer: 8 * 1024 * 1024 };
    const windows = process.platform === "win32";
    const { stdout } = windows
      ? await execCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_LIST], options)
      : await execCommand("ps", ["-axo", "pid=,command="], options);
    return ourServerPids(stdout, paths.models, windows);
  } catch {
    return [];
  }
}

/**
 * Pids in a "<pid> <command line>" listing that run `voicekit serve` for `modelsDir`. Windows
 * command lines can quote the executable and the folder, and its paths compare without case.
 */
export function ourServerPids(listing: string, modelsDir: string, windows = false): number[] {
  const fold = (text: string) => (windows ? text.toLowerCase() : text);
  const markers = [`--models-dir ${modelsDir}`, `--models-dir "${modelsDir}"`].map(fold);
  const pids: number[] = [];
  for (const raw of listing.split(/\r?\n/)) {
    const match = /^(\d+)\s+(.*)$/.exec(raw.trim());
    if (!match) continue;
    const [, pid, command] = match;
    if (!/voicekit(\.exe)?"?\s+serve\s/i.test(command)) continue;
    // The folder must end there: "--models-dir /a/models" is not "--models-dir /a/models-old".
    const folded = fold(command);
    const endsAt = (marker: string, from: number): boolean => {
      const at = folded.indexOf(marker, from);
      return at >= 0 && (/\s/.test(folded[at + marker.length] ?? " ") || endsAt(marker, at + 1));
    };
    if (!markers.some((marker) => endsAt(marker, 0))) continue;
    const value = Number(pid);
    if (Number.isInteger(value) && value > 1) pids.push(value);
  }
  return pids;
}

/**
 * Guard against pid reuse: only signal a process that is actually voicekit. On Windows the full
 * scan in `findOurServers` covers the pid file's server, so the pid file alone is not trusted.
 */
async function looksLikeVoicekit(pid: number): Promise<boolean> {
  if (process.platform === "win32") return false;
  try {
    const { stdout } = await execCommand("ps", ["-p", String(pid), "-o", "comm="], { timeout: 3000, shell: false });
    return /voicekit/.test(stdout);
  } catch {
    return false;
  }
}

/** Startup errors the client presents itself: download approval and a server of another version. */
function startNotice(error: unknown): Notice | null {
  if (error instanceof RuntimeDownloadRequired) return { code: "runtimeDownloadRequired", url: error.url, sha256: error.sha256, version: error.version };
  if (error instanceof ServerVersionMismatch) return { code: "serverVersionMismatch", version: error.found ?? undefined, required: SERVER_VERSION, source: error.source };
  return null;
}

function firstError(health: Health): string | null {
  for (const e of [...health.stt, ...(health.tts ? [health.tts] : [])]) if (e.error) return `${e.model}: ${e.error}`;
  return null;
}

/** Turn voicekit's JSON log lines into short readable lines for the settings log view. */
function compactLogLine(line: string): string {
  try {
    const entry = JSON.parse(line) as { timestamp?: string; level?: string; fields?: Record<string, unknown> };
    const { message, ...rest } = entry.fields ?? {};
    const time = entry.timestamp?.slice(11, 19) ?? "";
    const extra = Object.entries(rest)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    return `${time} ${entry.level ?? ""} ${message ?? ""} ${extra}`.trim();
  } catch {
    return line;
  }
}
