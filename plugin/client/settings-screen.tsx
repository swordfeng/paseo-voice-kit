import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  Loading,
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  logsRpc,
  modelsRpc,
  previewRpc,
  pullModelRpc,
  reclaimRpc,
  removeModelRpc,
  restartRpc,
  statusRpc,
  voicesRpc,
  type Model,
  type Site,
  type SiteStatus,
  type SpokenRun,
  type Status,
} from "../shared/rpc";
import { LANGUAGES, PREVIEW_LINES } from "../shared/languages";
import { DEFAULT_PORT, GGUF_QWEN_FAMILY, MLX_FAMILY_VALUES, preferences, type Preferences } from "../shared/settings";
import { CustomModelForm } from "./custom-model-form";
import { formatBytes, percent, phaseTone, type Tone } from "./format";
import {
  errorText,
  joinList,
  languageName,
  languageOptionLabel,
  modelLabel,
  noticeText,
  reasonText,
  sentences,
  urlHost,
  useText,
  DEVICE_NAMES,
  appleSilicon,
  voiceLabel,
  type Translate,
} from "./i18n";
import { Button, FieldWithAction, Tabs } from "./kit";
import { ModelManager, neuralHint } from "./model-manager";
import { useSettingsWriter } from "./settings-writer";
import { CHAIN_ROUTER_ID, isVisibleVoiceModel, nativeLanguages } from "./voice-chain";

type Tab = "listening" | "speaking" | "advanced";

const SITE_KEYS: Record<Site, "useForDictation" | "useForVoiceInput" | "useForVoiceOutput"> = {
  dictation: "useForDictation",
  voiceInput: "useForVoiceInput",
  voiceOutput: "useForVoiceOutput",
};
const SITE_USE = { dictation: "dictation", voiceInput: "voice_input", voiceOutput: "voice_output" } as const;

/**
 * Language choices: the languages the listening models understand (union when dictation and voice
 * mode use different models), in their own names, sorted by their name in the UI language. A saved
 * language the models do not list stays visible and says so. Values are speech-language codes; the
 * UI language only changes how they are shown.
 */
function languageOptions(t: Translate, locale: string, models: (Model | undefined)[], current: string) {
  const codes = new Set<string>();
  for (const m of models) for (const l of m?.languages ?? []) if (l !== "multi") codes.add(l);
  const options = [...codes]
    .map((code) => ({ code, sortName: languageName(code, locale) }))
    .sort((a, b) => a.sortName.localeCompare(b.sortName, locale))
    .map(({ code }) => ({ label: languageOptionLabel(code, locale), value: code }));
  const head = [{ label: t("listening.detectAutomatically"), value: "auto" }];
  if (current === "request") head.push({ label: t("listening.setByPaseo"), value: "request" });
  else if (current !== "auto" && !codes.has(current) && codes.size > 0)
    head.push({ label: t("listening.notSupported", { language: languageOptionLabel(current, locale) }), value: current });
  return [...head, ...options];
}

const SPEEDS = ["0.8", "0.9", "1", "1.1", "1.2", "1.35", "1.5"].map((v) => ({ label: v + "×", value: v }));

/** Idle choices in minutes, plus a value set elsewhere (for example from the CLI). */
function idleOptions(t: Translate, current: number) {
  const label = (minutes: number) =>
    minutes === 0 ? t("advanced.idleNever") : minutes % 60 === 0 ? t("advanced.idleHours", { n: minutes / 60 }) : t("advanced.idleMinutes", { n: minutes });
  const values = [0, 10, 30, 120];
  if (!values.includes(current)) values.push(current);
  return values.map((minutes) => ({ label: label(minutes), value: String(minutes) }));
}

/**
 * Debounce free-text inputs so typing does not save (and restart the server) per keystroke.
 * Leaving the screen saves the last text instead of dropping it.
 */
function useDebounced(fn: (value: string) => void, ms = 800) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ value: string } | null>(null);
  const latestFn = useRef(fn);
  latestFn.current = fn;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) latestFn.current(pending.current.value);
      pending.current = null;
    },
    [],
  );
  return useCallback(
    (value: string) => {
      if (timer.current) clearTimeout(timer.current);
      pending.current = { value };
      timer.current = setTimeout(() => {
        timer.current = null;
        const next = pending.current;
        pending.current = null;
        if (next) latestFn.current(next.value);
      }, ms);
    },
    [ms],
  );
}

