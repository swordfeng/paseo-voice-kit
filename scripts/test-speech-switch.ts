// Scenario test for the speech switch (how Voice Kit takes Paseo's voice settings over, hands
// them back, and respects changes made in Settings > Voice). Runs against a temporary
// PASEO_HOME with a fake Paseo API; never touches the real config or daemon.
//   npx esbuild scripts/test-speech-switch.ts --bundle --platform=node --format=esm --outfile=/tmp/vk-switch.mjs && node /tmp/vk-switch.mjs
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "vk-switch-"));
process.env.PASEO_HOME = home;
// Never reach the real daemon: `paseo reload` goes to a stub.
const fakeCli = join(home, "fake-paseo");
writeFileSync(fakeCli, "#!/bin/sh\necho {}\n", { mode: 0o755 });
process.env.PASEO_CLI = fakeCli;
const cfgPath = join(home, "config.json");
const OPENAI = { provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-real", model: "tts-1", voice: "alloy" };
writeFileSync(cfgPath, JSON.stringify({
  providers: { local: { modelsDir: "/x" } },
  features: { dictation: { stt: { provider: "local", model: "sense-voice" } }, voiceMode: { stt: { provider: "local", model: "sense-voice" }, tts: OPENAI } },
}));
const read = () => JSON.parse(readFileSync(cfgPath, "utf8"));
const write = (c: any) => writeFileSync(cfgPath, JSON.stringify(c));
let failNext = false;
let patchCalls = 0;
// Paseo's merge: same provider keeps other fields, a new provider replaces the site.
const paseo: any = {
  config: {
    get: async () => ({ config: read() }),
    patch: async ({ features }: any) => {
      patchCalls++;
      if (failNext) { failNext = false; throw new Error("simulated failure"); }
      const c = read();
      for (const [f, kinds] of Object.entries<any>(features)) for (const [k, v] of Object.entries<any>(kinds)) {
        const cur = c.features[f]?.[k];
        const next = cur && cur.provider === v.provider ? { ...cur, ...v } : { ...v };
        for (const [key, value] of Object.entries(next)) if (value === null) delete next[key];
        c.features[f] = { ...(c.features[f] ?? {}), [k]: next };
      }
      write(c);
    },
  },
};

const { SpeechSwitch } = await import("../plugin/server/speech-switch.ts");
const { loadState } = await import("../plugin/server/state.ts");
const sw = new SpeechSwitch(await loadState());
const K = "http://127.0.0.1:47615/v1";
const desired = (token: string | null, voice = "female-higher") => ({
  wanted: { dictation: true, voiceInput: true, voiceOutput: true },
  model: { dictation: "whisper", voiceInput: "whisper", voiceOutput: "voicekit-tts-chain" },
  waiting: { dictation: null, voiceInput: null, voiceOutput: null },
  voice, baseUrl: token ? K : null, token: token ?? "",
});
let failures = 0;
const check = (name: string, ok: boolean, extra?: unknown) => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " " + JSON.stringify(extra))); if (!ok) failures++; };
const tts = () => read().features.voiceMode.tts;
const dict = () => read().features.dictation.stt;
const st = (site: string) => sw.siteStatuses.find((s: any) => s.site === site);

sw.attach(paseo);
sw.setDesired(desired("T1")); await sw.reconcile();
check("1 takes over all sites", tts().baseUrl === K && tts().apiKey === "T1" && tts().voice === "female-higher" && dict().baseUrl === K, read().features);

// User picks another voice in Settings > Voice, keeping Voice Kit's server.
write({ ...read(), features: { ...read().features, voiceMode: { ...read().features.voiceMode, tts: { ...tts(), voice: "M3" } } } });
await sw.reconcile();
check("2 voice edit is kept, not reverted", tts().voice === "M3" && tts().baseUrl === K, tts());
check("2 shows as changed by user", st("voiceOutput")?.state === "override", st("voiceOutput"));

sw.setDesired(desired("T2")); await sw.reconcile();
check("3 server restart refreshes the key, keeps the voice", tts().apiKey === "T2" && tts().voice === "M3", tts());
check("3 managed sites get the new key", dict().apiKey === "T2", dict());

sw.setDesired(desired(null)); await sw.reconcile();
check("4 server down: edited site back to real OpenAI with its key", tts().baseUrl === OPENAI.baseUrl && tts().apiKey === "sk-real" && tts().voice === "alloy", tts());
check("4 server down: dictation back to local", dict().provider === "local" && dict().model === "sense-voice", dict());

