//! Data-driven model catalog.
//!
//! Built-in entries come from `catalog.json` (compiled in). Users add their own through extra
//! catalog files (`--catalog`), written by the Paseo plugin from its settings: local files or
//! folders, download URLs, or remote OpenAI-compatible servers.
//!
//! Install layout: `<models_dir>/<dir>/<files...>`. Directory names follow the upstream archive
//! names, which are also what Paseo uses under `~/.paseo/models/local-speech`, so models Paseo
//! already downloaded are reused read-only through `--reuse-dir`.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use anyhow::Context;
use serde::{Deserialize, Serialize};

const BUILTIN: &str = include_str!("../catalog.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Stt,
    Tts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Engine {
    /// whisper.cpp (ggml models).
    Whisper,
    /// sherpa-onnx; `family` picks the model type.
    Sherpa,
    /// Apple Silicon MLX worker (currently Qwen3-TTS).
    Mlx,
    /// Qwen3-TTS CustomVoice through an isolated native GGUF worker.
    Gguf,
    /// Forward to an OpenAI-compatible server.
    Openai,
    /// Ordered native-language voice candidates (`options.chain`).
    Chain,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Download {
    pub url: String,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size: u64,
    /// "tar.bz2" or "zip". Absent: a single file.
    #[serde(default)]
    pub unpack: Option<String>,
    /// Single files: name inside the model dir (default: the URL's file name).
    #[serde(default)]
    pub file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceSpec {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub gender: String,
    #[serde(default)]
    pub sid: i32,
    #[serde(default)]
    pub featured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Remote {
    /// OpenAI-style base URL, e.g. http://127.0.0.1:8000/v1
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
    /// TTS: voice to request (default: the voice Paseo asked for).
    #[serde(default)]
    pub voice: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    pub id: String,
    pub kind: Kind,
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub languages: Vec<String>,
    /// "recommended", "more" or "custom". The UI shows recommended ones first.
    #[serde(default = "default_tier")]
    pub tier: String,
    /// Features this model suits: "dictation", "voice_input", "voice_output".
    #[serde(default)]
    pub uses: Vec<String>,
    pub engine: Engine,
    #[serde(default)]
    pub family: Option<String>,
    /// Install directory name (default: the id).
    #[serde(default)]
    pub dir: Option<String>,
    /// A local folder or file the user already has. Overrides downloads.
    #[serde(default)]
    pub path: Option<String>,
    /// Role -> file name(s) inside the model dir. Several files: comma separated.
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    pub options: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub download: Vec<Download>,
    /// whisper.cpp encoder compiled for the Apple Neural Engine (zip of `*-encoder.mlmodelc`).
    #[serde(default)]
    pub coreml: Option<Download>,
    #[serde(default)]
    pub voices: Vec<VoiceSpec>,
    #[serde(default)]
    pub default_voice: Option<String>,
    #[serde(default)]
    pub remote: Option<Remote>,
    /// Measured quality and speed, kept in docs/eval.md. Free-form JSON.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eval: Option<serde_json::Value>,
}

fn default_tier() -> String {
    "more".into()
}

impl ModelEntry {
    pub fn dir_name(&self) -> &str {
        self.dir.as_deref().unwrap_or(&self.id)
    }

    pub fn size_bytes(&self) -> u64 {
        self.download.iter().map(|d| d.size).sum()
    }

    pub fn option_str(&self, key: &str) -> Option<&str> {
        self.options.get(key).and_then(|v| v.as_str())
    }

    pub fn option_bool(&self, key: &str) -> Option<bool> {
        self.options.get(key).and_then(|v| v.as_bool())
    }

    /// Personas pair a voice per enabled model.
    pub fn personas(&self) -> Vec<crate::engine::route::Persona> {
        let Some(list) = self.options.get("personas").and_then(|p| p.as_array()) else { return vec![] };
        list.iter()
            .filter_map(|p| {
                Some(crate::engine::route::Persona {
                    id: p.get("id")?.as_str()?.to_string(),
                    label: p.get("label")?.as_str()?.to_string(),
                    gender: p.get("gender").and_then(|g| g.as_str()).unwrap_or_default().to_string(),
                    voices: p
                        .get("voices")?
                        .as_object()?
                        .iter()
                        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                        .collect(),
                })
            })
            .collect()
    }

    /// Enabled model IDs in preference order.
    pub fn chain_models(&self) -> Vec<String> {
        self.options.get("chain").and_then(|v| v.as_array()).into_iter().flatten()
            .filter_map(|v| v.as_str().map(str::to_string)).collect()
    }

    fn validate(&self) -> anyhow::Result<()> {
        // Starting with a letter or digit rules out "." and "..", which would name the models
        // folder or its parent when the model's own folder is derived from the id.
        anyhow::ensure!(
            self.id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && self.id.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)),
            "model id {:?} must start with a letter or digit and use only letters, digits, '-', '_' or '.'",
            self.id
        );
        if let Some(dir) = &self.dir {
            anyhow::ensure!(!dir.contains("..") && !dir.contains('/') && !dir.contains('\\'), "model {}: bad dir", self.id);
        }
        for f in self.files.values().flat_map(|v| v.split(',')).map(str::trim) {
            anyhow::ensure!(
                !f.contains("..") && !f.starts_with('/') && !f.starts_with('\\') && !f.contains(':') && !Path::new(f).is_absolute(),
                "model {}: file paths must be relative to the model folder",
                self.id
            );
        }
        match self.engine {
            Engine::Openai => anyhow::ensure!(self.remote.is_some(), "model {}: openai engine needs `remote`", self.id),
            Engine::Chain => {
                let chain = self.options.get("chain").and_then(|v| v.as_array()).context("chain needs an ordered model array")?;
                let ids = self.chain_models();
                let unique: std::collections::BTreeSet<_> = ids.iter().collect();
                anyhow::ensure!(self.kind == Kind::Tts && ids.len() == chain.len() && ids.len() <= 64 && unique.len() == ids.len(), "{}: invalid ordered voice models", self.id);
            }
            Engine::Sherpa => anyhow::ensure!(self.family.is_some(), "model {}: sherpa engine needs `family`", self.id),
            Engine::Mlx => anyhow::ensure!(self.kind == Kind::Tts && self.family.as_deref() == Some("qwen3_tts"), "model {}: unsupported MLX model", self.id),
            Engine::Gguf => anyhow::ensure!(self.kind == Kind::Tts && self.family.as_deref() == Some("qwen3_tts") && self.files.contains_key("model") && self.files.contains_key("codec"), "model {}: GGUF needs Qwen3-TTS talker and codec", self.id),
            Engine::Whisper => anyhow::ensure!(self.files.contains_key("model"), "model {}: whisper needs files.model", self.id),
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct CatalogFile {
    models: Vec<ModelEntry>,
}

#[derive(Debug, Clone)]
pub struct Catalog {
    entries: Vec<ModelEntry>,
}

impl Catalog {
    /// Built-in catalog plus extra catalog files. Extra entries are tagged "custom" and may not
    /// reuse a built-in id.
    pub fn load(extra: &[PathBuf]) -> anyhow::Result<Self> {
        let builtin: CatalogFile = serde_json::from_str(BUILTIN).context("built-in catalog.json")?;
        let mut entries = builtin.models;
        for e in &entries {
            e.validate()?;
        }
        for path in extra {
            let text = match std::fs::read_to_string(path) {
                Ok(t) => t,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
            };
            let file: CatalogFile = serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
            for mut e in file.models {
                if let Err(err) = e.validate() {
                    tracing::warn!(error = %err, "skipping invalid custom model");
                    continue;
                }
                if entries.iter().any(|b| b.id == e.id) {
                    tracing::warn!(id = e.id, "custom model id clashes with a built-in model; skipped");
                    continue;
                }
                e.tier = "custom".into();
                entries.push(e);
            }
        }
        Ok(Self { entries })
    }

    pub fn find(&self, id: &str) -> Option<&ModelEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    pub fn entries(&self) -> &[ModelEntry] {
        &self.entries
    }
}

#[derive(Debug, Clone)]
pub struct Store {
    pub models_dir: PathBuf,
    pub reuse_dirs: Vec<PathBuf>,
    pub shared_models_dir: Option<PathBuf>,
    pub paseo_managed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Installed {
    /// Directory the entry's `files` are relative to.
    pub root: PathBuf,
    /// True for external storage. Paseo-managed storage is deleted through its model manager.
    pub shared: bool,
}

impl Installed {
    pub fn file(&self, entry: &ModelEntry, role: &str) -> Option<PathBuf> {
        entry.files.get(role).map(|f| self.root.join(f.split(',').next().unwrap_or(f).trim()))
    }

    /// All files for a role, joined with commas (sherpa takes lists that way).
    pub fn files_csv(&self, entry: &ModelEntry, role: &str) -> Option<String> {
        let list: Vec<String> = entry
            .files
            .get(role)?
            .split(',')
            .map(|f| self.root.join(f.trim()))
            .filter(|p| p.exists())
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        (!list.is_empty()).then(|| list.join(","))
    }
}

impl Store {
    pub fn paseo_model<'a>(&self, entry: &'a ModelEntry) -> Option<&'a str> {
        ((self.paseo_managed || self.shared_models_dir.is_some()) && entry.tier != "custom" && entry.path.is_none())
            .then(|| entry.option_str("paseo_model")).flatten()
    }
    pub fn own_dir(&self, entry: &ModelEntry) -> PathBuf {
        self.models_dir.join(entry.dir_name())
    }

    pub fn locate(&self, entry: &ModelEntry) -> Option<Installed> {
        // Invalid custom configurations stay visible without becoming loadable/downloadable.
        if entry.option_str("unavailable").is_some() { return None; }
        if self.paseo_model(entry).is_some() {
            let cache = self.shared_models_dir.as_ref()?;
            let root = cache.join(entry.dir_name());
            // Paseo retains its archive until extraction is complete; that marker means missing.
            if entry.download.iter().any(|d| {
                let name = d.url.rsplit('/').next().unwrap_or_default();
                std::fs::metadata(cache.join(".downloads").join(name)).is_ok_and(|m| m.len() > 0)
            }) { return None; }
            return complete(entry, &root).then_some(Installed { root, shared: true });
        }
        if matches!(entry.engine, Engine::Openai | Engine::Chain) {
            // Nothing on disk of its own (chains: the runtime checks their models).
            return Some(Installed { root: PathBuf::new(), shared: true });
        }
        if let Some(path) = &entry.path {
            let path = expand_home(path);
            let root = if path.is_file() { path.parent()?.to_path_buf() } else { path };
            return complete(entry, &root).then_some(Installed { root, shared: true });
        }
        let own = self.own_dir(entry);
        if complete(entry, &own) {
            return Some(Installed { root: own, shared: false });
        }
        self.reuse_dirs
            .iter()
            .map(|d| d.join(entry.dir_name()))
            .find(|root| complete(entry, root))
            .map(|root| Installed { root, shared: true })
    }

    /// A link to a whisper model under a name whisper.cpp will not match to a CoreML encoder.
    pub fn plain_whisper_path(&self, model: &Path) -> anyhow::Result<PathBuf> {
        let dir = self.models_dir.join(".plain");
        std::fs::create_dir_all(&dir)?;
        let name = model.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let link = dir.join(format!("plain-{name}"));
        if std::fs::read_link(&link).ok().as_deref() != Some(model) {
            std::fs::remove_file(&link).ok();
            #[cfg(unix)]
            std::os::unix::fs::symlink(model, &link)?;
            #[cfg(not(unix))]
            return Ok(model.to_path_buf());
        }
        Ok(link)
    }

    /// The CoreML encoder whisper.cpp would load for this entry, if any.
    pub fn coreml_dir(&self, entry: &ModelEntry) -> Option<PathBuf> {
        let installed = self.locate(entry)?;
        // The encoder is unpacked next to the model. Folders Voice Kit borrows (Paseo's models,
        // the user's own) are never written, so their models run without one.
        if !installed.root.starts_with(&self.models_dir) {
            return None;
        }
        let model = installed.file(entry, "model")?;
        Some(coreml_encoder_path(&model))
    }
}

fn complete(entry: &ModelEntry, root: &Path) -> bool {
    if entry.engine == Engine::Gguf {
        use std::io::Read;
        for role in ["model", "codec"] {
            let Some(name)=entry.files.get(role) else {return false};
            let Ok(mut f)=std::fs::File::open(root.join(name)) else {return false};
            let Ok(meta)=f.metadata() else {return false};
            let mut magic=[0;4];
            if !meta.is_file() || f.read_exact(&mut magic).is_err() || magic!=*b"GGUF" {return false;}
            if let Some(size)=entry.download.iter().find(|d|d.file.as_deref()==Some(name.as_str())).map(|d|d.size).filter(|v|*v>0) {
                if meta.len()!=size {return false;}
            }
        }
    }
    if entry.engine == Engine::Mlx {
        use sha2::{Digest, Sha256};
        let Ok(config) = std::fs::read(root.join("config.json")) else { return false };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&config) else { return false };
        if value["model_type"] != "qwen3_tts" || value["tts_model_type"] != "custom_voice" { return false; }
        if let Some(expected) = entry.download.iter().find(|d| d.file.as_deref() == Some("config.json")).and_then(|d| d.sha256.as_deref()) {
            if hex::encode(Sha256::digest(&config)) != expected { return false; }
        }
    }
    if entry.files.is_empty() {
        return entry.engine == Engine::Sherpa && autodetect(entry.family.as_deref().unwrap_or_default(), root).is_some();
    }
    entry.files.values().flat_map(|v| v.split(',')).all(|f| root.join(f.trim()).exists())
}

impl Store {
    /// The entry with its `files` filled in (auto-detected for custom sherpa models that do not
    /// list them), plus where it is installed.
    pub fn resolve(&self, entry: &ModelEntry) -> Option<(ModelEntry, Installed)> {
        let inst = self.locate(entry)?;
        let mut entry = entry.clone();
        if entry.files.is_empty() && entry.engine == Engine::Sherpa {
            entry.files = autodetect(entry.family.as_deref().unwrap_or_default(), &inst.root)?;
        }
        Some((entry, inst))
    }
}

/// Guess file roles in a sherpa-onnx model folder from the upstream naming conventions, so users
/// can add a model by pointing at a folder or archive and naming its family.
pub fn autodetect(family: &str, root: &Path) -> Option<BTreeMap<String, String>> {
    let names: Vec<String> = std::fs::read_dir(root).ok()?.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    // A Git LFS pointer (about 130 bytes) is not a model, even when named like one.
    let real = |name: &str| std::fs::metadata(root.join(name)).is_ok_and(|m| m.len() >= 1024);
    // Prefer int8 when both precisions ship (smaller, same quality for these families).
    let model = |prefix: &str, extensions: &[&str]| -> Option<String> {
        let mut c: Vec<&String> = names.iter().filter(|n| n.starts_with(prefix) && extensions.iter().any(|e| n.ends_with(e)) && real(n)).collect();
        c.sort_by_key(|n| (!n.contains("int8"), n.len()));
        c.first().map(|s| s.to_string())
    };
    let onnx = |prefix: &str| model(prefix, &[".onnx"]);
    let has = |name: &str| names.iter().any(|n| n == name).then(|| name.to_string());
    let fsts: Vec<String> = names.iter().filter(|n| n.ends_with(".fst")).cloned().collect();
    let lexicons: Vec<String> = names.iter().filter(|n| n.starts_with("lexicon") && n.ends_with(".txt")).cloned().collect();
    let mut files = BTreeMap::new();
    let mut put = |role: &str, value: Option<String>| -> Option<()> {
        files.insert(role.to_string(), value?);
        Some(())
    };
    match family {
        "sense_voice" | "paraformer" | "nemo_ctc" | "dolphin" | "omnilingual" | "fire_red_asr_ctc" => {
            put("model", onnx("model").or_else(|| onnx("")))?;
            put("tokens", has("tokens.txt"))?;
        }
        "transducer" => {
            put("encoder", onnx("encoder"))?;
            put("decoder", onnx("decoder"))?;
            put("joiner", onnx("joiner"))?;
            put("tokens", has("tokens.txt"))?;
        }
        "fire_red_asr" => {
            put("encoder", onnx("encoder"))?;
            put("decoder", onnx("decoder"))?;
            put("tokens", has("tokens.txt"))?;
        }
        "moonshine" => {
            if let Some(merged) = model("decoder_model_merged", &[".onnx", ".ort"]).or_else(|| model("merged_decode", &[".onnx", ".ort"])) {
                // Moonshine v2: an encoder and one merged decoder.
                put("encoder", model("encoder", &[".onnx", ".ort"]).or_else(|| model("encode", &[".onnx", ".ort"])))?;
                put("merged_decoder", Some(merged))?;
            } else {
                put("preprocessor", onnx("preprocess"))?;
                put("encoder", onnx("encode"))?;
                put("uncached_decoder", onnx("uncached_decode"))?;
                put("cached_decoder", onnx("cached_decode"))?;
            }
            put("tokens", has("tokens.txt"))?;
        }
        "qwen3_asr" => {
            put("conv_frontend", onnx("conv_frontend"))?;
            put("encoder", onnx("encoder"))?;
            put("decoder", onnx("decoder"))?;
            put("tokenizer", has("tokenizer"))?;
        }
        "kokoro" => {
            put("model", onnx("model"))?;
            put("voices", has("voices.bin"))?;
            put("tokens", has("tokens.txt"))?;
            if !lexicons.is_empty() {
                put("lexicon", Some(lexicons.join(",")));
            }
            put("dict_dir", has("dict"));
        }
        "vits" => {
            put("model", onnx("model").or_else(|| onnx("")))?;
            put("tokens", has("tokens.txt"))?;
            if !lexicons.is_empty() {
                put("lexicon", Some(lexicons.join(",")));
            }
            put("dict_dir", has("dict"));
            // Marks a model that needs espeak-ng phonemes (Piper), which sherpa-onnx 2.0 no longer
            // provides; loading refuses it with that reason.
            put("data_dir", has("espeak-ng-data"));
        }
        _ => return None,
    }
    if !fsts.is_empty() && matches!(family, "kokoro" | "vits") {
        files.insert("rule_fsts".into(), fsts.join(","));
    }
    Some(files)
}

pub fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

/// whisper.cpp's naming rule: `ggml-large-v3-turbo-q5_0.bin` -> `ggml-large-v3-turbo-encoder.mlmodelc`.
pub fn coreml_encoder_path(model: &Path) -> PathBuf {
    let stem = model.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = match stem.rfind('-') {
        Some(pos) if stem[pos..].len() == 5 && stem[pos..].as_bytes()[1] == b'q' && stem[pos..].as_bytes()[3] == b'_' => stem[..pos].to_string(),
        _ => stem,
    };
    model.with_file_name(format!("{stem}-encoder.mlmodelc"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mlx_copy_identity_distinguishes_size_and_quantization_with_same_filenames() {
        use sha2::{Digest, Sha256};
        let dir = std::env::temp_dir().join(format!("vk-mlx-identity-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let small = br#"{"model_type":"qwen3_tts","tts_model_type":"custom_voice","tts_model_size":"0b6","quantization":{"bits":8}}"#;
        let entry: ModelEntry = serde_json::from_value(serde_json::json!({
            "id":"identity-test","kind":"tts","label":"fixture","engine":"mlx","family":"qwen3_tts",
            "files":{"config":"config.json","model":"model.safetensors"},
            "download":[{"url":"https://example.test/config.json","file":"config.json","sha256":hex::encode(Sha256::digest(small))}]
        })).unwrap();
        std::fs::write(dir.join("model.safetensors"), b"fixture").unwrap();
        for (size,bits) in [("1b7",8),("0b6",4)] {
            std::fs::write(dir.join("config.json"), serde_json::json!({"model_type":"qwen3_tts","tts_model_type":"custom_voice","tts_model_size":size,"quantization":{"bits":bits}}).to_string()).unwrap();
            assert!(!complete(&entry,&dir), "wrong model must not be borrowed merely because filenames match");
        }
        std::fs::write(dir.join("config.json"),small).unwrap();assert!(complete(&entry,&dir));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn builtin_catalog_is_valid() {
        let catalog = Catalog::load(&[]).unwrap();
        assert!(catalog.entries().len() >= 6);
        for e in catalog.entries() {
            assert_eq!(catalog.entries().iter().filter(|o| o.id == e.id).count(), 1, "{}", e.id);
            if e.engine != Engine::Openai && e.engine != Engine::Chain {
                assert!(!e.download.is_empty(), "{} has no download", e.id);
            }
            for use_ in &e.uses {
                assert!(["dictation", "voice_input", "voice_output"].contains(&use_.as_str()), "{}: {use_}", e.id);
            }
        }
    }

    #[test]
    fn autodetect_finds_sherpa_files() {
        let tmp = std::env::temp_dir().join(format!("vk-auto-{}", std::process::id()));
        std::fs::create_dir_all(tmp.join("dict")).unwrap();
        for f in ["model.onnx", "model.int8.onnx", "tokens.txt", "voices.bin", "lexicon-zh.txt", "lexicon-us-en.txt", "date-zh.fst"] {
            std::fs::write(tmp.join(f), vec![b'x'; 2048]).unwrap();
        }
        let sv = autodetect("sense_voice", &tmp).unwrap();
        assert_eq!(sv["model"], "model.int8.onnx");
        // A Git LFS pointer named like the preferred file is skipped for the real model.
        std::fs::write(tmp.join("model.int8.onnx"), "version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n").unwrap();
        assert_eq!(autodetect("sense_voice", &tmp).unwrap()["model"], "model.onnx");
        let k = autodetect("kokoro", &tmp).unwrap();
        assert_eq!(k["voices"], "voices.bin");
        assert!(k["lexicon"].contains("lexicon-zh.txt"));
        assert_eq!(k["rule_fsts"], "date-zh.fst");
        assert!(autodetect("transducer", &tmp).is_none());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn autodetect_finds_both_moonshine_layouts() {
        let tmp = std::env::temp_dir().join(format!("vk-moonshine-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        for f in ["preprocess.onnx", "encode.int8.onnx", "uncached_decode.int8.onnx", "cached_decode.int8.onnx", "tokens.txt"] {
            std::fs::write(tmp.join(f), vec![b'x'; 2048]).unwrap();
        }
        let v1 = autodetect("moonshine", &tmp).unwrap();
        assert_eq!(v1["preprocessor"], "preprocess.onnx");
        assert_eq!(v1["uncached_decoder"], "uncached_decode.int8.onnx");
        std::fs::remove_dir_all(&tmp).unwrap();
        std::fs::create_dir_all(&tmp).unwrap();
        for f in ["encoder_model.ort", "decoder_model_merged.ort", "tokens.txt"] {
            std::fs::write(tmp.join(f), vec![b'x'; 2048]).unwrap();
        }
        let v2 = autodetect("moonshine", &tmp).unwrap();
        assert_eq!((v2["encoder"].as_str(), v2["merged_decoder"].as_str()), ("encoder_model.ort", "decoder_model_merged.ort"));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn ids_and_file_paths_cannot_leave_the_models_folder() {
        let entry = |id: &str, file: &str| -> ModelEntry {
            serde_json::from_value(serde_json::json!({"id": id, "kind": "stt", "label": "x", "engine": "whisper", "files": {"model": file}})).unwrap()
        };
        assert!(entry("whisper-ok.v2", "sub/a.bin").validate().is_ok());
        for (id, file) in [(".", "a.bin"), ("..", "a.bin"), (".hidden", "a.bin"), ("ok", "/etc/passwd"), ("ok", "C:\\x.bin"), ("ok", "\\\\server\\x"), ("ok", "../x.bin"), ("ok", "a.bin, /abs")] {
            assert!(entry(id, file).validate().is_err(), "{id} {file}");
        }
    }

    #[test]
    fn coreml_name_strips_quantization() {
        assert_eq!(
            coreml_encoder_path(Path::new("/m/ggml-large-v3-turbo-q5_0.bin")),
            PathBuf::from("/m/ggml-large-v3-turbo-encoder.mlmodelc")
        );
        assert_eq!(coreml_encoder_path(Path::new("/m/ggml-base.bin")), PathBuf::from("/m/ggml-base-encoder.mlmodelc"));
    }

    #[test]
    fn custom_entries_load_and_cannot_shadow_builtins() {
        let dir = std::env::temp_dir().join(format!("vk-cat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("custom.json");
        std::fs::write(
            &file,
            r#"{"models":[
              {"id":"my-remote","kind":"tts","label":"Mine","engine":"openai","remote":{"base_url":"http://127.0.0.1:9/v1","model":"x"}},
              {"id":"sensevoice-int8","kind":"stt","label":"Clash","engine":"whisper","files":{"model":"a.bin"}},
              {"id":"bad/id","kind":"stt","label":"Bad","engine":"whisper","files":{"model":"a.bin"}}
            ]}"#,
        )
        .unwrap();
        let catalog = Catalog::load(&[file]).unwrap();
        assert_eq!(catalog.find("my-remote").unwrap().tier, "custom");
        assert_ne!(catalog.find("sensevoice-int8").unwrap().label, "Clash");
        assert!(catalog.find("bad/id").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn paseo_shared_cache_is_canonical_and_never_resurrects_private_duplicates() {
        let folder = std::env::temp_dir().join(format!("vk-paseo-canonical-{}", std::process::id()));
        let catalog = Catalog::load(&[]).unwrap();
        let entry = catalog.find("sensevoice-int8").unwrap();
        let own = folder.join("private").join(entry.dir_name());
        let root = folder.join("paseo").join(entry.dir_name());
        for dir in [&own, &root] {
            std::fs::create_dir_all(dir).unwrap();
            for name in entry.files.values() { std::fs::write(dir.join(name), "fixture").unwrap(); }
        }
        let store = Store { models_dir: folder.join("private"), reuse_dirs: vec![], shared_models_dir: Some(folder.join("paseo")), paseo_managed: true };
        let unavailable = Store { models_dir: folder.join("private"), reuse_dirs: vec![], shared_models_dir: None, paseo_managed: true };
        assert!(unavailable.paseo_model(entry).is_some());
        assert!(unavailable.locate(entry).is_none(), "an unknown canonical folder must not fall back to private copies");
        assert_eq!(store.paseo_model(entry), Some("sense-voice-int8"));
        let installed = store.locate(entry).unwrap();
        assert_eq!(installed.root, root); assert!(installed.shared);
        let marker = folder.join("paseo/.downloads"); std::fs::create_dir_all(&marker).unwrap();
        let archive = marker.join(entry.download[0].url.rsplit('/').next().unwrap());
        std::fs::write(&archive, "unfinished extraction").unwrap();
        assert!(store.locate(entry).is_none(), "Paseo's unfinished marker must agree in both apps");
        std::fs::remove_file(archive).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        assert!(store.locate(entry).is_none(), "Paseo deletion cannot reveal a private duplicate");
        let mut custom = entry.clone(); custom.tier = "custom".into();
        assert_eq!(store.paseo_model(&custom), None, "custom models cannot opt into destructive shared management");
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn locate_prefers_own_then_reuse() {
        let tmp = std::env::temp_dir().join(format!("vk-loc-{}", std::process::id()));
        let catalog = Catalog::load(&[]).unwrap();
        let entry = catalog.find("sensevoice-int8").unwrap();
        let reuse = tmp.join("reuse").join(entry.dir_name());
        std::fs::create_dir_all(&reuse).unwrap();
        for f in entry.files.values() {
            std::fs::write(reuse.join(f), "x").unwrap();
        }
        let store = Store { models_dir: tmp.join("own"), reuse_dirs: vec![tmp.join("reuse")], shared_models_dir: None, paseo_managed: false };
        assert!(store.locate(entry).unwrap().shared);
        std::fs::remove_dir_all(&tmp).ok();
    }
}
