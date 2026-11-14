import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, constants, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execCommand } from "@getpaseo/plugin/server";
import { RELEASE, platformKey } from "../shared/release";
import { EXE, paths } from "./paths";
import { extractTarGz } from "./untar";

export interface ResolvedBinary {
  path: string;
  source: "setting" | "local" | "release";
  version: string | null;
}

export interface InstallProgress {
  downloaded: number;
  total: number | null;
}

export class RuntimeDownloadRequired extends Error {
  constructor(readonly url: string) {
    super("Confirm installation of the Voice Kit speech server before downloading it.");
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("Runtime resolution cancelled"), { name: "AbortError" });
}

/** Cancels this caller's wait, without cancelling an installation another revision needs. */
async function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  cancelled(signal);
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(Object.assign(new Error("Runtime resolution cancelled"), { name: "AbortError" }));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([promise, interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}

async function versionOf(path: string, signal: AbortSignal): Promise<string | null> {
  try {
    const { stdout } = await execCommand(path, ["--version"], { timeout: 5000, shell: false, signal });
    return stdout.trim().replace(/^voicekit\s+/, "") || null;
  } catch {
    cancelled(signal);
    return null;
  }
}

/**
 * Find a usable voicekit binary, installing the release build when needed. Order:
 * the "Binary path" setting, a local development build (scripts/dev-install.sh), then the
 * pinned release for this platform.
 */
export async function resolveBinary(
  binaryPath: string,
  onProgress: (p: InstallProgress) => void,
  signal: AbortSignal,
  allowDownload = false,
  waitSignal: AbortSignal = signal,
): Promise<ResolvedBinary> {
  cancelled(signal);
  cancelled(waitSignal);
  // One install at a time: concurrent callers share it (they would write the same files).
  const key = JSON.stringify([binaryPath.trim(), allowDownload]);
  let running = inflight.get(key);
  if (running?.signal.aborted) {
    // Its staging cleanup must finish before a replacement touches the same paths.
    await waitFor(running.promise.catch(() => undefined), waitSignal);
    return resolveBinary(binaryPath, onProgress, signal, allowDownload, waitSignal);
  }
  if (!running) {
    const listeners = new Set<(p: InstallProgress) => void>();
    const entry: Installation = { signal, listeners, promise: Promise.resolve(null as never) };
    entry.promise = findOrInstall(binaryPath, progress => {
      entry.progress = progress;
      for (const listener of listeners) listener(progress);
    }, signal, allowDownload).finally(() => {
      if (inflight.get(key) === entry) inflight.delete(key);
      listeners.clear();
    });
    running = entry;
    inflight.set(key, entry);
  }
  running.listeners.add(onProgress);
  if (running.progress) onProgress(running.progress);
  try { return await waitFor(running.promise, waitSignal); }
  finally { running.listeners.delete(onProgress); }
}

interface Installation {
  signal: AbortSignal;
  listeners: Set<(p: InstallProgress) => void>;
  progress?: InstallProgress;
  promise: Promise<ResolvedBinary>;
}
const inflight = new Map<string, Installation>();

/** Called after the owner's lifetime aborts, so staging cleanup finishes before plugin exit. */
export async function settleBinaryInstalls(signal: AbortSignal): Promise<void> {
  await Promise.allSettled([...inflight.values()].filter(entry => entry.signal === signal).map(entry => entry.promise));
}

async function findOrInstall(
  binaryPath: string,
  onProgress: (p: InstallProgress) => void,
  signal: AbortSignal,
  allowDownload: boolean,
): Promise<ResolvedBinary> {
  const custom = binaryPath.trim();
  if (custom) {
    if (!(await isExecutable(custom))) throw new Error(`Binary path is not an executable file: ${custom}`);
    return { path: custom, source: "setting", version: await versionOf(custom, signal) };
  }

  const local = join(paths.bin, "local", EXE);
  if (await isExecutable(local)) return { path: local, source: "local", version: await versionOf(local, signal) };

  const key = platformKey(process.platform, process.arch);
  const asset = RELEASE.assets[key];
  const versionDir = join(paths.bin, RELEASE.version);
  if (!asset) {
    throw new Error(
      `No voicekit ${RELEASE.version} build is published for ${key} yet. Build one with scripts/dev-install.sh or set Binary path.`,
    );
  }
  const release = join(versionDir, ...asset.exe.split("/"));
  if (await isExecutable(release)) return { path: release, source: "release", version: RELEASE.version };
  if (!allowDownload) throw new RuntimeDownloadRequired(asset.url);
  await installArchive(asset.url, asset.sha256, versionDir, onProgress, signal);
  if (!(await isExecutable(release))) throw new Error(`The voicekit archive did not contain ${asset.exe}`);
  return { path: release, source: "release", version: RELEASE.version };
}

/**
 * Download and verify a .tar.gz, unpack it into a staging folder, then move that into place as
 * `versionDir`, so a half-extracted folder is never mistaken for an install.
 */
async function installArchive(
  url: string,
  sha256: string,
  versionDir: string,
  onProgress: (p: InstallProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  await mkdir(paths.bin, { recursive: true });
  const part = `${versionDir}.tar.gz.part`;
  const staging = `${versionDir}.staging-${process.pid}`;
  try {
    await downloadVerified(url, sha256, part, onProgress, signal);
    cancelled(signal);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await extractTarGz(part, staging);
    cancelled(signal);
    await rm(versionDir, { recursive: true, force: true });
    await rename(staging, versionDir);
  } finally {
    await rm(part, { force: true }).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Download `url` to `part`, failing (and deleting it) unless its SHA-256 matches. */
async function downloadVerified(
  url: string,
  sha256: string,
  part: string,
  onProgress: (p: InstallProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`);
  const total = Number(response.headers.get("content-length")) || null;
  let downloaded = 0;
  const hash = createHash("sha256");
  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => {
    downloaded += chunk.length;
    hash.update(chunk);
    onProgress({ downloaded, total });
  });
  await pipeline(body, createWriteStream(part), { signal });
  const digest = hash.digest("hex");
  if (digest !== sha256) {
    await rm(part, { force: true });
    throw new Error(`Checksum mismatch for voicekit download (expected ${sha256}, got ${digest})`);
  }
}
