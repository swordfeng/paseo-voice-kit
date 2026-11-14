import type { Phase } from "../shared/rpc";
import type { Preferences } from "../shared/settings";
import type { SupervisorSnapshot } from "./supervisor";

/** The native server may also track voices which the user has switched off in Paseo. */
export function featurePhase(prefs: Preferences | null, snap: SupervisorSnapshot): Phase {
  if (!prefs?.enabled) return "disabled";
  if (!snap.health || !["ready", "degraded", "loading", "failed"].includes(snap.phase)) return snap.phase;
  const health = snap.health;
  const recognition = [
    ...(prefs.useForDictation ? [prefs.dictationModel] : []),
    ...(prefs.useForVoiceInput ? [prefs.voiceInputModel] : []),
  ];
  // Recognition can temporarily use the other configured recognizer, as computeDesired does.
  const listeningReady = health.stt.some(e => e.available && recognition.includes(e.model));
  const available = recognition.map(() => listeningReady);
  if (prefs.useForVoiceOutput && prefs.ttsModels.length) available.push(!!health.tts?.available);
  if (!available.length) return "disabled";
  if (available.every(Boolean)) return "ready";
  if (available.some(Boolean)) return "degraded";
  return snap.phase === "ready" ? "loading" : snap.phase;
}
