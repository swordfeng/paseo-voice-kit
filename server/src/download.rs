//! Resumable, checksum-verified model downloads with progress reporting.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};

use anyhow::Context;
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::catalog::{Download, ModelEntry, Store};

#[derive(Debug, Clone, Serialize, Default)]
pub struct Progress {
    pub downloaded: u64,
    pub total: Option<u64>,
    pub phase: &'static str,
    pub error: Option<String>,
    #[serde(skip)]
    failed_at: Option<Instant>,
}

/// A connection that sends nothing for this long fails the download, so it can be retried.
const STALL: Duration = Duration::from_secs(60);
const CONNECT: Duration = Duration::from_secs(15);
/// A failed automatic download is tried again after this long.
pub const RETRY_FAILED_AFTER: Duration = Duration::from_secs(5 * 60);
/// Partial downloads nobody resumed for this long are deleted at startup.
const STALE_PARTIAL: Duration = Duration::from_secs(7 * 24 * 3600);
/// Separates the model id from the rest of a partial file name. Model ids can't contain it, so
/// one model's partial files are never mistaken for another's.
const SEP: char = '~';

#[derive(Clone)]
pub struct Downloads {
    inner: Arc<Mutex<HashMap<String, Progress>>>,
    /// See STALL; shorter in tests.
    stall: Duration,
}

impl Default for Downloads {
    fn default() -> Self {
        Self { inner: Arc::default(), stall: STALL }
    }
}

/// Progress key for an entry's CoreML encoder.
pub fn coreml_key(id: &str) -> String {
    format!("{id}:coreml")
}

impl Downloads {
    pub fn snapshot(&self) -> HashMap<String, Progress> {
        self.inner.lock().unwrap().clone()
    }

    pub fn is_active(&self, key: &str) -> bool {
        self.inner.lock().unwrap().get(key).is_some_and(|p| p.error.is_none() && p.phase != "done")
    }

    pub fn error(&self, key: &str) -> Option<String> {
        self.inner.lock().unwrap().get(key).and_then(|p| p.error.clone())
    }

    /// A download that failed at least `RETRY_FAILED_AFTER` ago (automatic retries wait this long).
    pub fn failed_and_due(&self, key: &str) -> bool {
        self.inner.lock().unwrap().get(key).is_some_and(|p| p.error.is_some() && p.failed_at.is_none_or(|t| t.elapsed() >= RETRY_FAILED_AFTER))
    }

    /// Not downloading now, and not a recent failure: an automatic download may start.
    pub fn may_start(&self, key: &str) -> bool {
        match self.inner.lock().unwrap().get(key) {
            None => true,
            Some(p) if p.error.is_some() => p.failed_at.is_none_or(|t| t.elapsed() >= RETRY_FAILED_AFTER),
            Some(p) => p.phase == "done",
        }
    }

    fn set(&self, key: &str, f: impl FnOnce(&mut Progress)) {
        let mut map = self.inner.lock().unwrap();
        f(map.entry(key.to_string()).or_default());
    }

    pub fn clear(&self, key: &str) {
        self.inner.lock().unwrap().remove(key);
    }

    fn begin(&self, key: &str, total: u64) -> anyhow::Result<()> {
        let mut map = self.inner.lock().unwrap();
        if map.get(key).is_some_and(|p| p.error.is_none() && p.phase != "done") {
            anyhow::bail!("download already in progress");
        }
        map.insert(key.to_string(), Progress { phase: "downloading", total: (total > 0).then_some(total), ..Default::default() });
        Ok(())
    }

    fn finish(&self, key: &str, result: &anyhow::Result<()>) {
        match result {
            Ok(()) => self.set(key, |p| p.phase = "done"),
            Err(err) => self.set(key, |p| {
                p.error = Some(format!("{err:#}"));
                p.failed_at = Some(Instant::now());
            }),
        }
    }

    /// Download and install `entry` unless it is already present.
    pub async fn ensure(&self, store: &Store, entry: &ModelEntry) -> anyhow::Result<()> {
        if store.locate(entry).is_some() {
            return Ok(());
        }
        anyhow::ensure!(store.paseo_model(entry).is_none(), "shared model {} is managed by Paseo", entry.id);
        anyhow::ensure!(!entry.download.is_empty(), "model {} has no download source", entry.id);
        self.begin(&entry.id, entry.size_bytes())?;
        // A download that leaves the model incomplete is a failure like any other, so it is
        // reported and not started again on every request.
        let result = match self.install(store, entry).await {
            Ok(()) if store.locate(entry).is_none() => Err(anyhow::anyhow!("model {} is incomplete after download (its files don't match the catalog)", entry.id)),
            other => other,
        };
        self.finish(&entry.id, &result);
        if result.is_ok() {
            clean_partials(&store.models_dir, &entry.id).await;
        }
        result
    }

