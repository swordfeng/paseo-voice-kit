// The sidebar row's short status: whether Voice Kit is actually in effect, what needs attention,
// and, while it works, the devices its loaded models run on and its memory use. No model names:
// those are on the Voice Kit page. Built only from the status the row already polls.
import type { Engine, SiteStatus, Status } from "../shared/rpc";
import type { Preferences } from "../shared/settings";
import { DEVICE_NAMES, joinList, type Translate } from "./i18n";
import { percent, phaseTone, type Tone } from "./format";
import { sidebarMemory } from "./sidebar-memory";

/** The setting that turns each feature on. */
const SITE_SWITCH = { dictation: "useForDictation", voiceInput: "useForVoiceInput", voiceOutput: "useForVoiceOutput" } as const;

/** A reply Voice Kit couldn't read is mentioned for this long. */
const RECENT_ERROR_MS = 5 * 60_000;

export interface SidebarSummary {
  /**
   * Texts for the row, most detailed first. The row shows the first that fits on one line; text is
   * never cut off.
   */
  candidates: string[];
  /** Kept on its own line so a narrow sidebar does not discard either memory figure. */
  memory?: string;
  /** Full description for assistive technology. */
  accessible: string;
  tone: Tone;
}

type DeviceClass = "gpu" | "npu" | "cpu";
/** Kind of device for each accelerator the server reports; "mixed" is Metal and CPU together. */
const CLASSES: Record<string, DeviceClass[]> = {
  metal: ["gpu"],
  mlx: ["gpu"],
  vulkan: ["gpu"],
  cuda: ["gpu"],
  directml: ["gpu"],
  coreml: ["npu"],
  "neural-engine": ["npu"],
  cpu: ["cpu"],
  mixed: ["gpu", "cpu"],
};

/** The accelerator a loaded engine actually uses, or null when it isn't loaded. */
function loaded(engine: Engine | null | undefined): string | null {
  return engine?.state === "ready" && engine.accelerator && engine.accelerator in CLASSES ? engine.accelerator : null;
}

export function sidebarSummary(
  t: Translate,
  status: Status | undefined,
  values: Pick<Preferences, "enabled" | (typeof SITE_SWITCH)[keyof typeof SITE_SWITCH]> | null,
  /** When the status was last fetched, so a same-data refetch still ages the reply error. */
  now: number = Date.now(),
  /** The last status request failed: don't keep showing an older, healthy summary. */
  unreachable = false,
): SidebarSummary {
  const state = (text: string, tone: Tone): SidebarSummary => ({ candidates: [text], accessible: t("app.sidebarStatus", { status: text }), tone });
  if (unreachable) return state(t("sidebar.unreachable"), "danger");
  if (!status) return { candidates: [], accessible: t("app.sidebarStatus", { status: t("app.checking") }), tone: "muted" };

  // Exceptions first: each replaces the normal summary.
  if (values && !values.enabled) return state(t("sidebar.off"), "muted");
  if (!status.connected) return state(t("sidebar.connecting"), "warning");
  if (status.notice?.code === "runtimeDownloadRequired") return state(t("sidebar.needsPermission"), "warning");
  if (status.phase !== "ready" && status.phase !== "degraded") return state(t(`phase.${status.phase}`), phaseTone(status.phase));
  const downloading = Object.values(status.downloads).find((d) => !d.error && d.phase !== "done");
  if (downloading) return state(t("sidebar.downloading", { progress: percent(downloading.downloaded, downloading.total ?? null) }), "warning");
  const error = status.ttsLastError;
  if (error && (error.at === undefined || now - error.at < RECENT_ERROR_MS)) return state(t("sidebar.replyNotRead"), "warning");

  // In effect: features Voice Kit should handle that Paseo actually routes to it. Which ones it
  // should handle comes from their switches: a feature turned off still reports "override" or
  // "locked" when Paseo's own setting is changed or locked. Until settings load, "off" stands in.
  // Speaking with no voice model enabled is the user's choice too, not a failure.
  const wanted = status.sites.filter((s) => (values ? values[SITE_SWITCH[s.site]] : s.state !== "off") && s.reason?.code !== "noVoiceModels");
  const active = wanted.filter((s) => s.state === "active");
  const featureNames = (sites: SiteStatus[]) => joinList(t, sites.map((s) => t(`sites.${s.site}`)));
  const phase = t("sidebar.a11yPhase", { phase: t(`phase.${status.phase}`) });
  if (!wanted.length) return { candidates: [t("sidebar.notInUse")], accessible: t("app.sidebarStatus", { status: t("sidebar.notInUse") }), tone: "muted" };
  const notActive = wanted.filter((s) => s.state !== "active");
  const effect = [
    active.length ? t("sidebar.a11yInEffect", { features: featureNames(active) }) : null,
    notActive.length ? t("sidebar.a11yNotInEffect", { features: featureNames(notActive) }) : null,
  ];
  if (!active.length) {
    return { candidates: [t("sidebar.notInEffect")], accessible: [phase, ...effect].filter(Boolean).join(" "), tone: "warning" };
  }

  // Devices the loaded models of active features run on right now; nothing when they're unloaded.
  const accelerators = new Set<string>();
  for (const s of active) {
    const engine = s.site === "voiceOutput" ? status.tts : status.stt.find((e) => e.model === s.model);
    const acc = loaded(engine);
    if (acc) accelerators.add(acc);
  }
  const classes = new Set([...accelerators].flatMap((a) => CLASSES[a]));
  const device = (["gpu", "npu", "cpu"] as const).filter((k) => classes.has(k)).map((k) => t(`sidebar.${k}`)).join("+");
  const deviceNames = [...new Set([...accelerators].flatMap((a) => (a === "mixed" ? ["metal", "cpu"] : [a])).map((a) => DEVICE_NAMES[a] ?? a))];
  const memory = sidebarMemory(status, classes.has("gpu"));

  const full = active.length === wanted.length;
  const lead = full ? t("sidebar.on") : t("sidebar.partial", { active: active.length, total: wanted.length });
  const join = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  // Detail drops before the in-effect word, except that a green dot already says "on".
  const candidates = [join(lead, device), full && device ? device : "", lead];

  const accessible = [
    phase,
    ...effect,
    deviceNames.length ? t("sidebar.a11yDevices", { devices: joinList(t, deviceNames) }) : t("sidebar.a11yNoneLoaded"),
    memory?.dedicated !== null && memory?.dedicated !== undefined ? t("sidebar.a11yGpuMemory", { size: memory.dedicated }) : null,
    memory ? t("sidebar.a11yMemory", { size: memory.resident }) : null,
  ];
  return {
    candidates: [...new Set(candidates.filter(Boolean))],
    memory: memory?.text,
    accessible: accessible.filter(Boolean).join(" "),
    tone: full ? phaseTone(status.phase) : "warning",
  };
}
