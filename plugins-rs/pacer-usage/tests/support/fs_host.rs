//! A `ReaderIo` over a temp directory plus an in-memory usage-state store.
//!
//! The Rust twin of the TS test's `fakeCtx` IO at
//! `test/plugins-usage-readers.test.ts:81-108`: every `fs.*` and `usage.state.*`
//! operation reads a real temp-dir file (or an in-memory state blob), and
//! `run` is scriptable per-test. `cached_fetch` and `cursors` reproduce the
//! host's usage-state semantics from `crates/plugin-sdk/src/usage.rs` over the
//! in-memory store, so the provider readers see the same caching and cursor
//! behaviour they would through a real host.

use pacer_plugin::usage::{BoxFuture, Cached, CursorFiles, FileInfo, ReaderIo, RunResult};
use pacer_plugin::PluginError;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// A recorded `run` invocation, so a test can assert the exact argv/timeout.
#[derive(Debug, Clone, PartialEq)]
pub struct RunCall {
    pub argv: Vec<String>,
    pub timeout_ms: u64,
}

/// Scriptable process result (the plugin's `capability.process.spawn` reply).
pub type RunFn = Box<dyn Fn(&[&str], u64) -> RunResult + Send + Sync + 'static>;

/// A host stand-in: real files under `root`, an in-memory `usage.state.*`
/// store, and a scriptable `run`.
pub struct FsHost {
    root: PathBuf,
    store: Arc<Mutex<BTreeMap<String, Value>>>,
    run: Arc<Mutex<RunFn>>,
    calls: Arc<Mutex<Vec<RunCall>>>,
    reads: Arc<Mutex<Vec<String>>>,
    ranges: Arc<Mutex<usize>>,
}

impl FsHost {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            store: Arc::new(Mutex::new(BTreeMap::new())),
            run: Arc::new(Mutex::new(Box::new(|_argv: &[&str], _: u64| {
                RunResult {
                    timed_out: false,
                    code: 0,
                    stdout: String::new(),
                    stderr: String::new(),
                }
            }))),
            calls: Arc::new(Mutex::new(Vec::new())),
            reads: Arc::new(Mutex::new(Vec::new())),
            ranges: Arc::new(Mutex::new(0)),
        }
    }

    /// The paths consulted by `read`, in order (one per candidate file).
    pub fn read_calls(&self) -> Vec<String> {
        self.reads.lock().unwrap().clone()
    }

    /// The number of held `range` reads (for asserting a reused cursor reads
    /// no bytes on the follow-up call).
    pub fn range_calls(&self) -> usize {
        *self.ranges.lock().unwrap()
    }

    /// Set the payload a `run` returns for the given argv/timeout.
    pub fn set_run(&self, f: RunFn) {
        *self.run.lock().unwrap() = f;
    }

    /// The `run` invocations so far, in order.
    pub fn calls(&self) -> Vec<RunCall> {
        self.calls.lock().unwrap().clone()
    }

    /// The current persisted value of an in-memory state store key (e.g. the
    /// `arkcli-usage-plan` cache), mirroring the "cache file" the TS test reads,
    /// so a test can assert a readOnly policy left it untouched.
    pub fn store_value(&self, key: &str) -> Option<Value> {
        self.store.lock().unwrap().get(key).cloned()
    }

    /// Resolve `p` to a real-file path. Absolute paths are used as-is (the
    /// host's captured authority keeps them under `root` in tests); relative
    /// paths are joined to `root`.
    fn full(&self, p: &str) -> PathBuf {
        let pb = PathBuf::from(p);
        if pb.is_absolute() {
            pb
        } else {
            self.root.join(pb)
        }
    }

    fn info(&self, path: &Path) -> Option<FileInfo> {
        let md = std::fs::metadata(path).ok()?;
        let mtime_ms = md
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d: std::time::Duration| d.as_millis() as f64)
            .unwrap_or(0.0);
        Some(FileInfo {
            path: path.to_string_lossy().into_owned(),
            size: md.len(),
            mtime_ms,
            inode: inode_of(&md),
            device: device_of(&md),
            mode: None,
        })
    }
}

