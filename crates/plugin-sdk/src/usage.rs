//! SDK `usage` feature: the host-capability reader IO used by quota readers
//! (`packages/plugin-sdk/src/usage.ts:76-209`).
//!
//! Provider readers must never touch the ambient filesystem or process state;
//! every read, stat, list, range, spawn and usage-state interaction goes through
//! the host capabilities mapped here. Paths and store ids remain subject to the
//! host's captured authority (the manifest's capability scopes).

use crate::{Host, PluginError};
use serde_json::{Map, Value, json};
use std::{fmt, future::Future, pin::Pin};

/// A boxed future.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Capability read replies carry file identity; ranged reads require the
/// expected file to still match after the read (usage.ts `FileInfo`).
#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct FileInfo {
    #[serde(rename = "path")]
    pub path: String,
    #[serde(rename = "size")]
    pub size: u64,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: f64,
    #[serde(rename = "inode")]
    pub inode: u64,
    #[serde(rename = "device")]
    pub device: u64,
    #[serde(rename = "mode", skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
}

/// The result of a spawned process (usage.ts `RunResult`).
#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct RunResult {
    #[serde(default, rename = "timedOut")]
    pub timed_out: bool,
    #[serde(rename = "code")]
    pub code: i64,
    #[serde(rename = "stdout")]
    pub stdout: String,
    #[serde(rename = "stderr")]
    pub stderr: String,
}

/// A cached lookup result (usage.ts `Cached`).
#[derive(Debug, Clone, PartialEq)]
pub struct Cached {
    pub value: Option<Value>,
    pub captured_at: Option<f64>,
    pub stale: bool,
    pub error: Option<String>,
}

/// A filesystem cursor, tracking how far a rolling `codex` session log is read.
#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct Cursor {
    #[serde(rename = "size")]
    pub size: u64,
    #[serde(rename = "mtime")]
    pub mtime: f64,
    #[serde(rename = "inode")]
    pub inode: u64,
    #[serde(rename = "offset")]
    pub offset: u64,
    #[serde(rename = "aggregate")]
    pub aggregate: Value,
    #[serde(rename = "retainedSince", skip_serializing_if = "Option::is_none")]
    pub retained_since: Option<f64>,
}

/// Host-capability IO for provider readers (usage.ts `ReaderIO`).
pub trait ReaderIo: Send + Sync {
    fn read<'a>(
        &'a self,
        path: &'a str,
    ) -> BoxFuture<'a, Result<Option<(String, f64)>, PluginError>>;
    fn list<'a>(
        &'a self,
        root: &'a str,
        glob: &'a str,
    ) -> BoxFuture<'a, Result<Vec<FileInfo>, PluginError>>;
    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Option<FileInfo>, PluginError>>;
    fn range<'a>(
        &'a self,
        path: &'a str,
        offset: u64,
        length: u64,
        expected: &'a FileInfo,
    ) -> BoxFuture<'a, Result<(Vec<u8>, FileInfo), PluginError>>;
    fn run<'a>(
        &'a self,
        argv: &'a [&'a str],
        timeout_ms: u64,
    ) -> BoxFuture<'a, Result<RunResult, PluginError>>;
    #[allow(clippy::too_many_arguments)] // SDk core API, mirrors TS ReaderClient (.usage.ts)
    fn cached_fetch<'a>(
        &'a self,
        key: &'a str,
        ttl_s: f64,
        max_stale_s: f64,
        fetcher: BoxFuture<'a, Result<Value, PluginError>>,
        refresh: bool,
        now: f64,
        read_only: bool,
    ) -> BoxFuture<'a, Result<Cached, PluginError>>;
    #[allow(clippy::type_complexity)] // SDK core API action type; stability over refactor
    fn cursors<'a>(
        &'a self,
        store: &'a str,
        version: u64,
        valid: &'a (dyn Fn(&Value) -> bool + Sync),
        action: Box<
            dyn for<'f> FnOnce(&'f mut CursorFiles) -> BoxFuture<'f, Result<Value, PluginError>>
                + Send
                + 'a,
        >,
    ) -> BoxFuture<'a, Result<Value, PluginError>>;
}

