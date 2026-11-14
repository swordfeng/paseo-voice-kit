// Settings writes must pass Paseo's real settings write contract (`values: z.json()`), which rejects
// `undefined` anywhere in the document. Regression for adding a custom model from the form, whose
// optional fields used to be sent as explicit `undefined`.
//   .capture/harness/node_modules/.bin/esbuild scripts/test-settings-json.ts --bundle --platform=node --format=esm --outfile=/tmp/vk-json.mjs && node /tmp/vk-json.mjs
import { settingsRpc } from "../plugin/node_modules/@getpaseo/plugin/dist/settings.js";
import { preferencesSchema } from "../plugin/shared/settings";
import { customModelFromDraft, type Draft } from "../plugin/client/custom-model";
import { SettingsWriter } from "../plugin/client/settings-writer";
import { jsonSafe } from "../plugin/client/settings-writer";

let failed = 0;
function expect(ok: boolean, what: string) {
  console.log((ok ? "PASS " : "FAIL ") + what);
  if (!ok) failed++;
}
const write = settingsRpc("preferences").write.input;
const accepts = (values: unknown) => write.safeParse({ revision: "r1", values }).success;
const base = preferencesSchema.parse({});

// The failure as it was: a model object with optional fields present but undefined.
const withUndefined = { id: "custom-my-voice-ab12", label: "My voice", kind: "tts", source: "sherpa", family: "vits", location: "/m", baseUrl: undefined, apiKey: undefined };
expect(!accepts({ ...base, customModels: [withUndefined] }), "1 the real contract rejects undefined fields (the reported failure)");
expect(accepts({ ...base, customModels: [jsonSafe(withUndefined)] }), "1 the same model without undefined fields is accepted");

// Every form source builds a model the contract accepts and the settings schema keeps.
const drafts: Draft[] = [
  { kind: "tts", source: "sherpa", label: "My voice", location: "/Users/me/models/vits-x", family: "vits", languages: ["en"] },
  { kind: "stt", source: "whisper", label: "Whisper medium", location: "~/models/ggml-medium.bin" },
  { kind: "stt", source: "server", label: "Remote", baseUrl: "http://127.0.0.1:8000/v1", model: "whisper-1" },
  { kind: "tts", source: "huggingface", label: "Qwen 1.7B", hfRepo: "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit", hfRevision: "41d3337e", family: "qwen3_tts" },
  // The live case: the MLX 0.6B CustomVoice 4-bit repository found by the user's lookup, with the
  // optional fields the form leaves empty.
  { kind: "tts", source: "huggingface", label: "Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit", hfRepo: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit", hfRevision: "08c72cad5e2fd0f41730c8bd1f28149585e46361", family: "qwen3_tts", baseUrl: undefined, model: undefined, apiKey: undefined, voice: undefined, location: undefined, sha256: undefined, hfFile: undefined, languages: undefined, ggufModelFile: undefined, ggufCodecFile: undefined },
  { kind: "tts", source: "huggingface", label: "中文 声音 !!", hfRepo: "a/b", hfRevision: "abc", family: "qwen3_tts_gguf", ggufModelFile: "t.gguf", ggufCodecFile: "c.gguf" },
];
for (const d of drafts) {
  const model = customModelFromDraft(d);
  const values = { ...base, customModels: [model] };
  expect(accepts(values), `2 ${d.source} ${d.kind} model passes the write contract`);
  expect(preferencesSchema.safeParse(values).success, `2 ${d.source} ${d.kind} model passes the settings schema (id ${model.id})`);
  expect(!Object.values(model).includes(undefined), `2 ${d.source} ${d.kind} model has no undefined fields`);
}

// Ids are always valid, even from labels with no ASCII letters.
for (const label of ["中文 声音", "!!!", "   ", "Ünïcödé Voice"]) {
  const id = customModelFromDraft({ kind: "tts", source: "sherpa", label, location: "/m", family: "vits", languages: ["en"] }).id;
  expect(/^custom-[a-z0-9-]+$/.test(id) && !id.includes("--") && !id.endsWith("-"), `3 id from "${label}" is valid: ${id}`);
}

// jsonSafe drops undefined deeply and keeps everything else.
expect(JSON.stringify(jsonSafe({ a: 1, b: undefined, c: [{ d: undefined, e: "x" }], f: null })) === JSON.stringify({ a: 1, c: [{ e: "x" }], f: null }), "4 jsonSafe drops undefined, keeps null");

// End to end through the writer, with a port that validates like Paseo's settings RPC: a model
// with undefined fields is saved, and a refusal reports Paseo's actual reason.
{
  let doc = { values: base as Record<string, unknown>, revision: "r1" };
  const port = {
    current: () => doc,
    revisionAfter: async () => undefined,
    reload: async () => undefined,
    save: async (values: Record<string, unknown>, revision: string) => {
      const parsed = write.safeParse({ revision, values });
      if (!parsed.success) throw new Error("Invalid input: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
      doc = { values, revision: revision + "+" };
      return true;
    },
  };
  const writer = new SettingsWriter<Record<string, unknown>>(port, () => undefined, () => undefined);
  const model = { ...customModelFromDraft(drafts[2]), baseUrl: undefined, hfRepo: undefined };
  const result = await writer.update({ customModels: [model] });
  expect(result.ok && (doc.values.customModels as unknown[]).length === 1, "5 the writer saves a model even if it carries undefined fields");
  const refusing = new SettingsWriter<Record<string, unknown>>({ ...port, save: async () => { throw new Error("settings host unavailable"); } }, () => undefined, () => undefined);
  const refused = await refusing.update({ vocabulary: "x" });
  expect(!refused.ok && refused.reason === "settings host unavailable", "5 a refused save reports the error Paseo gave: " + JSON.stringify(refused));
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
