// API keys of remote servers added as custom models. They live only on the daemon, in an
// owner-only file, never in plugin settings (which every connected Paseo app can read); settings
// keep `hasApiKey`. Like Paseo's own speech settings, a key can be written but not read back.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { paths } from "./paths";

interface Entry {
  apiKey: string;
  /** When the key was written, so a key saved just before its model is pruned only later. */
  at: number;
}
type Keys = Record<string, Entry>;

/** A key whose model isn't in the settings yet is kept this long (it is saved first). */
const UNCLAIMED_MS = 10 * 60_000;

const file = () => join(paths.data, "model-keys.json");
let queue: Promise<unknown> = Promise.resolve();

/** One read-modify-write at a time. */
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(work);
  queue = next;
  return next;
}

export async function readKeys(): Promise<Keys> {
  let text: string;
  try {
    text = await readFile(file(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, Entry] => typeof (entry[1] as Entry)?.apiKey === "string" && typeof (entry[1] as Entry)?.at === "number",
      ),
    );
  } catch (error) {
    // A damaged file loses the keys, not the models: they show as failing until re-entered.
    console.error(`[voice-kit] ${file()} is unreadable (${String(error)}); remote server keys need to be entered again`);
    return {};
  }
}

async function writeKeys(keys: Keys): Promise<void> {
  await mkdir(dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(keys, null, 2), { mode: 0o600 });
  await rename(tmp, file());
}

/** Save or (with null or "") remove the key of one custom model. */
export function setKey(id: string, apiKey: string | null, now = Date.now()): Promise<void> {
  return serialized(async () => {
    const keys = await readKeys();
    const value = apiKey?.trim();
    if (value) keys[id] = { apiKey: value, at: now };
    else delete keys[id];
    await writeKeys(keys);
  });
}

/** Drop keys of models that are no longer in the settings (after a grace period for new ones). */
export function pruneKeys(models: Iterable<string>, now = Date.now()): Promise<Keys> {
  return serialized(async () => {
    const keep = new Set(models);
    const keys = await readKeys();
    const stale = Object.entries(keys).filter(([id, entry]) => !keep.has(id) && now - entry.at > UNCLAIMED_MS);
    if (stale.length === 0) return keys;
    for (const [id] of stale) delete keys[id];
    await writeKeys(keys);
    return keys;
  });
}
