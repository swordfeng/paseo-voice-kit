import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultSttModel, DefaultSttSelectionPending, INCONCLUSIVE_CHECKS, chooseDefaultSttModel, interimListeningModel, needsDefaultStt, settledDefault, withDefaultSttModels } from "../plugin/server/default-stt";
import { DEFAULT_CPU_STT_MODEL, DEFAULT_GPU_STT_MODEL, preferencesSchema } from "../plugin/shared/settings";

const folder = await mkdtemp(join(tmpdir(), "vk-default-stt-"));
try {
  const values = preferencesSchema.parse({});
  assert.equal(values.dictationModel, "");
  assert.equal(values.voiceInputModel, "");
  assert(needsDefaultStt(values));
  assert(!needsDefaultStt({ ...values, enabled: false }));
  assert(!needsDefaultStt({ ...values, useForDictation: false, useForVoiceInput: false }));
  assert(!needsDefaultStt({ ...values, dictationModel: "custom-listening", useForVoiceInput: false }), "a disabled voice-input field must not start a probe");
  assert(!needsDefaultStt({ ...values, voiceInputModel: "sensevoice-int8", useForDictation: false }), "a disabled dictation field must not start a probe");
  const file = join(folder, "choice.json");
  let selections = 0;
  const defaults = new DefaultSttModel(file);
  const select = async () => { selections++; return DEFAULT_GPU_STT_MODEL; };
  assert.deepEqual(await Promise.all([defaults.get(select), defaults.get(select)]), [DEFAULT_GPU_STT_MODEL, DEFAULT_GPU_STT_MODEL]);
  assert.equal(selections, 1, "concurrent requests select only once");
  assert.equal(JSON.parse(await readFile(file, "utf8")).model, DEFAULT_GPU_STT_MODEL);
  const restarted = new DefaultSttModel(file);
  assert.equal(await restarted.get(async () => { throw new Error("must not probe after restart or upgrade"); }), DEFAULT_GPU_STT_MODEL);
  assert.equal(await defaults.get(async () => DEFAULT_CPU_STT_MODEL), DEFAULT_GPU_STT_MODEL, "later hardware preferences cannot replace the default");
  const first = withDefaultSttModels(values, DEFAULT_GPU_STT_MODEL);
  assert.equal(first.dictationModel, DEFAULT_GPU_STT_MODEL);
  assert.equal(first.voiceInputModel, DEFAULT_GPU_STT_MODEL);
  const changed = withDefaultSttModels({ ...values, dictationModel: "custom-listening" }, DEFAULT_GPU_STT_MODEL);
  assert.equal(changed.dictationModel, "custom-listening");
  assert.equal(changed.voiceInputModel, DEFAULT_GPU_STT_MODEL, "changing dictation does not change voice input's default");
  assert.deepEqual(withDefaultSttModels({ ...changed, voiceInputModel: "sensevoice-int8" }, DEFAULT_CPU_STT_MODEL), { ...changed, voiceInputModel: "sensevoice-int8" });
  const pendingFile = join(folder, "pending.json");
  const pending = new DefaultSttModel(pendingFile);
  await assert.rejects(pending.get(async () => { throw new Error("runtime download approval needed"); }), /approval needed/);
  await assert.rejects(readFile(pendingFile), { code: "ENOENT" });
  assert.equal(await pending.get(select), DEFAULT_GPU_STT_MODEL, "a deferred runtime install does not lock in a CPU default");
  const cancelledFile = join(folder, "cancelled.json");
  const cancelled = new DefaultSttModel(cancelledFile);
  const controller = new AbortController();
  let started!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; });
  const selection = cancelled.get(async () => {
    started();
    await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
    return DEFAULT_GPU_STT_MODEL;
  }, controller.signal);
  await starting;
  controller.abort();
  await assert.rejects(selection, { name: "AbortError" });
  await assert.rejects(readFile(cancelledFile), { code: "ENOENT" });
  assert.equal(await cancelled.get(async () => DEFAULT_CPU_STT_MODEL), DEFAULT_CPU_STT_MODEL, "a cancelled selection cannot persist or block the next preferences");
  const noProbe = async () => { throw new Error("should not prepare a runtime"); };
  assert.equal(await chooseDefaultSttModel({ ...values, accelerator: "cpu" }, noProbe, () => {}), DEFAULT_CPU_STT_MODEL);
  assert.equal(await chooseDefaultSttModel({ ...values, accelerator: "cpu", dictationModel: "custom-listening" }, noProbe, () => {}), DEFAULT_CPU_STT_MODEL, "a removable custom choice cannot become the computer's default");
  await writeFile(join(folder, "invalid.json"), '{"model":""}');
  await assert.rejects(new DefaultSttModel(join(folder, "invalid.json")).get(select), /Invalid/);
  const binary = async () => ({ path: "/fixture/voicekit", source: "local" as const, version: "fixture" });
  for (const autoDownload of [false, true]) {
    let probeArgs: readonly string[] = [];
    const selected = await chooseDefaultSttModel({ ...values, autoDownload }, binary, () => {}, undefined,
      async (_path, args) => { probeArgs = args ?? []; return { stdout: JSON.stringify({ gpu: null, fastWhisper: false, reason: "no GPU device" }), stderr: "" }; }, "linux");
    assert.equal(selected, DEFAULT_CPU_STT_MODEL);
    assert.equal(probeArgs.includes("--auto-pull"), autoDownload, "initial probe respects model download consent");
  }
  for (const fast of [false, true]) {
    const chosen = new DefaultSttModel(join(folder, "measured-" + fast + ".json"));
    assert.equal(await chosen.get(() => chooseDefaultSttModel(values, binary, () => {}, undefined,
      async () => ({ stdout: JSON.stringify({ gpu: { name: "fixture" }, accelerator: "vulkan", medianMs: fast ? 10 : 100, fastWhisper: fast }), stderr: "" }), "linux")),
    fast ? DEFAULT_GPU_STT_MODEL : DEFAULT_CPU_STT_MODEL, "only a successful measurement is persisted");
  }
  for (const [name, result] of [
    ["network", new Error("network failed")], ["timeout", new Error("probe timed out")],
    ["missing", new Error("calibration model is not downloaded")],
    ["driver-cpu-fallback", { gpu: { name: "fixture" }, accelerator: "cpu", medianMs: 50, fastWhisper: false }],
    ["malformed", { fastWhisper: false }],
  ] as const) {
    const file = join(folder, name + ".json"), defaults = new DefaultSttModel(file);
    await assert.rejects(defaults.get(() => chooseDefaultSttModel({ ...values, autoDownload: false }, binary, () => {}, undefined,
      async () => { if (result instanceof Error) throw result; return { stdout: JSON.stringify(result), stderr: "" }; }, "linux")), DefaultSttSelectionPending);
    await assert.rejects(readFile(file), { code: "ENOENT" });
    assert.equal(await defaults.get(async () => DEFAULT_GPU_STT_MODEL), DEFAULT_GPU_STT_MODEL, "unknown results remain retryable");
  }
  console.log("PASS initial selection persists across reloads; manual feature choices are independent; deferred install retries without changing the default");
} finally { await rm(folder, { recursive: true, force: true }); }

// STT-3: while the GPU check is pending, listening stays with built-in speech; after three
// inconclusive checks in a row the CPU model becomes the default; other errors keep the CPU model
// for the moment so they are reported, never stored.
{
  const pending = new DefaultSttSelectionPending("GPU measurement is unavailable");
  assert.equal(interimListeningModel(pending), "", "nothing to download while the check is pending");
  assert.equal(interimListeningModel(new Error("Confirm installation")), DEFAULT_CPU_STT_MODEL);
  assert.equal(INCONCLUSIVE_CHECKS, 3);
  assert.equal(settledDefault(pending, 0), null);
  assert.equal(settledDefault(pending, 1), null);
  assert.equal(settledDefault(pending, 2), DEFAULT_CPU_STT_MODEL, "the third inconclusive check settles on the CPU model");
  assert.equal(settledDefault(new Error("consent"), 5), null, "only inconclusive checks settle the default");
  const empty = withDefaultSttModels(preferencesSchema.parse({}), interimListeningModel(pending));
  assert.equal(empty.dictationModel, ""); assert.equal(empty.voiceInputModel, "");
  console.log("PASS a pending GPU check keeps built-in listening and settles after three inconclusive checks");
}