sw.setDesired(desired("T3")); await sw.reconcile();
check("5 server back: user's voice on Voice Kit again", tts().baseUrl === K && tts().voice === "M3" && tts().apiKey === "T3", tts());

await sw.reclaim("voiceOutput");
check("6 Use Voice Kit: plugin voice again", tts().voice === "female-higher" && st("voiceOutput")?.state === "active", [tts(), st("voiceOutput")]);
sw.setDesired(desired(null)); await sw.reconcile();
check("6 then server down: still restores real OpenAI", tts().baseUrl === OPENAI.baseUrl && tts().apiKey === "sk-real", tts());

// A failed write must not look like a user edit.
sw.setDesired(desired("T4")); await sw.reconcile();
failNext = true;
sw.setDesired(desired("T4", "male-deep")); await sw.reconcile();
check("7 failed write leaves old voice", tts().voice === "female-higher", tts());
await sw.reconcile();
check("7 next pass retries, not an override", tts().voice === "male-deep" && st("voiceOutput")?.state === "active", [tts(), st("voiceOutput")]);

// Edit, then move the site somewhere else entirely.
write({ ...read(), features: { ...read().features, voiceMode: { ...read().features.voiceMode, tts: { ...tts(), voice: "F2" } } } });
await sw.reconcile();
write({ ...read(), features: { ...read().features, voiceMode: { ...read().features.voiceMode, tts: { provider: "local", model: "kokoro" } } } });
await sw.reconcile();
sw.setDesired(desired(null)); await sw.reconcile();
check("8 moved away by hand: left alone afterwards", tts().provider === "local" && tts().model === "kokoro", tts());

// Provider change still counts as taking it over.
sw.setDesired(desired("T5")); await sw.reconcile();
write({ ...read(), features: { ...read().features, dictation: { stt: { provider: "local", model: "parakeet" } } } });
await sw.reconcile();
check("9 provider change: override, untouched", dict().model === "parakeet" && st("dictation")?.state === "override", [dict(), st("dictation")]);

await sw.releaseAll();
check("10 turning off: managed voice input restored", read().features.voiceMode.stt.provider === "local", read().features.voiceMode.stt);
// Missing optional keys must be cleared on a same-provider restoration.
const original = { provider: "openai", baseUrl: "https://example.invalid/v1", apiKey: "previous-key" };
write({ ...read(), features: { ...read().features, voiceMode: { ...read().features.voiceMode, tts: original } } });
await sw.reclaim("voiceOutput");
sw.setDesired(desired("T6")); await sw.reconcile();
failNext = true;
sw.setDesired(desired(null)); await sw.reconcile();
const saved = JSON.parse(readFileSync(join(home, "plugin-data/voice-kit/state.json"), "utf8"));
check("11 rejected restore retains the previous credentials", saved.previous.voiceOutput?.apiKey === "previous-key", saved.previous);
check("11 rejected restore retains ownership", !!saved.managed.voiceOutput, saved.managed);
await sw.reconcile();
check("12 restore retry removes introduced model and voice", JSON.stringify(tts()) === JSON.stringify(original), tts());
check("12 successful restore removes recovery intent", !JSON.parse(readFileSync(join(home, "plugin-data/voice-kit/state.json"), "utf8")).managed.voiceOutput);

sw.setDesired(desired("T7")); await sw.reconcile();
failNext = true;
sw.setDesired(desired(null)); await sw.reconcile();
sw.setDesired(desired("T7")); await sw.reconcile();
const recovered = JSON.parse(readFileSync(join(home, "plugin-data/voice-kit/state.json"), "utf8"));
check("13 recovery before restoration clears the restoring flag", !recovered.managed.voiceOutput?.restoring);
write({ ...read(), features: { ...read().features, voiceMode: { ...read().features.voiceMode, tts: original } } });
await sw.reconcile();
check("14 a later manual restoration stays a user override", tts().baseUrl === original.baseUrl && st("voiceOutput")?.state === "override", [tts(), st("voiceOutput")]);

