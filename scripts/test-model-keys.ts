// API keys of custom remote servers stay on the daemon: never in settings, written owner-only,
// passed to the server's catalog, and removed with their model. Temporary PASEO_HOME only.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "vk-keys-"));
process.env.PASEO_HOME = home;
const { preferencesSchema } = await import("../plugin/shared/settings.ts");
const { setKey, readKeys, pruneKeys } = await import("../plugin/server/model-keys.ts");
const { writeCustomCatalog } = await import("../plugin/server/custom-models.ts");

// Settings can't hold a key, even if an older client sends one.
const parsed = preferencesSchema.parse({
  customModels: [{ id: "custom-remote-a1b2", label: "Remote", kind: "stt", source: "server", baseUrl: "http://10.0.0.2:8000/v1", model: "whisper-1", apiKey: "sk-leak", hasApiKey: true }],
});
assert.equal("apiKey" in parsed.customModels[0], false);
assert.equal(JSON.stringify(parsed).includes("sk-leak"), false);
console.log("PASS settings never carry an API key");

const remote = parsed.customModels[0];
await setKey(remote.id, "  sk-secret  ", 1_000);
const file = join(home, "plugin-data/voice-kit/model-keys.json");
// Windows has no POSIX permission bits; the file sits in the user's profile there.
if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
assert.equal((await readKeys())[remote.id]?.apiKey, "sk-secret");
const catalog = await writeCustomCatalog([remote]);
const entry = JSON.parse(readFileSync(catalog.path, "utf8")).models.find((m: any) => m.id === remote.id);
assert.equal(entry.remote.api_key, "sk-secret");
console.log("PASS a saved key is owner-only and reaches the server catalog");

const before = catalog.hash;
await setKey(remote.id, "sk-rotated");
assert.notEqual((await writeCustomCatalog([remote])).hash, before, "a new key changes the catalog, so the server restarts with it");
await setKey(remote.id, null);
const cleared = JSON.parse(readFileSync((await writeCustomCatalog([remote])).path, "utf8")).models.find((m: any) => m.id === remote.id);
assert.equal(cleared.remote.api_key, undefined);
console.log("PASS keys can be replaced and removed");

// A key saved for a model that isn't in settings yet survives a short while, then goes.
await setKey("custom-new-c3d4", "sk-new", 10_000);
await setKey(remote.id, "sk-old", 10_000);
let kept = await pruneKeys([], 10_000 + 60_000);
assert.ok(kept["custom-new-c3d4"] && kept[remote.id], "within the grace period nothing is pruned");
kept = await pruneKeys(["custom-new-c3d4"], 10_000 + 11 * 60_000);
assert.ok(kept["custom-new-c3d4"]);
assert.equal(kept[remote.id], undefined);
assert.equal((await readKeys())[remote.id], undefined);
console.log("PASS keys of removed models are deleted");
