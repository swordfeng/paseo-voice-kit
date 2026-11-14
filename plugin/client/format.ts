import type { Phase } from "../shared/rpc";

/** The Voice Kit page: a screen (/voicekit, ⌘K) and the plugin's settings screen. */
export const SCREEN_ID = "voice-kit";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export function percent(done: number, total: number | null | undefined): string {
  return total ? `${Math.min(100, Math.floor((done / total) * 100))}%` : formatBytes(done);
}

export type Tone = "success" | "warning" | "danger" | "muted";

export function phaseTone(phase: Phase): Tone {
  if (phase === "ready") return "success";
  if (phase === "failed") return "danger";
  if (phase === "disabled") return "muted";
  return "warning";
}