await sw.reclaim("voiceOutput");
write({ ...read(), features: { ...read().features, voiceMode: { ...read().features.voiceMode, tts: { ...tts(), voice: "F2" } } } });
await sw.reconcile();
failNext = true;
sw.setDesired(desired(null)); await sw.reconcile();
sw.setDesired(desired("T7")); await sw.reconcile();
const activeEdit = JSON.parse(readFileSync(join(home, "plugin-data/voice-kit/state.json"), "utf8"));
check("15 recovered edited site clears the parking intent", !activeEdit.edited.voiceOutput?.parking);
write({ ...read(), features: { ...read().features, voiceMode: { ...read().features.voiceMode, tts: original } } });
await sw.reconcile();
check("16 edited site's later manual restoration is respected", tts().baseUrl === original.baseUrl && st("voiceOutput")?.state === "override", [tts(), st("voiceOutput")]);
// Rejected first takeover survives both a later pass and reconstruction after plugin restart.
for (const restart of [false, true]) {
  write({ providers: { local: { modelsDir: "/fixture" } }, features: { dictation: { stt: { provider: "local", model: "original" } }, voiceMode: {} } });
  const first = new SpeechSwitch({ previous: {}, managed: {}, overrides: {}, edited: {} });
  first.attach(paseo); await first.reconcile();
  failNext = true;
  first.setDesired(desired("FIRST")); await first.reconcile();
  check("17 rejected initial takeover retains intent", !!JSON.parse(readFileSync(join(home, "plugin-data/voice-kit/state.json"), "utf8")).managed.dictation);
  const retry = restart ? new SpeechSwitch(await loadState()) : first;
  if (restart) { retry.setDesired(desired("FIRST")); retry.attach(paseo); }
  await retry.reconcile();
  check("17 first takeover retries" + (restart ? " after restart" : " in place"), dict().apiKey === "FIRST" && retry.siteStatuses[0]?.state === "active", [dict(), retry.siteStatuses]);
  await retry.releaseAll();
}
// A real edit while the initial patch is rejected remains an override (including API-key-only edits).
for (const restart of [false, true]) {
  write({ providers: { local: { modelsDir: "/fixture" } }, features: { dictation: { stt: { provider: "openai", baseUrl: "https://original.invalid", model: "original", apiKey: "old" } }, voiceMode: {} } });
  const first = new SpeechSwitch({ previous: {}, managed: {}, overrides: {}, edited: {} });
  first.attach(paseo); await first.reconcile(); failNext = true;
  first.setDesired(desired("FIRST")); await first.reconcile();
  const editedConfig = read(); editedConfig.features.dictation.stt.apiKey = "user-edit"; write(editedConfig);
  const retry = restart ? new SpeechSwitch(await loadState()) : first;
  if (restart) { retry.setDesired(desired("FIRST")); retry.attach(paseo); }
  await retry.reconcile();
  check("18 real external edit after rejection wins" + (restart ? " after restart" : ""), dict().apiKey === "user-edit" && retry.siteStatuses[0]?.state === "override", [dict(), retry.siteStatuses]);
  await retry.releaseAll();
}
// Simulate acceptance followed by a crash before saving applied=true. Same-provider extras merge.
write({ providers: { local: { modelsDir: "/fixture" } }, features: { dictation: { stt: { provider: "openai", baseUrl: "https://original.invalid", model: "original", apiKey: "old", extra: "keep" } }, voiceMode: {} } });
const interrupted = new SpeechSwitch({ previous: {}, managed: {}, overrides: {}, edited: {} });
interrupted.attach(paseo); await interrupted.reconcile(); failNext = true;
interrupted.setDesired(desired("CRASH")); await interrupted.reconcile();
const intents = await loadState(), accepted = read();
const locations: Record<string, [string, string]> = { dictation: ["dictation", "stt"], voiceInput: ["voiceMode", "stt"], voiceOutput: ["voiceMode", "tts"] };
for (const [site, intent] of Object.entries(intents.managed)) {
  const [feature, kind] = locations[site];
  accepted.features[feature][kind] = intent!.pending!.after;
}
write(accepted);
const recoveredSwitch = new SpeechSwitch(await loadState()), calls = patchCalls;
recoveredSwitch.setDesired(desired("CRASH")); recoveredSwitch.attach(paseo); await recoveredSwitch.reconcile();
check("19 accepted pending takeover finalizes after restart without rewriting", patchCalls === calls && recoveredSwitch.siteStatuses[0]?.state === "active" && dict().extra === "keep");
const external = read(); external.features.dictation.stt.model = "user-model"; write(external);
await recoveredSwitch.reconcile();
check("19 a later real edit remains an override", dict().model === "user-model" && recoveredSwitch.siteStatuses[0]?.state === "override");
console.log(failures ? failures + " FAILED" : "all passed");
process.exitCode = failures ? 1 : 0;