/// A dirtiness-tracking map of cursors, mirroring the TS `Proxy` around the
/// hydrated `files` map (usage.ts:194-198): replacing a value with a
/// *different* value, or deleting a *present* key, marks the snapshot dirty.
pub struct CursorFiles {
    files: Map<String, Value>,
    dirty: bool,
}

impl CursorFiles {
    /// Construct a cursor map from a hydrated snapshot. Test-support hosts
    /// (`pacer-usage` reader tests) build one from an in-memory state store.
    pub fn new(files: Map<String, Value>) -> Self {
        Self {
            files,
            dirty: false,
        }
    }

    pub fn get(&self, path: &str) -> Option<Cursor> {
        self.files
            .get(path)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.files.keys()
    }

    /// Remove a key; marks dirty only when the key was present.
    pub fn remove(&mut self, path: &str) {
        if self.files.remove(path).is_some() {
            self.dirty = true;
        }
    }

    /// Replace or insert a cursor; marks dirty only when the value actually
    /// differed from the previous one.
    pub fn set(&mut self, path: &str, cursor: Cursor) {
        // A cursor is always JSON (plain u64/f64/String fields); a non-finite
        // float would be the only way this can fail, and such a cursor is not
        // storable, so skip it rather than mark the snapshot dirty.
        let Some(value) = serde_json::to_value(cursor).ok() else {
            return;
        };
        if self.files.get(path) != Some(&value) {
            self.dirty = true;
        }
        self.files.insert(path.to_owned(), value);
    }

    fn into_parts(self) -> (Map<String, Value>, bool) {
        (self.files, self.dirty)
    }
}

const CHUNK: u64 = 256 * 1024;
const OUTPUT_CAP: u64 = 1024 * 1024;
const EN_GEO: &str = "ENOENT";

fn state_method(op: &str) -> String {
    format!("capability.usage.state.{op}")
}

/// Monotonic lease-owned snapshot read (usage.ts `snapshot`).
struct Snapshot {
    lease: String,
    data: Value,
    dirty: bool,
}

/// A capability call glue binding the host to the fixed capability names.
struct CapabilityIo<'a> {
    host: &'a Host,
}

impl<'a> CapabilityIo<'a> {
    async fn state_snapshot(&self, store: &str) -> Result<Snapshot, PluginError> {
        let begin = self
            .host
            .call(&state_method("begin"), json!({ "store": store }))
            .await?;
        let lease = begin
            .get("lease")
            .and_then(Value::as_str)
            .ok_or_else(|| PluginError::new("internal", "usage state begin missing lease"))?
            .to_owned();
        let bytes = begin.get("bytes").and_then(Value::as_u64).unwrap_or(0);
        let dirty = begin.get("dirty").and_then(Value::as_bool).unwrap_or(false);
        let release = || async {
            let _ = self
                .host
                .call(&state_method("release"), json!({ "lease": &lease }))
                .await;
        };
        let decoded = match self.read_all_chunks(&lease, bytes).await {
            Ok(d) => d,
            Err(error) => {
                release().await;
                return Err(error);
            }
        };
        let data: Value = match serde_json::from_slice(&decoded) {
            Ok(data) => data,
            Err(error) => {
                release().await;
                return Err(PluginError::new("internal", error.to_string()));
            }
        };
        Ok(Snapshot { lease, data, dirty })
    }

    async fn read_all_chunks(&self, lease: &str, bytes: u64) -> Result<Vec<u8>, PluginError> {
        let mut decoded = Vec::with_capacity(bytes as usize);
        let mut offset: u64 = 0;
        while offset < bytes {
            let length = CHUNK.min(bytes - offset);
            let next = self
                .host
                .call(
                    &state_method("readChunk"),
                    json!({
                        "lease": lease,
                        "offset": offset,
                        "length": length
                    }),
                )
                .await?;
            let b64 = next
                .get("base64")
                .and_then(Value::as_str)
                .ok_or_else(|| PluginError::new("internal", "readChunk missing base64"))?;
            let chunk = crate::js::base64::decode_lenient(b64);
            if chunk.len() as u64 != length {
                return Err(PluginError::new(
                    "internal",
                    "incomplete usage state snapshot",
                ));
            }
            decoded.extend_from_slice(&chunk);
            offset += length;
        }
        Ok(decoded)
    }

