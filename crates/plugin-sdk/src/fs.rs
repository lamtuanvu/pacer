//! `capability.fs.*` with `fileWriteChunks` staging for writes that exceed one
//! frame. Port of `packages/plugin-sdk/src/fs.ts`.
//!
//! Not feature-gated because it is core TypeScript SDK API.

use crate::{FEATURE_FILE_WRITE_CHUNKS, Host, PluginError, host, js};
use serde_json::{Value, json};

pub(crate) const FS: &str = "capability.fs.";

const MAX: usize = 4 * 1024 * 1024; // 4194304
const CHUNK_BYTES: usize = 262_144;
const WRITE_MODE: u64 = 0o600;

fn internal(message: &str) -> PluginError {
    PluginError::new("internal", message)
}

fn ended() -> PluginError {
    host::owning_ended()
}

/// The filesystem facade served to a plugin, mirroring the `fs` object
/// `createFileSystem` returns in the TypeScript SDK. All operations pass
/// through one per-call queue so only one transaction runs at a time (the TS
/// `tail` chain), and an aborted owning call rejects queued work without
/// capability effects.
#[derive(Clone)]
pub struct FileSystem {
    host: Host,
    prefix: &'static str,
}

impl Host {
    /// The filesystem facade for this plugin call, sharing the call's queue
    /// so `write`/`mkdir`/`remove` serialize.
    pub fn fs(&self) -> FileSystem {
        FileSystem { host: self.clone(), prefix: FS }
    }
}

impl FileSystem {
    fn active(&self) -> Result<(), PluginError> {
        if self.host_cancelled() {
            Err(ended())
        } else {
            Ok(())
        }
    }

    fn host_cancelled(&self) -> bool {
        self.host.cancel.as_ref().is_some_and(|c| c.is_cancelled())
    }

    fn fit(&self, method: &str, params: &Value) -> Result<(), PluginError> {
        if self.host.fits(&self.full(method), params) {
            Ok(())
        } else {
            Err(internal("filesystem complete frame exceeds limit"))
        }
    }

    fn negotiated(&self) -> bool {
        features(&self.host).contains(FEATURE_FILE_WRITE_CHUNKS)
    }

    fn full(&self, method: &str) -> String {
        format!("{}{}", self.prefix, method)
    }

    async fn invoke(&self, method: &str, params: Value) -> Result<Value, PluginError> {
        self.active()?;
        self.fit(method, &params)?;
        self.host.call(&self.full(method), params).await
    }

    fn ok(&self, reply: &Value) -> Result<(), PluginError> {
        if reply.get("ok") == Some(&json!(true)) {
            Ok(())
        } else {
            Err(internal("invalid filesystem acknowledgement"))
        }
    }

    /// Serialise one filesystem transaction so only one runs per caller. If the
    /// owning call is already ended, or ends while waiting for the queue, the
    /// queued operation rejects with no capability effects (fs.ts `queue`).
    async fn queue<F, Fut>(&self, action: F) -> Result<(), PluginError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<(), PluginError>>,
    {
        if self.host_cancelled() {
            return Err(ended());
        }
        let queue = self.host.fs_queue.clone();
        let cancel = self.host.cancel.clone();
        let guard = match &cancel {
            Some(token) => {
                let lock = queue.lock();
                tokio::pin!(lock);
                tokio::select! {
                    g = &mut lock => g,
                    _ = token.cancelled() => return Err(ended()),
                }
            }
            None => queue.lock().await,
        };
        let outcome = action().await;
        drop(guard);
        outcome
    }

    /// Write `text` to `path`, optionally inlining the mode. Writes larger
    /// than one frame stage via `beginWrite`/`writeChunk`/`commitWrite` when
    /// `fileWriteChunks` is negotiated, releasing the staging handle on any
    /// failure.
    pub async fn write(&self, path: &str, text: &str, mode: Option<u64>) -> Result<(), PluginError> {
        self.queue(move || self.write_once(path, text, mode)).await
    }

