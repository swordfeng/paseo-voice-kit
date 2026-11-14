#!/usr/bin/env node
// End-to-end voice-mode round trip through the local Paseo daemon, modeled on Paseo's own
// voice round-trip debug script. Audio goes only to this script's session, not to any app.
//
//   1. voicekit synthesizes a spoken request ("Use the speak tool and say exactly ...").
//   2. A throwaway Claude agent (temp folder) runs in voice mode; Paseo transcribes the request
//      with its configured voice STT, the agent calls `speak`, Paseo synthesizes with its
//      configured TTS and streams audio_output back here.
//   3. The captured PCM is saved as WAV and transcribed by voicekit to check it says the phrase.
//   4. The agent is deleted.
//
// Usage (from the repo root): node scripts/e2e-voice.mjs [out.wav]
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const require = createRequire(join(process.cwd(), "plugin", "package.json"));
const { createHostClient } = await import(require.resolve("@getpaseo/client/node"));

const outWav = process.argv[2] ?? join(tmpdir(), "voicekit-e2e-voice.wav");
const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
// voicekit's token changes on every start; read the current one where Paseo gets it.
const tts = JSON.parse(readFileSync(join(home, "config.json"), "utf8")).features?.voiceMode?.tts ?? {};
if (tts.provider !== "openai" || !tts.apiKey) throw new Error("Paseo voice output is not using Voice Kit right now");
const vk = tts.baseUrl.replace(/\/v1\/?$/, "");
const auth = { authorization: `Bearer ${tts.apiKey}` };
const PHRASE = "round trip successful";

function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms))]);

// 1. The spoken request, in an English voice.
const request = await fetch(`${vk}/v1/audio/speech`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ input: `Use the speak tool and say exactly: ${PHRASE}.`, voice: "en-maple", response_format: "pcm" }),
});
if (!request.ok) throw new Error(`voicekit TTS failed: ${request.status}`);
const requestPcm = Buffer.from(await request.arrayBuffer());

const client = createHostClient(process.env.PASEO_HOST ?? "127.0.0.1:6767", {
  clientId: `voicekit-e2e-voice-${randomUUID()}`,
  clientType: "cli",
  localCredential: () => readFileSync(join(home, "local-credential"), "utf8").trim(),
  reconnect: { enabled: false },
});
await client.connect();
await client.fetchAgents({ subscribe: {} });

const cwd = mkdtempSync(join(tmpdir(), "voicekit-e2e-"));
let agentId = null;
const t0 = Date.now();
try {
  const agent = await client.createAgent({
    config: { provider: "claude", cwd, modeId: "bypassPermissions", model: process.env.E2E_MODEL ?? "claude-haiku-5-5" },
  });
  agentId = agent.id;
  const mode = await client.setVoiceMode(true, agentId);
  if (!mode.accepted) throw new Error(`setVoiceMode rejected: ${mode.error ?? "unknown"}`);

  const offTranscript = client.on("transcription_result", (msg) => {
    console.log(`paseo heard (${Date.now() - t0} ms): ${JSON.stringify(msg.payload.text)}`);
  });
  const chunks = [];
  let format = null;
  let firstAudioMs = null;
  const done = new Promise((resolve) => {
    const off = client.on("audio_output", (msg) => {
      const p = msg.payload;
      format ??= p.format;
      firstAudioMs ??= Date.now() - t0;
      chunks.push(Buffer.from(p.audio, "base64"));
      if (p.isLastChunk) {
        off();
        resolve();
      }
    });
  });

  const chunkBytes = 4800; // 100 ms at 24 kHz
  for (let off = 0; off < requestPcm.length; off += chunkBytes) {
    const isLast = off + chunkBytes >= requestPcm.length;
    await client.sendVoiceAudioChunk(requestPcm.subarray(off, off + chunkBytes).toString("base64"), "audio/pcm;rate=24000;bits=16", isLast);
  }
  // Trailing silence so turn detection sees the end of speech.
  const silence = Buffer.alloc(4800);
  for (let i = 0; i < 15; i++) await client.sendVoiceAudioChunk(silence.toString("base64"), "audio/pcm;rate=24000;bits=16", i === 14);

  await withTimeout(done, 180_000, "final audio_output");
  offTranscript();
  await client.setVoiceMode(false).catch(() => undefined);

  const rate = Number(/rate=(\d+)/.exec(format ?? "")?.[1] ?? 24000);
  const pcm = Buffer.concat(chunks);
  writeFileSync(outWav, wav(pcm, rate));
  console.log(`agent audio: ${chunks.length} chunks, format ${format}, ${(pcm.length / 2 / rate).toFixed(2)} s, first audio after ${firstAudioMs} ms -> ${outWav}`);

  // 3. Check what the agent's audio says.
  const form = new FormData();
  form.append("file", new Blob([readFileSync(outWav)], { type: "audio/wav" }), "agent.wav");
  form.append("model", "whisper-large-v3-turbo-q5_0");
  const heard = await (await fetch(`${vk}/v1/audio/transcriptions`, { method: "POST", headers: auth, body: form })).json();
  const ok = /round\s*trip\s*successful/i.test(heard.text ?? "");
  console.log(`agent said: ${JSON.stringify(heard.text)} -> ${ok ? "PASS" : "FAIL"}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  if (agentId) await client.deleteAgent(agentId).catch((e) => console.error("delete agent failed", e.message));
  await client.close().catch(() => undefined);
  rmSync(cwd, { recursive: true, force: true });
  // Creating the agent registered a workspace for the temp folder; archive it.
  try {
    const { execFileSync } = await import("node:child_process");
    const list = JSON.parse(execFileSync("paseo", ["workspace", "ls", "--json"], { encoding: "utf8" }));
    for (const ws of Array.isArray(list) ? list : []) {
      const id = ws.id ?? ws.workspaceId;
      if (id && JSON.stringify(ws).includes(cwd)) execFileSync("paseo", ["workspace", "archive", id], { stdio: "ignore" });
    }
  } catch (e) {
    console.error(`could not archive the e2e workspace for ${cwd}: ${e.message}`);
  }
}
