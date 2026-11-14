#!/usr/bin/env node
// Validate a native archive with the same extractor the plugin uses; never install it into Paseo.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "plugin/package.json"));
const { build } = require("esbuild");
const [archive, destination] = process.argv.slice(2);
if (!archive || !destination) throw new Error("usage: verify-native-package.mjs <archive> <destination>");
const base = basename(archive, ".tar.gz");
if (!/^voicekit-(darwin|linux|win32)-(arm64|x64)$/.test(base)) throw new Error("Unknown native archive platform");
const compiled = await build({ entryPoints: [join(root, "plugin/server/untar.ts")], bundle: true, platform: "node", format: "esm", write: false });
const { extractTarGz } = await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));
await mkdir(destination, { recursive: true });
const files = await extractTarGz(archive, resolve(destination));
const executable = base.includes("win32") ? "voicekit.exe" : "voicekit";
const worker = "gguf-runtime/voicekit-qwen-worker" + (base.includes("win32") ? ".exe" : "");
const required = [executable, worker, "LICENSE", "MODEL_LICENSES.md", "RUST_DEPENDENCIES.md", "THIRD_PARTY_NOTICES.md"];
if (base === "voicekit-darwin-arm64") required.push("qwen-runtime/install-qwen-runtime.sh", "qwen-runtime/qwen-requirements.txt", "qwen-runtime/qwen-build-requirements.txt");
for (const name of required) {
  const file = join(resolve(destination), base, ...name.split("/"));
  if (!(await stat(file)).isFile()) throw new Error("Missing archive member: " + name);
}
const exe = join(resolve(destination), base, executable);
const version = execFileSync(exe, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
console.log(JSON.stringify({ exe, files: files.length, version }));
