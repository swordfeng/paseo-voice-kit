// Regression checks with fake child processes and fetch; never touches Paseo or downloads software.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const root = path.resolve(__dirname, '..');
const ts = require(root + '/plugin/node_modules/typescript');
require.extensions['.ts'] = (m, filename) => m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-supervisor-test-'));
process.env.PASEO_HOME = home;
let active = 0, maximum = 0, spawns = [], gate = null, latestChild, spawnMode = 'normal';
const sdk = {
  execCommand: async (_command, args) => {
    if (args?.includes('--version')) {
      if (gate) await gate;
      return { stdout: 'voicekit ' + (sdk.reportedVersion ?? require(root + '/plugin/shared/release.ts').SERVER_VERSION), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  },
  spawnProcess: (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.pid = spawnMode === 'error' ? undefined : 1000000000 + spawns.length; child.exitCode = null;
    const exit = () => { if (child.exitCode !== null) return; child.exitCode = 0; active--; child.emit('exit', 0, null); child.emit('close', 0, null); };
    child.stdin = { end: () => setImmediate(exit) }; child.kill = () => { setImmediate(exit); return true; };
    if (spawnMode === 'stubborn') {
      // Ignores stdin EOF and SIGTERM, like a server stuck in a long request; only SIGKILL ends it.
      child.stdin = { end: () => {} };
      child.kill = (signal) => { if (signal === 'SIGKILL') setImmediate(exit); return true; };
    }
    if (child.pid) active++;
    maximum = Math.max(maximum, active); spawns.push(args); latestChild = child;
    if (spawnMode === 'error') queueMicrotask(() => {
      child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      child.exitCode = -2; child.emit('close', -2, null);
    });
    if (spawnMode === 'early-exit') queueMicrotask(exit);
    return child;
  },
  terminateProcess: async (child, signal) => child.kill(signal ?? 'SIGKILL'),
};
function archive(name, bytes) {
  const header = Buffer.alloc(512);
  header.write(name); header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136); header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257);
  const sum = header.reduce((a, b) => a + b, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512), Buffer.alloc(1024)]));
}
async function until(check) {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error('fixture timed out'); await new Promise(r => setTimeout(r, 2)); }
}
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === '@getpaseo/plugin/server') return sdk;
  return originalLoad.call(this, name, ...args);
};
(async () => {
  const { RELEASE, SERVER_VERSION, platformKey } = require(root + '/plugin/shared/release.ts');
  const { resolveBinary, settleBinaryInstalls, RuntimeDownloadRequired, ServerVersionMismatch } = require(root + '/plugin/server/binary.ts');
  const cargoVersion = /^version = "([^"]+)"/m.exec(fs.readFileSync(path.join(root, 'server/Cargo.toml'), 'utf8'))[1];
  assert.equal(SERVER_VERSION, cargoVersion, 'plugin SERVER_VERSION matches server/Cargo.toml');
  console.log('PASS the plugin names the server version it is built with');
  const pinnedVersion = RELEASE.version;
  RELEASE.version = SERVER_VERSION;
  const { paths, EXE } = require(root + '/plugin/server/paths.ts');
  const bytes = Buffer.from('#!/bin/sh\necho voicekit ' + SERVER_VERSION + '\n');
  const packaged = archive('voicekit-fixture/' + EXE, bytes);
  const url = 'https://example.invalid/voicekit';
  const approved = createHash('sha256').update(packaged).digest('hex');
  RELEASE.assets[platformKey(process.platform, process.arch)] = { url, exe: 'voicekit-fixture/' + EXE, sha256: approved };
  const oldFetch = global.fetch;
  let requests = 0;
  global.fetch = async (source) => { assert.equal(source, url); requests++; return new Response(packaged); };
  try {
    await assert.rejects(resolveBinary('', () => {}, new AbortController().signal), (e) => e instanceof RuntimeDownloadRequired && e.sha256 === approved && e.version === SERVER_VERSION);
    await assert.rejects(resolveBinary('', () => {}, new AbortController().signal, 'f'.repeat(64)), RuntimeDownloadRequired);
    assert.equal(requests, 0, 'no request before consent, nor with consent for another archive');
    RELEASE.version = pinnedVersion === SERVER_VERSION ? '0.0.0-other' : pinnedVersion;
    await assert.rejects(resolveBinary('', () => {}, new AbortController().signal, approved), (e) => e instanceof ServerVersionMismatch && e.source === 'release');
    assert.equal(requests, 0, 'a pinned release of another version is never downloaded');
    RELEASE.version = SERVER_VERSION;
    console.log('PASS approval covers one archive; a release of another version is refused before download');
    const denied = resolveBinary('', () => {}, new AbortController().signal);
    const accepted = resolveBinary('', () => {}, new AbortController().signal, approved);
    await assert.rejects(denied, RuntimeDownloadRequired);
    await accepted;
    assert.equal(requests, 1);
    await resolveBinary('', () => {}, new AbortController().signal);
    assert.equal(requests, 1, 'cached runtime needs no new approval or download');
    console.log('PASS native consent, mixed concurrent permissions, cached runtime');
    fs.rmSync(path.join(paths.bin, RELEASE.version), { recursive: true });
    let releaseFetch;
    const owner = new AbortController(), oldWait = new AbortController();
    global.fetch = async () => { requests++; await new Promise(r => { releaseFetch = r; }); return new Response(packaged); };
    const old = resolveBinary('', () => {}, owner.signal, approved, oldWait.signal);
    await until(() => !!releaseFetch);
    oldWait.abort(); await assert.rejects(old, { name: 'AbortError' });
    let progress = 0;
    const latest = resolveBinary('', () => progress++, owner.signal, approved, new AbortController().signal);
    releaseFetch(); await latest;
    assert.equal(requests, 2, 'settings cancellation reuses the single in-flight archive');
    assert(progress > 0, 'the new waiter receives install progress');
    console.log('PASS setting revisions cancel waiting, not the shared installation');

    fs.rmSync(path.join(paths.bin, RELEASE.version), { recursive: true });
    const cancelled = new AbortController(); let streamCancelled = false;
    global.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(packaged.subarray(0, 16)); }, cancel() { streamCancelled = true; } }));
    const unfinished = resolveBinary('', () => {}, cancelled.signal, approved);
    await until(() => fs.existsSync(path.join(paths.bin, RELEASE.version + '.tar.gz.part')));
    cancelled.abort(); await assert.rejects(unfinished, { name: 'AbortError' });
    await settleBinaryInstalls(cancelled.signal);
    assert(streamCancelled); assert(!fs.existsSync(path.join(paths.bin, RELEASE.version + '.tar.gz.part')));
    assert(!fs.existsSync(path.join(paths.bin, RELEASE.version + '.staging-' + process.pid)));
    global.fetch = async () => new Response(packaged);
    await resolveBinary('', () => {}, new AbortController().signal, approved);
    console.log('PASS owner shutdown cancels transfer, cleans staging and allows a later retry');
  } finally { global.fetch = oldFetch; }
  fs.mkdirSync(path.join(paths.bin, 'local'), { recursive: true });
  fs.writeFileSync(path.join(paths.bin, 'local', EXE), bytes, { mode: 0o755 });
  sdk.reportedVersion = '0.0.9';
  await assert.rejects(resolveBinary('', () => {}, new AbortController().signal), (e) => e instanceof ServerVersionMismatch && e.source === 'local' && e.found === '0.0.9');
  sdk.reportedVersion = undefined;
  assert.equal((await resolveBinary('', () => {}, new AbortController().signal)).version, SERVER_VERSION);
  console.log('PASS a local build of another version is refused');
  const { Supervisor, ourServerPids } = require(root + '/plugin/server/supervisor.ts');
  {
    const unix = [
      '  101 /Users/a/.paseo/plugin-data/voice-kit/bin/local/voicekit serve --port 47615 --models-dir /Users/a/.paseo/plugin-data/voice-kit/models --reuse-dir /x',
      '  102 /tmp/other/voicekit serve --port 0 --models-dir /Users/a/other-models',
      '  103 /usr/bin/vim voicekit serve --models-dir /Users/a/.paseo/plugin-data/voice-kit/modelsx',
      '  104 node voicekit-tests.mjs --models-dir /Users/a/.paseo/plugin-data/voice-kit/models',
    ].join('\n');
    assert.deepEqual(ourServerPids(unix, '/Users/a/.paseo/plugin-data/voice-kit/models'), [101]);
    const windows = [
      '4120 "C:\\Users\\A\\.paseo\\plugin-data\\voice-kit\\bin\\local\\voicekit.exe" serve --port 47615 --models-dir C:\\Users\\A\\.paseo\\plugin-data\\voice-kit\\models --exit-on-stdin-eof',
      '4121 C:\\VK\\voicekit.exe serve --port 0 --models-dir "C:\\Users\\A\\.paseo\\plugin-data\\voice-kit\\models"',
      '4122 C:\\VK\\voicekit.exe probe --models-dir C:\\Users\\A\\.paseo\\plugin-data\\voice-kit\\models',
      '4123 C:\\VK\\voicekit.exe serve --models-dir D:\\elsewhere',
      '',
    ].join('\r\n');
    assert.deepEqual(ourServerPids(windows, 'c:\\users\\a\\.paseo\\plugin-data\\voice-kit\\models', true), [4120, 4121]);
    console.log('PASS leftover servers are found on Unix and Windows, and only for this models folder');
  }
  const supervisor = new Supervisor(() => {});
  const config = { binaryPath: '', port: 0, sttModels: ['test'], ttsModel: 'test', voice: 'A', speed: 1,
    language: 'auto', voiceLanguages: [], vocabulary: '', accelerator: 'cpu', autoDownload: false,
    approvedServerArchive: '', idleUnloadMinutes: 10, neuralEngine: false, catalogPath: '/unused', catalogHash: '1' };
  let release;
  gate = new Promise(resolve => { release = resolve; });
  const first = supervisor.apply(config);
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = supervisor.apply({ ...config, voice: 'B' });
  release(); gate = null;
  await Promise.all([first, second]);
  assert.equal(maximum, 1, 'overlapping applies never leave two children');
  assert.equal(active, 1);
  assert.equal(spawns.at(-1)[spawns.at(-1).indexOf('--voice') + 1], 'B');
  await supervisor.apply({ ...config, voice: 'B' });
  latestChild.kill();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(supervisor.state.phase, 'restarting', 'a no-op settings change must not disable crash recovery');
  await supervisor.dispose();
  assert.equal(active, 0);
  console.log('PASS latest supervisor configuration wins; no orphan process');

  const cancelledStart = new Supervisor(() => {});
  const beforeStarts = spawns.length, oldRevision = new AbortController();
  gate = new Promise(resolve => { release = resolve; });
  const staleStart = cancelledStart.apply(config, false, oldRevision.signal);
  await new Promise(resolve => setTimeout(resolve, 10));
  oldRevision.abort();
  const currentStart = cancelledStart.apply({ ...config, voice: 'LATEST' }, false, new AbortController().signal);
  release(); gate = null;
  await Promise.all([staleStart, currentStart]);
  assert.equal(spawns.length, beforeStarts + 1, 'cancelled settings cannot spawn an old server after shared resolution');
  await cancelledStart.dispose();

  spawnMode = 'error';
  const broken = new Supervisor(() => {});
  await broken.apply(config); await new Promise(resolve => setImmediate(resolve));
  assert.equal(broken.state.phase, 'restarting'); assert.equal(broken.childPid, null); assert.equal(broken.crashes.length, 1, 'error and close are counted once');
  for (let i = 1; i < 5; i++) {
    clearTimeout(broken.restartTimer); broken.restartTimer = null;
    await broken.start(); await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(broken.state.phase, 'failed'); assert.equal(broken.restartTimer, null); assert.equal(active, 0);
  await broken.dispose();
  spawnMode = 'early-exit';
  const early = new Supervisor(() => {});
  await early.apply(config); await new Promise(resolve => setImmediate(resolve));
  assert.equal(early.state.phase, 'restarting'); assert.equal(early.crashes.length, 1);
  assert(!fs.existsSync(paths.pidFile), 'an exit during the PID write leaves no stale PID file');
  await early.dispose();
  spawnMode = 'normal';
  const postSpawnError = new Supervisor(() => {});
  await postSpawnError.apply(config); latestChild.emit('error', new Error('post-spawn error'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, 0); assert.equal(postSpawnError.state.phase, 'restarting');
  assert.equal(postSpawnError.crashes.length, 1); await postSpawnError.dispose();
  console.log('PASS spawn error/close/exit once, bounded retries, immediate exit and no live predecessor');

  // SUP-3: restarts back off (1 s, then 2 s) before giving up.
  spawnMode = 'early-exit';
  const backoff = new Supervisor(() => {});
  await backoff.apply(config); await new Promise(resolve => setImmediate(resolve));
  assert.equal(backoff.state.notice.code, 'crashRestarting'); assert.equal(backoff.state.notice.seconds, 1);
  clearTimeout(backoff.restartTimer); backoff.restartTimer = null;
  await backoff.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(backoff.state.notice.seconds, 2, 'the second crash waits longer');
  await backoff.dispose();
  spawnMode = 'normal';
  console.log('PASS crash restarts back off');

  // SUP-1: a busy port falls back to a free one and says so.
  const net = require('node:net');
  const blocker = net.createServer(); await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const busyPort = blocker.address().port;
  const busy = new Supervisor(() => {});
  await busy.apply({ ...config, port: busyPort });
  const args = spawns.at(-1);
  assert.equal(args[args.indexOf('--port') + 1], '0', 'the server picks a free port');
  assert.equal(busy.state.notice?.code, 'portBusy'); assert.equal(busy.state.notice?.port, busyPort);
  await busy.dispose(); await new Promise(resolve => blocker.close(resolve));
  console.log('PASS a busy port falls back to a free one with a notice');

  // SUP-4: one missed health check is not an outage; two in a row are.
  const healthy = new Supervisor(() => {});
  const realFetch = global.fetch;
  try {
    await healthy.apply(config);
    healthy.snapshot.port = 49102;
    global.fetch = async () => { throw new Error('connection refused'); };
    await healthy.checkHealth();
    assert.notEqual(healthy.state.phase, 'degraded', 'one miss is tolerated');
    await healthy.checkHealth();
    assert.equal(healthy.state.phase, 'degraded'); assert.equal(healthy.state.notice?.code, 'healthCheckFailed');
  } finally { global.fetch = realFetch; await healthy.dispose(); }
  console.log('PASS two missed health checks mark the server degraded');

  // SUP-5: a restart waits only so long for a server that doesn't exit, then ends it.
  spawnMode = 'stubborn';
  const draining = new Supervisor(() => {});
  draining.drainMs = 80;
  await draining.apply(config);
  const stuck = latestChild, began = Date.now();
  spawnMode = 'normal';
  await draining.apply({ ...config, voice: 'NEXT' });
  assert(stuck.exitCode !== null, 'the old server was ended');
  assert(Date.now() - began >= 80 && Date.now() - began < 3000, 'after the drain limit, not before');
  assert.equal(spawns.at(-1)[spawns.at(-1).indexOf('--voice') + 1], 'NEXT');
  await draining.dispose();
  console.log('PASS a restart ends a server that outlives the drain limit');

  const checked = new Supervisor(() => {});
  const savedFetch = global.fetch;
  try {
    await checked.apply(config);
    checked.snapshot.port = 49100; // no socket: only the deferred fixture observes this address
    let finishFetch;
    global.fetch = () => new Promise(resolve => { finishFetch = resolve; });
    const pending = checked.checkHealth();
    await checked.apply(null);
    finishFetch({ ok: true, json: async () => ({ status: 'ready', stt: [{ model: 'OLD' }] }) });
    await pending;
    assert.equal(checked.state.phase, 'disabled');
    assert.equal(checked.state.health, null);
    assert.equal(checked.healthTimer, null);
    console.log('PASS a late health response cannot revive a disabled server');

    await checked.apply(config);
    checked.snapshot.port = 49101;
    let finishBody;
    global.fetch = async () => ({ ok: true, json: () => new Promise(resolve => { finishBody = resolve; }) });
    const bodyPending = checked.checkHealth();
    await new Promise(resolve => setImmediate(resolve));
    await checked.apply({ ...config, voice: 'C' });
    finishBody({ status: 'ready', stt: [{ model: 'OLD' }] });
    await bodyPending;
    assert.equal(checked.state.phase, 'starting');
    assert.equal(checked.state.health, null);
    assert.equal(checked.healthTimer, null);
    console.log('PASS a late health body cannot overwrite a replacement server');

    checked.snapshot.port = 49102;
    let failFetch;
    global.fetch = () => new Promise((_resolve, reject) => { failFetch = reject; });
    const errorPending = checked.checkHealth();
    await checked.apply(null);
    failFetch(new Error('old connection failed'));
    await errorPending;
    assert.equal(checked.healthFailures, 0);
    assert.equal(checked.healthTimer, null);
    assert.equal(checked.state.phase, 'disabled');
    console.log('PASS a stale health failure cannot affect counters or schedule checks');

    await checked.apply(config);
    checked.snapshot.port = 49103;
    global.fetch = () => new Promise(resolve => { finishFetch = resolve; });
    const disposePending = checked.checkHealth();
    await checked.dispose();
    finishFetch({ ok: true, json: async () => ({ status: 'ready', stt: [{ model: 'OLD' }] }) });
    await disposePending;
    assert.equal(checked.state.phase, 'disabled');
    assert.equal(checked.state.health, null);
    assert.equal(checked.healthTimer, null);
    console.log('PASS disposal also discards an in-flight health response');
  } finally {
    global.fetch = savedFetch;
    await checked.dispose();
  }
  fs.rmSync(home, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });
