import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HfLookup } from "../shared/rpc";
import { paths } from "./paths";
import { timeoutSignal } from "./voicekit-api";

const HF = "https://huggingface.co";

export interface HfFile {
  path: string;
  size: number;
  /** SHA-256 for files stored in Git LFS (all model weights); null for small git files. */
  sha256: string | null;
}

export interface HfTree {
  repo: string;
  revision: string;
  files: HfFile[];
}

/** Accepts "owner/name", "https://huggingface.co/owner/name[/tree/rev]" or "hf.co/owner/name". */
export function parseRepo(input: string): { repo: string; revision?: string } | null {
  const text = input.trim().replace(/^https?:\/\//, "").replace(/^(www\.)?(huggingface\.co|hf\.co)\//, "");
  const m = text.match(/^([A-Za-z0-9][\w.-]*)\/([\w.-]+)(?:\/(?:tree|blob|resolve)\/([\w.-]+))?\/?$/);
  return m ? { repo: `${m[1]}/${m[2]}`, revision: m[3] } : null;
}

function cachePath(repo: string, revision: string): string {
  return join(paths.data, "hf", `${repo.replace("/", "__")}@${revision}.json`);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { "user-agent": "paseo-voice-kit" }, signal: timeoutSignal(20_000) });
  if (response.status === 401 || response.status === 404) throw new Error("Repository not found, or it is private or gated.");
  if (!response.ok) throw new Error(`Hugging Face answered ${response.status}`);
  return (await response.json()) as T;
}

/** File listing pinned to a commit, cached on disk so the catalog can be rebuilt offline. */
export async function hfTree(repo: string, revision = "main"): Promise<HfTree> {
  if (/^[0-9a-f]{40}$/.test(revision)) {
    try {
      return JSON.parse(await readFile(cachePath(repo, revision), "utf8")) as HfTree;
    } catch {
      // Not cached yet.
    }
  }
  const info = await getJson<{ sha: string }>(`${HF}/api/models/${repo}/revision/${encodeURIComponent(revision)}`);
  const items = await getJson<{ type: string; path: string; size: number; lfs?: { oid: string } }[]>(
    `${HF}/api/models/${repo}/tree/${info.sha}?recursive=true`,
  );
  const tree: HfTree = {
    repo,
    revision: info.sha,
    files: items.filter((i) => i.type === "file").map((i) => ({ path: i.path, size: i.size, sha256: i.lfs?.oid ?? null })),
  };
  const file = cachePath(repo, info.sha);
  await mkdir(join(paths.data, "hf"), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(tree));
  await rename(`${file}.tmp`, file);
  return tree;
}

const SKIP = /(^|\/)(test_wavs|test|examples|samples|onnx_export)\/|\.(wav|mp3|flac|md|png|jpe?g|gif|py|sh|ipynb|gitattributes|txt\.bak)$|^\.git/i;

/** Data only: never fetch Python code from a custom MLX repository. */
export function mlxFiles(files: HfFile[]): HfFile[] {
  return files.filter((f) => !SKIP.test(f.path) && !f.path.split("/").some((p) => !p || p === "..") &&
    /^(?:speech_tokenizer\/)?(?:[^/]+\.(?:json|safetensors)|merges\.txt|tokenizer\.model)$/.test(f.path));
}