    async fn write_once(
        &self,
        path: &str,
        text: &str,
        mode: Option<u64>,
    ) -> Result<(), PluginError> {
        self.active()?;
        if mode.is_some_and(|m| m != WRITE_MODE) {
            return Err(internal("filesystem write mode must be 0600"));
        }
        let bytes = text.as_bytes();
        if bytes.len() > MAX {
            return Err(internal("filesystem write exceeds 4MiB UTF8"));
        }
        let mut params = serde_json::Map::new();
        params.insert("path".into(), json!(path));
        params.insert("text".into(), json!(text));
        if let Some(m) = mode {
            params.insert("mode".into(), json!(m));
        }
        let params = Value::Object(params);
        if self.host.fits(&self.full("write"), &params) {
            self.ok(&self.invoke("write", params).await?)?;
            self.active()?;
            return Ok(());
        }
        if !self.negotiated() {
            return Err(internal("oversized filesystem write requires fileWriteChunks"));
        }
        let mut begin = serde_json::Map::new();
        begin.insert("path".into(), json!(path));
        begin.insert("bytes".into(), json!(bytes.len()));
        if let Some(m) = mode {
            begin.insert("mode".into(), json!(m));
        }
        let begin = Value::Object(begin);
        // Reserve worst-case encoded handle metadata before allocating host staging.
        let reserved = "\0".repeat(256);
        self.fit("beginWrite", &begin)?;
        self.fit("commitWrite", &json!({ "handle": reserved }))?;
        self.fit("releaseWrite", &json!({ "handle": reserved }))?;
        if !bytes.is_empty() {
            self.fit("writeChunk", &json!({ "handle": reserved, "offset": MAX, "base64": "AA==" }))?;
        }
        let mut handle: Option<String> = None;
        let mut failure: Option<PluginError> = None;
        let opened = self.invoke("beginWrite", begin).await;
        match opened {
            Ok(value) => {
                let good = value
                    .get("handle")
                    .and_then(Value::as_str)
                    .filter(|h| !h.is_empty() && h.len() <= 256);
                match good {
                    Some(h) => {
                        handle = Some(h.to_owned());
                        let h = h.to_owned();
                        let mut offset = 0usize;
                        let mut ok_so_far = true;
                        while offset < bytes.len() && ok_so_far {
                            // Base64 has monotonic encoded size. Adapt to the
                            // actual complete frame, including long owner
                            // metadata, path-independent handle and current ID.
                            let mut low = 1usize;
                            let mut high = CHUNK_BYTES.min(bytes.len() - offset);
                            let mut length = 0usize;
                            while low <= high {
                                let candidate = (low + high) / 2;
                                let part = &bytes[offset..offset + candidate];
                                let params = json!({
                                    "handle": h,
                                    "offset": offset,
                                    "base64": js::base64::encode(part),
                                });
                                if self.host.fits(&self.full("writeChunk"), &params) {
                                    length = candidate;
                                    low = candidate + 1;
                                } else {
                                    high = candidate - 1;
                                }
                            }
                            if length == 0 {
                                failure = Some(internal("filesystem complete frame exceeds limit"));
                                ok_so_far = false;
                                break;
                            }
                            let part = &bytes[offset..offset + length];
                            let params = json!({
                                "handle": h,
                                "offset": offset,
                                "base64": js::base64::encode(part),
                            });
                            match self.invoke("writeChunk", params).await {
                                Ok(reply) => {
                                    let got = reply
                                        .get("bytes")
                                        .and_then(Value::as_u64)
                                        .map(|v| v as usize);
                                    if got != Some(offset + length) {
                                        failure =
                                            Some(internal("invalid filesystem byte acknowledgement"));
                                        ok_so_far = false;
                                    } else {
                                        offset += length;
                                    }
                                }
                                Err(e) => {
                                    failure = Some(e);
                                    ok_so_far = false;
                                }
                            }
                        }
                        if ok_so_far {
                            match self.invoke("commitWrite", json!({ "handle": h })).await {
                                Ok(reply) => match self.ok(&reply) {
                                    Ok(()) => {}
                                    Err(e) => failure = Some(e),
                                },
                                Err(e) => failure = Some(e),
                            }
                            if failure.is_none() {
                                handle = None; // Successful commit consumes the staging handle.
                            }
                        }
                    }
                    None => failure = Some(internal("invalid filesystem upload handle")),
                }
            }
            Err(e) => failure = Some(e),
        }
        if let Some(h) = handle {
            let release = json!({ "handle": h });
            if let Err(e) = self.fit("releaseWrite", &release) {
                failure = Some(e);
            } else {
                match self
                    .host
                    .call_cleanup(&self.full("releaseWrite"), release)
                    .await
                {
                    Ok(reply) => {
                        if let Err(e) = self.ok(&reply) {
                            failure = Some(e);
                        }
                    }
                    Err(e) => failure = Some(e),
                }
            }
        }
        if let Some(e) = failure {
            return Err(e);
        }
        self.active()?;
        Ok(())
    }

    /// Create `path` (and any parent directories). Inlined when it fits.
    pub async fn mkdir(&self, path: &str) -> Result<(), PluginError> {
        self.queue(move || self.mkdir_once(path)).await
    }

    async fn mkdir_once(&self, path: &str) -> Result<(), PluginError> {
        self.ok(&self.invoke("mkdir", json!({ "path": path })).await?)?;
        self.active()?;
        Ok(())
    }

    /// Remove `path`, optionally recursively. Inlined when it fits.
    pub async fn remove(&self, path: &str, recursive: Option<bool>) -> Result<(), PluginError> {
        self.queue(move || self.remove_once(path, recursive)).await
    }

    async fn remove_once(&self, path: &str, recursive: Option<bool>) -> Result<(), PluginError> {
        let mut params = serde_json::Map::new();
        params.insert("path".into(), json!(path));
        if let Some(r) = recursive {
            params.insert("recursive".into(), json!(r));
        }
        self.ok(&self.invoke("remove", Value::Object(params)).await?)?;
        self.active()?;
        Ok(())
    }
}

fn features(host: &Host) -> std::collections::HashSet<String> {
    match host.state.read() {
        Ok(s) => s.negotiated.clone(),
        Err(e) => e.into_inner().negotiated.clone(),
    }
}