    /// Download the CoreML encoder for a whisper entry (next to its model file).
    pub async fn ensure_coreml(&self, store: &Store, entry: &ModelEntry) -> anyhow::Result<()> {
        let (Some(download), Some(target)) = (&entry.coreml, store.coreml_dir(entry)) else {
            anyhow::bail!("model {} has no CoreML encoder", entry.id);
        };
        if target.exists() {
            return Ok(());
        }
        let key = coreml_key(&entry.id);
        self.begin(&key, download.size)?;
        let into = target.parent().map(Path::to_path_buf).unwrap_or_default();
        let stem = format!("{}{SEP}coreml{SEP}{}", entry.id, url_file_name(&download.url));
        let result = self.fetch_into(&key, &store.models_dir, download, &into, entry, &stem).await;
        self.finish(&key, &result);
        result?;
        anyhow::ensure!(target.exists(), "CoreML archive did not contain {}", target.display());
        Ok(())
    }

    async fn install(&self, store: &Store, entry: &ModelEntry) -> anyhow::Result<()> {
        let target = store.own_dir(entry);
        let staging_root = store.models_dir.join(".partial");
        let staged = staging_root.join(format!("{}{SEP}dir", entry.id));
        // Files finished by an interrupted attempt are kept, as long as the entry's downloads
        // are still the same ones.
        let fingerprint = entry.download.iter().map(|d| format!("{}|{}|{}|{}", d.url, d.sha256.as_deref().unwrap_or(""), d.file.as_deref().unwrap_or(""), d.unpack.as_deref().unwrap_or(""))).collect::<Vec<_>>().join("\n");
        let marker = staged.join(".voicekit-entry");
        if staged.exists() && tokio::fs::read_to_string(&marker).await.ok().as_deref() != Some(fingerprint.as_str()) {
            tokio::fs::remove_dir_all(&staged).await.ok();
        }
        tokio::fs::create_dir_all(&staged).await?;
        tokio::fs::write(&marker, &fingerprint).await?;
        let mut done_before = 0u64;
        for (index, download) in entry.download.iter().enumerate() {
            let fetched = staged.join(format!(".voicekit-fetched-{index}"));
            if !tokio::fs::try_exists(&fetched).await.unwrap_or(false) {
                let stem = format!("{}{SEP}{index}{SEP}{}", entry.id, url_file_name(&download.url));
                self.fetch_into(&entry.id, &store.models_dir, download, &staged, entry, &stem).await?;
                tokio::fs::write(&fetched, b"").await?;
            }
            done_before += download.size;
            self.set(&entry.id, |p| p.downloaded = done_before);
        }
        let mut items = tokio::fs::read_dir(&staged).await?;
        while let Some(item) = items.next_entry().await? {
            if item.file_name().to_string_lossy().starts_with(".voicekit-") {
                tokio::fs::remove_file(item.path()).await.ok();
            }
        }
        if target.exists() {
            tokio::fs::remove_dir_all(&target).await.ok();
        }
        tokio::fs::rename(&staged, &target).await.with_context(|| format!("install {}", target.display()))?;
        Ok(())
    }

