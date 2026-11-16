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
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const require = createRequire(join(process.cwd(), "plugin", "package.json"));
// A file URL, not a path: Windows paths ("C:\\...") are not valid ESM specifiers.
const { createHostClient } = await import(pathToFileURL(require.resolve("@getpaseo/client/node")).href);

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

// The timer is cleared when `p` settles, so a finished run exits at once.
const withTimeout = (p, ms, what) => {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};

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

// The real path: Windows temp paths can be 8.3 short names that Paseo records in long form.
const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "voicekit-e2e-")));
let agentId = null;
const t0 = Date.now();
try {
  const agent = await client.createAgent({
    // E2E_PROVIDER / E2E_MODEL pick another agent (for example codex) where Claude isn't signed in.
    config: process.env.E2E_PROVIDER
      // The throwaway agent must call `speak` without an approval nobody answers: Codex's
      // default mode asks before MCP tools, so it runs in full access, as Claude bypasses.
      ? { provider: process.env.E2E_PROVIDER, cwd, modeId: process.env.E2E_MODE ?? (process.env.E2E_PROVIDER === "codex" ? "full-access" : undefined), ...(process.env.E2E_MODEL ? { model: process.env.E2E_MODEL } : {}) }
      : { provider: "claude", cwd, modeId: "bypassPermissions", model: process.env.E2E_MODEL ?? "claude-haiku-5-5" },
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
    // Windows installs the CLI as paseo.cmd, which only runs through a shell.
    const windows = process.platform === "win32";
    // The CLI refuses PASEO_HOME and PASEO_HOST together; with a home set (an isolated
    // daemon), the home is the target.
    const env = { ...process.env };
    if (env.PASEO_HOME && env.PASEO_HOST) delete env.PASEO_HOST;
    const paseo = (args, options) => execFileSync(windows ? "paseo.cmd" : "paseo", args, { ...options, env, shell: windows });
    const list = JSON.parse(paseo(["workspace", "ls", "--json"], { encoding: "utf8" }));
    for (const ws of Array.isArray(list) ? list : []) {
      const id = ws.id ?? ws.workspaceId;
      // Compare paths themselves: JSON escapes Windows backslashes, and Windows paths can differ
      // in case. Paths of the workspace and of its projects are both checked.
      const norm = (p) => (typeof p === "string" ? p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : null);
      const paths = [ws.cwd, ws.path, ws.directory, ...(Array.isArray(ws.projects) ? ws.projects.flatMap((pr) => [pr?.cwd, pr?.path]) : [])].map(norm);
      if (id && paths.includes(norm(cwd))) paseo(["workspace", "archive", id], { stdio: "ignore" });
    }
  } catch (e) {
    console.error(`could not archive the e2e workspace for ${cwd}: ${e.message}`);
  }
}
