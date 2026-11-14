#!/usr/bin/env node
// Inspect the npm artifact without installing it or connecting it to Paseo.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "plugin/package.json"));
const { build } = require("esbuild");
const folder = resolve(process.argv[2]);
const tarballs = (await readdir(folder)).filter(n => n.endsWith(".tgz"));
assert.equal(tarballs.length, 1, "expected exactly one npm artifact");
const compiled = await build({ entryPoints: [join(root, "plugin/server/untar.ts")], bundle: true, platform: "node", format: "esm", write: false });
const { extractTarGz } = await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const destination = await mkdtemp(join(tmpdir(), "voicekit-package-check-"));
try {
  const files = await extractTarGz(join(folder, tarballs[0]), destination);
  const source = join(destination, "package");
  const json = async name => JSON.parse(await readFile(join(source, name), "utf8"));
  const pkg = await json("package.json"), manifest = await json("paseo-plugin.json"), lock = await json("npm-shrinkwrap.json");
  assert(!pkg.private, "npm artifact must be publishable");
  assert(!manifest.build, "npm acquisition already installs production dependencies");
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name || entry.dev) continue;
    assert(entry.version && /^https:\/\//.test(entry.resolved) && /^sha(256|512)-/.test(entry.integrity), "unlocked runtime dependency: " + name);
  }
  for (const name of ["index.server.ts", "index.client.tsx", "MODEL_LICENSES.md", "licenses/models/supertonic-3-OpenRAIL-M.txt"]) {
    assert(files.includes("package/" + name), "missing package member: " + name);
  }
  for (const name of manifest.media) assert(files.includes("package/" + name), "missing listing media: " + name);
  const external = ["@getpaseo/plugin", "@getpaseo/plugin/*", "react", "react/*", "react-native", "@tanstack/react-query", "zod", ...Object.keys(pkg.dependencies)];
  for (const name of ["index.server.ts", "index.client.tsx"]) {
    await build({ entryPoints: [join(source, name)], bundle: true, platform: name.includes("server") ? "node" : "neutral", format: "cjs", jsx: "automatic", external, write: false, logLevel: "silent" });
  }
  console.log(JSON.stringify({ artifact: tarballs[0], files: files.length, locked: true, entriesCompile: true }));
} finally { await rm(destination, { recursive: true, force: true }); }
