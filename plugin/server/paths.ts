import { homedir } from "node:os";
import { join } from "node:path";

export function paseoHome(): string {
  const fromEnv = process.env.PASEO_HOME?.trim();
  if (fromEnv) return fromEnv.startsWith("~") ? join(homedir(), fromEnv.slice(1)) : fromEnv;
  return join(homedir(), ".paseo");
}

export const paths = {
  get home() {
    return paseoHome();
  },
  get config() {
    return join(paseoHome(), "config.json");
  },
  /** Paseo's own local speech models; reused read-only. */
  get paseoModels() {
    return join(paseoHome(), "models", "local-speech");
  },
  get data() {
    return join(paseoHome(), "plugin-data", "voice-kit");
  },
  get models() {
    return join(this.data, "models");
  },
  get bin() {
    return join(this.data, "bin");
  },
  get state() {
    return join(this.data, "state.json");
  },
  get pidFile() {
    return join(this.data, "voicekit.pid");
  },
};

export const EXE = process.platform === "win32" ? "voicekit.exe" : "voicekit";
