// Regression test for the settings screen's save queue (plugin/client/settings-writer.ts): quick
// edits, debounced text saved after other changes, conflicting writes from elsewhere, and saves
// that keep failing. Uses a fake settings store with revisions and deferred saves, like Paseo's.
//   plugin/node_modules/.bin/esbuild scripts/test-settings-writer.ts --bundle --platform=node --format=esm --outfile=/tmp/vk-writer.mjs && node /tmp/vk-writer.mjs
import { SettingsWriter, type WriteFailure } from "../plugin/client/settings-writer";

type Prefs = { a: number; b: number; text: string; other: string };

/** A store that rejects stale revisions and shows new revisions a little after saving. */
class FakeStore {
  doc = { values: { a: 0, b: 0, text: "", other: "x" } as Prefs, revision: "r0" };
  shown = { ...this.doc };
  saves: { revision: string; ok: boolean }[] = [];
  failNext = 0;
  saveDelay = 5;
  /** The host stops answering: saves never settle. */
  hang = false;
  showDelay = 5;
  private n = 0;
  private listeners: (() => void)[] = [];

  /** Someone else (another device) writes the document. */
  external(patch: Partial<Prefs>) {
    this.doc = { values: { ...this.doc.values, ...patch }, revision: "r" + ++this.n + "x" };
  }
  private show() {
    setTimeout(() => {
      this.shown = { values: { ...this.doc.values }, revision: this.doc.revision };
      for (const l of this.listeners.splice(0)) l();
    }, this.showDelay);
  }
  port() {
    return {
      current: () => this.shown,
      revisionAfter: (revision: string) =>
        new Promise<void>((resolve) => {
          if (this.shown.revision !== revision) return resolve();
          this.listeners.push(resolve);
          setTimeout(resolve, 200);
        }),
      save: async (values: Prefs, revision: string) => {
        if (this.hang) return new Promise<boolean>(() => undefined);
        await new Promise((r) => setTimeout(r, this.saveDelay));
        const ok = this.failNext > 0 ? (this.failNext--, false) : revision === this.doc.revision;
        this.saves.push({ revision, ok });
        if (ok) {
          this.doc = { values: { ...values }, revision: "r" + ++this.n };
          this.show();
        }
        return ok;
      },
      // Like Paseo's hook: the reloaded document is shown on a later render.
      reload: async () => this.show(),
    };
  }
}

let failed = 0;
function expect(ok: boolean, what: string) {
  console.log((ok ? "PASS " : "FAIL ") + what);
  if (!ok) failed++;
}

function setup() {
  const store = new FakeStore();
  const failures: WriteFailure[] = [];
  let changes = 0;
  const writer = new SettingsWriter<Prefs>(store.port(), () => changes++, (f) => failures.push(f), () => "conflict");
  return { store, writer, failures, changes: () => changes };
}

{
  // Two quick changes before the first save returns: both must land.
  const { store, writer, failures } = setup();
  void writer.update({ a: 1 });
  void writer.update({ b: 2 });
  expect(writer.pending().a === 1 && writer.pending().b === 2, "1 unsaved changes are shown immediately");
  await writer.settled();
  expect(store.doc.values.a === 1 && store.doc.values.b === 2, "1 quick changes both saved");
  expect(store.saves.every((s) => s.ok), "1 no conflicts between our own saves");
  expect(failures.length === 0 && Object.keys(writer.pending()).length === 0, "1 nothing left pending");
}

{
  // A debounced text save fires after another change was saved: it must not undo that change.
  const { store, writer } = setup();
  await writer.update({ a: 5 });
  await writer.update({ text: "Kubernetes" });
  expect(store.doc.values.a === 5 && store.doc.values.text === "Kubernetes", "2 late text save keeps the earlier change");
}

{
  // Someone else saved meanwhile: our save conflicts, reloads, and applies on top of theirs.
  const { store, writer, failures } = setup();
  store.external({ other: "from another device" });
  await writer.update({ b: 7 });
  expect(store.saves.length === 2 && !store.saves[0].ok && store.saves[1].ok, "3 conflict retried once after reload");
  expect(store.doc.values.other === "from another device" && store.doc.values.b === 7, "3 both writes kept");
  expect(failures.length === 0, "3 no failure reported");
}

{
  // Saves keep failing: report once, drop the patch, show the saved value again.
  const { store, writer, failures } = setup();
  store.failNext = 2;
  await writer.update({ a: 9 });
  expect(failures.length === 1 && failures[0].reason === "conflict" && (failures[0].patch as Partial<Prefs>).a === 9, "4 failure reported with reason");
  expect(store.doc.values.a === 0 && writer.pending().a === undefined, "4 saved value shown after failure");
  await writer.update({ a: 3 });
  expect(store.doc.values.a === 3, "4 next change still saves");
}

{
  // Many changes while one save is slow: coalesced into few saves, last value wins.
  const { store, writer } = setup();
  store.saveDelay = 30;
  void writer.update({ a: 1 });
  for (let i = 2; i <= 10; i++) void writer.update({ a: i });
  await writer.settled();
  expect(store.doc.values.a === 10, "5 last value wins");
  expect(store.saves.length === 2, "5 coalesced into two saves (got " + store.saves.length + ")");
}

{
  // The store shows the new revision late (after the save resolves): the next save must wait for
  // it rather than conflict.
  const { store, writer } = setup();
  store.showDelay = 40;
  void writer.update({ a: 1 });
  await new Promise((r) => setTimeout(r, 10));
  void writer.update({ b: 1 });
  await writer.settled();
  expect(store.saves.every((s) => s.ok) && store.doc.values.a === 1 && store.doc.values.b === 1, "6 waits for the shown revision");
}

{
  // A save that never answers is reported and dropped, so the screen shows the host's values
  // (here written by another device) instead of the stuck change.
  const store = new FakeStore();
  const failures: WriteFailure[] = [];
  const writer = new SettingsWriter<Prefs>(store.port(), () => {}, (f) => failures.push(f), () => null, 30);
  store.hang = true;
  void writer.update({ a: 5 });
  store.external({ a: 9 });
  await new Promise((r) => setTimeout(r, 300));
  await writer.settled();
  expect(Object.keys(writer.pending()).length === 0, "7 a save that never answers is dropped");
  expect(failures.length === 1 && /timed out/.test(failures[0].reason ?? ""), "7 and reported as timed out");
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
