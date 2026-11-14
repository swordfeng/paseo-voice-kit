//! Resumable, checksum-verified model downloads with progress reporting.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
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
}

#[derive(Clone, Default)]
pub struct Downloads {
    inner: Arc<Mutex<HashMap<String, Progress>>>,
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
            Err(err) => self.set(key, |p| p.error = Some(format!("{err:#}"))),
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
        let result = self.install(store, entry).await;
        self.finish(&entry.id, &result);
        result?;
        anyhow::ensure!(store.locate(entry).is_some(), "model {} is incomplete after download", entry.id);
        Ok(())
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
        let result = self.fetch_into(&key, &store.models_dir, download, &into, entry).await;
        self.finish(&key, &result);
        result?;
        anyhow::ensure!(target.exists(), "CoreML archive did not contain {}", target.display());
        Ok(())
    }

    async fn install(&self, store: &Store, entry: &ModelEntry) -> anyhow::Result<()> {
        let target = store.own_dir(entry);
        let staging_root = store.models_dir.join(".partial");
        let staged = staging_root.join(format!("{}.dir", entry.id));
        if staged.exists() {
            tokio::fs::remove_dir_all(&staged).await.ok();
        }
        tokio::fs::create_dir_all(&staged).await?;
        let mut done_before = 0u64;
        for download in &entry.download {
            self.fetch_into(&entry.id, &store.models_dir, download, &staged, entry).await?;
            done_before += download.size;
            self.set(&entry.id, |p| p.downloaded = done_before);
        }
        if target.exists() {
            tokio::fs::remove_dir_all(&target).await.ok();
        }
        tokio::fs::rename(&staged, &target).await.with_context(|| format!("install {}", target.display()))?;
        Ok(())
    }

    /// Fetch one download (file or archive) and place its contents into `into`.
    async fn fetch_into(&self, key: &str, models_dir: &Path, download: &Download, into: &Path, entry: &ModelEntry) -> anyhow::Result<()> {
        let staging = models_dir.join(".partial");
        tokio::fs::create_dir_all(&staging).await?;
        tokio::fs::create_dir_all(into).await?;
        let name = url_file_name(&download.url);
        let part = staging.join(format!("{}-{}.part", entry.id, name));
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
                let unpack_dir = staging.join(format!("{}-{}.unpack", entry.id, name));
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
        let client = reqwest::Client::builder().user_agent(concat!("voicekit/", env!("CARGO_PKG_VERSION"))).build()?;
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
        let mut resp = req.send().await?;
        if resp.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && offset > 0 {
            // Stale/oversized partial file: retry from zero once, without a Range header.
            resp = client.get(url).send().await?;
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
        while let Some(chunk) = stream.next().await {
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
