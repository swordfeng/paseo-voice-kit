// Windows reports working sets and per-process GPU memory in bytes, independent of locale.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);

export interface MemoryUsage {
  memoryBytes: number | null;
  /** Sum of Windows' per-process dedicated GPU counters, not whole-adapter usage. */
  gpuMemoryBytes: number | null;
  /** GPU-backed system RAM; deliberately separate from dedicated GPU memory. */
  gpuSharedMemoryBytes: number | null;
  gpuMemorySource: "windows-process-counters" | null;
}

const unavailable = (): MemoryUsage => ({ memoryBytes: null, gpuMemoryBytes: null, gpuSharedMemoryBytes: null, gpuMemorySource: null });
type ProcessRow = { pid: number; parent: number; bytes: number | null; born: number };
function bytes(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
const pid = (value: unknown): number | null => {
  const n = bytes(value);
  return n !== null && n > 0 && n <= 0xffffffff ? n : null;
};
function sum(values: (number | null)[]): number | null {
  if (values.some(n => n === null)) return null;
  const total = (values as number[]).reduce((a, b) => a + b, 0);
  return Number.isSafeInteger(total) ? total : null;
}

/** A single process/GPU snapshot; never include the PowerShell sampler or unrelated processes. */
export function windowsMemoryUsage(output: string, root: number | null, ownPid: number, ownRss: number): MemoryUsage {
  const data = JSON.parse(output.replace(/^\uFEFF/, ""));
  if (!Array.isArray(data.processes) || data.processes.length > 8192) return unavailable();
  const processes = new Map<number, ProcessRow>();
  for (const row of data.processes) {
    if (!row || typeof row !== "object") continue;
    const id = pid(row.pid), parent = bytes(row.parent), born = Date.parse(row.born);
    if (id === null) continue; // Idle/system entries may not have a creation time.
    if (parent === null || processes.has(id)) return unavailable();
    processes.set(id, { pid: id, parent, born, bytes: bytes(row.bytes) });
  }
  if (!processes.has(ownPid) || (root !== null && !processes.has(root))) return unavailable();
  const owned = new Set<number>(root === null || root === ownPid ? [] : [root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of processes.values()) {
      // A reused parent PID must not adopt a process born before the new parent.
      if (owned.has(row.parent) && !owned.has(row.pid)) {
        const parentBorn = processes.get(row.parent)!.born;
        if (!Number.isFinite(parentBorn) || !Number.isFinite(row.born)) return unavailable();
        if (parentBorn <= row.born) {
          owned.add(row.pid); changed = true;
          if (owned.size > 512) return unavailable();
        }
      }
    }
  }
  // The plugin is measured directly; its other children (including this sampler) are excluded.
  owned.delete(ownPid);
  const memoryBytes = sum([bytes(ownRss), ...[...owned].map(id => processes.get(id)!.bytes)]);
  owned.add(ownPid);
  if (!Array.isArray(data.gpu) || data.gpu.length > 32768) return { ...unavailable(), memoryBytes };
  const instances = new Map<string, { dedicated: number | null; shared: number | null }>();
  for (const row of data.gpu) {
    if (!row || typeof row.name !== "string") continue;
    const match = /^pid_(\d+)_luid_0x[0-9a-f]+_0x[0-9a-f]+_phys_\d+$/i.exec(row.name);
    if (!match || !owned.has(Number(match[1]))) continue;
    const value = { dedicated: bytes(row.dedicated), shared: bytes(row.shared) };
    const previous = instances.get(row.name);
    if (previous && (previous.dedicated !== value.dedicated || previous.shared !== value.shared)) return { ...unavailable(), memoryBytes };
    instances.set(row.name, value);
  }
  const gpuMemoryBytes = sum([...instances.values()].map(v => v.dedicated));
  const gpuSharedMemoryBytes = sum([...instances.values()].map(v => v.shared));
  return { memoryBytes, gpuMemoryBytes, gpuSharedMemoryBytes, gpuMemorySource: "windows-process-counters" };
}

// Read-only CIM class/property names are not localized performance-counter display names.
// A missing GPU provider must not discard a successful working-set measurement.
const script = `
$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,WorkingSetSize,CreationDate FROM Win32_Process' | ForEach-Object {
  $born = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
  @{pid=$_.ProcessId;parent=$_.ParentProcessId;bytes=$_.WorkingSetSize;born=$born}
})
$gpu = $null
try {
  $gpu = @(Get-CimInstance -Query 'SELECT Name,DedicatedUsage,SharedUsage FROM Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory' | ForEach-Object {
    @{name=$_.Name;dedicated=$_.DedicatedUsage;shared=$_.SharedUsage}
  })
} catch { $gpu = $null }
ConvertTo-Json -InputObject @{processes=$processes;gpu=$gpu} -Compress -Depth 4
`;

export async function sampleWindowsMemory(root: number | null, ownPid: number, ownRss: number): Promise<MemoryUsage> {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await exec(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  });
  return windowsMemoryUsage(stdout, root, ownPid, ownRss);
}
