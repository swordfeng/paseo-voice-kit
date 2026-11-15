// The Models tab: every model as a card with its state and actions, grouped by kind.
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink, SettingsInput, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { MODEL_LICENSES } from "../shared/model-licenses";
import { setModelKeyRpc, type Model, type RouteVoices, type Status } from "../shared/rpc";
import { GGUF_QWEN_FAMILY, MLX_FAMILY_VALUES, effectiveApproximateLanguages, modelVoice, type CustomModel, type Preferences } from "../shared/settings";
import { LanguagePicker } from "./custom-model-form";
import { MlxRuntimeStatus } from "./mlx-runtime";
import type { WriteResult } from "./settings-writer";
import { formatBytes, percent } from "./format";
import { DEVICE_NAMES, appleSilicon, joinList, languageName, languageOptionLabel, modelDescription, modelLabel, useText, usedByLabel, voiceLabel, type Translate } from "./i18n";
import { coverage, isVisibleVoiceModel, move, nativeLanguages } from "./voice-chain";
import { Badge, Button, Chip, Heading, ProgressBar } from "./kit";

type Use = "dictation" | "voice_input" | "voice_output";
/** Listening features and the setting that picks each one's model. */
type ListenUse = Exclude<Use, "voice_output">;
const USE_KEY: Record<ListenUse, "dictationModel" | "voiceInputModel"> = {
  dictation: "dictationModel",
  voice_input: "voiceInputModel",
};

function languageSummary(t: Translate, locale: string, languages: string[]): string {
  if (languages.includes("multi")) return t("models.manyLanguages");
  if (languages.length > 4) return t("models.languageCount", { n: languages.length });
  return joinList(t, languages.map((l) => languageName(l, locale)));
}

/** Devices a model is running on right now: its own engine, or its place in the voice chain. */
function liveDevices(m: Model, status: Status | undefined, routes: RouteVoices[]): string[] {
  const out = new Set<string>();
  const engine = [...(status?.stt ?? []), ...(status?.tts ? [status.tts] : [])].find((e) => e.model === m.id);
  // Only a loaded engine's device counts; a loading one may still report an earlier device.
  if (engine?.accelerator && engine.state === "ready" && DEVICE_NAMES[engine.accelerator]) {
    out.add(engine.accelerator);
  }
  for (const r of routes) {
    if (r.model === m.id && r.ready && r.accelerator && DEVICE_NAMES[r.accelerator]) out.add(r.accelerator);
  }
  return [...new Set([...out].map((a) => DEVICE_NAMES[a]))];
}

/**
 * What a model can run on, and what it runs on now. Capability chips: Whisper and GGUF models run
 * on the CPU or a GPU; sherpa-onnx models on the CPU; MLX models on an Apple Silicon GPU only. The
 * GPU chip says so when no GPU was found or Acceleration is CPU only. A loaded model adds a chip
 * with the device it actually uses; nothing claims a GPU is in use otherwise.
 */
function hardwareChips(t: Translate, m: Model, status: Status | undefined, routes: RouteVoices[], accelerator: string): string[] {
  if (m.engine === "openai") return [t("models.engine.remote")];
  const live = liveDevices(m, status, routes);
  const running = live.length ? [t("models.engine.runsOn", { device: joinList(t, live) })] : [];
  const devices = status?.devices ?? [];
  const gpuFound = devices.length === 0 || devices.some((d) => d.type === "gpu" || d.type === "igpu");
  const gpu = accelerator === "cpu" ? t("models.engine.gpuOff") : gpuFound ? t("models.engine.gpu") : t("models.engine.gpuNone");
  if (m.engine === "mlx") {
    if (appleSilicon(status?.devices) === false) return [t("models.engine.appleSiliconOnly")];
    return [accelerator === "cpu" ? t("models.engine.skippedOnCpu") : t("models.engine.gpu"), ...running];
  }
  if (m.engine === "whisper" || m.engine === "gguf") return [t("models.engine.cpu"), gpu, ...running];
  return [t("models.engine.cpu"), ...running];
}

