import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, SettingsAction, SettingsInput, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { LANGUAGES } from "../shared/languages";
import { hfLookupRpc, type HfLookup } from "../shared/rpc";
import { GGUF_QWEN_FAMILY, MLX_FAMILY_VALUES, SHERPA_FAMILIES, type CustomModel } from "../shared/settings";
import { customModelFromDraft } from "./custom-model";
import { MlxRuntimeStatus } from "./mlx-runtime";
import { formatBytes } from "./format";
import { errorText, languageName, languageOptionLabel, useText, type Translate } from "./i18n";

type Source = CustomModel["source"];
type Kind = CustomModel["kind"];

const SOURCES: { value: Source; stt: boolean; tts: boolean }[] = [
  { value: "huggingface", stt: true, tts: true },
  { value: "server", stt: true, tts: true },
  // Whisper only recognizes speech.
  { value: "whisper", stt: true, tts: false },
  { value: "sherpa", stt: true, tts: true },
];


/** Qwen3-TTS (MLX or GGUF) has its 10 languages fixed; other voice models need them chosen. */
function isQwen(family: string | undefined, found: HfLookup | undefined): boolean {
  return MLX_FAMILY_VALUES.has(family ?? "") || family === GGUF_QWEN_FAMILY || found?.suggestion.source === "mlx" || found?.suggestion.source === "gguf";
}

/** Returns a problem to show, or null when the form can be saved. */
function validate(t: Translate, m: Partial<CustomModel>, found: HfLookup | undefined): string | null {
  if (m.source === "huggingface") {
    if (!found) return t("form.errors.pressLookUp");
    if (!found.suggestion.source) return m.kind === "tts" ? t("form.errors.noVoiceFiles") : t("form.errors.noModelFiles");
    // The tab decides the kind; a model of the other kind belongs on the other tab.
    const foundKind = found.suggestion.kind ?? (found.suggestion.source === "whisper" ? "stt" : found.suggestion.source === "mlx" || found.suggestion.source === "gguf" ? "tts" : null);
    if (foundKind && foundKind !== m.kind) return foundKind === "stt" ? t("form.errors.wrongKindStt") : t("form.errors.wrongKindTts");
    if (found.suggestion.source === "whisper" && !m.hfFile) return t("form.errors.pickWhisperFile");
    if (found.suggestion.source === "sherpa" && !m.family) return t("form.errors.pickFamily");
    if (found.suggestion.source === "gguf" && (!m.ggufModelFile || !m.ggufCodecFile)) return t("form.errors.pickGgufFiles");
  }
  if (!m.label?.trim()) return t("form.errors.giveName");
  if (m.kind === "tts" && !isQwen(m.family, found) && !(m.languages?.length)) return t("form.errors.pickLanguages");
  if (m.source === "huggingface") return null;
  if (m.source === "server") {
    if (!/^https?:\/\/.+/i.test(m.baseUrl ?? "")) return t("form.errors.baseUrl", { example: "http://127.0.0.1:8000/v1" });
    if (!m.model?.trim()) return t("form.errors.modelName");
    return null;
  }
  if (!m.location?.trim()) return m.source === "whisper" ? t("form.errors.whisperLocation") : t("form.errors.sherpaLocation");
  if (m.source === "whisper" && !/\.bin($|\?)/i.test(m.location)) return t("form.errors.whisperBin");
  if (m.source === "sherpa" && !m.family) return t("form.errors.pickFamily");
  if (m.sha256 && !/^[0-9a-f]{64}$/i.test(m.sha256.trim())) return t("form.errors.checksum");
  return null;
}

function describeLookup(t: Translate, found: HfLookup): string {
  const revision = found.revision.slice(0, 7);
  if (found.suggestion.source === "whisper") return t("form.lookupWhisper", { n: found.suggestion.whisperFiles.length, revision });
  // A GGUF repository can hold many sizes; only the picked pair is downloaded.
  if (found.suggestion.source === "gguf") return t("form.lookupGguf", { revision });
  if (found.suggestion.source === "sherpa" || found.suggestion.source === "mlx") {
    const fallback = found.suggestion.source === "mlx" ? "MLX" : "sherpa-onnx";
    const family = SHERPA_FAMILIES.find((f) => f.value === found.suggestion.family)?.label ?? fallback;
    return t("form.lookupSherpa", { family, files: found.fileCount, size: formatBytes(found.sizeBytes), revision });
  }
  return t("form.lookupNone");
}

