//! Cursor store (`src/usage/cursors.ts`): a per-path cursor to a growing log
//! file, persisted as an atomic snapshot so incremental reads can resume from
//! where they stopped. Updates are serialized within a process; atomic
//! snapshots are safe across processes. A lost cache update only causes a
//! subsequent reader to do extra work.

use pacer_js_json::stringify;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, PoisonError},
};

/// A read cursor into a grow-only file (`src/usage/cursors.ts`).
#[derive(Debug, Clone)]
pub struct Cursor {
    /// Byte size of the file when the cursor was written.
    pub size: f64,
    /// `fs.Stats.mtimeMs` (seconds * 1000) when the cursor was written.
    pub mtime: f64,
    /// `fs.Stats.ino` (machine-specific; normalized when comparing goldens).
    pub inode: u64,
    /// Bytes of the file consumed so far (exclusive of a trailing carry).
    pub offset: f64,
    /// The aggregate built from consumed bytes. An object of `hour ->
    /// [minSecond, maxSecond]`.
    pub aggregate: Value,
    /// The oldest clock hour this aggregate covers, when retention applied.
    pub retained_since: Option<f64>,
}

/// `reusable` (cursors.ts:75-78): whether `cursor` can be trusted for the
/// current stat. `s` is `(size, mtimeMs, ino)`.
pub fn reusable(cursor: Option<&Cursor>, s: &(f64, f64, u64)) -> bool {
    let Some(c) = cursor else {
        return false;
    };
    c.offset.is_finite()
        && c.offset >= 0.0
        && c.offset <= c.size
        && c.size.is_finite()
        && c.mtime.is_finite()
        && c.inode == s.2
        && c.size <= s.0
        && (c.size != s.0 || c.mtime == s.1)
}

/// A JSON file of cursors keyed by path, with the same versioning and
/// validation surface as the TS class. `run` serializes the load + action +
/// save so concurrent inputs to one store do not interleave, and it keeps the
/// loaded map in memory so repeated scans in the same process resume from it.
#[derive(Clone)]
pub struct CursorStore {
    path: PathBuf,
    valid_aggregate: fn(&Value) -> bool,
    version: u64,
    files: Arc<Mutex<Option<HashMap<String, Cursor>>>>,
}

impl CursorStore {
    pub fn new(path: PathBuf, valid_aggregate: fn(&Value) -> bool, version: u64) -> Arc<Self> {
        Arc::new(Self {
            path,
            valid_aggregate,
            version,
            files: Arc::new(Mutex::new(None)),
        })
    }

    /// Load the persisted file once, run `action` with the live cursor map,
    /// and, when not read-only and the map changed, write the snapshot back.
    /// The in-memory map is always updated so the same process reuses cursors.
    pub async fn run<R>(
        self: &Arc<Self>,
        read_only: bool,
        action: impl FnOnce(&mut HashMap<String, Cursor>) -> R + Send + 'static,
    ) -> R
    where
        R: Send + 'static,
    {
        let this = self.clone();
        match tokio::task::spawn_blocking(move || this.run_sync(read_only, action)).await {
            Ok(r) => r,
            Err(_) => panic!("cursor store task must not panic"),
        }
    }

    fn run_sync<R>(
        self: &Arc<Self>,
        read_only: bool,
        action: impl FnOnce(&mut HashMap<String, Cursor>) -> R,
    ) -> R {
        let mut guard = self.files.lock().unwrap_or_else(PoisonError::into_inner);
        if guard.is_none() {
            *guard = Some(self.load());
        }
        let before = match guard.as_mut() {
            Some(m) => m.clone(),
            None => HashMap::new(),
        };
        let mut map = before.clone();
        let result = action(&mut map);
        if !read_only && !cursors_equal(&map, &before) {
            let snapshot = self.files_snapshot(&map);
            let _ = self.persist(&snapshot);
        }
        *guard = Some(map);
        result
    }

    fn load(&self) -> HashMap<String, Cursor> {
        let Ok(bytes) = std::fs::read(&self.path) else {
            // Missing or corrupt cache is rebuilt from source logs.
            return HashMap::new();
        };
        let Ok(data) = serde_json::from_slice::<Value>(&bytes) else {
            return HashMap::new();
        };
        let mut out = HashMap::new();
        if data.get("version") == Some(&json!(self.version))
            && let Some(entries) = data.get("files").and_then(Value::as_object)
        {
            for (path, value) in entries {
                if let Some(c) = cursor_from_value(value) {
                    // The TS cross-check re-validates against its own size/mtime.
                    if reusable(Some(&c), &(c.size, c.mtime, c.inode))
                        && (self.valid_aggregate)(&c.aggregate)
                    {
                        out.insert(path.clone(), c);
                    }
                }
            }
        }
        out
    }

    fn files_snapshot(&self, map: &HashMap<String, Cursor>) -> Value {
        let files: serde_json::Map<String, Value> = map
            .iter()
            .map(|(k, v)| (k.clone(), cursor_to_value(v)))
            .collect();
        json!({ "version": self.version, "files": Value::Object(files) })
    }

    fn persist(&self, snapshot: &Value) -> Result<(), ()> {
        let bytes = stringify(snapshot);
        pacer_foundation::fsutil::write_private(&self.path, bytes.as_bytes()).map_err(|_| ())
    }
}

fn cursor_from_value(value: &Value) -> Option<Cursor> {
    let obj = value.as_object()?;
    Some(Cursor {
        size: obj.get("size").and_then(Value::as_f64)?,
        mtime: obj.get("mtime").and_then(Value::as_f64)?,
        inode: obj.get("inode").and_then(Value::as_u64)?,
        offset: obj.get("offset").and_then(Value::as_f64)?,
        aggregate: obj.get("aggregate").cloned()?,
        retained_since: obj.get("retainedSince").and_then(Value::as_f64),
    })
}

fn cursor_to_value(c: &Cursor) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("size".to_string(), json!(c.size));
    obj.insert("mtime".to_string(), json!(c.mtime));
    obj.insert("inode".to_string(), json!(c.inode));
    obj.insert("offset".to_string(), json!(c.offset));
    obj.insert("aggregate".to_string(), c.aggregate.clone());
    if let Some(r) = c.retained_since {
        obj.insert("retainedSince".to_string(), json!(r));
    }
    Value::Object(obj)
}

/// Equal cursor maps (aggregate compared by its stringified bytes, matching
/// how the TS metadata tracks a change).
fn cursors_equal(a: &HashMap<String, Cursor>, b: &HashMap<String, Cursor>) -> bool {
    if a.len() != b.len() {
        return false;
    }
    for (k, va) in a {
        match b.get(k) {
            Some(vb) if cursor_eq(va, vb) => {}
            _ => return false,
        }
    }
    true
}

fn cursor_eq(a: &Cursor, b: &Cursor) -> bool {
    a.size == b.size
        && a.mtime == b.mtime
        && a.inode == b.inode
        && a.offset == b.offset
        && a.retained_since == b.retained_since
        && stringify(&a.aggregate) == stringify(&b.aggregate)
}