export interface ModelManagerProps {
  theme: PluginTheme;
  compact: boolean;
  models: Model[];
  status: Status | undefined;
  values: Preferences;
  /** Models serving each use (this computer's default until the user picks one). */
  inUse: Partial<Record<Use, string>>;
  coremlSupported: boolean;
  busy: boolean;
  update(patch: Partial<Preferences>): void;
  pull(id: string): void;
  remove(id: string): void;
  removeCustom(id: string): void;
  /** Saves a settings change and reports whether Paseo accepted it. */
  saveSettings(patch: Partial<Preferences>): Promise<WriteResult>;
  onAdd(): void;
  /** Restart the speech server, which also reloads custom models. */
  restart(): void;
  /** Voice routes (one per model in the ordered list) with their device and state, when known. */
  routes: RouteVoices[];
  /** Which list is shown: speech recognition or voices. */
  kind: "stt" | "tts";
  /** A voice model's own preview with the voice on its card; `previewing` is the model playing. */
  previewModel(model: Model, voice: string | undefined): void;
  previewing: string | null;
}

/** The model chosen for a listening feature: the saved one, else this computer's default. */
function chosenModel(values: Preferences, status: Status | undefined, use: ListenUse): string {
  return values[USE_KEY[use]] || status?.defaultSttModel || "";
}

/** Recommended models first; otherwise catalog order. */
function recommendedFirst(list: Model[]): Model[] {
  return [...list.filter((m) => m.tier === "recommended"), ...list.filter((m) => m.tier !== "recommended")];
}

export function ModelManager(props: ModelManagerProps) {
  const { theme, models, values, status } = props;
  const { t } = useText();
  const { kind } = props;
  // Internal models (Whisper base, the language detector) only show once they are on disk.
  const list = models.filter((m) => m.kind === kind && (m.tier !== "internal" || m.installed || m.active));
  const chosen = new Set((["dictation", "voice_input"] as const).map((u) => chosenModel(values, status, u)).filter(Boolean));
  const selected = list.filter((m) => chosen.has(m.id));
  const others = recommendedFirst(list.filter((m) => !chosen.has(m.id) && m.tier !== "custom"));
  const yours = list.filter((m) => !chosen.has(m.id) && m.tier === "custom");
  const customById = new Map(values.customModels.map((c) => [c.id, c]));
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 };

  return (
    <View style={{ gap: 14 }}>
      {models.length === 0 ? <Text style={muted}>{t("models.startToManage")}</Text> : null}
      {kind === "tts" && models.length > 0 ? <VoiceModels {...props} customById={customById} /> : null}

      {kind === "stt" && models.length > 0 ? (
        <>
          <Heading theme={theme} title={t("models.selected")} />
          <Text style={muted}>{t("models.selectedIntro")}</Text>
          {selected.map((m) => (
            <ModelCard key={m.id} {...props} model={m} custom={customById.get(m.id)} />
          ))}

          {others.length ? <Heading theme={theme} title={t("models.otherModels")} /> : null}
          {others.map((m) => (
            <ModelCard key={m.id} {...props} model={m} />
          ))}

          <Heading theme={theme} title={t("models.yourModels")} trailing={<Button theme={theme} label={t("models.addModel")} onPress={props.onAdd} />} />
          {yours.length === 0 ? <Text style={muted}>{t("models.yourModelsEmpty")}</Text> : null}
          {yours.map((m) => (
            <ModelCard key={m.id} {...props} model={m} custom={customById.get(m.id)} />
          ))}
        </>
      ) : null}
    </View>
  );
}

