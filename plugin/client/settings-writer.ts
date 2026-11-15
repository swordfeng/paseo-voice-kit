// Saves settings changes one at a time against the latest revision, so quick edits are not lost.
//
// Paseo's settings store rejects a save made against an old revision (another device, another
// tab, or an earlier save of ours that has not been displayed yet). Saving straight from a
// render would drop such edits silently. Instead:
// - patches queue and coalesce (later values for the same key win);
// - each save merges the queued patch onto the newest values and revision Paseo has shown;
// - after a save, the next one waits for Paseo to show the new revision;
// - a rejected save reloads and retries once on top of the fresh document; if that fails too, the
//   patch is dropped and reported, and the screen falls back to the saved values.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface SettingsDocument<V> {
  values: V;
  revision: string;
}

export interface SettingsPort<V> {
  /** The newest document Paseo has shown, or null while it is not loaded. */
  current(): SettingsDocument<V> | null;
  /** Resolves once Paseo shows a revision other than `revision`, or after a timeout. */
  revisionAfter(revision: string): Promise<void>;
  save(values: V, revision: string): Promise<boolean>;
  reload(): Promise<void>;
}

export type WriteFailure = { patch: Partial<unknown>; reason: string | null };
export type WriteResult = { ok: true } | { ok: false; reason: string | null };

/**
 * A copy with every `undefined` removed (object keys and array items). Paseo validates saved
 * settings as JSON values and rejects a document with an `undefined` anywhere in it.
 */
export function jsonSafe<T>(value: T): T {
  if (Array.isArray(value)) return value.filter((v) => v !== undefined).map((v) => jsonSafe(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = jsonSafe(v);
    return out as T;
  }
  return value;
}

export class SettingsWriter<V extends object> {
  private queued: Partial<V> | null = null;
  private queuedWaiters: ((result: WriteResult) => void)[] = [];
  /** The error thrown by the last failed save, when Paseo gave one. */
  private thrown: string | null = null;
  private inFlight: Partial<V> | null = null;
  private running = false;
  private idle: Promise<void> = Promise.resolve();

  constructor(
    private readonly port: SettingsPort<V>,
    private readonly onChange: () => void,
    private readonly onFailure: (failure: WriteFailure) => void,
    private readonly lastError: () => string | null = () => null,
    /**
     * A save that never answers (a remote host's connection dropped) would otherwise keep its
     * value on screen forever, hiding what the host and other devices saved since.
     */
    private readonly saveTimeoutMs = 15_000,
  ) {}

  /** Changes not yet confirmed by Paseo, newest last, for showing them right away. */
  pending(): Partial<V> {
    return { ...(this.inFlight ?? {}), ...(this.queued ?? {}) } as Partial<V>;
  }

  /** Queues a change; resolves once it is saved, or with the reason Paseo gave for refusing it. */
  update(patch: Partial<V>): Promise<WriteResult> {
    this.queued = { ...(this.queued ?? {}), ...patch } as Partial<V>;
    const result = new Promise<WriteResult>((resolve) => this.queuedWaiters.push(resolve));
    this.onChange();
    if (!this.running) this.idle = this.drain();
    return result;
  }

  /** Resolves when everything queued so far has been saved or reported. */
  settled(): Promise<void> {
    return this.idle;
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.queued) {
        const patch = this.queued;
        const waiters = this.queuedWaiters;
        this.queued = null;
        this.queuedWaiters = [];
        this.thrown = null;
        this.inFlight = patch;
        this.onChange();
        const first = await this.attempt(patch);
        let saved = first.ok;
        if (!saved) {
          // Rejected (usually a newer revision): load it and apply the patch on top, once. The
          // reloaded document reaches the screen a little later, so wait for it before retrying.
          await this.port.reload().catch(() => undefined);
          if (first.revision !== null) await this.port.revisionAfter(first.revision);
          saved = (await this.attempt(patch)).ok;
        }
        this.inFlight = null;
        const reason = saved ? null : (this.lastError() ?? this.thrown);
        if (!saved) this.onFailure({ patch, reason });
        for (const resolve of waiters) resolve(saved ? { ok: true } : { ok: false, reason });
        this.onChange();
      }
    } finally {
      this.running = false;
    }
  }

  private async attempt(patch: Partial<V>): Promise<{ ok: boolean; revision: string | null }> {
    const doc = this.port.current();
    if (!doc) return { ok: false, revision: null };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        this.thrown = "Saving timed out: the host didn't answer";
        resolve(false);
      }, this.saveTimeoutMs);
    });
    const saving = this.port.save(jsonSafe({ ...doc.values, ...patch }), doc.revision).catch((error: unknown) => {
      this.thrown = error instanceof Error ? error.message : String(error);
      return false;
    });
    const ok = await Promise.race([saving, timedOut]);
    clearTimeout(timer);
    // Wait until the saved document is shown, so the next save starts from it.
    if (ok) await this.port.revisionAfter(doc.revision);
    return { ok, revision: doc.revision };
  }
}

/** The subset of Paseo's useSettings() result the writer needs. */
export interface SettingsLike<V> {
  status: string;
  values?: V;
  revision?: string;
  saveError: string | null;
  save(values: V, revision: string): Promise<boolean>;
  reload(): Promise<void>;
}

const REVISION_WAIT_MS = 1500;

/**
 * React binding: `values` includes unsaved changes, `update` queues a patch, `failure` holds the
 * last change Paseo did not accept (cleared by the next successful change).
 */
export function useSettingsWriter<V extends object>(settings: SettingsLike<V>, onFailure: (failure: WriteFailure) => void) {
  const latest = useRef(settings);
  latest.current = settings;
  const failureRef = useRef(onFailure);
  failureRef.current = onFailure;
  const waiters = useRef<{ revision: string; resolve(): void }[]>([]);
  const [, setTick] = useState(0);

  const ready = settings.status === "ready" && settings.values !== undefined && settings.revision !== undefined;
  const revision = ready ? settings.revision : undefined;
  useEffect(() => {
    if (revision === undefined) return;
    const due = waiters.current.filter((w) => w.revision !== revision);
    waiters.current = waiters.current.filter((w) => w.revision === revision);
    for (const w of due) w.resolve();
  }, [revision]);

  const writer = useMemo(
    () =>
      new SettingsWriter<V>(
        {
          current: () => {
            const s = latest.current;
            return s.status === "ready" && s.values !== undefined && s.revision !== undefined ? { values: s.values, revision: s.revision } : null;
          },
          revisionAfter: (rev) =>
            new Promise<void>((resolve) => {
              const s = latest.current;
              if (s.status === "ready" && s.revision !== rev) return resolve();
              const waiter = { revision: rev, resolve };
              waiters.current.push(waiter);
              setTimeout(() => {
                waiters.current = waiters.current.filter((w) => w !== waiter);
                resolve();
              }, REVISION_WAIT_MS);
            }),
          save: (values, rev) => latest.current.save(values, rev),
          reload: () => latest.current.reload(),
        },
        () => setTick((n) => n + 1),
        (failure) => failureRef.current(failure),
        () => latest.current.saveError,
      ),
    [],
  );

  const values = ready ? ({ ...settings.values, ...writer.pending() } as V) : null;
  const update = useCallback((patch: Partial<V>) => void writer.update(patch), [writer]);
  /** Like update, but resolves with whether this change was saved. */
  const save = useCallback((patch: Partial<V>) => writer.update(patch), [writer]);
  return { values, update, save, writer };
}
