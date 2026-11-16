import type { Status } from "../shared/rpc";
import { formatBytes } from "./format";

/** Separate accounting figures, never a sum of GPU allocations and the resident working set. */
export function sidebarMemory(status: Pick<Status, "memoryBytes" | "gpuMemoryBytes" | "gpuMemorySource" | "devices">, gpuActive: boolean) {
  if (typeof status.memoryBytes !== "number" || !Number.isFinite(status.memoryBytes) || status.memoryBytes <= 0) return null;
  const resident = formatBytes(status.memoryBytes);
  const gpus = status.devices.filter(d => d.type === "gpu" || d.type === "igpu");
  // Vulkan distinguishes discrete GPUs from iGPUs. On hybrid/unknown hardware we cannot
  // attribute this aggregate to a separate pool. Apple unified memory has no Windows counters.
  const separatePool = gpus.length > 0 && gpus.every(d => d.type === "gpu")
    && status.gpuMemorySource === "windows-process-counters";
  const measured = typeof status.gpuMemoryBytes === "number" && Number.isFinite(status.gpuMemoryBytes) && status.gpuMemoryBytes >= 0;
  const dedicated = gpuActive && separatePool && measured ? formatBytes(status.gpuMemoryBytes!) : null;
  return { resident, dedicated, text: dedicated === null ? resident : `${dedicated} + ${resident}` };
}