function ModelCard(props: ModelManagerProps & { model: Model; custom?: CustomModel; actions?: ReactNode; extra?: ReactNode; highlight?: boolean; enabled?: boolean; order?: number }) {
  const { theme, model: m, models, status, values, compact, busy } = props;
  const { t, locale } = useText();
  const [editing, setEditing] = useState(false);
  const c = theme.colors;
  const dl = status?.downloads[m.id] ?? m.download ?? null;
  const downloading = !!dl && !dl.error && dl.phase !== "done";
  const failed = dl?.error && !m.installed ? dl.error : null;
  const remote = m.engine === "openai";
  // Any speech recognition model can serve both listening features.
  // Voices are chosen through the ordered list (actions), not a per-use button.
  const uses: ListenUse[] = m.tier === "internal" || props.actions !== undefined || m.kind !== "stt" ? [] : ["dictation", "voice_input"];
  // Features this model is chosen for (a choice, not a claim that it is loaded or running).
  const chosen = (u: ListenUse) => chosenModel(values, status, u);
  const usedFor = uses.filter((u) => chosen(u) === m.id);
  const isDefault = usedFor.some((u) => !values[USE_KEY[u]]);
  // Qwen3-TTS (MLX) runs only on Apple Silicon.
  const unsupported = m.engine === "mlx" && appleSilicon(status?.devices) === false;
  // Removable: Voice Kit's own files, or Paseo's shared cache (removed for both), when nothing uses
  // them. Files borrowed from elsewhere stay.
  const ownFiles = !m.shared || !!m.sharedWithPaseo;
  const removable = m.installed && !remote && ownFiles && !m.active && !m.paseoInUse && !downloading && !props.enabled && m.tier !== "custom";
  // A custom model whose files or config are broken: nothing to use or download until fixed.
  const broken = m.unavailable ?? null;
  const canUse = !broken && !unsupported && (m.installed || remote || values.autoDownload);
  const description = modelDescription(t, m);
  const license = MODEL_LICENSES[m.id];
  // The server names the model that needs this one by its English label.
  const labelByEnglish = (label: string) => {
    const owner = models.find((o) => o.label === label);
    return owner ? modelLabel(t, owner) : label;
  };

  return (
    <View style={{ borderWidth: 1, borderColor: usedFor.length || props.highlight ? c.accent : c.border, borderRadius: 12, backgroundColor: c.surface1, padding: compact ? 12 : 14, gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {props.order ? <Text style={{ color: c.foregroundMuted, fontSize: 15, fontWeight: "600", marginRight: -4 }}>{props.order + "."}</Text> : null}
        <Text style={{ color: c.foreground, fontSize: 15, fontWeight: "600" }}>{modelLabel(t, m)}</Text>
        {usedFor.map((u) => (
          <Badge key={u} theme={theme} tone="accent">
            {t(`models.use.${u}`)}
          </Badge>
        ))}
        {isDefault ? <Badge theme={theme}>{t("models.computerDefault")}</Badge> : null}
        {/* "Language detection" for Whisper base; voice models show their place in the list instead. */}
        {m.usedBy && m.kind === "stt" && !usedFor.length ? (
          <Badge theme={theme} tone="accent">
            {usedByLabel(t, m.usedBy, labelByEnglish)}
          </Badge>
        ) : null}
        {m.tier === "recommended" && !(m.kind === "stt" && m.usedBy) && !unsupported ? (
          <Badge theme={theme} tone="success">
            {t("models.recommendedBadge")}
          </Badge>
        ) : null}
        {m.tier === "custom" ? <Badge theme={theme}>{t("models.yours")}</Badge> : null}
      </View>
      {description && description !== broken ? <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{description}</Text> : null}
      {broken ? (
        <View style={{ gap: 2 }}>
          <Text selectable style={{ color: c.statusDanger, fontSize: 12 }}>{t("models.unavailable", { error: broken })}</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("models.unavailableHint")}</Text>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {m.languages.length ? <Chip theme={theme}>{languageSummary(t, locale, m.languages)}</Chip> : null}
        {!remote && m.sizeBytes > 0 ? <Chip theme={theme}>{formatBytes(m.sizeBytes)}</Chip> : null}
        {hardwareChips(t, m, status, props.routes, values.accelerator).map((chip) => (
          <Chip key={chip} theme={theme}>
            {chip}
          </Chip>
        ))}
        {license ? (
          <ExternalLink href={license.url} accessibilityLabel={t("models.licenseLink", { name: license.name, model: modelLabel(t, m) })}>
            {/* ExternalLink adds its own arrow icon. */}
            <Chip theme={theme}>{t("models.license", { name: license.name })}</Chip>
          </ExternalLink>
        ) : null}
        {m.installed && !remote ? (
          <Chip theme={theme}>
            {m.sharedWithPaseo ? t("models.sharedCache") : !m.shared ? t("models.installed") : m.tier === "custom" ? t("models.yourFiles") : t("models.sharedWithPaseo")}
          </Chip>
        ) : null}
      </View>

      {downloading ? (
        <View style={{ gap: 4 }}>
          <ProgressBar theme={theme} fraction={dl.total ? dl.downloaded / dl.total : null} />
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {dl.phase === "unpacking" ? t("models.unpacking") : t("models.downloading", { progress: percent(dl.downloaded, dl.total) })}
          </Text>
        </View>
      ) : null}
      {failed ? <Text style={{ color: c.statusDanger, fontSize: 12 }}>{t("models.downloadFailed", { error: failed })}</Text> : null}
      {unsupported ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("models.unsupported")}</Text> : null}
      {license?.note ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t(`models.licenseNote.${license.note}`)}</Text> : null}
      {props.extra}
      {props.enabled && m.installed && !remote && (!m.shared || m.tier === "custom") ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("models.disableToRemove")}</Text> : null}
      {props.enabled === false && m.installed && m.shared && !m.sharedWithPaseo && m.tier !== "custom" ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("models.reusedNoRemove")}</Text> : null}
      {m.installed && m.sharedWithPaseo ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{m.paseoInUse ? t("models.paseoInUse") : t("models.removesForPaseo")}</Text>
      ) : null}

      {m.engine === "mlx" && m.tier === "custom" ? <MlxRuntimeStatus theme={theme} /> : null}
      {editing && props.custom ? <CustomEditor {...props} model={m} custom={props.custom} onDone={() => setEditing(false)} /> : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: compact ? "flex-start" : "flex-end" }}>
        {props.actions}
        {props.custom && !editing ? <Button theme={theme} label={t("models.edit")} disabled={busy} onPress={() => setEditing(true)} /> : null}
        {uses
          .filter((u) => chosen(u) !== m.id)
          .map((u) => (
            <Button
              key={u}
              theme={theme}
              label={t(`models.useFor.${u}`)}
              disabled={busy || !canUse}
              onPress={() => props.update({ [USE_KEY[u]]: m.id } as Partial<Preferences>)}
            />
          ))}
        {broken ? <Button theme={theme} label={t("models.restartServer")} disabled={busy} onPress={props.restart} /> : null}
        {!m.installed && !remote && !downloading && !unsupported && !broken ? (
          <Button theme={theme} label={t("models.download", { size: formatBytes(m.sizeBytes) })} disabled={busy} onPress={() => props.pull(m.id)} />
        ) : null}
        {/* Not while enabled, nor while the server uses it. */}
        {removable ? (
          <Button theme={theme} kind="danger" label={t("models.remove")} disabled={busy} onPress={() => props.remove(m.id)} />
        ) : null}
        {props.custom && !props.enabled ? <Button theme={theme} kind="danger" label={t("models.remove")} disabled={busy} onPress={() => props.removeCustom(m.id)} /> : null}
      </View>
    </View>
  );
}

