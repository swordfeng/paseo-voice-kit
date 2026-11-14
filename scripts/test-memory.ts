import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySampler, processTreeRss, linuxProcessTreeRss } from "../plugin/server/memory";

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
const actual = await new MemorySampler().sample(process.pid);
assert(actual === null || Number.isFinite(actual) && actual > 0);
console.log("PASS owned process tree, unrelated-process exclusion, caching, restart invalidation and unavailable measurements");
