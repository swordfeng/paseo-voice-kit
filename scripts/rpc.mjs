#!/usr/bin/env node
// Call a Voice Kit plugin RPC on the local daemon, like the settings screen does.
// Usage: node scripts/rpc.mjs <method> [json-input] [--save-audio out.wav]
//   node scripts/rpc.mjs voicekit.status
//   node scripts/rpc.mjs voicekit.reclaim '{"site":"dictation"}'
//   node scripts/rpc.mjs voicekit.preview '{}' --save-audio /tmp/preview.wav
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const require = createRequire(join(process.cwd(), "plugin", "package.json"));
const { createHostClient } = await import(require.resolve("@getpaseo/client/node"));

const args = process.argv.slice(2);
const saveIdx = args.indexOf("--save-audio");
const savePath = saveIdx >= 0 ? args.splice(saveIdx, 2)[1] : null;
const [method, input = "{}"] = args;
if (!method) {
  console.error("usage: node scripts/rpc.mjs <method> [json-input] [--save-audio out.wav]");
  process.exit(2);
}
const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
const client = createHostClient(process.env.PASEO_HOST ?? "127.0.0.1:6767", {
  clientId: `voicekit-rpc-${randomUUID()}`,
  clientType: "cli",
  localCredential: () => readFileSync(join(home, "local-credential"), "utf8").trim(),
  reconnect: { enabled: false },
});
await client.connect();
try {
  const result = await client.invokePluginRpc("voice-kit", method, JSON.parse(input));
  if (savePath && result && typeof result === "object" && "base64" in result) {
    writeFileSync(savePath, Buffer.from(result.base64, "base64"));
    console.log(JSON.stringify({ ...result, base64: `<${result.base64.length} chars saved to ${savePath}>` }, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await client.close();
}