/** The Neural Engine setup state, or null while it is off. */
export function neuralHint(t: Translate, state: string | undefined, seconds: number | undefined): string | null {
  switch (state) {
    case "installed":
      return t("models.neural.installed");
    case "downloading":
      return t("models.neural.downloading");
    case "compiling":
      return t("models.neural.compiling", { seconds: seconds ?? 0 });
    case "failed":
      return t("models.neural.failed");
    default:
      return null;
  }
}

/**
 * Voices: the ordered list of enabled voice models, the languages they cover, and the models that
 * can be added. Each sentence uses the first enabled model that natively speaks its language.
 */
function VoiceModels(props: ModelManagerProps & { customById: Map<string, CustomModel> }) {
  const { theme, models, status, values, busy, routes, customById } = props;
  const { t, locale } = useText();
  const [details, setDetails] = useState(false);
  const c = theme.colors;
  const muted = { color: c.foregroundMuted, fontSize: 13, lineHeight: 18 };
  const chain = values.ttsModels;
  const byId = new Map(models.map((m) => [m.id, m]));
  const enabled = chain.map((id) => byId.get(id)).filter((m): m is Model => !!m && isVisibleVoiceModel(m));
  const voiceModels = models.filter(isVisibleVoiceModel);
  const write = (ttsModels: string[]) => props.update({ ttsModels });
  const approximateNow = effectiveApproximateLanguages(values);
  const unsupported = (m: Model) => m.engine === "mlx" && appleSilicon(status?.devices) === false;
  const label = (m: Model) => modelLabel(t, m);

  const routeOf = (id: string) => routes.find((r) => r.model === id && (r.route === id || r.enabled !== undefined));
  const paused = (id: string) => {
    const r = routeOf(id);
    if (!r || r.available !== false) return null;
    // A cooldown after an error retries on its own; without one the model can't run here (for
    // example hardware or runtime it needs), shown neutrally with the server's diagnostic.
    const lead = r.retryAfterSeconds ? t("voiceModels.paused", { seconds: Math.ceil(r.retryAfterSeconds) }) : t("voiceModels.unavailableHere");
    return (
      <Text selectable style={{ color: r.retryAfterSeconds ? c.statusWarning : c.foregroundMuted, fontSize: 12 }}>
        {r.error ? lead + " " + r.error : lead}
      </Text>
    );
  };

  const cov = coverage(enabled, values, approximateNow);
  const others = recommendedFirst(voiceModels.filter((m) => !chain.includes(m.id) && m.tier !== "custom"));
  const yours = voiceModels.filter((m) => !chain.includes(m.id) && m.tier === "custom");

  // Your own voice models need their languages before they can join the list (Qwen3-TTS has them fixed).
  const needsLanguages = (m: Model) =>
    m.tier === "custom" &&
    nativeLanguages(m).length === 0 &&
    !(values.customModels.find((x) => x.id === m.id)?.languages?.length) &&
    !MLX_FAMILY_VALUES.has(m.family ?? "") &&
    m.family !== GGUF_QWEN_FAMILY;
  const enableButton = (m: Model) => (
    <Button theme={theme} label={t("voiceModels.enable")} disabled={busy || unsupported(m) || needsLanguages(m) || !!m.unavailable} onPress={() => write([...chain.filter((x) => x !== m.id), m.id])} />
  );
  const languageEditor = (m: Model) => {
    const own = values.customModels.find((x) => x.id === m.id);
    if (!own || m.kind !== "tts" || nativeLanguages(m).length > 0 || MLX_FAMILY_VALUES.has(m.family ?? "") || m.family === GGUF_QWEN_FAMILY) return null;
    return (
      <View style={{ gap: 4 }}>
        {needsLanguages(m) ? <Text style={{ color: c.statusWarning, fontSize: 12 }}>{t("voiceModels.needsLanguages")}</Text> : null}
        <LanguagePicker
          theme={theme}
          value={own.languages ?? []}
          onChange={(languages) => props.update({ customModels: values.customModels.map((x) => (x.id === m.id ? { ...x, languages } : x)) })}
        />
      </View>
    );
  };

  return (
    <View style={{ gap: 14 }}>
      <Heading theme={theme} title={t("voiceModels.inUse")} />
      <Text style={muted}>{t("voiceModels.intro")}</Text>
      {enabled.length === 0 ? <Text style={{ ...muted, color: c.foreground }}>{t("voiceModels.noneEnabled")}</Text> : null}
      {enabled.map((m, i) => (
        <ModelCard
          key={m.id}
          {...props}
          model={m}
          custom={customById.get(m.id)}
          highlight
          enabled
          order={enabled.length > 1 ? i + 1 : undefined}
          extra={
            <>
              {paused(m.id)}
              <CardVoice {...props} model={m} route={routeOf(m.id)} custom={customById.get(m.id)} />
            </>
          }
          actions={
            <>
              <Button theme={theme} label={t("voiceModels.up")} disabled={busy || i === 0} onPress={() => write(move(chain, m.id, -1))} />
              <Button theme={theme} label={t("voiceModels.down")} disabled={busy || i === enabled.length - 1} onPress={() => write(move(chain, m.id, 1))} />
              <Button theme={theme} label={t("voiceModels.disable")} disabled={busy} onPress={() => write(chain.filter((x) => x !== m.id))} />
            </>
          }
        />
      ))}

      {enabled.length ? (
        <View style={{ gap: 8 }}>
          <Heading theme={theme} title={t("voiceModels.coverage")} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 4 }}>
            <Text style={{ ...muted, color: c.foreground }}>{t("voiceModels.coverageSummary", { n: cov.rows.length })}</Text>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: details }} onPress={() => setDetails(!details)} hitSlop={6}>
              <Text style={{ color: c.accent, fontSize: 13, lineHeight: 18 }}>{(details ? t("voiceModels.hideDetails") : t("voiceModels.showDetails")) + (details ? " ▴" : " ▾")}</Text>
            </Pressable>
          </View>
          {details ? <CoverageDetails {...props} enabled={enabled} cov={cov} approximateNow={approximateNow} /> : null}
        </View>
      ) : null}

      {others.length ? <Heading theme={theme} title={t("models.otherModels")} /> : null}
      {others.map((m) => (
        <ModelCard key={m.id} {...props} model={m} enabled={false} actions={enableButton(m)} />
      ))}


      <Heading theme={theme} title={t("models.yourModels")} trailing={<Button theme={theme} label={t("models.addModel")} onPress={props.onAdd} />} />
      {yours.length === 0 ? <Text style={muted}>{t("models.yourModelsEmpty")}</Text> : null}
      {yours.map((m) => (
        <ModelCard key={m.id} {...props} model={m} custom={customById.get(m.id)} enabled={false} actions={enableButton(m)} extra={languageEditor(m)} />
      ))}
    </View>
  );
}

