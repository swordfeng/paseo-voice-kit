#!/usr/bin/env node
// End-to-end check: stream a WAV through the local Paseo daemon's dictation pipeline, exactly as
// the app does, and print the transcript. Whatever STT Paseo is configured with answers, so with
// Voice Kit active this exercises Paseo -> voicekit -> Paseo.
//
// Usage: node scripts/e2e-dictation.mjs <pcm16-mono.wav> [host:port]
// Run from the plugin directory's node_modules context:
//   NODE_PATH=plugin/node_modules node scripts/e2e-dictation.mjs clip.wav
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const require = createRequire(join(process.cwd(), "plugin", "package.json"));
const { createHostClient } = await import(require.resolve("@getpaseo/client/node"));

const [wavPath, host = "127.0.0.1:6767"] = process.argv.slice(2);
if (!wavPath) {
  console.error("usage: node scripts/e2e-dictation.mjs <pcm16-mono.wav> [host:port]");
  process.exit(2);
}

function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not a WAV file");
  let pos = 12;
  let rate = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") rate = buf.readUInt32LE(pos + 12);
    if (id === "data") return { rate, pcm: buf.subarray(pos + 8, pos + 8 + size) };
    pos += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}

const { rate, pcm } = parseWav(readFileSync(wavPath));
const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
const client = createHostClient(host, {
  clientId: `voicekit-e2e-${randomUUID()}`,
  clientType: "cli",
  localCredential: () => readFileSync(join(home, "local-credential"), "utf8").trim(),
  reconnect: { enabled: false },
});
await client.connect();
const format = `audio/pcm;rate=${rate};bits=16`;
const id = `e2e_${Date.now()}`;
const started = Date.now();
await client.startDictationStream(id, format);
const chunkBytes = Math.floor(rate / 10) * 2; // 100 ms chunks, like the app
let seq = 0;
for (let off = 0; off < pcm.length; off += chunkBytes) {
  client.sendDictationStreamChunk(id, seq++, pcm.subarray(off, off + chunkBytes).toString("base64"), format);
}
const result = await client.finishDictationStream(id, seq - 1);
console.log(JSON.stringify({ text: result.text, ms: Date.now() - started, audioSecs: +(pcm.length / 2 / rate).toFixed(2) }));
await client.close();
