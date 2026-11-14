import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import { paseoHome } from "./paths";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Candidate locations of the `paseo` CLI that ships with the desktop app, plus PATH. */
async function findPaseoCli(): Promise<string | null> {
  const candidates = [
    process.env.PASEO_CLI,
    // The plugin host runs under the app's bundled runtime on desktop installs.
    join(dirname(process.execPath), "paseo"),
    join(dirname(process.execPath), "..", "bin", "paseo"),
    process.platform === "darwin" ? "/Applications/Paseo.app/Contents/Resources/bin/paseo" : undefined,
    process.platform === "darwin" ? join(homedir(), "Applications/Paseo.app/Contents/Resources/bin/paseo") : undefined,
    process.platform === "linux" ? "/opt/Paseo/resources/bin/paseo" : undefined,
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Programs", "Paseo", "resources", "bin", "paseo.cmd")
      : undefined,
  ].filter((c): c is string => !!c);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  try {
    await execCommand("paseo", ["--version"], { timeout: 5000 });
    return "paseo";
  } catch {
    return null;
  }
}

/**
 * Ask the daemon to re-read config.json. Needed once after Voice Kit writes a key the SDK
 * cannot set (`providers.local.modelsDir`). Returns false when no CLI is available.
 */
export async function reloadDaemonConfig(): Promise<boolean> {
  const cli = await findPaseoCli();
  if (!cli) return false;
  try {
    await execCommand(cli, ["reload", "--json", "--home", paseoHome()], { timeout: 15_000 });
    return true;
  } catch (error) {
    console.error(`[voice-kit] paseo reload failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
