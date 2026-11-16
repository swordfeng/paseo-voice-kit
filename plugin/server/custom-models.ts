import { createHash } from "node:crypto";
import { mkdir, rename, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CustomModel, Preferences } from "../shared/settings";
import { hfTree, sherpaFiles, mlxFiles, hfBytes, type HfFile } from "./huggingface";
import { qwenMetadata, QWEN_LANGUAGES, QWEN_VOICES } from "./mlx-models";
import { paths } from "./paths";
import { pruneKeys } from "./model-keys";
import { BUILTIN_VOICE_MODELS, effectiveTts, voiceChainCatalog } from "./tts-chain";

const USES = { stt: ["dictation", "voice_input"], tts: ["voice_output"] } as const;

function isUrl(location: string): boolean {
  return /^https?:\/\//i.test(location);
}

function archiveKind(url: string): "tar.bz2" | "zip" | undefined {
  const clean = url.split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith(".tar.bz2")) return "tar.bz2";
  if (clean.endsWith(".zip")) return "zip";
  return undefined;
}

function hfUrl(repo: string, revision: string, path: string): string {
  return "https://huggingface.co/" + repo + "/resolve/" + revision + "/" + path.split("/").map(encodeURIComponent).join("/");
}

function ggufMetadata(model: string, codec: string) {
  if(!/^qwen-talker-.*customvoice.*\.gguf$/i.test(basename(model)) || !/^qwen-tokenizer.*\.gguf$/i.test(basename(codec)))throw new Error("Select a Qwen3-TTS CustomVoice talker and a speech tokenizer GGUF");
  for(const file of [model,codec])if(file.split(/[\\/]/).includes("..") || file.startsWith("/") || file.includes(","))throw new Error("Invalid GGUF file path");
  return {engine:"gguf",family:"qwen3_tts",languages:QWEN_LANGUAGES,voices:QWEN_VOICES,default_voice:"vivian",files:{model,codec}};
}