/// A best-effort inode. `metadata` has no stable per-plat inode API; derive
/// one from `(device, ino)` where available, else from `(len, mtime)`.
fn inode_of(md: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    md.ino()
}

fn device_of(md: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    md.dev()
}

/// Convert a `**/name`, `*` glob into a regex over a root-relative path.
fn glob_regex(glob: &str) -> regex::Regex {
    let mut re = String::from("^(?:");
    let mut parts = glob.split('/').peekable();
    while let Some(part) = parts.next() {
        if part == "**" {
            // `**` spans zero or more directory components including the
            // trailing separator, so it must match a bare `name` at the root
            // *and* a nested `dir/name`. `(?:.*/)?` already ends in `/`;
            // do not push a further separator after it.
            re.push_str("(?:.*/)?");
            if parts.peek().is_some() {
                // The next part follows the treated-as-consumed separator.
                continue;
            }
        } else {
            re.push_str(&escape_glob(part));
        }
        if parts.peek().is_some() {
            re.push('/');
        }
    }
    re.push_str(")$");
    regex::Regex::new(&re).unwrap_or_else(|e| panic!("invalid glob {glob:?}: {e}"))
}

fn escape_glob(part: &str) -> String {
    let mut out = String::new();
    for ch in part.chars() {
        match ch {
            '*' => out.push_str("[^/]*"),
            '?' => out.push_str("[^/]"),
            c => {
                if "\\.[]{}()+-^$|".contains(c) {
                    out.push('\\');
                }
                out.push(c);
            }
        }
    }
    out
}

fn walk(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, out);
        } else {
            out.push(path);
        }
    }
}