    /// Fetch one download (file or archive) and place its contents into `into`.
    /// `stem` names this download's partial file uniquely (id, position in the entry, URL name):
    /// two files with the same name in different folders never share one.
    async fn fetch_into(&self, key: &str, models_dir: &Path, download: &Download, into: &Path, entry: &ModelEntry, stem: &str) -> anyhow::Result<()> {
        let staging = models_dir.join(".partial");
        tokio::fs::create_dir_all(&staging).await?;
        tokio::fs::create_dir_all(into).await?;
        let name = url_file_name(&download.url);
        let part = staging.join(format!("{stem}.part"));
        let digest = self.fetch(key, &download.url, &part, download.sha256.as_deref()).await?;
        if let Some(expected) = &download.sha256 {
            if &digest != expected {
                tokio::fs::remove_file(&part).await.ok();
                anyhow::bail!("checksum mismatch for {} ({name}): got {digest}", entry.id);
            }
        }
        tracing::info!(model = entry.id, file = name, sha256 = %digest, "downloaded");
        match download.unpack.as_deref() {
            None => {
                let file = download.file.clone().unwrap_or_else(|| name.clone());
                // Nested paths are allowed (Hugging Face repos have subfolders); escaping is not.
                anyhow::ensure!(
                    !file.split(['/', '\\']).any(|seg| seg == ".." || seg.is_empty()) && !file.starts_with('/') && !file.contains(':'),
                    "bad file name {file}"
                );
                let dest = into.join(&file);
                if let Some(parent) = dest.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::rename(&part, dest).await?;
            }
            Some(kind) => {
                self.set(key, |p| p.phase = "unpacking");
                let unpack_dir = staging.join(format!("{stem}.unpack"));
                let (archive, out, kind) = (part.clone(), unpack_dir.clone(), kind.to_string());
                tokio::task::spawn_blocking(move || unpack(&archive, &out, &kind)).await.context("unpack task")??;
                merge_single_root(&unpack_dir, into)?;
                std::fs::remove_dir_all(&unpack_dir).ok();
                tokio::fs::remove_file(&part).await.ok();
                self.set(key, |p| p.phase = "downloading");
            }
        }
        Ok(())
    }

    /// Stream `url` into `part`, resuming a partial file. Returns the sha256 of the whole file.
    async fn fetch(&self, key: &str, url: &str, part: &Path, expected_sha: Option<&str>) -> anyhow::Result<String> {
        let client = reqwest::Client::builder()
            .user_agent(concat!("voicekit/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(CONNECT)
            .build()?;
        let stall = self.stall;
        let stalled = || anyhow::anyhow!("download stalled: no data for {} s", stall.as_secs_f32());
        let mut offset = tokio::fs::metadata(part).await.map(|m| m.len()).unwrap_or(0);
        // Stream the prefix rather than allocating a potentially gigabyte-sized buffer.
        let mut hasher = Sha256::new();
        if offset > 0 {
            let mut prefix = tokio::fs::File::open(part).await?;
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = prefix.read(&mut buf).await?;
                if n == 0 { break; }
                hasher.update(&buf[..n]);
            }
            let digest = hex::encode(hasher.clone().finalize());
            if expected_sha == Some(digest.as_str()) {
                return Ok(digest); // complete, verified archive left by an interrupted unpack
            }
        }
        let mut req = client.get(url);
        if offset > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={offset}-"));
        }
        let mut resp = tokio::time::timeout(stall, req.send()).await.map_err(|_| stalled())??;
        if resp.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && offset > 0 {
            // Stale/oversized partial file: retry from zero once, without a Range header.
            resp = tokio::time::timeout(stall, client.get(url).send()).await.map_err(|_| stalled())??;
            offset = 0;
            hasher = Sha256::new();
        }
        let resp = resp.error_for_status()?;
        let resumed = resp.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        if !resumed {
            offset = 0;
            hasher = Sha256::new();
        } else {
            let start = resp.headers().get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("bytes "))
                .and_then(|v| v.split_once('-')).and_then(|(start, _)| start.parse::<u64>().ok());
            anyhow::ensure!(start == Some(offset), "invalid resume range");
        }
        let expected_len = resp.content_length().map(|len| len + offset);
        let base = self.inner.lock().unwrap().get(key).map(|p| p.downloaded).unwrap_or(0);

        let mut file = if resumed && offset > 0 {
            tokio::fs::OpenOptions::new().append(true).open(part).await?
        } else {
            tokio::fs::File::create(part).await?
        };
        let mut stream = resp.bytes_stream();
        let mut done = offset;
        let mut last = 0u64;
        while let Some(chunk) = tokio::time::timeout(stall, stream.next()).await.map_err(|_| stalled())? {
            let chunk = chunk?;
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
            done += chunk.len() as u64;
            if done - last > 1 << 20 {
                last = done;
                self.set(key, |p| p.downloaded = base + done);
            }
        }
        file.flush().await?;
        if let Some(expected) = expected_len {
            anyhow::ensure!(done == expected, "download truncated ({done} of {expected} bytes)");
        }
        Ok(hex::encode(hasher.finalize()))
    }
}

