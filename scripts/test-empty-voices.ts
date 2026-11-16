// A stale healthy response must not keep Voice Kit in charge after its last voice is disabled.
import assert from "node:assert/strict";
import { computeDesired } from "../plugin/index.server";
import { preferencesSchema } from "../plugin/shared/settings";
import type { SupervisorSnapshot } from "../plugin/server/supervisor";

const stt = "whisper-large-v3-turbo-q5_0";
const prefs = preferencesSchema.parse({ dictationModel: stt, voiceInputModel: stt, ttsModels: [] });
const snapshot = {
  phase: "ready",
  health: {
    stt: [{ model: stt, available: true }],
    tts: { model: "voicekit-tts-chain", available: true },
    downloads: {},
  },
} as unknown as SupervisorSnapshot;
const empty = computeDesired(prefs, snapshot, "http://127.0.0.1:47615", "fixture");
assert.equal(empty.model.voiceOutput, null);
assert.equal(empty.waiting.voiceOutput?.code, "noVoiceModels");
assert.equal(empty.model.dictation, stt);
assert.equal(empty.model.voiceInput, stt);
const enabled = computeDesired({ ...prefs, ttsModels: ["supertonic-3"] }, snapshot, "http://127.0.0.1:47615", "fixture");
assert.equal(enabled.model.voiceOutput, "voicekit-tts-chain");
assert.equal(enabled.waiting.voiceOutput, null);
console.log("PASS disabling the last voice restores speech output without disabling recognition; enabling a voice permits takeover again");

// STT-4: dictation and voice-mode listening use their own models, each falling back to the other
// while its own isn't ready.
{
  const both = preferencesSchema.parse({ dictationModel: "whisper-a", voiceInputModel: "qwen-b", ttsModels: [] });
  const ready = (ids: string[]) => ({ phase: "ready", health: { stt: ids.map((model) => ({ model, available: true })), tts: null, downloads: {} } }) as unknown as SupervisorSnapshot;
  const separate = computeDesired(both, ready(["whisper-a", "qwen-b"]), "http://127.0.0.1:47615", "fixture");
  assert.equal(separate.model.dictation, "whisper-a");
  assert.equal(separate.model.voiceInput, "qwen-b");
  const partly = computeDesired(both, ready(["whisper-a"]), "http://127.0.0.1:47615", "fixture");
  assert.equal(partly.model.voiceInput, "whisper-a", "voice mode borrows dictation's model while its own isn't ready");
  console.log("PASS dictation and voice mode use their own listening models");
}

// SET-4: a feature that falls back says why, as a code the app translates.
{
  const one = preferencesSchema.parse({ dictationModel: "whisper-a", voiceInputModel: "whisper-a", ttsModels: [] });
  const state = (engine: Record<string, unknown>, downloads: Record<string, unknown> = {}, phase = "loading") =>
    computeDesired(one, { phase, health: { stt: [{ model: "whisper-a", available: false, ...engine }], tts: null, downloads } } as unknown as SupervisorSnapshot, "http://127.0.0.1:47615", "fixture").waiting.dictation;
  assert.deepEqual(state({ state: "downloading" }, { "whisper-a": { downloaded: 50, total: 200, phase: "downloading" } }), { code: "downloading", model: "whisper-a", percent: 25 });
  assert.equal(state({ state: "missing" })?.code, "notDownloaded");
  assert.equal(state({ state: "missing", error: "checksum mismatch" })?.code, "downloadFailed");
  assert.equal(state({ state: "failed", error: "bad model" })?.code, "loadFailed");
  assert.equal(state({ state: "loading" })?.code, "loading");
  const stopped = computeDesired(one, { phase: "failed", message: "gave up", health: null } as unknown as SupervisorSnapshot, null, "").waiting.dictation;
  assert.equal(stopped?.code, "stopped");
  console.log("PASS each fallback reports its reason code");
}