impl ReaderIo for FsHost {
    fn read<'a>(
        &'a self,
        path: &'a str,
    ) -> BoxFuture<'a, Result<Option<(String, f64)>, PluginError>> {
        Box::pin(async move {
            let p = self.full(path);
            let text = match std::fs::read(&p) {
                Ok(b) => String::from_utf8_lossy(&b).into_owned(),
                Err(_) => return Ok(None),
            };
            self.reads.lock().unwrap().push(path.to_owned());
            let mtime_ms = self
                .info(&p)
                .map(|f| f.mtime_ms)
                .unwrap_or(0.0);
            Ok(Some((text, mtime_ms)))
        })
    }

    fn list<'a>(
        &'a self,
        root: &'a str,
        glob: &'a str,
    ) -> BoxFuture<'a, Result<Vec<FileInfo>, PluginError>> {
        Box::pin(async move {
            let base = self.full(root);
            let mut files = Vec::new();
            let mut all = Vec::new();
            walk(&base, &mut all);
            let re = glob_regex(glob);
            for path in all {
                let rel = path.strip_prefix(&base).unwrap_or(&path);
                let rel_str = rel.to_string_lossy();
                if !re.is_match(&rel_str) {
                    continue;
                }
                if let Some(info) = self.info(&path) {
                    files.push(info);
                }
            }
            Ok(files)
        })
    }

    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Option<FileInfo>, PluginError>> {
        Box::pin(async move { Ok(self.info(&self.full(path))) })
    }

    fn range<'a>(
        &'a self,
        path: &'a str,
        offset: u64,
        length: u64,
        expected: &'a FileInfo,
    ) -> BoxFuture<'a, Result<(Vec<u8>, FileInfo), PluginError>> {
        Box::pin(async move {
            // Ranged reads are always at most 256 KiB (usage.ts range loop),
            // and the expected identity must still match after the read.
            assert!(length <= 256 * 1024, "codex range chunk must be <= 256 KiB");
            *self.ranges.lock().unwrap() += 1;
            let p = self.full(path);
            let Some(current) = self.info(&p) else {
                return Err(PluginError::new("ENOENT", "file disappeared"));
            };
            assert_eq!(&current, expected, "expected file identity must match the stat");
            let data = std::fs::read(&p).unwrap_or_default();
            let start = offset as usize;
            let end = (start + length as usize).min(data.len());
            // A short chunk means the file changed under us, as in usage.ts:166.
            if end - start != length as usize {
                return Err(PluginError::new(
                    "incomplete",
                    "incomplete or changed usage file range",
                ));
            }
            Ok((data[start..end].to_vec(), current))
        })
    }

    fn run<'a>(
        &'a self,
        argv: &'a [&'a str],
        timeout_ms: u64,
    ) -> BoxFuture<'a, Result<RunResult, PluginError>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(RunCall {
                argv: argv.iter().map(|s| s.to_string()).collect(),
                timeout_ms,
            });
            let result = (self.run.lock().unwrap())(argv, timeout_ms);
            Ok(result)
        })
    }

    fn cached_fetch<'a>(
        &'a self,
        key: &'a str,
        ttl_s: f64,
        max_stale_s: f64,
        fetcher: BoxFuture<'a, Result<Value, PluginError>>,
        refresh: bool,
        now: f64,
        read_only: bool,
    ) -> BoxFuture<'a, Result<Cached, PluginError>> {
        Box::pin(async move {
            // The in-memory store mirrors the host's `usage.state` blob for a key.
            let hit = self.store.lock().unwrap().get(key).cloned();
            let hit_value = hit.as_ref().and_then(|v| v.get("value")).cloned();
            let hit_captured = hit
                .as_ref()
                .and_then(|v| v.get("capturedAt"))
                .and_then(Value::as_f64);

            let result = {
                if !refresh
                    && let Some(captured) = hit_captured
                    && now >= captured
                    && now - captured < ttl_s
                {
                    Cached {
                        value: hit_value.clone(),
                        captured_at: hit_captured,
                        stale: false,
                        error: None,
                    }
                } else {
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
                    match fetcher.await {
                        Ok(value) => {
                            if !read_only {
                                self.store
                                    .lock()
                                    .unwrap()
                                    .insert(key.to_owned(), json!({ "capturedAt": now, "value": value.clone() }));
                            }
                            Cached {
                                value: Some(value),
                                captured_at: Some(now),
                                stale: false,
                                error: None,
                            }
                        }
                        Err(error) => fallback(error.message.clone()),
                    }
                }
            };
            Ok(result)
        })
    }

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
    ) -> BoxFuture<'a, Result<Value, PluginError>> {
        Box::pin(async move {
            let data = self.store.lock().unwrap().get(store).cloned();
            let mut files: Map<String, Value> = Map::new();
            if data
                .as_ref()
                .and_then(|d| d.get("version"))
                .and_then(Value::as_u64)
                == Some(version)
                && let Some(obj) = data
                    .as_ref()
                    .and_then(|d| d.get("files"))
                    .and_then(Value::as_object)
            {
                for (path, value) in obj {
                    let Ok(c) = serde_json::from_value::<pacer_plugin::usage::Cursor>(value.clone())
                    else {
                        continue;
                    };
                    if c.offset <= c.size && c.mtime.is_finite() && valid(&c.aggregate) {
                        files.insert(path.clone(), value.clone());
                    }
                }
            }
            let mut tracked = CursorFiles::new(files);
            let result = action(&mut tracked).await;
            // Rebuild the persisted map from the public cursor surface; the
            // in-memory store always rewrites the snapshot on success, matching
            // the host's readOnly-tolerant commit (usage.rs:672-733).
            let mut final_files: Map<String, Value> = Map::new();
            for path in tracked.keys() {
                if let Some(c) = tracked.get(path) {
                    if let Ok(v) = serde_json::to_value(c) {
                        final_files.insert(path.clone(), v);
                    }
                }
            }
            match result {
                Ok(value) => {
                    self.store
                        .lock()
                        .unwrap()
                        .insert(store.to_owned(), json!({ "version": version, "files": final_files }));
                    Ok(value)
                }
                Err(e) => Err(e),
            }
        })
    }
}