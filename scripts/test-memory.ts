import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySampler, processTreeRss, linuxProcessTreeRss } from "../plugin/server/memory";
import { windowsMemoryUsage } from "../plugin/server/windows-memory";

const born = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
const winProcesses = [
  { pid: 0, parent: 0, bytes: 0, born: null },
  { pid: 5, parent: 1, bytes: 999999, born: born(0) }, // plugin: measured directly, once
  { pid: 10, parent: 5, bytes: "100", born: born(1) },
  { pid: 11, parent: 10, bytes: 200, born: born(2) },
  { pid: 12, parent: 11, bytes: 300, born: born(3) },
  { pid: 20, parent: 5, bytes: 900000, born: born(4) }, // sampler: must be excluded
  { pid: 30, parent: 1, bytes: 900000, born: born(0) }, // unrelated app
  { pid: 40, parent: 10, bytes: 900000, born: born(0) }, // stale parent PID, older child
];
const gpu = (id: number, dedicated: unknown, shared: unknown, adapter = "01") => ({ name: `pid_${id}_luid_0x00000000_0x${adapter}_phys_0`, dedicated, shared });
const winGpu = [gpu(5, 1, 2), gpu(10, 3, 4), gpu(11, 8 * 1024 ** 3, 6), gpu(11, 7, 8, "02"), gpu(12, 9, 10), gpu(20, 999, 999), gpu(30, 999, 999), gpu(40, 999, 999), { name: "_Total", dedicated: 9999999, shared: 9999999 }];
const win = (processes = winProcesses, counters: unknown = winGpu, root: number | null = 10) => windowsMemoryUsage(JSON.stringify({ processes, gpu: counters }), root, 5, 2048);
assert.deepEqual(win(), { memoryBytes: 2648, gpuMemoryBytes: 8 * 1024 ** 3 + 20, gpuSharedMemoryBytes: 30, gpuMemorySource: "windows-process-counters" });
assert.equal(win(winProcesses, [...winGpu, winGpu[0]]).gpuMemoryBytes, win().gpuMemoryBytes, "duplicate instances do not count twice");
assert.equal(win(winProcesses, [...winGpu, gpu(10, 100, 4)]).gpuMemoryBytes, null, "conflicting duplicates are not a plausible total");
assert.equal(win(winProcesses, null).memoryBytes, 2648, "missing GPU provider preserves Windows RAM");
assert.equal(win(winProcesses, null).gpuMemoryBytes, null, "unknown is not zero");
assert.equal(win(winProcesses, []).gpuMemoryBytes, 0, "successful empty GPU snapshot is zero");
assert.equal(win(winProcesses, [gpu(10, "N/A", 15)]).gpuMemoryBytes, null);
assert.equal(win(winProcesses, [gpu(10, "N/A", 15)]).gpuSharedMemoryBytes, 15);
assert.equal(win(winProcesses, [gpu(10, Number.MAX_SAFE_INTEGER + 1, 0)]).gpuMemoryBytes, null);
assert.equal(win(winProcesses, [gpu(10, Number.MAX_SAFE_INTEGER, 0), gpu(11, 1, 0)]).gpuMemoryBytes, null);
assert.equal(win(winProcesses.filter(p => p.pid !== 10)).memoryBytes, null, "exited server cannot report a partial total");
assert.equal(win(winProcesses.map(p => p.pid === 11 ? { ...p, bytes: -1 } : p)).memoryBytes, null);
assert.equal(win(winProcesses, winGpu, null).memoryBytes, 2048);
assert.equal(win(winProcesses, winGpu, null).gpuMemoryBytes, 1, "plugin-only sampling excludes its other children");
assert.equal(win(winProcesses, winGpu, 5).memoryBytes, 2048, "never include the sampler through the plugin root");

const processes = "1 0 9000\n10 1 100\n11 10 200\n12 11 300\n20 1 4000\ninvalid\n30 10 -3\n";
assert.equal(processTreeRss(processes, 10), 600 * 1024);
assert.equal(processTreeRss(processes, 99), null);
const proc = await mkdtemp(join(tmpdir(), "vk-proc-"));
try {
  for (const [pid, parent, rss] of [[10, 1, 100], [11, 10, 200], [12, 11, 300], [20, 1, 4000]]) {
    await mkdir(join(proc, String(pid)));
    await writeFile(join(proc, String(pid), "status"), `Name:\tfixture\nPPid:\t${parent}\nVmRSS:\t${rss} kB\n`);
  }
  // Worker 11 is spawned from task 15; the main task's children file is empty.
  await mkdir(join(proc, "10/task/10"), { recursive: true });
  await mkdir(join(proc, "10/task/15"), { recursive: true });
  await writeFile(join(proc, "10/task/10/children"), "");
  await writeFile(join(proc, "10/task/15/children"), "11 ");
  assert.equal(await linuxProcessTreeRss(10, proc), 600 * 1024, "include non-main-thread workers and descendants");
  await rm(join(proc, "10/task"), { recursive: true });
  assert.equal(await linuxProcessTreeRss(10, proc), 600 * 1024, "work without CONFIG_PROC_CHILDREN");
  assert.equal(await linuxProcessTreeRss(99, proc), null, "missing root is not a partial total");
} finally { await rm(proc, { recursive: true, force: true }); }
let calls = 0, now = 0;
const sampler = new MemorySampler({ read: async () => { calls++; return 1024; }, own: () => 2048, now: () => now });
assert.deepEqual(await Promise.all([sampler.sample(10), sampler.sample(10)]), [3072, 3072]);
assert.equal(calls, 1);
now = 9000; assert.equal(await sampler.sample(10), 3072); assert.equal(calls, 1);
now = 10000; await sampler.sample(10); assert.equal(calls, 2);
await sampler.sample(11); assert.equal(calls, 3, "new child cannot reuse old process memory");
assert.equal(await sampler.sample(null), 2048, "no native server means only this plugin's resident memory");
const missing = new MemorySampler({ read: async () => null, own: () => 2048 });
assert.equal(await missing.sample(12), null, "unsupported/missing measurements are never presented as a total");
let usageCalls = 0;
let usageNow = 0;
const usageSampler = new MemorySampler({ readUsage: async () => { usageCalls++; return win(); }, now: () => usageNow });
const [ram, usage] = await Promise.all([usageSampler.sample(10), usageSampler.sampleUsage(10)]);
assert.equal(ram, 2648); assert.equal(usage.gpuMemoryBytes, 8 * 1024 ** 3 + 20); assert.equal(usageCalls, 1, "RAM and VRAM share one snapshot");
usageNow = 10001; await usageSampler.sampleUsage(10); assert.equal(usageCalls, 2);
await usageSampler.sampleUsage(11); assert.equal(usageCalls, 3, "restarted server invalidates VRAM too");
const failed = new MemorySampler({ readUsage: async () => { throw new Error("access denied or sampler timeout"); } });
assert.deepEqual(await failed.sampleUsage(10), { memoryBytes: null, gpuMemoryBytes: null, gpuSharedMemoryBytes: null, gpuMemorySource: null });
const actual = await new MemorySampler().sample(process.pid);
assert(actual === null || Number.isFinite(actual) && actual > 0);
if (process.platform === "win32") assert(actual !== null && actual > 0, "Windows real working-set sampling must work");
console.log("PASS process-tree RAM, Windows per-process dedicated/shared GPU memory, unrelated-process exclusion, caching, restart invalidation and unavailable measurements");