export async function hfBytes(repo: string, revision: string, file: string): Promise<Buffer> {
  if (file.startsWith("/") || file.split("/").some((part) => !part || part === "..")) throw new Error("Invalid model file path");
  const cached = cachePath(repo, revision) + "." + encodeURIComponent(file) + ".data";
  if (/^[0-9a-f]{40}$/.test(revision)) {
    try { return await readFile(cached); } catch { /* first lookup */ }
  }
  const response = await fetch(`${HF}/${repo}/resolve/${revision}/${file.split("/").map(encodeURIComponent).join("/")}`, { signal: timeoutSignal(20_000) });
  if (!response.ok) throw new Error(`Hugging Face answered ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Model config response is empty");
  const parts: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 1_000_000) { await reader.cancel(); throw new Error("Model config is too large"); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(parts);
  await mkdir(join(paths.data, "hf"), { recursive: true });
  await writeFile(cached + ".tmp", bytes, { mode: 0o600 }); await rename(cached + ".tmp", cached);
  return bytes;
}

/** Files worth downloading for a sherpa-onnx model: no samples or docs, and no fp32 copy when an int8 one exists. */
export function sherpaFiles(files: HfFile[]): HfFile[] {
  const names = new Set(files.map((f) => f.path));
  return files.filter((f) => {
    if (SKIP.test(f.path)) return false;
    const int8 = f.path.replace(/\.onnx$/, ".int8.onnx");
    return !(f.path.endsWith(".onnx") && !f.path.includes(".int8.") && int8 !== f.path && names.has(int8));
  });
}

/** Guess what a repository contains from its file names. */
export function suggest(tree: HfTree): HfLookup["suggestion"] {
  const root = tree.files.filter((f) => !f.path.includes("/")).map((f) => f.path);
  const name = tree.repo.toLowerCase();
  const has = (re: RegExp) => root.some((p) => re.test(p));
  const whisperFiles = root.filter((p) => /^ggml-.*\.bin$/.test(p) && !/encoder/.test(p));
  if (whisperFiles.length > 0) return { source: "whisper", kind: "stt", family: null, whisperFiles };
  const ggufModelFiles=root.filter(p=>/^qwen-talker-.*customvoice.*\.gguf$/i.test(p));
  const ggufCodecFiles=root.filter(p=>/^qwen-tokenizer.*\.gguf$/i.test(p));
  if(ggufModelFiles.length && ggufCodecFiles.length) return {
    source:"gguf",kind:"tts",family:"qwen3_tts_gguf",whisperFiles:[],ggufModelFiles,ggufCodecFiles,
    ggufFileSizes:Object.fromEntries(tree.files.filter(f=>ggufModelFiles.includes(f.path)||ggufCodecFiles.includes(f.path)).map(f=>[f.path,f.size])),
  };
  if (name.includes("qwen3-tts") && !name.includes("voicedesign") && !name.includes("-base") && has(/\.safetensors$/) && tree.files.some((f) => f.path.startsWith("speech_tokenizer/") && f.path.endsWith(".safetensors"))) {
    return { source: "mlx", kind: "tts", family: "qwen3_tts", whisperFiles: [] };
  }
  if (!has(/\.onnx$/)) return { source: null, kind: null, family: null, whisperFiles: [] };
  let family: string | null = null;
  let kind: "stt" | "tts" | null = null;
  if (has(/^voices\.bin$/)) [family, kind] = ["kokoro", "tts"];
  else if (has(/^conv_frontend.*\.onnx$/)) [family, kind] = ["qwen3_asr", "stt"];
  else if (has(/^joiner.*\.onnx$/)) [family, kind] = ["transducer", "stt"];
  else if (has(/^lexicon.*\.txt$/) || name.includes("vits") || name.includes("melo") || name.includes("piper")) [family, kind] = ["vits", "tts"];
  else if (name.includes("sense-voice") || name.includes("sensevoice")) [family, kind] = ["sense_voice", "stt"];
  else if (name.includes("paraformer")) [family, kind] = ["paraformer", "stt"];
  else if (name.includes("fire-red") || name.includes("firered")) [family, kind] = [has(/^encoder/) ? "fire_red_asr" : "fire_red_asr_ctc", "stt"];
  else if (name.includes("dolphin")) [family, kind] = ["dolphin", "stt"];
  else if (name.includes("moonshine")) [family, kind] = ["moonshine", "stt"];
  else if (name.includes("omnilingual")) [family, kind] = ["omnilingual", "stt"];
  else if (has(/^model.*\.onnx$/) && has(/^tokens\.txt$/)) kind = "stt";
  return { source: "sherpa", kind, family, whisperFiles: [] };
}

/**
 * Refuse, when a model is added, what this version can't speak with: sherpa-onnx 2.0 no longer
 * includes espeak-ng, so voices that need its phonemes (Piper, English-only Kokoro) would only
 * fail later. Matcha dropped English text in tests.
 */
export function unsupportedReason(tree: HfTree, suggestion: HfLookup["suggestion"]): string | null {
  const root = tree.files.filter((f) => !f.path.includes("/")).map((f) => f.path);
  const lexicon = root.some((p) => p.startsWith("lexicon") && p.endsWith(".txt"));
  const espeak = tree.files.some((f) => f.path.startsWith("espeak-ng-data/"));
  if (tree.repo.toLowerCase().includes("matcha")) return "Matcha voice models aren't supported in this version.";
  if (suggestion.source === "sherpa" && suggestion.kind === "tts" && !lexicon && (suggestion.family === "kokoro" || espeak)) {
    return "This voice model needs a phonemizer (espeak-ng) that Voice Kit doesn't include yet. Models with a lexicon, such as Kokoro multilingual or MeloTTS, work.";
  }
  return null;
}

export async function lookup(input: string): Promise<HfLookup> {
  const parsed = parseRepo(input);
  if (!parsed) throw new Error("Enter a Hugging Face repository like owner/name or its URL.");
  const tree = await hfTree(parsed.repo, parsed.revision);
  const suggestion = suggest(tree);
  const unsupported = unsupportedReason(tree, suggestion);
  if (unsupported) throw new Error(unsupported);
  const files = suggestion.source === "sherpa" ? sherpaFiles(tree.files) : suggestion.source === "mlx" ? mlxFiles(tree.files) : suggestion.source==="gguf" ? [] : tree.files;
  return {
    repo: tree.repo,
    revision: tree.revision,
    suggestion,
    sizeBytes: files.reduce((sum, f) => sum + f.size, 0),
    fileCount: files.length,
  };
}