/** Lists longer than this get language and gender filters (Kokoro v1.1 has 103 voices). */
const FILTER_FROM = 12;

/**
 * An enabled voice model's voice, chosen from its own voices, and a preview of it. Single-voice
 * models show their voice as text; a remote server's is set in its model settings.
 */
function CardVoice(props: ModelManagerProps & { model: Model; route: RouteVoices | undefined; custom?: CustomModel }) {
  const { theme, model: m, route, values, busy, previewing } = props;
  const { t, locale } = useText();
  const [language, setLanguage] = useState("");
  const [gender, setGender] = useState("");
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 };
  const voices = route?.voices ?? [];
  const chosen = modelVoice(values, m.id, m.family) ?? route?.shared_voice ?? undefined;
  const current = voices.find((v) => v.id === chosen) ?? (chosen ? undefined : voices[0]);
  const play = (
    <Button
      theme={theme}
      label={previewing === m.id ? t("speaking.playing") : t("speaking.play")}
      disabled={busy || previewing !== null || route?.available === false}
      onPress={() => props.previewModel(m, current?.id ?? chosen)}
    />
  );
  const row = (content: ReactNode) => (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <View style={{ flexShrink: 1, flexGrow: 1 }}>{content}</View>
      {play}
    </View>
  );
  if (m.engine === "openai") {
    const voice = props.custom?.voice;
    return row(<Text style={muted}>{voice ? t("voiceModels.voiceRemote", { voice }) : t("voiceModels.voiceRemoteDefault")}</Text>);
  }
  // Downloaded but its voices aren't known before it loads: a preview loads it.
  if (voices.length === 0) return route?.installed ? row(<Text style={muted}>{t("voiceModels.voiceAfterLoad")}</Text>) : <Text style={muted}>{t("voiceModels.voiceAfterDownload")}</Text>;
  if (voices.length === 1 || route?.shared_voice) {
    const only = voices.find((v) => v.id === route?.shared_voice) ?? voices[0];
    return row(<Text style={muted}>{t("voiceModels.voiceSingle", { voice: voiceLabel(t, locale, only) })}</Text>);
  }
  const filtering = voices.length > FILTER_FROM;
  const languages = [...new Set(voices.map((v) => v.language).filter((l) => l && l !== "multi"))];
  const genders = [...new Set(voices.map((v) => v.gender).filter(Boolean))];
  const shown = voices.filter((v) => (!language || v.language === language) && (!gender || v.gender === gender));
  // Frequently used voices first; the chosen one stays listed even when filtered out.
  const ordered = [...shown.filter((v) => v.featured), ...shown.filter((v) => !v.featured)];
  if (current && !ordered.includes(current)) ordered.unshift(current);
  const all = { label: t("voiceModels.voiceFilterAll"), value: "" };
  return (
    <View style={{ gap: 6 }}>
      {filtering ? (
        <View style={{ flexDirection: props.compact ? "column" : "row", gap: 8 }}>
          {languages.length > 1 ? (
            <View style={{ flex: props.compact ? undefined : 1 }}>
              <SettingsSelect label={t("voiceModels.voiceFilterLanguage")} value={language} options={[all, ...languages.map((l) => ({ label: languageName(l, locale), value: l }))]} onValueChange={setLanguage} />
            </View>
          ) : null}
          {genders.length > 1 ? (
            <View style={{ flex: props.compact ? undefined : 1 }}>
              <SettingsSelect label={t("voiceModels.voiceFilterGender")} value={gender} options={[all, ...genders.map((g) => ({ label: g === "female" ? t("common.female") : g === "male" ? t("common.male") : g, value: g }))]} onValueChange={setGender} />
            </View>
          ) : null}
        </View>
      ) : null}
      {row(
        <SettingsSelect
          label={t("voiceModels.voice")}
          value={current?.id ?? ""}
          options={ordered.map((v) => ({ label: voiceLabel(t, locale, v), value: v.id }))}
          onValueChange={(voice) => props.update({ modelVoices: { ...values.modelVoices, [m.id]: voice } })}
        />,
      )}
    </View>
  );
}

