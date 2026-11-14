#!/usr/bin/env node
// Pin a published voicekit GitHub release in plugin/shared/release.ts.
// Usage: node scripts/release-manifest.mjs <tag> [owner/repo]
// Reads the release's SHA256SUMS asset and writes one archive entry per platform.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [tag, repoArg] = process.argv.slice(2);
if (!tag) {
  console.error("usage: node scripts/release-manifest.mjs <tag> [owner/repo]");
  process.exit(2);
}
const repo = repoArg ?? execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { encoding: "utf8" }).trim();
const base = `https://github.com/${repo}/releases/download/${tag}`;
const sums = await (await fetch(`${base}/SHA256SUMS`, { redirect: "follow" })).text();

// Every platform ships an archive containing the server, workers, libraries and notices.
const assets = {};
for (const line of sums.split("\n")) {
  const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(voicekit-([a-z0-9]+-[a-z0-9]+)\.tar\.gz)$/);
  if (!match) continue;
  const [, sha256, file, key] = match;
  const exe = `voicekit-${key}/voicekit${key.startsWith("win32-") ? ".exe" : ""}`;
  assets[key] = { url: `${base}/${file}`, sha256, exe };
}
if (Object.keys(assets).length === 0) throw new Error("SHA256SUMS listed no voicekit archives");

const path = join(import.meta.dirname, "..", "plugin", "shared", "release.ts");
const source = readFileSync(path, "utf8");
const version = tag.replace(/^v/, "");
const block = `export const RELEASE: { version: string; assets: Partial<Record<string, ReleaseAsset>> } = ${JSON.stringify({ version, assets }, null, 2)};`;
const next = source.replace(/export const RELEASE:[\s\S]*?\n};/, block);
if (next === source) throw new Error("could not find the RELEASE block in release.ts");
writeFileSync(path, next);
console.log(`pinned ${Object.keys(assets).length} assets for ${tag}: ${Object.keys(assets).join(", ")}`);