/** voicekit catalog entry for a model the user added in settings. */
export async function catalogEntry(model: CustomModel, apiKeys: Record<string, { apiKey: string }> = {}): Promise<Record<string, unknown> | null> {
  const base = { id: model.id, kind: model.kind, label: model.label, uses: USES[model.kind], languages: model.languages ?? [] };
  if (model.source === "server") {
    if (!model.baseUrl || !model.model) return null;
    return {
      ...base,
      description: "Forwarded to " + model.baseUrl,
      engine: "openai",
      remote: { base_url: model.baseUrl, model: model.model, api_key: apiKeys[model.id]?.apiKey || undefined, voice: model.voice || undefined },
    };
  }
  // Whisper only recognizes speech; a voice entry pointing at one is skipped.
  if (model.kind === "tts" && (model.source === "whisper" || model.hfFile)) return null;
  if (model.source === "huggingface") {
    if (!model.hfRepo || !model.hfRevision) return null;
    // Pinned commit: served from the on-disk listing cache after the first lookup.
    const tree = await hfTree(model.hfRepo, model.hfRevision);
    const description = "Hugging Face: " + model.hfRepo;
    if (model.hfFile) {
      const file = tree.files.find((f) => f.path === model.hfFile);
      if (!file) return null;
      return {
        ...base,
        description,
        engine: "whisper",
        files: { model: basename(file.path) },
        download: [{ url: hfUrl(tree.repo, tree.revision, file.path), sha256: file.sha256 ?? undefined, size: file.size, file: basename(file.path) }],
      };
    }
    if (!model.family) return null;
    if(model.family==="qwen3_tts_gguf") {
      if(model.kind!=="tts" || !model.ggufModelFile || !model.ggufCodecFile)throw new Error("Select both GGUF files");
      const files=[model.ggufModelFile,model.ggufCodecFile].map(path=>{
        const file=tree.files.find(f=>f.path===path);
        if(!file?.sha256)throw new Error("Missing pinned GGUF file checksum: "+path);
        return file;
      });
      return {...base,description,...ggufMetadata(model.ggufModelFile,model.ggufCodecFile),download:files.map(f=>({url:hfUrl(tree.repo,tree.revision,f.path),sha256:f.sha256,size:f.size,file:f.path}))};
    }
    if (model.family === "qwen3_tts") {
      if (model.kind !== "tts") return null;
      const files = mlxFiles(tree.files);
      const { configSha256, ...metadata } = qwenMetadata(await hfBytes(tree.repo, tree.revision, "config.json"), files);
      for (const f of files.filter((f) => f.path.endsWith(".safetensors"))) {
        if (!f.sha256) throw new Error("Qwen weight checksum is missing: " + f.path);
      }
      return { ...base, description, ...metadata, download: files.map((f) => ({ url: hfUrl(tree.repo, tree.revision, f.path), sha256: f.path === "config.json" ? configSha256 : f.sha256 ?? undefined, size: f.size, file: f.path })) };
    }
    return {
      ...base,
      description,
      engine: "sherpa",
      family: model.family,
      download: sherpaFiles(tree.files).map((f) => ({ url: hfUrl(tree.repo, tree.revision, f.path), sha256: f.sha256 ?? undefined, size: f.size, file: f.path })),
    };
  }
  const location = model.location?.trim();
  if (!location) return null;
  if (model.source === "whisper") {
    if (isUrl(location)) {
      const file = basename(location.split(/[?#]/)[0]);
      return { ...base, engine: "whisper", files: { model: file }, download: [{ url: location, sha256: model.sha256 || undefined, file }] };
    }
    return { ...base, engine: "whisper", path: dirname(location), files: { model: basename(location) } };
  }
  if (!model.family) return null;
  if(model.family==="qwen3_tts_gguf") {
    if(model.kind!=="tts" || isUrl(location))throw new Error("Use a local folder containing both GGUF files");
    const root=location.startsWith("~/")?join(homedir(),location.slice(2)):location;
    const files=await readdir(root);
    const talkers=files.filter(f=>/^qwen-talker-.*customvoice.*\.gguf$/i.test(f));
    const codecs=files.filter(f=>/^qwen-tokenizer.*\.gguf$/i.test(f));
    const talker=model.ggufModelFile ?? (talkers.length===1?talkers[0]:undefined);
    const codec=model.ggufCodecFile ?? (codecs.length===1?codecs[0]:undefined);
    if(!talker || !codec || !files.includes(talker)||!files.includes(codec))throw new Error("Choose a folder with exactly one CustomVoice talker and one speech tokenizer GGUF, or specify both files");
    return {...base,...ggufMetadata(talker,codec),path:root};
  }
  if (model.family === "qwen3_tts") {
    if (model.kind !== "tts" || isUrl(location)) return null;
    const root = location.startsWith("~/") ? join(homedir(), location.slice(2)) : location;
    const files: HfFile[] = [];
    for (const folder of ["", "speech_tokenizer"]) {
      for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
        if (entry.isDirectory()) continue;
        const path = folder ? folder + "/" + entry.name : entry.name;
        files.push({ path, size: (await stat(join(root, path))).size, sha256: null });
      }
    }
    const { configSha256: _, ...metadata } = qwenMetadata(await readFile(join(root, "config.json")), mlxFiles(files));
    return { ...base, ...metadata, path: root };
  }
  if (isUrl(location)) {
    return { ...base, engine: "sherpa", family: model.family, download: [{ url: location, sha256: model.sha256 || undefined, unpack: archiveKind(location) }] };
  }
  // Files are detected from the folder by the server.
  return { ...base, engine: "sherpa", family: model.family, path: location };
}

/**
 * Write the user's models as a voicekit catalog file. Owner-only permissions: entries can hold
 * API keys. Returns the path and a content hash (a change restarts the server).
 */
export async function writeCustomCatalog(models: CustomModel[], preferences?: Preferences): Promise<{ path: string; hash: string; ttsModel?: string }> {
  const entries: Record<string, unknown>[] = [];
  const apiKeys = await pruneKeys(models.map((m) => m.id));
  const unavailable = (model: Pick<CustomModel, "id" | "kind" | "label" | "languages" | "family">, reason: string) => ({
    id: model.id, kind: model.kind, label: model.label, uses: USES[model.kind],
    languages: model.family?.startsWith("qwen3_tts") ? QWEN_LANGUAGES : model.languages ?? [],
    engine: "sherpa", family: "unavailable", description: reason, options: { unavailable: reason },
  });
  for (const model of models) {
    try {
      const entry = await catalogEntry(model, apiKeys);
      entries.push(entry ?? unavailable(model, "Incomplete custom model configuration"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error("[voice-kit] unavailable custom model " + model.label + ": " + reason);
      entries.push(unavailable(model, reason));
    }
  }
  if (preferences) {
    for (const id of effectiveTts(preferences).models) {
      if (!BUILTIN_VOICE_MODELS.has(id) && !entries.some((m) => m.id === id)) {
        entries.push(unavailable({ id, kind: "tts", label: id }, "Unknown configured voice model: " + id));
      }
    }
  }
  const chain=preferences ? voiceChainCatalog(preferences,entries) : null;
  if(chain)entries.push(chain);
  const text = JSON.stringify({ models: entries }, null, 2) + "\n";
  const path = join(paths.data, "custom-models.json");
  await mkdir(paths.data, { recursive: true });
  const tmp = path + "." + process.pid + ".tmp";
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
  return { path, hash: createHash("sha256").update(text).digest("hex").slice(0, 16), ttsModel: chain?.id as string | undefined };
}