/// Delete a model's partial downloads (after it installed, or when it is removed).
pub async fn clean_partials(models_dir: &Path, id: &str) {
    let staging = models_dir.join(".partial");
    let Ok(mut items) = tokio::fs::read_dir(&staging).await else { return };
    let prefix = format!("{id}{SEP}");
    while let Ok(Some(item)) = items.next_entry().await {
        if item.file_name().to_string_lossy().starts_with(&prefix) {
            let path = item.path();
            if path.is_dir() { tokio::fs::remove_dir_all(&path).await.ok(); } else { tokio::fs::remove_file(&path).await.ok(); }
        }
    }
}

/// At startup, before any download runs: delete partial downloads untouched for a week, and
/// files left in the old naming scheme, which a resume no longer finds.
pub fn gc_partials(models_dir: &Path) {
    let Ok(items) = std::fs::read_dir(models_dir.join(".partial")) else { return };
    for item in items.flatten() {
        let old = item.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_none_or(|age| age >= STALE_PARTIAL);
        let legacy = !item.file_name().to_string_lossy().contains(SEP);
        if old || legacy {
            let path = item.path();
            tracing::info!(path = %path.display(), "removing an abandoned partial download");
            if path.is_dir() { std::fs::remove_dir_all(&path).ok(); } else { std::fs::remove_file(&path).ok(); }
        }
    }
}

fn url_file_name(url: &str) -> String {
    url.split(['?', '#']).next().unwrap_or(url).rsplit('/').next().unwrap_or("download").to_string()
}

fn unpack(archive: &Path, into: &Path, kind: &str) -> anyhow::Result<()> {
    if into.exists() {
        std::fs::remove_dir_all(into)?;
    }
    std::fs::create_dir_all(into)?;
    let file = std::io::BufReader::new(std::fs::File::open(archive)?);
    match kind {
        "tar.bz2" => tar::Archive::new(bzip2::read::BzDecoder::new(file)).unpack(into).context("unpack tar.bz2")?,
        // `extract` refuses entries that would escape `into`.
        "zip" => zip::ZipArchive::new(file)?.extract(into).context("unpack zip")?,
        other => anyhow::bail!("unsupported archive type {other}"),
    }
    // macOS zips carry resource-fork noise.
    std::fs::remove_dir_all(into.join("__MACOSX")).ok();
    Ok(())
}