export function SettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const { t, locale } = useText();
  const settings = useSettings(preferences);
  const toast = useToast();
  const queryClient = useQueryClient();
  const getStatus = useRpc(statusRpc);
  const getModels = useRpc(modelsRpc);
  const getVoices = useRpc(voicesRpc);
  const restart = useRpc(restartRpc);
  const preview = useRpc(previewRpc);
  const pull = useRpc(pullModelRpc);
  const remove = useRpc(removeModelRpc);
  const reclaim = useRpc(reclaimRpc);
  const getLogs = useRpc(logsRpc);
  const [tab, setTab] = useState<Tab>("listening");
  const [showLogs, setShowLogs] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replyRuns, setReplyRuns] = useState<SpokenRun[] | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  // Experimental options start collapsed, or open while one of them is on.
  const [experimental, setExperimental] = useState<boolean | null>(null);
  const [adding, setAdding] = useState<"stt" | "tts" | null>(null);

  const status = useQuery({ queryKey: ["voicekit", "status"], queryFn: () => getStatus({}), refetchInterval: 1500 });
  const running = !!status.data?.baseUrl;
  const models = useQuery({
    queryKey: ["voicekit", "models"],
    queryFn: () => getModels({}),
    enabled: running,
    refetchInterval: hasDownloads(status.data) ? 1500 : 15_000,
  });
  // Voices and per-model route state. Keyed by the voice configuration so enabling, reordering or
  // editing a voice model fetches fresh routes at once; while Speaking is open it refreshes on a
  // bounded interval (faster while a model cools down after an error) so loaded / unloaded state,
  // devices and errors stay current. Reading routes never loads a model.
  const voiceConfig = settings.status === "ready" ? voiceConfigKey(settings.values) : "";
  const voices = useQuery({
    queryKey: ["voicekit", "voices", status.data?.tts?.model, voiceConfig],
    queryFn: () => getVoices({}),
    // Also while speech as a whole is unavailable, so each model's reason shows.
    enabled: running,
    staleTime: 5_000,
    placeholderData: (previous) => previous,
    refetchInterval: (query) => {
      if (tab !== "speaking") return false;
      const cooling = query.state.data?.routes.some((r) => !!r.retryAfterSeconds);
      return cooling ? 3_000 : 10_000;
    },
  });
  const logs = useQuery({ queryKey: ["voicekit", "logs"], queryFn: () => getLogs({}), enabled: tab === "advanced" && showLogs, refetchInterval: 2000 });

  // Error toasts read the current language when they fire.
  const tRef = useRef(t);
  tRef.current = t;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["voicekit"] });
  const action = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: (error) => toast.error(errorText(tRef.current, error)),
  });
  // "Try a reply": the whole voice list, reporting which model read each part.
  const tryReply = useMutation({
    mutationFn: async (text: string) => {
      setReplyRuns(null);
      const audio = await preview({ text: text.trim() || undefined });
      setReplyRuns(audio.runs);
      await playPreview(audio, tRef.current);
      return audio.ms;
    },
    onError: (error) => toast.error(errorText(tRef.current, error)),
  });
  // A voice model's own preview, with the voice picked on its card.
  const previewModel = useMutation({
    mutationFn: async ({ id, voice, text }: { id: string; voice?: string; text: string }) => {
      setPreviewing(id);
      const audio = await preview({ model: id, voice, text });
      await playPreview(audio, tRef.current);
      return audio.ms;
    },
    onError: (error) => toast.error(errorText(tRef.current, error)),
    // The preview may have loaded the model: show its voices right away.
    onSettled: () => {
      setPreviewing(null);
      void queryClient.invalidateQueries({ queryKey: ["voicekit", "voices"] });
    },
  });

  const styles = useMemo(
    () => ({
      scroll: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 16 : 24, gap: layout.compact ? 16 : 22, maxWidth: 760, width: "100%" as const, alignSelf: "center" as const },
      statusRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 10, paddingVertical: 4 },
      dot: (tone: Tone) => ({
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor:
          tone === "success" ? theme.colors.statusSuccess : tone === "danger" ? theme.colors.statusDanger : tone === "warning" ? theme.colors.statusWarning : theme.colors.border,
      }),
      title: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      body: { color: theme.colors.foreground, fontSize: 14, lineHeight: 20 },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 10, paddingTop: 6 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      mono: { color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: layout.platform === "ios" ? "Menlo" : "monospace" },
      logBox: { maxHeight: 320, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
      card: { padding: 14, gap: 6 },
    }),
    [theme, layout.compact, layout.platform],
  );

  // Changes save one at a time against the newest revision; a change Paseo rejects is reported
  // and the saved value is shown again. Text fields keep what was typed.
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const { values, update: queueUpdate, save: saveNow } = useSettingsWriter<Preferences>(settings, ({ reason }) => {
    const message = sentences(tRef.current, tRef.current("status.saveFailed"), reason);
    setSaveFailure(message);
    toast.error(message);
  });
  const update = useCallback(
    (patch: Partial<Preferences>) => {
      setSaveFailure(null);
      queueUpdate(patch);
    },
    [queueUpdate],
  );
  const saveVocabulary = useDebounced(useCallback((text: string) => update({ vocabulary: text }), [update]));
  const saveBinaryPath = useDebounced(useCallback((text: string) => update({ binaryPath: text.trim() }), [update]));
  const savePort = useDebounced(
    useCallback(
      (text: string) => {
        const port = Number(text.trim());
        if (Number.isInteger(port) && port >= 1024 && port <= 65535) update({ port });
      },
      [update],
    ),
  );

  if (settings.status === "loading") return <Loading />;
  if (settings.status === "error" || settings.status === "invalid") {
    return (
      <View style={[styles.scroll, styles.content]}>
        <Text style={styles.danger}>{t("status.loadError", { error: settings.error })}</Text>
        <SettingsAction label={t("status.resetSettings")} actionLabel={t("status.reset")} onPress={() => void settings.reset()} />
      </View>
    );
  }
  if (!values) return <Loading />;

  const st = status.data;
  // Your own models show their saved name and languages right away, even while the server's model
  // list still reports the old ones. Qwen3-TTS keeps its fixed languages; an explicit empty list
  // (speech recognition with no languages given) stays empty.
  const modelList = (models.data?.models ?? []).map((m) => {
    const own = values.customModels.find((c) => c.id === m.id);
    if (!own) return m;
    const fixed = MLX_FAMILY_VALUES.has(own.family ?? "") || own.family === GGUF_QWEN_FAMILY;
    const languages = own.languages === undefined || fixed ? m.languages : own.languages;
    return { ...m, label: own.label, languages };
  });
  const byId = new Map(modelList.map((m) => [m.id, m]));
  const siteStatus = (site: Site): SiteStatus | undefined => st?.sites.find((s) => s.site === site);

  // What serves each use: the model reported active, else the chosen one (this computer's default
  // until the user picks one).
  const inUse: Partial<Record<"dictation" | "voice_input" | "voice_output", string>> = {};
  for (const site of Object.keys(SITE_USE) as Site[]) {
    const s = siteStatus(site);
    // Voices are a list, not one model: only what the server reports serves reading aloud.
    const configured = site === "dictation" ? values.dictationModel : site === "voiceInput" ? values.voiceInputModel : undefined;
    const chosen = configured === undefined ? undefined : configured || st?.defaultSttModel || undefined;
    const id = s?.state === "active" && s.model ? s.model : chosen;
    if (id) inUse[SITE_USE[site]] = id;
  }
  const chain = values.ttsModels;
  const qwenSpeed = atLeast(st?.binary.version, [0, 1, 1]);
  const experimentalOpen = experimental ?? values.neuralEngine;
  // Neural Engine setup state of the Whisper model in use for listening, if any.
  const whisperInUse = [values.dictationModel || st?.defaultSttModel, values.voiceInputModel || st?.defaultSttModel]
    .map((id) => byId.get(id ?? ""))
    .find((m) => m?.coreml);
  const neuralState = whisperInUse?.coreml ? neuralHint(t, whisperInUse.coreml.state, whisperInUse.coreml.seconds) : null;
  /** A model's name in the UI language: built-in names are translated, others shown as they are. */
  const labelOf = (id: string): string => {
    if (id === CHAIN_ROUTER_ID) return joinList(t, chain.map((c) => (c === CHAIN_ROUTER_ID ? c : labelOf(c))));
    const m = byId.get(id);
    return m ? modelLabel(t, m) : modelLabel(t, { id, label: id });
  };

  const routes = voices.data?.routes ?? [];
  /** "Supertonic 3 · F1": which model and voice read a part of a reply. */
  const spokenBy = (run: SpokenRun): string => {
    const voice = routes.find((r) => r.model === run.model)?.voices.find((v) => v.id === run.voice);
    return labelOf(run.model) + (run.voice ? " · " + (voice ? voiceLabel(t, locale, voice) : run.voice) : "");
  };
  // A model's preview line: the speech Language setting when the model speaks it, else its first language.
  const previewLine = (m: Model): string => {
    const languages = nativeLanguages(m);
    const language = languages.includes(values.language) ? values.language : languages[0] ?? "en";
    return PREVIEW_LINES[language] ?? PREVIEW_LINES.en;
  };
  // The listening models, for the Language choices.
  const listeningIds = [values.dictationModel, values.voiceInputModel].map((id) => id || st?.defaultSttModel || "").filter(Boolean);
  const listening = [...new Set(listeningIds)].map((id) => byId.get(id));
  const listeningNames = listening.filter((m): m is Model => !!m).map((m) => modelLabel(t, m));
  const removeCustom = (id: string) => {
    const patch: Partial<Preferences> = { customModels: values.customModels.filter((m) => m.id !== id) };
    // Do not leave a feature pointing at a model that no longer exists.
    // An empty choice uses this computer's default model.
    if (values.dictationModel === id) patch.dictationModel = "";
    if (values.voiceInputModel === id) patch.voiceInputModel = "";
    // Nor the voice model list, per-language choices or custom voices.
    if (values.ttsModels.includes(id)) patch.ttsModels = values.ttsModels.filter((x) => x !== id);
    if (Object.values(values.ttsLanguageModels).includes(id)) {
      patch.ttsLanguageModels = Object.fromEntries(Object.entries(values.ttsLanguageModels).filter(([, m]) => m !== id));
    }
    if (id in values.modelVoices) {
      const { [id]: _removed, ...rest } = values.modelVoices;
      patch.modelVoices = rest;
    }
    update(patch);
  };
  // Qwen3-TTS has no speed control: say so where its voices are used.
  const speedHint = () => {
    const enabled = chain.map((id) => byId.get(id)).filter((m): m is Model => !!m);
    // Speech servers from 0.1.1 change Qwen3-TTS's tempo after generating (keeping its pitch);
    // older ones read it at normal speed.
    const qwen = enabled.filter(isQwen);
    if (qwen.length === 0) return undefined;
    if (qwenSpeed) return t("speaking.speedQwen");
    return qwen.length === enabled.length ? t("speaking.speedQwenUnavailable") : t("speaking.speedQwenUnavailableMixed");
  };
  // Nothing to change when every enabled voice is Qwen3-TTS on a server that can't change its speed.
  const enabledVoices = chain.map((id) => byId.get(id)).filter((m): m is Model => !!m);
  const speedUnavailable = !qwenSpeed && enabledVoices.length > 0 && enabledVoices.every(isQwen);
  // The last reply Voice Kit couldn't read, and which models could help.
  const ttsError = (() => {
    const e = st?.ttsLastError;
    if (!e) return null;
    const names = joinList(t, e.languages.map((l) => languageName(l, locale)));
    if (e.code === "model_unavailable") return e.model ? t("speaking.unavailable", { model: labelOf(e.model) }) : t("speaking.unavailableGeneric", { languages: names });
    const groups = new Map<string, { names: string[]; langs: string[] }>();
    for (const m of modelList) {
      if (!isVisibleVoiceModel(m) || chain.includes(m.id)) continue;
      const langs = nativeLanguages(m).filter((l) => e.languages.includes(l));
      if (!langs.length) continue;
      const key = langs.join(",");
      groups.set(key, { names: [...(groups.get(key)?.names ?? []), modelLabel(t, m)], langs });
    }
    const helpers = [...groups.values()].map((g) => t("voiceModels.canSpeak", { model: joinList(t, g.names), languages: joinList(t, g.langs.map((l) => languageName(l, locale))) }));
    return sentences(t, t("speaking.unsupported", { languages: names }), ...helpers);
  })();
  const siteRow = (site: Site) => {
    const s = siteStatus(site);
    if (s?.state === "override") {
      return (
        <SettingsAction
          key={site}
          label={t(`sites.${site}`)}
          hint={s.reason ? reasonText(t, s.reason, labelOf) : t("sites.state.override")}
          actionLabel={t("sites.useVoiceKit")}
          onPress={() => action.mutate(() => reclaim({ site }))}
        />
      );
    }
    return (
      <SettingsSwitch
        key={site}
        label={t(`sites.${site}`)}
        hint={siteHint(t, site, s, labelOf, !!consent)}
        value={values[SITE_KEYS[site]]}
        disabled={!values.enabled || s?.state === "locked"}
        onValueChange={(on) => update({ [SITE_KEYS[site]]: on } as Partial<Preferences>)}
      />
    );
  };
  const modelManager = (kind: "stt" | "tts") => (
    <ModelManager
      theme={theme}
      compact={layout.compact}
      models={modelList}
      status={st}
      values={values}
      inUse={inUse}
      coremlSupported={models.data?.coremlSupported ?? false}
      busy={action.isPending}
      update={update}
      pull={(id) => action.mutate(() => pull({ id }))}
      remove={(id) => action.mutate(() => remove({ id }))}
      removeCustom={removeCustom}
      onAdd={() => setAdding(kind)}
      restart={() => action.mutate(() => restart({}))}
      saveSettings={async (patch) => {
        const result = await saveNow(patch);
        // Names and languages of your models feed the model list and voices: fetch them again.
        if (result.ok && patch.customModels) {
          void queryClient.invalidateQueries({ queryKey: ["voicekit"], predicate: (q) => q.queryKey[1] === "models" || q.queryKey[1] === "voices" });
        }
        return result;
      }}
      routes={routes}
      kind={kind}
      previewing={previewing}
      previewModel={(m, voice) => previewModel.mutate({ id: m.id, voice, text: previewLine(m) })}
    />
  );
  // First run: the speech server must be downloaded, and only with the user's permission.
  // Approval covers one archive (version and platform), so a new server version asks again.
  const consent = st?.notice?.code === "runtimeDownloadRequired" && values.enabled && !!st.notice.sha256 && values.approvedServerArchive !== st.notice.sha256 ? st.notice : null;
  const statusMessage = consent ? null : st?.notice ? noticeText(t, st.notice) : st?.message;
  const accel = acceleratorKey(st);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <SettingsCard>
        <View style={styles.card}>
          <View style={styles.statusRow}>
            <View style={styles.dot(consent ? "warning" : st ? phaseTone(st.phase) : "muted")} />
            <Text style={styles.title}>{consent ? t("consent.status") : st ? t(`phase.${st.phase}`) : t("app.checking")}</Text>
            {accel ? <Text style={styles.muted}>{"· " + t(accel)}</Text> : null}
          </View>
          {statusMessage ? <Text style={st?.phase === "failed" ? styles.danger : styles.muted}>{statusMessage}</Text> : null}
          {st?.install ? <Text style={styles.muted}>{t("status.downloadingServer", { progress: percent(st.install.downloaded, st.install.total) })}</Text> : null}
          {st && !st.connected ? <Text style={styles.muted}>{t("status.connecting")}</Text> : null}
          {downloadSummary(t, st, labelOf) ? <Text style={styles.muted}>{downloadSummary(t, st, labelOf)}</Text> : null}
          {saveFailure ? <Text style={styles.danger}>{saveFailure}</Text> : null}
        </View>
        <SettingsSwitch label={t("sites.master")} hint={t("sites.masterHint")} value={values.enabled} onValueChange={(enabled) => update({ enabled })} />
      </SettingsCard>

      {consent ? (
        <SettingsCard>
          <View style={styles.card}>
            <Text style={styles.title}>{t("consent.title")}</Text>
            <Text style={styles.body}>
              {urlHost(consent.url) ? t("consent.body", { host: urlHost(consent.url) ?? "" }) : t("consent.bodyNoSource")}
            </Text>
            {consent.url ? (
              <Text selectable style={styles.mono}>
                {consent.url}
              </Text>
            ) : null}
            <Text style={styles.muted}>{t("consent.models")}</Text>
            <Text style={styles.muted}>{t("consent.declineHint")}</Text>
            <View style={styles.actions}>
              <Button theme={theme} kind="primary" label={t("consent.install")} onPress={() => update({ approvedServerArchive: consent.sha256 ?? "" })} />
              <Button theme={theme} label={t("consent.decline")} onPress={() => update({ enabled: false })} />
            </View>
          </View>
        </SettingsCard>
      ) : null}

      <Tabs
        theme={theme}
        value={tab}
        options={[
          { value: "listening", label: t("listening.title") },
          { value: "speaking", label: t("speaking.title") },
          { value: "advanced", label: t("tabs.advanced") },
        ]}
        onChange={setTab}
      />

      {tab === "listening" ? (
        <>
          <SettingsSection title={t("sites.title")}>
            {siteRow("dictation")}
            {siteRow("voiceInput")}
          </SettingsSection>

          <SettingsSection title={t("listening.title")}>
            <SettingsSelect
              label={t("listening.language")}
              hint={listeningNames.length ? t("listening.languageHint", { models: joinList(t, listeningNames) }) : t("listening.languageHintGeneric")}
              value={values.language}
              options={languageOptions(t, locale, listening, values.language)}
              onValueChange={(language) => update({ language })}
            />
            <SettingsInput
              label={t("listening.vocabulary")}
              hint={t("listening.vocabularyHint")}
              placeholder="Paseo, Kubernetes, 张三"
              initialValue={values.vocabulary}
              onChangeText={saveVocabulary}
            />
          </SettingsSection>

          {modelManager("stt")}
        </>
      ) : null}

      {tab === "speaking" ? (
        <>
          <SettingsSection title={t("sites.title")}>{siteRow("voiceOutput")}</SettingsSection>
          {ttsError ? <Text style={styles.danger}>{ttsError}</Text> : null}

          <SettingsSection title={t("speaking.title")}>
            <SettingsSelect
              label={t("speaking.speed")}
              hint={speedHint()}
              disabled={speedUnavailable}
              value={String(values.speed)}
              options={SPEEDS}
              onValueChange={(v) => update({ speed: Number(v) })}
            />
            <SettingsRow
              label={t("speaking.tryReply")}
              hint={replyRuns?.length ? t("speaking.readBy", { list: joinList(t, replyRuns.map(spokenBy)) }) : t("speaking.tryReplyHint")}
            >
              <View style={{ width: layout.compact ? "100%" : 360, maxWidth: "100%" }}>
                <FieldWithAction
                  theme={theme}
                  value={replyText}
                  placeholder={t("speaking.tryReplyPlaceholder")}
                  accessibilityLabel={t("speaking.tryReply")}
                  onChangeText={setReplyText}
                  onSubmit={() => !tryReply.isPending && st?.tts?.available && tryReply.mutate(replyText)}
                  action={
                    <Button
                      theme={theme}
                      label={tryReply.isPending ? t("speaking.playing") : t("speaking.play")}
                      disabled={!st?.tts?.available || tryReply.isPending}
                      onPress={() => tryReply.mutate(replyText)}
                    />
                  }
                />
              </View>
            </SettingsRow>
          </SettingsSection>

          {modelManager("tts")}
        </>
      ) : null}

      {tab === "advanced" ? (
        <>
          <SettingsSection title={t("advanced.app")}>
            <SettingsSwitch
              label={t("advanced.showInSidebar")}
              hint={t("advanced.showInSidebarHint")}
              value={values.showInSidebar}
              onValueChange={(showInSidebar) => update({ showInSidebar })}
            />
          </SettingsSection>
          <SettingsSection title={t("advanced.server")}>
            <SettingsAction
              label={t("advanced.speechServer")}
              hint={
                st?.binary.version
                  ? t("advanced.version", {
                      version: st.binary.version,
                      source: t(st.binary.source === "local" ? "advanced.source.local" : st.binary.source === "setting" ? "advanced.source.setting" : "advanced.source.official"),
                    })
                  : undefined
              }
              actionLabel={t("advanced.restart")}
              disabled={!values.enabled || action.isPending}
              onPress={() => action.mutate(() => restart({}))}
            />
            <SettingsSelect
              label={t("advanced.acceleration")}
              hint={sentences(t, t("advanced.accelerationHint"), deviceSummary(t, st))}
              value={values.accelerator}
              options={[
                { label: t("advanced.automatic"), value: "auto" },
                { label: t("advanced.cpuOnly"), value: "cpu" },
              ]}
              onValueChange={(accelerator) => update({ accelerator })}
            />
            <SettingsSwitch
              label={t("models.autoDownload")}
              hint={t("models.autoDownloadHint")}
              value={values.autoDownload}
              onValueChange={(autoDownload) => update({ autoDownload })}
            />
            <SettingsSelect
              label={t("advanced.idle")}
              hint={t("advanced.idleHint")}
              value={String(values.idleUnloadMinutes)}
              options={idleOptions(t, values.idleUnloadMinutes)}
              onValueChange={(v) => update({ idleUnloadMinutes: Number(v) })}
            />
            <SettingsInput label={t("advanced.port")} hint={t("advanced.portHint", { port: DEFAULT_PORT })} initialValue={String(values.port)} onChangeText={savePort} />
            <SettingsInput
              label={t("advanced.binaryPath")}
              hint={t("advanced.binaryPathHint")}
              placeholder="/path/to/voicekit"
              initialValue={values.binaryPath}
              onChangeText={saveBinaryPath}
            />
            <SettingsAction label={t("advanced.serverLog")} actionLabel={showLogs ? t("advanced.hide") : t("advanced.show")} onPress={() => setShowLogs((v) => !v)} />
          </SettingsSection>
          {showLogs ? (
            <ScrollView style={styles.logBox}>
              <Text selectable style={styles.mono}>
                {(logs.data?.lines ?? []).slice(-150).join("\n") || t("advanced.noOutput")}
              </Text>
            </ScrollView>
          ) : null}
          {st ? <EngineLines t={t} status={st} textStyle={styles.muted} labelOf={labelOf} /> : null}

          {models.data?.coremlSupported ? (
            <View style={{ gap: 8 }}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: experimentalOpen }} onPress={() => setExperimental(!experimentalOpen)} hitSlop={6}>
                <Text style={{ color: theme.colors.accent, fontSize: 13 }}>
                  {experimentalOpen ? t("advanced.hideExperimental") + " ▴" : t("advanced.showExperimental") + " ▾"}
                </Text>
              </Pressable>
              {experimentalOpen ? (
                <SettingsSection title={t("advanced.experimental")}>
                  <SettingsSwitch
                    label={t("models.neural.label")}
                    hint={sentences(t, t("advanced.neuralHint"), neuralState)}
                    value={values.neuralEngine}
                    onValueChange={(neuralEngine) => update({ neuralEngine })}
                  />
                </SettingsSection>
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}

      <CustomModelForm
        open={adding !== null}
        kind={adding ?? "stt"}
        theme={theme}
        onClose={() => setAdding(null)}
        onSave={async (model) => {
          setSaveFailure(null);
          const result = await saveNow({ customModels: [...values.customModels, model] });
          if (!result.ok) return result.reason ?? "";
          setAdding(null);
          return null;
        }}
      />
    </ScrollView>
  );
}

/** "Found: Vulkan (NVIDIA GeForce RTX 3060)." or "No GPU found." */
function deviceSummary(t: Translate, status: Status | undefined): string | null {
  const devices = status?.devices ?? [];
  if (devices.length === 0) return null;
  const gpus = devices.filter((d) => d.type === "gpu" || d.type === "igpu").map((d) => d.backend + " (" + d.description + ")");
  return gpus.length ? t("advanced.found", { devices: gpus.join(t("common.listSeparator")) }) : t("advanced.noGpu");
}

function acceleratorKey(status: Status | undefined): "status.neuralAndGpu" | "status.usingGpu" | null {
  const engines = [...(status?.stt ?? []), ...(status?.tts ? [status.tts] : [])];
  const accels = new Set(engines.map((e) => e.accelerator).filter(Boolean));
  if (accels.has("neural-engine")) return "status.neuralAndGpu";
  if (accels.has("metal") || accels.has("mlx") || accels.has("mixed") || accels.has("cuda") || accels.has("vulkan")) return "status.usingGpu";
  return null;
}

/** One line about work in progress: model downloads and Neural Engine setup. */
function downloadSummary(t: Translate, status: Status | undefined, labelOf: (id: string) => string): string | null {
  const active = Object.entries(status?.downloads ?? {}).filter(([, d]) => !d.error && d.phase !== "done");
  if (active.length) {
    const [id, d] = active[0];
    const line = t("status.downloadingModel", { model: labelOf(id), progress: percent(d.downloaded, d.total ?? null) });
    return active.length > 1 ? line + " " + t("status.moreDownloads", { n: active.length - 1 }) : line;
  }
  if (Object.values(status?.coreml ?? {}).some((c) => c?.state === "compiling")) return t("status.neuralSetup");
  return null;
}

/** A Qwen3-TTS model (GGUF or MLX), whose speed is changed after generating. */
function isQwen(m: Model): boolean {
  return m.family === "qwen3_tts" || m.family === GGUF_QWEN_FAMILY;
}

/** Whether a version string ("0.1.1", "0.1.1-dev") is at least `min`. Unknown counts as no. */
function atLeast(version: string | null | undefined, min: number[]): boolean {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!parts) return false;
  const v = parts.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

/** What the voices RPC depends on in the settings: the ordered list and your own voice models. */
function voiceConfigKey(values: Preferences): string {
  const own = values.customModels.filter((m) => m.kind === "tts").map((m) => [m.id, m.label, m.location ?? m.hfRepo ?? m.baseUrl ?? "", (m.languages ?? []).join("+")].join(":"));
  return [values.ttsModels.join(","), own.join(",")].join("|");
}

function hasDownloads(status: Status | undefined): boolean {
  return (
    Object.values(status?.downloads ?? {}).some((d) => !d.error && d.phase !== "done") ||
    Object.values(status?.coreml ?? {}).some((c) => c?.state === "downloading" || c?.state === "compiling")
  );
}

function siteHint(t: Translate, site: Site, status: SiteStatus | undefined, labelOf: (id: string) => string, awaitingConsent = false): string {
  const base = t(`sites.${site}Hint`);
  if (!status || status.state === "off") return base;
  if (status.state === "active") return t("sites.activeWith", { model: status.model ? labelOf(status.model) : "" });
  if (status.state === "fallback" && awaitingConsent) return t("sites.state.fallback") + " · " + t("consent.status");
  // The structured reason, translated; the server's diagnostic only when it gives no reason.
  const detail = status.reason ? reasonText(t, status.reason, labelOf) : status.detail;
  if (status.state === "locked") return detail ?? t("sites.state.locked");
  return t(`sites.state.${status.state}`) + (detail ? " · " + detail : "");
}

const ACCELERATOR_NAMES: Record<string, string> = { ...DEVICE_NAMES, mixed: "Metal + CPU" };
const ENGINE_STATES = ["ready", "idle", "unloaded", "loading", "downloading", "missing", "failed"] as const;

function EngineLines({ t, status, textStyle, labelOf }: { t: Translate; status: Status; textStyle: object; labelOf: (id: string) => string }) {
  const engines = [...status.stt, ...(status.tts ? [status.tts] : [])];
  if (engines.length === 0) return null;
  return (
    <View style={{ gap: 2 }}>
      {engines.map((e) => {
        const state = (ENGINE_STATES as readonly string[]).includes(e.state) ? t(`advanced.engineState.${e.state as (typeof ENGINE_STATES)[number]}`) : e.state;
        const parts = [labelOf(e.model) + ": " + state];
        // The voice chain reports "idle" until one of its models is used.
        if (e.accelerator && e.accelerator !== "idle") parts.push(ACCELERATOR_NAMES[e.accelerator] ?? e.accelerator);
        if (e.p50_ms != null) parts.push(t("advanced.typical", { ms: e.p50_ms }));
        return (
          <Text key={e.model} style={textStyle}>
            {parts.join(" · ")}
          </Text>
        );
      })}
    </View>
  );
}

/** Set by index.client.tsx so surfaces can play audio through the client context. */
let player: ((audio: { base64: string; mimeType: string }) => Promise<void>) | null = null;

export function setAudioPlayer(play: typeof player) {
  player = play;
}

async function playPreview(audio: { base64: string; mimeType: string }, t: Translate) {
  if (!player) throw new Error(t("app.noPlayer"));
  await player(audio);
}