/** The codec that matches a talker's quantization ("…-Q4_K_M.gguf"), else the first. */
function matchingCodec(talker: string | undefined, codecs: string[]): string | undefined {
  const quant = /-(Q\d[\w]*|BF16|F16|F32)\.gguf$/i.exec(talker ?? "")?.[1];
  return codecs.find((c) => quant && c.toLowerCase().includes(quant.toLowerCase())) ?? codecs[0];
}

/**
 * Pick the languages a voice model speaks: chosen ones as removable chips, and a select to add
 * another. Used when adding a model and to fill in languages for a custom voice model added without them.
 */
export function LanguagePicker({ theme, value, onChange, hint }: { theme: PluginTheme; value: string[]; onChange(next: string[]): void; hint?: string }) {
  const { t, locale } = useText();
  const options = Object.keys(LANGUAGES)
    .filter((code) => !value.includes(code))
    .map((code) => ({ code, name: languageName(code, locale) }))
    .sort((a, b) => a.name.localeCompare(b.name, locale))
    .map(({ code }) => ({ label: languageOptionLabel(code, locale), value: code }));
  const c = theme.colors;
  return (
    <View style={{ gap: 6 }}>
      <SettingsSelect
        label={t("form.languages")}
        hint={hint ?? t("form.languagesHint")}
        value=""
        options={[{ label: t("form.addLanguage"), value: "" }, ...options]}
        onValueChange={(code) => {
          if (code) onChange([...value, code]);
        }}
      />
      {value.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 4 }}>
          {value.map((code) => (
            <Pressable
              key={code}
              accessibilityRole="button"
              accessibilityLabel={t("form.removeLanguage", { language: languageName(code, locale) })}
              onPress={() => onChange(value.filter((l) => l !== code))}
              style={{ flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 6, backgroundColor: c.surface2, paddingHorizontal: 8, paddingVertical: 3 }}
            >
              <Text style={{ color: c.foreground, fontSize: 12 }}>{languageOptionLabel(code, locale)}</Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>×</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function CustomModelForm({
  open,
  kind,
  theme,
  onClose,
  onSave,
}: {
  open: boolean;
  /** Set by the tab the form was opened from: speech recognition (Listening) or a voice (Speaking). */
  kind: Kind;
  theme: PluginTheme;
  onClose(): void;
  /** Saves the model; resolves with null once saved, or the reason it couldn't be. */
  onSave(model: CustomModel): Promise<string | null>;
}) {
  // Drafts live in state below, so a language change only re-renders the text.
  const { t } = useText();
  const [source, setSource] = useState<Source>("huggingface");
  const [fields, setFields] = useState<Partial<CustomModel>>({});
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [repoInput, setRepoInput] = useState("");
  const lookupRpc = useRpc(hfLookupRpc);
  const lookup = useMutation({
    mutationFn: (repo: string) => lookupRpc({ repo }),
    onSuccess: (found) => {
      // Pre-fill from what the repository holds; the user can still change it.
      const talkers = found.suggestion.ggufModelFiles ?? [];
      const codecs = found.suggestion.ggufCodecFiles ?? [];
      setFields((f) => ({
        ...f,
        label: f.label || found.repo.split("/")[1],
        family: found.suggestion.source === "gguf" ? GGUF_QWEN_FAMILY : found.suggestion.family ?? undefined,
        hfFile: found.suggestion.whisperFiles.find((w) => /q5|q8/.test(w)) ?? found.suggestion.whisperFiles[0],
        ggufModelFile: talkers[0],
        ggufCodecFile: matchingCodec(talkers[0], codecs),
      }));
    },
  });
  const found = source === "huggingface" ? lookup.data : undefined;
  const set = (patch: Partial<CustomModel>) => setFields((f) => ({ ...f, ...patch }));
  const effectiveSource = SOURCES.some((o) => o.value === source && o[kind]) ? source : "huggingface";
  const draft: Partial<CustomModel> = { ...fields, kind, source: effectiveSource };
  const problem = validate(t, draft, found);
  const families = SHERPA_FAMILIES.filter((f) => f.kind === kind);
  const qwen = isQwen(draft.family, found);
  const sizes = found?.suggestion.ggufFileSizes ?? {};
  const fileOption = (f: string) => ({ label: sizes[f] ? f + " · " + formatBytes(sizes[f]) : f, value: f });

  const styles = useMemo(
    () => ({
      body: { gap: 4, paddingBottom: 8 },
      error: { color: theme.colors.statusDanger, fontSize: 13, paddingHorizontal: 4 },
      note: { color: theme.colors.foregroundMuted, fontSize: 13, paddingHorizontal: 4 },
      row: { flexDirection: "row" as const, justifyContent: "flex-end" as const, gap: 10, paddingTop: 12 },
      button: (primary: boolean) => ({
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: primary ? theme.colors.accent : theme.colors.border,
        backgroundColor: primary ? theme.colors.accent : "transparent",
      }),
      buttonText: (primary: boolean) => ({ color: primary ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 14 }),
    }),
    [theme],
  );

  const reset = () => {
    setFields({});
    setTried(false);
    setSaveError(null);
    setRepoInput("");
    setSource("huggingface");
    lookup.reset();
  };
  const save = async () => {
    setTried(true);
    if (problem || saving) return;
    const label = draft.label!.trim();
    const gguf = found?.suggestion.source === "gguf" || draft.family === GGUF_QWEN_FAMILY;
    const model = customModelFromDraft({
      label,
      kind,
      source: effectiveSource,
      baseUrl: draft.baseUrl?.trim() || undefined,
      model: draft.model?.trim() || undefined,
      apiKey: draft.apiKey?.trim() || undefined,
      voice: kind === "tts" ? draft.voice?.trim() || undefined : undefined,
      location: draft.location?.trim() || undefined,
      family:
        effectiveSource === "sherpa" || found?.suggestion.source === "sherpa"
          ? draft.family
          : found?.suggestion.source === "mlx"
            ? found.suggestion.family ?? "qwen3_tts"
            : found?.suggestion.source === "gguf"
              ? GGUF_QWEN_FAMILY
              : undefined,
      sha256: draft.sha256?.trim().toLowerCase() || undefined,
      hfRepo: found?.repo,
      hfRevision: found?.revision,
      hfFile: found?.suggestion.source === "whisper" ? draft.hfFile : undefined,
      // Qwen3-TTS has its languages fixed; other voice models keep what the user chose.
      languages: kind === "tts" && !qwen ? draft.languages : undefined,
      ggufModelFile: gguf ? draft.ggufModelFile?.trim() || undefined : undefined,
      ggufCodecFile: gguf ? draft.ggufCodecFile?.trim() || undefined : undefined,
    });
    // Keep everything entered until the model is actually saved.
    setSaving(true);
    setSaveError(null);
    const failure = await onSave(model).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    setSaving(false);
    if (failure === null) reset();
    else setSaveError(failure);
  };

  return (
    <Modal
      title={t("form.title")}
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
    >
      <Modal.Content scrollable>
        <View style={styles.body}>
          <SettingsSelect
            label={t("form.source")}
            value={effectiveSource}
            options={SOURCES.filter((o) => o[kind]).map(({ value }) => ({ value, label: t(`form.sources.${value}`) }))}
            onValueChange={(v) => setSource(v as Source)}
          />
          {effectiveSource === "huggingface" ? (
            <>
              <SettingsInput
                label={t("form.repository")}
                hint={t("form.repositoryHint")}
                placeholder={kind === "tts" ? "owner/name" : "ggerganov/whisper.cpp"}
                onChangeText={(text) => {
                  setRepoInput(text);
                  if (lookup.data || lookup.error) lookup.reset();
                }}
              />
              <SettingsAction
                label={lookup.data ? lookup.data.repo : t("form.modelFiles")}
                hint={
                  lookup.isPending
                    ? t("form.lookingUp")
                    : lookup.error
                      ? errorText(t, lookup.error)
                      : lookup.data
                        ? describeLookup(t, lookup.data)
                        : t("form.lookupHint")
                }
                actionLabel={t("form.lookUp")}
                disabled={!repoInput.trim() || lookup.isPending}
                onPress={() => lookup.mutate(repoInput.trim())}
              />
              {found?.suggestion.source === "whisper" ? (
                <SettingsSelect
                  label={t("form.whisperFile")}
                  value={draft.hfFile ?? ""}
                  options={found.suggestion.whisperFiles.map((f) => ({ label: f, value: f }))}
                  onValueChange={(hfFile) => set({ hfFile })}
                />
              ) : null}
              {found?.suggestion.source === "gguf" ? (
                <>
                  <SettingsSelect
                    label={t("form.ggufTalker")}
                    hint={t("form.ggufTalkerHint")}
                    value={draft.ggufModelFile ?? ""}
                    options={(found.suggestion.ggufModelFiles ?? []).map(fileOption)}
                    onValueChange={(ggufModelFile) => set({ ggufModelFile, ggufCodecFile: matchingCodec(ggufModelFile, found.suggestion.ggufCodecFiles ?? []) })}
                  />
                  <SettingsSelect
                    label={t("form.ggufCodec")}
                    hint={t("form.ggufCodecHint")}
                    value={draft.ggufCodecFile ?? ""}
                    options={(found.suggestion.ggufCodecFiles ?? []).map(fileOption)}
                    onValueChange={(ggufCodecFile) => set({ ggufCodecFile })}
                  />
                </>
              ) : null}
              {found?.suggestion.source === "sherpa" ? (
                <SettingsSelect
                  label={t("form.modelFamily")}
                  hint={found.suggestion.family ? t("form.familyDetected") : t("form.familyUnknown")}
                  value={draft.family ?? ""}
                  options={[{ label: t("form.choose"), value: "" }, ...families.map((f) => ({ label: f.label, value: f.value }))]}
                  onValueChange={(family) => set({ family: family || undefined })}
                />
              ) : null}
            </>
          ) : null}
          <SettingsInput label={t("form.name")} placeholder={t("form.namePlaceholder")} initialValue={fields.label} key={found?.revision ?? "name"} onChangeText={(label) => set({ label })} />
          {effectiveSource === "huggingface" ? null : effectiveSource === "server" ? (
            <>
              <SettingsInput label={t("form.baseUrl")} hint={t("form.baseUrlHint")} placeholder="http://127.0.0.1:8000/v1" onChangeText={(baseUrl) => set({ baseUrl })} />
              <SettingsInput label={t("form.modelName")} placeholder={kind === "stt" ? "whisper-1" : "tts-1"} onChangeText={(model) => set({ model })} />
              <SettingsInput label={t("form.apiKey")} hint={t("form.apiKeyHint")} secureTextEntry onChangeText={(apiKey) => set({ apiKey })} />
              {kind === "tts" ? <SettingsInput label={t("form.voiceName")} hint={t("form.voiceNameHint")} onChangeText={(voice) => set({ voice })} /> : null}
            </>
          ) : (
            <>
              {effectiveSource === "sherpa" ? (
                <SettingsSelect
                  label={t("form.modelFamily")}
                  hint={t("form.familyHint")}
                  value={draft.family ?? ""}
                  options={[{ label: t("form.choose"), value: "" }, ...families.map((f) => ({ label: f.label, value: f.value }))]}
                  onValueChange={(family) => set({ family: family || undefined })}
                />
              ) : null}
              <SettingsInput
                label={effectiveSource === "whisper" ? t("form.fileOrUrl") : t("form.folderOrUrl")}
                hint={effectiveSource === "whisper" ? t("form.fileHint") : t("form.folderHint")}
                placeholder={effectiveSource === "whisper" ? "~/models/ggml-medium.bin" : "~/models/sherpa-onnx-…"}
                onChangeText={(location) => set({ location })}
              />
              {draft.family === GGUF_QWEN_FAMILY ? (
                <>
                  <SettingsInput label={t("form.ggufTalker")} hint={t("form.ggufPairHint")} placeholder="qwen-talker-…-customvoice-….gguf" onChangeText={(ggufModelFile) => set({ ggufModelFile })} />
                  <SettingsInput label={t("form.ggufCodec")} hint={t("form.ggufPairHint")} placeholder="qwen-tokenizer-12hz-….gguf" onChangeText={(ggufCodecFile) => set({ ggufCodecFile })} />
                </>
              ) : null}
              <SettingsInput label="SHA-256" hint={t("form.sha256Hint")} onChangeText={(sha256) => set({ sha256 })} />
            </>
          )}
          {kind === "tts" && !qwen ? <LanguagePicker theme={theme} value={draft.languages ?? []} onChange={(languages) => set({ languages })} /> : null}
          {found?.suggestion.source === "mlx" || MLX_FAMILY_VALUES.has(draft.family ?? "") ? (
            <View style={{ gap: 6, paddingHorizontal: 4 }}>
              <Text style={styles.note}>{t("form.mlxNote")}</Text>
              <MlxRuntimeStatus theme={theme} showReady />
            </View>
          ) : null}
          {tried && problem ? <Text style={styles.error}>{problem}</Text> : null}
          {saveError !== null ? (
            <Text selectable style={styles.error}>
              {saveError ? t("form.saveFailed") + " " + saveError : t("form.saveFailed")}
            </Text>
          ) : null}
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("form.cancel")}
              style={styles.button(false)}
              onPress={() => {
                reset();
                onClose();
              }}
            >
              <Text style={styles.buttonText(false)}>{t("form.cancel")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("form.add")}
              accessibilityState={{ disabled: saving }}
              disabled={saving}
              style={[styles.button(true), saving ? { opacity: 0.6 } : null]}
              onPress={() => void save()}
            >
              <Text style={styles.buttonText(true)}>{t("form.add")}</Text>
            </Pressable>
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}