    async fn state_stage(&self, lease: &str, value: &Value) -> Result<(), PluginError> {
        let bytes =
            serde_json::to_vec(value).map_err(|e| PluginError::new("internal", e.to_string()))?;
        let mut offset = 0usize;
        while offset < bytes.len() {
            let end = (offset + CHUNK as usize).min(bytes.len());
            let part = &bytes[offset..end];
            let result = self
                .host
                .call(
                    &state_method("stageChunk"),
                    json!({
                        "lease": lease,
                        "offset": offset,
                        "base64": crate::js::base64::encode(part)
                    }),
                )
                .await?;
            let written = result.get("bytes").and_then(Value::as_u64).unwrap_or(0);
            if written != end as u64 {
                return Err(PluginError::new(
                    "internal",
                    "incomplete usage state staging",
                ));
            }
            offset = end;
        }
        Ok(())
    }

    async fn process_output(&self, handle: &str) -> Result<String, PluginError> {
        let mut chunks = Vec::new();
        let mut offset: u64 = 0;
        loop {
            let next = self
                .host
                .call(
                    "capability.process.outputChunk",
                    json!({
                        "handle": handle,
                        "offset": offset,
                        "length": CHUNK
                    }),
                )
                .await?;
            let b64 = next
                .get("base64")
                .and_then(Value::as_str)
                .ok_or_else(|| PluginError::new("internal", "outputChunk missing base64"))?;
            let part = crate::js::base64::decode_lenient(b64);
            if part.len() as u64 > CHUNK {
                return Err(PluginError::new(
                    "internal",
                    "invalid provider output chunk",
                ));
            }
            offset += part.len() as u64;
            if offset > OUTPUT_CAP {
                return Err(PluginError::new(
                    "internal",
                    "provider output exceeds 1 MiB",
                ));
            }
            chunks.extend_from_slice(&part);
            if (part.len() as u64) < CHUNK {
                break;
            }
        }
        Ok(String::from_utf8_lossy(&chunks).into_owned())
    }

    async fn capability_read(&self, path: &str) -> Result<Option<(String, f64)>, PluginError> {
        let result = self
            .host
            .call("capability.fs.read", json!({ "path": path }))
            .await?;
        if result
            .get("missing")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Ok(None);
        }
        if result.get("ranged").is_none() {
            let text = result
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| PluginError::new("internal", "fs.read missing text"))?
                .to_owned();
            let mtime = result.get("mtime").and_then(Value::as_f64).unwrap_or(0.0);
            return Ok(Some((text, mtime)));
        }
        let info: FileInfo =
            serde_json::from_value(result.get("ranged").cloned().unwrap_or(Value::Null))
                .map_err(|e| PluginError::new("internal", e.to_string()))?;
        let mut chunks = Vec::with_capacity(info.size as usize);
        let mut offset = 0u64;
        while offset < info.size {
            let length = CHUNK.min(info.size - offset);
            let (bytes, _) = self
                .capability_range(&info.path, offset, length, &info)
                .await?;
            chunks.extend_from_slice(&bytes);
            offset += length;
        }
        Ok(Some((
            String::from_utf8_lossy(&chunks).into_owned(),
            info.mtime_ms / 1000.0,
        )))
    }

    async fn capability_range(
        &self,
        path: &str,
        offset: u64,
        length: u64,
        expected: &FileInfo,
    ) -> Result<(Vec<u8>, FileInfo), PluginError> {
        match self
            .host
            .call(
                "capability.fs.readRange",
                json!({
                    "path": path,
                    "offset": offset,
                    "length": length,
                    "expected": expected
                }),
            )
            .await
        {
            Ok(result) => {
                if result
                    .get("missing")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    return Err(PluginError::new(EN_GEO, "usage file disappeared"));
                }
                let b64 = result
                    .get("base64")
                    .and_then(Value::as_str)
                    .ok_or_else(|| PluginError::new("internal", "readRange missing base64"))?;
                let bytes = crate::js::base64::decode_lenient(b64);
                let info: FileInfo =
                    serde_json::from_value(result.get("info").cloned().unwrap_or(Value::Null))
                        .map_err(|e| PluginError::new("internal", e.to_string()))?;
                let expect_len = length.min(expected.size.saturating_sub(offset));
                if bytes.len() as u64 != expect_len || expected != &info {
                    return Err(PluginError::new(
                        "internal",
                        "incomplete or changed usage file range",
                    ));
                }
                Ok((bytes, info))
            }
            Err(error) => {
                // A concurrently removed rollout is absent, not corrupt usage
                // (usage.ts:148-152).
                if error.code == "not_found" {
                    Err(PluginError {
                        code: EN_GEO.to_owned(),
                        ..error
                    })
                } else {
                    Err(error)
                }
            }
        }
    }

    async fn capability_run(
        &self,
        argv: &[&str],
        timeout_ms: u64,
    ) -> Result<RunResult, PluginError> {
        let result = self
            .host
            .call(
                "capability.process.spawn",
                json!({
                    "argv": argv,
                    "timeoutMs": timeout_ms
                }),
            )
            .await?;
        let timed_out = result
            .get("timedOut")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let code = result.get("code").and_then(Value::as_i64).unwrap_or(0);
        let (stdout, stderr) = match result.get("output") {
            Some(output) => {
                let sh = output
                    .get("stdout")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        PluginError::new("internal", "spawn output missing stdout handle")
                    })?;
                let st = output
                    .get("stderr")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        PluginError::new("internal", "spawn output missing stderr handle")
                    })?;
                (
                    self.process_output(&sh).await?,
                    self.process_output(&st).await?,
                )
            }
            None => (
                result
                    .get("stdout")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                result
                    .get("stderr")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            ),
        };
        Ok(RunResult {
            timed_out,
            code,
            stdout,
            stderr,
        })
    }
}

