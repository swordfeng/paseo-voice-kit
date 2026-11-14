#!/usr/bin/env node
// Produce the npm artifact from the Git plugin source without running install/lifecycle scripts.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "plugin");
const output = resolve(process.argv[2] ?? join(root, "dist"));
const stage = await mkdtemp(join(tmpdir(), "voicekit-npm-"));
let npm = "npm", prefix = [];
if (process.platform === "win32") {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")];
  const cli = candidates.find(p => p && p.endsWith(".js") && existsSync(p));
  if (!cli) throw new Error("Cannot find npm-cli.js beside Node; run this script through npm");
  npm = process.execPath; prefix = [cli];
}
const run = (args, cwd) => JSON.parse(execFileSync(npm, [...prefix, ...args], { cwd, encoding: "utf8", env: process.env }));
try {
  const [inventory] = run(["pack", "--dry-run", "--ignore-scripts", "--json"], source);
  for (const { path } of inventory.files) {
    if (path.split(/[\\/]/).includes("..") || resolve(stage, path) !== join(stage, path)) throw new Error("Unsafe package member");
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await cp(join(source, path), join(stage, path));
  }
  const manifestPath = join(stage, "paseo-plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // npm installs the locked production tree itself. Only Git acquisitions need npm ci.
  delete manifest.build;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  if (!inventory.files.some(f => f.path === "npm-shrinkwrap.json")) throw new Error("Missing published dependency lock");
  await mkdir(output, { recursive: true });
  const [packed] = run(["pack", "--ignore-scripts", "--json", "--pack-destination", output], stage);
  console.log(join(output, packed.filename));
} finally {
  await rm(stage, { recursive: true, force: true });
}
