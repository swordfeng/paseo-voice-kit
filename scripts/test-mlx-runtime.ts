import assert from "node:assert/strict";
import { MlxRuntimeMonitor } from "../plugin/server/mlx-runtime";
const files = new Set(["voicekit-mlx-worker", "mlx.metallib", "libswiftCompatibilitySpan.dylib"]);
let checks = 0;
const options = { binary: () => "/bundle/voicekit", supported: () => true,
  exists: async (path: string) => { checks++; return files.has(path.split(/[\\/]/).pop()!); },
  manifest: async () => ({ backend: "swift-mlx", protocol: 1, files: [...files] }),
};
const monitor = new MlxRuntimeMonitor(options);
assert.equal((await monitor.status()).phase, "ready");
assert.equal((await monitor.status()).worker?.replace(/\\/g, "/"), "/bundle/mlx-runtime/voicekit-mlx-worker");
assert.ok(checks > 0);
assert.equal((await new MlxRuntimeMonitor({ ...options, binary: () => null }).status()).reason, "runtimeRequired");
checks = 0;
assert.equal((await new MlxRuntimeMonitor({ ...options, supported: () => false }).status()).reason, "platform");
assert.equal(checks, 0, "unsupported hosts must not inspect or execute a runtime");
assert.equal((await new MlxRuntimeMonitor({ ...options, exists: async path => !path.endsWith("mlx.metallib") }).status()).phase, "unavailable");
assert.equal((await new MlxRuntimeMonitor({ ...options, manifest: async () => ({ backend: "swift-mlx", protocol: 1, files: ["voicekit-mlx-worker", "mlx.metallib", "../outside"] }) }).status()).phase, "unavailable");
assert.equal((await new MlxRuntimeMonitor({ ...options, manifest: async () => { throw new Error("not installed"); } }).status()).phase, "unavailable");
assert.equal((await new MlxRuntimeMonitor({ ...options, manifest: async () => ({ backend: "other", protocol: 1, files: [...files] }) }).status()).phase, "unavailable");
console.log("bundled MLX availability checks pass without subprocesses or installation");