/// Move unpacked content into `into`, unwrapping a single top-level directory.
fn merge_single_root(unpacked: &Path, into: &Path) -> anyhow::Result<()> {
    let entries: Vec<PathBuf> = std::fs::read_dir(unpacked)?.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    let source = match entries.as_slice() {
        [only] if only.is_dir() && !only.extension().is_some_and(|e| e == "mlmodelc") => only.clone(),
        _ => unpacked.to_path_buf(),
    };
    for entry in std::fs::read_dir(&source)? {
        let entry = entry?;
        let dest = into.join(entry.file_name());
        if dest.exists() {
            if dest.is_dir() {
                std::fs::remove_dir_all(&dest)?;
            } else {
                std::fs::remove_file(&dest)?;
            }
        }
        std::fs::rename(entry.path(), dest)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn complete_verified_partial_needs_no_network_and_stale_416_restarts() {
        let root = std::env::temp_dir().join(format!("vk-resume-{}", std::process::id()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let part = root.join("model.part");
        let digest = hex::encode(Sha256::digest(b"tiny"));
        tokio::fs::write(&part, b"tiny").await.unwrap();
        let downloads = Downloads::default();
        assert_eq!(downloads.fetch("test", "http://127.0.0.1:1/no-network", &part, Some(&digest)).await.unwrap(), digest);

        tokio::fs::write(&part, b"oversized-stale-file").await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for first in [true, false] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let n = socket.read(&mut buf).await.unwrap();
                let request = String::from_utf8_lossy(&buf[..n]).to_lowercase();
                assert_eq!(request.contains("range: bytes="), first);
                let response = if first {
                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntiny"
                };
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), downloads.fetch("test", &format!("http://{address}/model"), &part, Some(&digest))).await.unwrap().unwrap();
        assert_eq!(result, digest);
        assert_eq!(tokio::fs::read(&part).await.unwrap(), b"tiny");
        server.await.unwrap();
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn resumes_valid_prefix_with_content_range() {
        let part = std::env::temp_dir().join(format!("vk-prefix-{}.part", std::process::id()));
        tokio::fs::write(&part, b"ti").await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).to_lowercase().contains("range: bytes=2-"));
            socket.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 2-3/4\r\nContent-Length: 2\r\nConnection: close\r\n\r\nny").await.unwrap();
        });
        let digest = hex::encode(Sha256::digest(b"tiny"));
        let result = Downloads::default().fetch("test", &format!("http://{address}/model"), &part, Some(&digest)).await.unwrap();
        assert_eq!(result, digest);
        assert_eq!(tokio::fs::read(&part).await.unwrap(), b"tiny");
        server.await.unwrap();
        tokio::fs::remove_file(part).await.unwrap();
    }

    #[tokio::test]
    async fn multi_file_install_resumes_without_refetching_finished_files() {
        let root = std::env::temp_dir().join(format!("vk-multi-{}", std::process::id()));
        tokio::fs::remove_dir_all(&root).await.ok();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        // Two files with the same name in different folders; the second connection drops once.
        let requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = requests.clone();
        let server = tokio::spawn(async move {
            let mut dropped = false;
            loop {
                let Ok(Ok((mut socket, _))) = tokio::time::timeout(Duration::from_secs(5), listener.accept()).await else { break };
                let mut buf = [0u8; 4096];
                let n = socket.read(&mut buf).await.unwrap();
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
                seen.lock().unwrap().push(path.clone());
                let response: &[u8] = match path.as_str() {
                    "/a/config.json" => b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nAAAA",
                    "/b/config.json" if !dropped => { dropped = true; b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nBB" }
                    "/b/config.json" => b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nBBBB",
                    _ => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                };
                socket.write_all(response).await.unwrap();
                if requests_done(&seen) { break; }
            }
        });
        fn requests_done(seen: &Arc<Mutex<Vec<String>>>) -> bool { seen.lock().unwrap().len() >= 3 }
        let entry: ModelEntry = serde_json::from_value(serde_json::json!({
            "id": "multi-fixture", "kind": "tts", "label": "fixture", "engine": "whisper",
            "files": {"model": "a/config.json", "codec": "b/config.json"},
            "download": [
                {"url": format!("http://{address}/a/config.json"), "file": "a/config.json", "size": 4},
                {"url": format!("http://{address}/b/config.json"), "file": "b/config.json", "size": 4},
            ],
        })).unwrap();
        let store = Store { models_dir: root.clone(), reuse_dirs: vec![], shared_models_dir: None, paseo_managed: false };
        let downloads = Downloads::default();
        assert!(downloads.ensure(&store, &entry).await.is_err());
        assert!(downloads.error("multi-fixture").is_some());
        assert!(!downloads.failed_and_due("multi-fixture"), "an automatic retry waits after a failure");
        assert!(!downloads.may_start("multi-fixture"));
        downloads.ensure(&store, &entry).await.unwrap();
        server.await.unwrap();
        assert_eq!(*requests.lock().unwrap(), ["/a/config.json", "/b/config.json", "/b/config.json"], "the finished file is not fetched again");
        let installed = store.own_dir(&entry);
        assert_eq!(tokio::fs::read(installed.join("a/config.json")).await.unwrap(), b"AAAA");
        assert_eq!(tokio::fs::read(installed.join("b/config.json")).await.unwrap(), b"BBBB");
        assert!(std::fs::read_dir(installed.join("..").join(".partial")).unwrap().next().is_none(), "partial files are cleaned up");
        assert!(!std::fs::read_dir(&installed).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with(".voicekit-")));
        tokio::fs::remove_dir_all(root).await.ok();
    }

    #[tokio::test]
    async fn a_download_that_leaves_the_model_incomplete_is_a_failure() {
        let root = std::env::temp_dir().join(format!("vk-incomplete-{}", std::process::id()));
        tokio::fs::remove_dir_all(&root).await.ok();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntiny").await.unwrap();
        });
        // The catalog expects a file the download doesn't provide.
        let entry: ModelEntry = serde_json::from_value(serde_json::json!({
            "id": "incomplete-fixture", "kind": "stt", "label": "fixture", "engine": "whisper",
            "files": {"model": "missing.bin"},
            "download": [{"url": format!("http://{address}/x.bin"), "file": "x.bin", "size": 4}],
        })).unwrap();
        let store = Store { models_dir: root.clone(), reuse_dirs: vec![], shared_models_dir: None, paseo_managed: false };
        let downloads = Downloads::default();
        assert!(downloads.ensure(&store, &entry).await.is_err());
        server.await.unwrap();
        assert!(downloads.error("incomplete-fixture").unwrap().contains("incomplete"));
        assert!(!downloads.may_start("incomplete-fixture"), "not started again on the next request");
        tokio::fs::remove_dir_all(root).await.ok();
    }

    #[tokio::test]
    async fn a_connection_that_stops_sending_fails_instead_of_hanging() {
        let part = std::env::temp_dir().join(format!("vk-stall-{}.part", std::process::id()));
        tokio::fs::remove_file(&part).await.ok();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nti").await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let downloads = Downloads { stall: Duration::from_millis(200), ..Downloads::default() };
        let started = Instant::now();
        let error = downloads.fetch("test", &format!("http://{address}/model"), &part, None).await.unwrap_err();
        assert!(error.to_string().contains("stalled"), "{error:#}");
        assert!(started.elapsed() < Duration::from_secs(3));
        server.abort();
        tokio::fs::remove_file(&part).await.ok();
    }

    #[tokio::test]
    async fn a_file_that_fails_its_checksum_is_deleted() {
        let root = std::env::temp_dir().join(format!("vk-sha-{}", std::process::id()));
        tokio::fs::remove_dir_all(&root).await.ok();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nevil").await.unwrap();
        });
        let entry: ModelEntry = serde_json::from_value(serde_json::json!({
            "id": "sha-fixture", "kind": "stt", "label": "fixture", "engine": "whisper", "files": {"model": "m.bin"},
            "download": [{"url": format!("http://{address}/m.bin"), "file": "m.bin", "size": 4, "sha256": hex::encode(Sha256::digest(b"tiny"))}],
        })).unwrap();
        let store = Store { models_dir: root.clone(), reuse_dirs: vec![], shared_models_dir: None, paseo_managed: false };
        let error = Downloads::default().ensure(&store, &entry).await.unwrap_err();
        server.await.unwrap();
        assert!(format!("{error:#}").contains("checksum mismatch"));
        let leftovers: Vec<_> = std::fs::read_dir(root.join(".partial")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".part")).collect();
        assert!(leftovers.is_empty(), "the bad file is not kept to be resumed");
        assert!(store.locate(&entry).is_none());
        tokio::fs::remove_dir_all(root).await.ok();
    }

    #[test]
    fn startup_cleanup_removes_abandoned_and_old_style_partials_only() {
        let root = std::env::temp_dir().join(format!("vk-gc-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let partial = root.join(".partial");
        std::fs::create_dir_all(partial.join(format!("old{SEP}dir"))).unwrap();
        for name in [format!("fresh{SEP}0{SEP}a.bin.part"), "legacy-a.bin.part".to_string(), format!("old{SEP}0{SEP}a.bin.part")] {
            std::fs::write(partial.join(name), b"x").unwrap();
        }
        let month_ago = SystemTime::now() - Duration::from_secs(30 * 24 * 3600);
        std::fs::File::options().write(true).open(partial.join(format!("old{SEP}0{SEP}a.bin.part"))).unwrap().set_modified(month_ago).unwrap();
        std::fs::File::open(partial.join(format!("old{SEP}dir"))).unwrap().set_modified(month_ago).unwrap();
        gc_partials(&root);
        let mut left: Vec<_> = std::fs::read_dir(&partial).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, [format!("fresh{SEP}0{SEP}a.bin.part")]);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn file_name_from_url() {
        assert_eq!(url_file_name("https://h/x/ggml-base.bin?download=true"), "ggml-base.bin");
    }

    #[test]
    fn merge_unwraps_single_root_but_keeps_mlmodelc() {
        let tmp = std::env::temp_dir().join(format!("vk-merge-{}", std::process::id()));
        let unpacked = tmp.join("u");
        std::fs::create_dir_all(unpacked.join("model-dir")).unwrap();
        std::fs::write(unpacked.join("model-dir/tokens.txt"), "x").unwrap();
        let into = tmp.join("into");
        std::fs::create_dir_all(&into).unwrap();
        merge_single_root(&unpacked, &into).unwrap();
        assert!(into.join("tokens.txt").exists());

        let unpacked2 = tmp.join("u2");
        std::fs::create_dir_all(unpacked2.join("ggml-x-encoder.mlmodelc")).unwrap();
        merge_single_root(&unpacked2, &into).unwrap();
        assert!(into.join("ggml-x-encoder.mlmodelc").is_dir());
        std::fs::remove_dir_all(&tmp).ok();
    }
}
