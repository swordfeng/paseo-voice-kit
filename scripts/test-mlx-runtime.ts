import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MlxRuntimeInstaller, runInstaller } from "../plugin/server/mlx-runtime";
const empty = { binary: () => "/runtime/voicekit", data: "/managed", supported: () => true, python: "python3.12", external: "" };
let runs = 0, checks = 0, ready = false, refreshed = 0;
let done!: () => void;
const wait = new Promise<void>(resolve => { done = resolve; });
const installer = new MlxRuntimeInstaller({ ...empty,
  exists: async p => p.endsWith("python") ? ready : true,
  check: async (_python, runtime) => { checks++; if (runtime && !ready) throw new Error("broken packages"); return "/python3.12"; },
  run: async (_script, python, line) => { runs++; assert.equal(python, "/python3.12"); for (let n = 0; n < 100; n++) line("log " + n); await wait; ready = true; },
  installed: () => { refreshed++; },
});
assert.equal((await installer.status()).phase, "missing");
assert.equal((await installer.status()).phase, "missing");
assert.equal(checks, 1, "readiness checks cached");
assert.equal(runs, 0, "checking/adding models cannot install anything");
await assert.rejects(installer.install(false), /confirmation/);
const [one, two] = await Promise.all([installer.install(true), installer.install(true)]);
assert.equal(one.phase, "installing"); assert.equal(two.phase, "installing"); assert.equal(runs, 1, "concurrent confirmed clicks reuse one install");
assert.equal((await installer.status()).lines.length, 60, "bounded log tail");
done();
for (let n = 0; n < 30 && (await installer.status()).phase === "installing"; n++) await new Promise(r => setTimeout(r, 1));
assert.equal((await installer.status()).phase, "ready"); assert.equal(refreshed, 1);
assert.equal((await installer.install(true)).phase, "ready"); assert.equal(runs, 1, "installed runtime is not reinstalled");
await installer.dispose();
await assert.rejects(installer.install(true), /stopping/);
const unsupported = new MlxRuntimeInstaller({ ...empty, supported: () => false, run: async () => { throw new Error("must not run"); } });
assert.equal((await unsupported.install(true)).reason, "platform"); await unsupported.dispose();
const missingPython = new MlxRuntimeInstaller({ ...empty, exists: async () => false, check: async () => { throw new Error("Python missing"); } });
assert.equal((await missingPython.install(true)).reason, "pythonRequired"); await missingPython.dispose();
const external = new MlxRuntimeInstaller({ ...empty, external: "/custom/python", exists: async () => true, check: async () => { throw new Error("custom runtime broken"); } });
assert.equal((await external.install(true)).reason, "externalRuntime"); await external.dispose();
let attempts = 0;
const retry = new MlxRuntimeInstaller({ ...empty, exists: async p => !p.endsWith("python"), check: async () => "/python3.12", run: async () => { if (++attempts === 1) throw new Error("download failed"); } });
await retry.install(true);
for (let n = 0; n < 30 && (await retry.status()).phase === "installing"; n++) await new Promise(r => setTimeout(r, 1));
assert.equal((await retry.status()).phase, "failed"); assert.match((await retry.status()).error!, /download failed/);
await retry.install(true);
for (let n = 0; n < 30 && (await retry.status()).phase === "installing"; n++) await new Promise(r => setTimeout(r, 1));
assert.equal((await retry.status()).phase, "ready"); await retry.dispose();

// Real process lifecycle, using only scratch shell scripts; never pip/network/model downloads.
if (process.platform !== "win32") {
  const temp = await mkdtemp(join(tmpdir(), "vk-mlx-installer-"));
  try {
    const ok = join(temp, "ok.sh"), bad = join(temp, "bad.sh"), slow = join(temp, "slow.sh"), pid = join(temp, "child.pid");
    await writeFile(ok, 'printf "first\\nlast"\n');
    await writeFile(bad, 'echo "fixture diagnostic" >&2\nexit 7\n');
    await writeFile(slow, 'sleep 60 &\necho $! > "$1"\nwait\n');
    const lines: string[] = [];
    await runInstaller(ok, "not-used", line => lines.push(line), new AbortController().signal);
    assert.deepEqual(lines, ["first", "last"]);
    await assert.rejects(runInstaller(bad, "not-used", () => {}, new AbortController().signal), /7/);
    // The production runner supplies no script args. Embed only this generated scratch path.
    await writeFile(slow, `sleep 60 &\necho $! > '${pid}'\nwait\n`);
    const abort = new AbortController();
    const job = runInstaller(slow, "not-used", () => {}, abort.signal);
    let child = 0;
    for (let n = 0; n < 100; n++) { try { child = Number(await readFile(pid, "utf8")); break; } catch { await new Promise(r => setTimeout(r, 5)); } }
    assert(child > 1); abort.abort(); await assert.rejects(job, /SIGKILL/);
    // An orphan can remain a zombie briefly; it must no longer be running.
    const { execFileSync } = await import("node:child_process");
    let alive = ""; try { alive = execFileSync("ps", ["-p", String(child), "-o", "stat="], { encoding: "utf8" }).trim(); } catch { /* reaped */ }
    assert(!alive || alive.startsWith("Z"), "installer cleanup stops pip/build descendants");
  } finally { await rm(temp, { recursive: true, force: true }); }
}
console.log("PASS MLX explicit consent, prerequisites, singleflight, bounded logs, retry, checks and owned process cleanup (no install/inference)");
