#!/usr/bin/env node
// Validate a native archive with the same extractor the plugin uses; never install it into Paseo.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, stat, readFile } from "node:fs/promises";
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
if (base === "voicekit-darwin-arm64") required.push("mlx-runtime/voicekit-mlx-worker", "mlx-runtime/mlx.metallib", "mlx-runtime/runtime.json", "mlx-runtime/notices/DEPENDENCIES.md");
for (const name of required) {
  const file = join(resolve(destination), base, ...name.split("/"));
  if (!(await stat(file)).isFile()) throw new Error("Missing archive member: " + name);
}
if (base === "voicekit-darwin-arm64") {
  const folder = join(resolve(destination), base, "mlx-runtime");
  const manifest = JSON.parse(await readFile(join(folder, "runtime.json"), "utf8"));
  if (manifest.backend !== "swift-mlx" || manifest.protocol !== 1) throw new Error("Invalid native MLX manifest");
  for (const name of manifest.files) {
    if (typeof name !== "string" || name.startsWith("/") || name.split(/[\\/]/).includes("..") || !(await stat(join(folder, name))).isFile()) throw new Error("Missing native MLX resource: " + name);
  }
  const version = execFileSync(join(folder, "voicekit-mlx-worker"), ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (!version.includes("swift-mlx")) throw new Error("Invalid native MLX worker version");
  if (execFileSync("lipo", ["-archs", join(folder, "voicekit-mlx-worker")], { encoding: "utf8" }).trim() !== "arm64") throw new Error("Incorrect native MLX architecture");
  for (const name of ["voicekit-mlx-worker", ...manifest.files.filter(name => name.endsWith(".dylib"))]) {
    const linked = execFileSync("otool", ["-L", join(folder, name)], { encoding: "utf8" });
    for (const line of linked.split("\n").filter(line => line.startsWith("\t"))) {
      const dependency = line.trim().split(" (")[0];
      if (dependency.startsWith("@loader_path/")) {
        if (!(await stat(join(folder, dependency.slice("@loader_path/".length)))).isFile()) throw new Error("Missing MLX dylib: " + dependency);
      } else if (!dependency.startsWith("/System/Library/") && !dependency.startsWith("/usr/lib/")) throw new Error("External MLX dependency: " + dependency);
    }
  }
}
const exe = join(resolve(destination), base, executable);
const version = execFileSync(exe, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
console.log(JSON.stringify({ exe, files: files.length, version }));