/// The per-handler host-capability adapter (usage.ts `createUsageReaderIO`).
pub struct UsageReaderIo<'a> {
    inner: CapabilityIo<'a>,
}

impl fmt::Debug for UsageReaderIo<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("UsageReaderIo")
    }
}

impl<'a> ReaderIo for UsageReaderIo<'a> {
    fn read<'b>(
        &'b self,
        path: &'b str,
    ) -> BoxFuture<'b, Result<Option<(String, f64)>, PluginError>> {
        Box::pin(async move { self.inner.capability_read(path).await })
    }

    fn list<'b>(
        &'b self,
        root: &'b str,
        glob: &'b str,
    ) -> BoxFuture<'b, Result<Vec<FileInfo>, PluginError>> {
        Box::pin(async move {
            let result = self
                .inner
                .host
                .call(
                    "capability.fs.list",
                    json!({ "dir": root, "glob": glob, "limit": 1000 }),
                )
                .await?;
            let files = result.get("files").cloned().unwrap_or(Value::Null);
            serde_json::from_value(files).map_err(|e| PluginError::new("internal", e.to_string()))
        })
    }

    fn stat<'b>(&'b self, path: &'b str) -> BoxFuture<'b, Result<Option<FileInfo>, PluginError>> {
        Box::pin(async move {
            let result = self
                .inner
                .host
                .call("capability.fs.stat", json!({ "path": path }))
                .await?;
            match result.get("info") {
                Some(Value::Null) | None => Ok(None),
                Some(info) => serde_json::from_value(info.clone())
                    .map(Some)
                    .map_err(|e| PluginError::new("internal", e.to_string())),
            }
        })
    }

    fn range<'b>(
        &'b self,
        path: &'b str,
        offset: u64,
        length: u64,
        expected: &'b FileInfo,
    ) -> BoxFuture<'b, Result<(Vec<u8>, FileInfo), PluginError>> {
        Box::pin(async move {
            self.inner
                .capability_range(path, offset, length, expected)
                .await
        })
    }

    fn run<'b>(
        &'b self,
        argv: &'b [&'b str],
        timeout_ms: u64,
    ) -> BoxFuture<'b, Result<RunResult, PluginError>> {
        Box::pin(async move { self.inner.capability_run(argv, timeout_ms).await })
    }

    fn cached_fetch<'b>(
        &'b self,
        key: &'b str,
        ttl_s: f64,
        max_stale_s: f64,
        fetcher: BoxFuture<'b, Result<Value, PluginError>>,
        refresh: bool,
        now: f64,
        read_only: bool,
    ) -> BoxFuture<'b, Result<Cached, PluginError>> {
        Box::pin(async move {
            let lease = self.inner.state_snapshot(key).await?;
            let mut consumed = false;
            let hit = lease.data.clone();
            let hit_value = hit.get("value").cloned();
            let hit_captured = hit.get("capturedAt").and_then(Value::as_f64);
            let result = 'run: {
                if !refresh
                    && let Some(captured) = hit_captured
                    && now >= captured
                    && now - captured < ttl_s
                {
                    break 'run Cached {
                        value: hit_value.clone(),
                        captured_at: hit_captured,
                        stale: false,
                        error: None,
                    };
                }
                // The stage + commit lifecycle of a successful fetch is itself
                // fallible: a persistence failure falls back to the cached hit,
                // matching the TS inner try/catch (usage.ts:167-177).
                let fallback = |message: String| {
                    if let Some(captured) = hit_captured
                        && now >= captured
                        && now - captured < max_stale_s
                    {
                        Cached {
                            value: hit_value.clone(),
                            captured_at: hit_captured,
                            stale: true,
                            error: Some(message),
                        }
                    } else {
                        Cached {
                            value: None,
                            captured_at: None,
                            stale: false,
                            error: Some(message),
                        }
                    }
                };
                let fetched = fetcher.await;
                match fetched {
                    Ok(value) => {
                        let persisted: Result<(), PluginError> = if read_only {
                            Ok(())
                        } else {
                            async {
                                self.inner
                                    .state_stage(
                                        &lease.lease,
                                        &json!({ "capturedAt": now, "value": value.clone() }),
                                    )
                                    .await?;
                                consumed = true;
                                self.inner
                                    .host
                                    .call(&state_method("commit"), json!({ "lease": lease.lease }))
                                    .await?;
                                Ok(())
                            }
                            .await
                        };
                        match persisted {
                            Ok(()) => Cached {
                                value: Some(value),
                                captured_at: Some(now),
                                stale: false,
                                error: None,
                            },
                            Err(persist_error) => fallback(persist_error.message.clone()),
                        }
                    }
                    Err(error) => fallback(error.message.clone()),
                }
            };
            if !consumed {
                let _ = self
                    .inner
                    .host
                    .call(&state_method("release"), json!({ "lease": lease.lease }))
                    .await;
            }
            Ok(result)
        })
    }

    fn cursors<'b>(
        &'b self,
        store: &'b str,
        version: u64,
        valid: &'b (dyn Fn(&Value) -> bool + Sync),
        action: Box<
            dyn for<'f> FnOnce(&'f mut CursorFiles) -> BoxFuture<'f, Result<Value, PluginError>>
                + Send
                + 'b,
        >,
    ) -> BoxFuture<'b, Result<Value, PluginError>> {
        Box::pin(async move {
            let lease = self.inner.state_snapshot(store).await?;
            let data = lease.data.clone();
            let mut files: Map<String, Value> = Map::new();
            if data.get("version").and_then(Value::as_u64) == Some(version)
                && let Some(obj) = data.get("files").and_then(Value::as_object)
            {
                for (path, value) in obj {
                    let Ok(c) = serde_json::from_value::<Cursor>(value.clone()) else {
                        continue;
                    };
                    if c.offset <= c.size && c.mtime.is_finite() && valid(&c.aggregate) {
                        files.insert(path.clone(), value.clone());
                    }
                }
            }
            let mut tracked = CursorFiles::new(files);
            let result = action(&mut tracked).await;
            let (files_map, dirty) = tracked.into_parts();
            match result {
                Ok(value) => {
                    // Persistence errors never discard a successfully
                    // interpreted Codex reading (usage.ts:200-205).
                    let _ = self
                        .inner
                        .state_stage(
                            &lease.lease,
                            &json!({ "version": version, "files": files_map }),
                        )
                        .await;
                    let _ = self
                        .inner
                        .host
                        .call(
                            &state_method("commit"),
                            json!({ "lease": lease.lease, "dirty": dirty || lease.dirty }),
                        )
                        .await;
                    Ok(value)
                }
                Err(error) => {
                    let _ = self
                        .inner
                        .host
                        .call(&state_method("release"), json!({ "lease": lease.lease }))
                        .await;
                    Err(error)
                }
            }
        })
    }
}

/// Create the host-capability IO for a provider reader (usage.ts
/// `createUsageReaderIO`).
pub fn reader_io(host: &Host) -> impl ReaderIo + '_ {
    UsageReaderIo {
        inner: CapabilityIo { host },
    }
}
