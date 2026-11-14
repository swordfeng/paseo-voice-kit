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
