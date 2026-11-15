#!/usr/bin/env node
// Existing low-cost regressions: no model downloads, inference, or Paseo installation.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "plugin/package.json"));
const { build } = require("esbuild");
const suites = ["default-stt", "empty-voices", "feature-phase", "hf-lookup", "memory", "model-keys", "sidebar-memory", "mlx-catalog", "mlx-runtime", "paseo-models", "settings-json", "settings-writer", "speech-switch", "tts-chain", "voice-chain"];
const temporary = await mkdtemp(join(tmpdir(), "voicekit-tests-"));
try {
  for (const suite of suites) {
    const entry = join(root, "scripts", `test-${suite}.ts`);
    const out = join(temporary, suite + ".mjs");
    await build({ entryPoints: [entry], outfile: out, bundle: true, platform: "node", format: "esm", external: ["@getpaseo/client/node"], logLevel: "silent" });
    execFileSync(process.execPath, [out], { cwd: root, stdio: "inherit", timeout: 30_000 });
  }
  execFileSync(process.execPath, [join(root, "scripts/test-supervisor.cjs")], { cwd: root, stdio: "inherit", timeout: 30_000 });
} finally { await rm(temporary, { recursive: true, force: true }); }
