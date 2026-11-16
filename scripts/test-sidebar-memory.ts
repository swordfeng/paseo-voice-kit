import assert from "node:assert/strict";
import { sidebarMemory } from "../plugin/client/sidebar-memory";
import { sidebarSummary } from "../plugin/client/sidebar-summary";
import { en } from "../plugin/client/locales/en";
import { zhCN } from "../plugin/client/locales/zh-CN";
import type { Status } from "../plugin/shared/rpc";

const discrete = { memoryBytes: 3e9, gpuMemoryBytes: 2e9, gpuSharedMemoryBytes: 1e9, gpuMemorySource: "windows-process-counters" as const,
  devices: [{ name: "Vulkan0", description: "Discrete GPU", type: "gpu", backend: "Vulkan" }] };
assert.deepEqual(sidebarMemory(discrete, true), { resident: "3.0 GB", dedicated: "2.0 GB", text: "2.0 GB + 3.0 GB" });
const unified = { ...discrete, devices: [{ ...discrete.devices[0], type: "igpu" }] };
assert.deepEqual(sidebarMemory(unified, true), { resident: "3.0 GB", dedicated: null, text: "3.0 GB" }, "unified memory is not summed or presented as separate pools");
assert.equal(sidebarMemory({ ...discrete, devices: [...discrete.devices, ...unified.devices] }, true)?.text, "3.0 GB", "hybrid aggregate cannot be assigned to a separate pool");
assert.equal(sidebarMemory({ ...discrete, devices: [] }, true)?.text, "3.0 GB", "unknown architecture keeps one resident figure");
assert.equal(sidebarMemory({ ...discrete, gpuMemorySource: null, devices: [{ name: "Metal", type: "gpu", backend: "Metal", description: "Apple GPU" }] }, true)?.text, "3.0 GB", "Apple shared memory does not become two allocations");
assert.equal(sidebarMemory(discrete, false)?.text, "3.0 GB", "an inactive GPU's cached allocations do not imply GPU execution");
for (const gpuMemoryBytes of [null, -1, NaN, Infinity]) assert.equal(sidebarMemory({ ...discrete, gpuMemoryBytes }, true)?.text, "3.0 GB");
assert.equal(sidebarMemory({ ...discrete, gpuMemoryBytes: 0 }, true)?.text, "0 MB + 3.0 GB", "known zero is not inferred to mean UMA");
for (const memoryBytes of [null, 0, -1, NaN, Infinity]) assert.equal(sidebarMemory({ ...discrete, memoryBytes }, true), null);
const translator = (locale: typeof en | typeof zhCN) => ((key: string, values: Record<string, unknown> = {}) => {
  let text: unknown = locale;
  for (const part of key.split(".")) text = (text as Record<string, unknown>)[part];
  return String(text).replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name]));
}) as Parameters<typeof sidebarSummary>[0];
const enabled = { enabled: true, useForDictation: true, useForVoiceInput: true, useForVoiceOutput: true };
const status = { ...discrete, connected: true, phase: "ready", downloads: {}, ttsLastError: null,
  sites: [{ site: "dictation", state: "active", model: "asr" }, { site: "voiceOutput", state: "active", model: "tts" }],
  stt: [{ model: "asr", state: "ready", available: true, accelerator: "cpu" }],
  tts: { model: "tts", state: "ready", available: true, accelerator: "vulkan" },
} as unknown as Status;
for (const locale of [en, zhCN]) {
  const summary = sidebarSummary(translator(locale), status, enabled);
  assert(summary.candidates.some(s => s.includes("GPU+CPU")));
  assert.equal(summary.memory, "2.0 GB + 3.0 GB", "memory keeps its own line rather than disappearing when devices fill the status line");
  assert(summary.accessible.indexOf("2.0 GB") < summary.accessible.indexOf("3.0 GB"), "assistive text identifies GPU then resident memory");
  const shared = sidebarSummary(translator(locale), { ...status, devices: unified.devices }, enabled);
  assert(shared.candidates.some(s => s.includes("GPU+CPU")));
  assert.equal(shared.memory, "3.0 GB", "devices still describe execution on UMA");
  assert.equal(sidebarSummary(translator(locale), status, { ...enabled, enabled: false }).memory, undefined);
  assert.equal(sidebarSummary(translator(locale), status, enabled, Date.now(), true).memory, undefined);
  assert.equal(sidebarSummary(translator(locale), { ...status, ttsLastError: { message: "failed", at: Date.now() } } as Status, enabled).memory, undefined);
}
console.log("PASS sidebar GPU-before-RAM order, unified/unknown/hybrid memory, CPU-only, shared-memory exclusion and unavailable measurements");
