// Resident memory of this plugin process plus its speech server and owned model workers.
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { sampleWindowsMemory, type MemoryUsage } from "./windows-memory";
const exec = promisify(execFile);

/** ps RSS is KiB. Exclude the Paseo app, other plugins, agents and the sampler process. */
export function processTreeRss(output: string, root: number): number | null {
  const rows = new Map<number, { parent: number; bytes: number }>();
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3) continue;
    const [pid, parent, kib] = fields.map(Number);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parent) || parent < 0 || !Number.isFinite(kib) || kib < 0) continue;
    rows.set(pid, { parent, bytes: kib * 1024 });
  }
  if (!rows.has(root)) return null;
  const owned = new Set([root]);
  for (let changed = true; changed && owned.size <= 512;) {
    changed = false;
    for (const [pid, row] of rows) if (owned.has(row.parent) && !owned.has(pid)) { owned.add(pid); changed = true; }
  }
  if (owned.size > 512) return null;
  return [...owned].reduce((total, pid) => total + rows.get(pid)!.bytes, 0);
}

/** Process-wide PPid works for children spawned by any thread, without CONFIG_PROC_CHILDREN. */
export async function linuxProcessTreeRss(pid: number, proc = "/proc"): Promise<number | null> {
  const ids = (await readdir(proc)).filter(id => /^[1-9]\d*$/.test(id));
  if (ids.length > 8192) return null;
  const rows: string[] = [];
  let rootMeasured = false;
  for (let i = 0; i < ids.length; i += 64) {
    await Promise.all(ids.slice(i, i + 64).map(async id => {
      // Processes may exit during the snapshot. Unreadable entries are excluded.
      const status = await readFile(`${proc}/${id}/status`, "utf8").catch(() => "");
      const parent = /^PPid:\s+(\d+)$/m.exec(status);
      const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      if (!parent || !rss) return;
      if (Number(id) === pid) rootMeasured = true;
      rows.push(`${id} ${parent[1]} ${rss[1]}`);
    }));
  }
  return rootMeasured ? processTreeRss(rows.join("\n"), pid) : null;
}

async function serverRss(pid: number): Promise<number | null> {
  if (process.platform === "darwin") {
    const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,rss="], { timeout: 1000, maxBuffer: 2 * 1024 * 1024 });
    return processTreeRss(stdout, pid);
  }
  if (process.platform === "linux") {
    return linuxProcessTreeRss(pid);
  }
  return null;
}

export class MemorySampler {
  private cached: { pid: number | null; at: number; usage: MemoryUsage } | null = null;
  private pending: { pid: number | null; value: Promise<MemoryUsage> } | null = null;
  private generation = 0;
  constructor(private options: { read?: (pid: number) => Promise<number | null>; readUsage?: (pid: number | null) => Promise<MemoryUsage>; own?: () => number; now?: () => number } = {}) {}
  sample(pid: number | null): Promise<number | null> {
    return this.sampleUsage(pid).then(usage => usage.memoryBytes);
  }
  sampleUsage(pid: number | null): Promise<MemoryUsage> {
    const now = (this.options.now ?? Date.now)();
    if (this.cached?.pid === pid && now - this.cached.at < 10_000) return Promise.resolve(this.cached.usage);
    if (this.pending?.pid === pid) return this.pending.value;
    const generation = ++this.generation;
    const value = (async () => {
      const empty: MemoryUsage = { memoryBytes: null, gpuMemoryBytes: null, gpuSharedMemoryBytes: null, gpuMemorySource: null };
      let usage: MemoryUsage;
      if (this.options.readUsage) usage = await this.options.readUsage(pid).catch(() => empty);
      else if (process.platform === "win32" && !this.options.read) {
        const own = (this.options.own ?? (() => process.memoryUsage().rss))();
        usage = await sampleWindowsMemory(pid, process.pid, own).catch(() => ({ ...empty, memoryBytes: pid === null ? own : null }));
      } else {
        const speech = pid === null ? 0 : await (this.options.read ?? serverRss)(pid).catch(() => null);
        usage = { ...empty, memoryBytes: speech === null ? null : speech + (this.options.own ?? (() => process.memoryUsage().rss))() };
      }
      if (generation === this.generation) this.cached = { pid, at: now, usage };
      return usage;
    })().finally(() => { if (generation === this.generation) this.pending = null; });
    this.pending = { pid, value }; return value;
  }
}