/**
 * Details under the language summary: which model reads each language first, a first choice for
 * languages more than one model speaks, and approximate readings. Compact text, not a table.
 */
function CoverageDetails(props: ModelManagerProps & { enabled: Model[]; cov: ReturnType<typeof coverage>; approximateNow: string[] }) {
  const { theme, values, enabled, cov, approximateNow } = props;
  const { t, locale } = useText();
  const c = theme.colors;
  const muted = { color: c.foregroundMuted, fontSize: 13, lineHeight: 18 };
  const sub = { color: c.foreground, fontSize: 13, fontWeight: "600" as const };
  const label = (m: Model) => modelLabel(t, m);
  const names = (codes: string[]) => codes.map((l) => languageName(l, locale)).join(t("common.listSeparator"));
  const firstBy = enabled
    .map((m) => ({ m, langs: cov.rows.filter((r) => r.models[0]?.id === m.id).map((r) => r.language) }))
    .filter((x) => x.langs.length > 0);
  const shared = cov.rows.filter((r) => r.models.length > 1);
  const [language, setLanguage] = useState<string>(shared[0]?.language ?? "");
  const row = shared.find((r) => r.language === language) ?? shared[0];

  return (
    <View style={{ gap: 12, borderLeftWidth: 2, borderLeftColor: c.border, paddingLeft: 12 }}>
      <View style={{ gap: 4 }}>
        <Text style={sub}>{t("voiceModels.readsTitle")}</Text>
        {firstBy.map(({ m, langs }) => (
          <Text key={m.id} style={muted}>
            {t("voiceModels.reads", { model: label(m), languages: names(langs) })}
          </Text>
        ))}
      </View>
      {row ? (
        <View style={{ gap: 2 }}>
          <Text style={sub}>{t("voiceModels.overlapTitle")}</Text>
          <SettingsSelect
            label={t("voiceModels.overlapLanguage")}
            value={row.language}
            options={shared.map((r) => ({ label: languageOptionLabel(r.language, locale), value: r.language }))}
            onValueChange={setLanguage}
          />
          <SettingsSelect
            label={t("voiceModels.firstChoice", { language: languageName(row.language, locale) })}
            value={values.ttsLanguageModels[row.language] ?? "auto"}
            options={[
              { label: t("voiceModels.automatic"), value: "auto" },
              ...row.models.map((m) => ({ label: label(m), value: m.id })),
            ]}
            onValueChange={(v) => {
              const next = { ...values.ttsLanguageModels };
              if (v === "auto") delete next[row.language];
              else next[row.language] = v;
              props.update({ ttsLanguageModels: next });
            }}
          />
        </View>
      ) : null}
      {cov.approximate.length ? (
        <View style={{ gap: 6 }}>
          <Text style={sub}>{t("voiceModels.approximateTitle")}</Text>
          <Text style={muted}>{t("voiceModels.approximateHint")}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {cov.approximate.map((a) => (
              <Pressable
                key={a.language}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: a.allowed }}
                onPress={() => {
                  const next = a.allowed ? approximateNow.filter((l) => l !== a.language) : [...new Set([...approximateNow, a.language])];
                  props.update({ ttsApproximateLanguages: next });
                }}
                style={{
                  borderWidth: 1,
                  borderColor: a.allowed ? c.accent : c.border,
                  backgroundColor: a.allowed ? c.surface2 : "transparent",
                  borderRadius: 999,
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                }}
              >
                <Text style={{ color: a.allowed ? c.foreground : c.foregroundMuted, fontSize: 12 }}>
                  {(a.allowed ? "✓ " : "") + t("voiceModels.approximate", { language: languageName(a.language, locale), other: languageName(a.via, locale) })}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Renaming one of your models and changing its languages. Only the name and languages change; its
 * id, source, files, pins, keys and place in the voice list stay as they are. Qwen3-TTS speaks its
 * fixed 10 languages, so they aren't editable.
 */
function CustomEditor(props: ModelManagerProps & { model: Model; custom: CustomModel; onDone(): void }) {
  const { theme, custom, values } = props;
  const { t } = useText();
  const c = theme.colors;
  const fixed = MLX_FAMILY_VALUES.has(custom.family ?? "") || custom.family === GGUF_QWEN_FAMILY;
  const [label, setLabel] = useState(custom.label);
  const [languages, setLanguages] = useState<string[] | undefined>(custom.languages);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Remote servers: a saved key is never shown; it can be replaced or removed.
  const remote = custom.source === "server";
  const [newKey, setNewKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const setModelKey = useRpc(setModelKeyRpc);
  const name = label.trim();
  // A voice model must keep at least one language to be used; for speech recognition an empty
  // list means no limit.
  const noLanguages = custom.kind === "tts" && !fixed && languages !== undefined && languages.length === 0;
  const submit = async () => {
    if (!name || noLanguages || saving) return;
    setSaving(true);
    setError(null);
    const key = remote ? newKey.trim() : "";
    const keyChange = key ? { hasApiKey: true } : remote && removeKey && custom.hasApiKey ? { hasApiKey: false } : {};
    if ("hasApiKey" in keyChange) {
      const failure = await setModelKey({ id: custom.id, apiKey: key || null }).then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
      if (failure !== null) {
        setSaving(false);
        setError(failure);
        return;
      }
    }
    const next = values.customModels.map((x) => (x.id === custom.id ? { ...x, label: name, ...keyChange, ...(fixed || languages === undefined ? {} : { languages }) } : x));
    const result = await props.saveSettings({ customModels: next });
    setSaving(false);
    if (result.ok) props.onDone();
    else setError(result.reason ?? "");
  };
  return (
    <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 8 }}>
      <SettingsInput label={t("form.name")} initialValue={custom.label} onChangeText={setLabel} />
      {remote ? (
        <SettingsInput label={t("form.apiKey")} hint={custom.hasApiKey ? t("form.apiKeySaved") : t("form.apiKeyHint")} secureTextEntry onChangeText={setNewKey} />
      ) : null}
      {remote && custom.hasApiKey && !newKey.trim() ? (
        <SettingsSwitch label={t("form.apiKeyRemove")} value={removeKey} onValueChange={setRemoveKey} />
      ) : null}
      {fixed ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("models.languagesFixed")}</Text>
      ) : (
        <LanguagePicker theme={theme} value={languages ?? []} onChange={setLanguages} hint={custom.kind === "stt" ? t("models.languagesSttHint") : undefined} />
      )}
      {noLanguages ? <Text style={{ color: c.statusWarning, fontSize: 12 }}>{t("voiceModels.needsLanguages")}</Text> : null}
      {error !== null ? (
        <Text selectable style={{ color: c.statusDanger, fontSize: 12 }}>
          {error ? t("models.editFailed") + " " + error : t("models.editFailed")}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button theme={theme} label={t("models.editSave")} disabled={saving || !name || noLanguages} onPress={() => void submit()} />
        <Button theme={theme} label={t("models.editCancel")} disabled={saving} onPress={props.onDone} />
      </View>
    </View>
  );
}
