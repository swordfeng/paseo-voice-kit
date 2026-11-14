// Regression tests for the ordered voice model list helpers (plugin/client/voice-chain.ts) and the
// approximate-reading filter (plugin/shared/settings.ts).
//   .capture/harness/node_modules/.bin/esbuild scripts/test-voice-chain.ts --bundle --platform=node --format=esm --outfile=/tmp/vk-chain.mjs && node /tmp/vk-chain.mjs
import type { Model } from "../plugin/shared/rpc";
import { effectiveApproximateLanguages, preferencesSchema, voiceSpec } from "../plugin/shared/settings";
import { coverage, isVisibleVoiceModel, move, nativeLanguages } from "../plugin/client/voice-chain";

let failed = 0;
function expect(ok: boolean, what: string) {
  console.log((ok ? "PASS " : "FAIL ") + what);
  if (!ok) failed++;
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function model(id: string, languages: string[], extra: Partial<Model> = {}): Model {
  return { id, kind: "tts", engine: "sherpa", tier: "recommended", uses: ["voice_output"], label: id, description: "", languages, sizeBytes: 1, installed: true, active: false, ...extra } as Model;
}
const supertonic = model("supertonic-3", ["en", "es", "id"]);
const qwen = model("qwen3-tts-0.6b-gguf-q4", ["zh", "en"], { engine: "gguf" });
const chainEntry = model("voicekit-tts-chain", ["en", "es", "id", "zh"], { engine: "chain", tier: "internal" });

// Defaults: Supertonic 3 alone, no approximate readings, a persona voice.
const defaults = preferencesSchema.parse({});
expect(eq(defaults.ttsModels, ["supertonic-3"]), "1 default list is Supertonic 3 alone");
expect(eq(defaults.ttsApproximateLanguages, []), "1 no approximate readings by default");
expect(voiceSpec(defaults) === "female-higher", "1 default voice is a persona");
expect(voiceSpec({ voice: "custom" }) === "custom", "1 custom voice stays custom");
expect(eq(preferencesSchema.parse({ ttsModels: [] }).ttsModels, []), "1 an empty list is kept");

// Only real voice models can be enabled: not the server's chain entry, not listening models.
expect(isVisibleVoiceModel(supertonic) && isVisibleVoiceModel(qwen), "2 built-in voice models are visible");
expect(!isVisibleVoiceModel(chainEntry), "2 the chain entry is not");
expect(!isVisibleVoiceModel(model("sensevoice-int8", ["zh"], { kind: "stt" })), "2 listening models are not");
expect(isVisibleVoiceModel(model("custom-my-voice", ["th"], { tier: "custom" })), "2 your own voice models are");
expect(eq(nativeLanguages(model("x", ["multi", "en"])), ["en"]), "2 'multi' is not a language");

// Approximate readings: only the user's list, unknown codes dropped.
expect(eq(effectiveApproximateLanguages({ ttsApproximateLanguages: ["ms", "xx"] }), ["ms"]), "3 unknown dropped");
const cov = coverage([supertonic], { ttsLanguageModels: {} }, []);
expect(cov.approximate.length === 4 && cov.approximate.every((a) => !a.allowed), "3 four approximate readings offered, off");
expect(coverage([supertonic], { ttsLanguageModels: {} }, ["ca"]).approximate.find((a) => a.language === "ca")?.allowed === true, "3 an allowed one is on");

// Coverage order: list order, with a per-language first choice moved to the front.
const both = coverage([supertonic, qwen], { ttsLanguageModels: {} }, []);
expect(eq(both.rows.find((r) => r.language === "en")?.models.map((m) => m.id), ["supertonic-3", "qwen3-tts-0.6b-gguf-q4"]), "4 list order");
const chosen = coverage([supertonic, qwen], { ttsLanguageModels: { en: "qwen3-tts-0.6b-gguf-q4" } }, []);
expect(eq(chosen.rows.find((r) => r.language === "en")?.models.map((m) => m.id), ["qwen3-tts-0.6b-gguf-q4", "supertonic-3"]), "4 first choice goes first");
expect(chosen.rows.find((r) => r.language === "zh")?.first === null, "4 no first choice elsewhere");

// Reordering.
expect(eq(move(["a", "b", "c"], "b", -1), ["b", "a", "c"]), "5 move up");
expect(eq(move(["a", "b", "c"], "c", 1), ["a", "b", "c"]), "5 last stays last");

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
