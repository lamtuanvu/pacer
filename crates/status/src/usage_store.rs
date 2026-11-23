//! The usage store (`src/usage/store.ts`): per-identity usage readings on disk.

use pacer_foundation::Ctx;
use pacer_foundation::api::{Code, CoreError};
use pacer_foundation::lock::{LockOptions, with_lock};
use serde_json::{Map, Value, json};

use crate::freshness::{EVIDENCE_PRUNE_AFTER_S, mark_freshness};

/// `REFRESH_AHEAD_S` (store.ts:9): rewrite a fresh, unchanged reading this long
/// before it would turn stale so cold readers never see it lapse.
const REFRESH_AHEAD_S: f64 = 600.0;
const SCHEMA_VERSION: f64 = 1.0;

fn usage_path(ctx: &Ctx, identity: &str) -> std::path::PathBuf {
    ctx.pacer_home
        .join("state/usage")
        .join(format!("{identity}.json"))
}

fn read_file_value(path: &std::path::Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// `validFile` (store.ts:15-17).
fn valid_file(saved: Option<Value>, identity: &str) -> Option<Value> {
    let saved = saved?;
    if saved["schemaVersion"] == SCHEMA_VERSION
        && saved["identity"] == identity
        && saved["entries"].is_object()
    {
        Some(saved)
    } else {
        None
    }
}

/// `readUsageEntry` (store.ts:20-23).
pub fn read_usage_entry(ctx: &Ctx, identity: &str, key: &str) -> Option<Value> {
    let saved = valid_file(read_file_value(&usage_path(ctx, identity)), identity)?;
    let entry = saved["entries"].get(key)?;
    if entry["savedAt"].as_f64().is_some_and(f64::is_finite)
        && entry["reading"].is_object()
        && entry["reading"]["windows"].as_array().is_some()
    {
        Some(entry["reading"].clone())
    } else {
        None
    }
}

/// Same-window-shape predicate (store.ts:39); `JSON.stringify` of the shape
/// portion a write must differ on for the file to be rewritten.
fn same_shape(r: &Value) -> String {
    pacer_js_json::stringify(&json!([
        r["windows"],
        r.get("error").cloned().unwrap_or(Value::Null),
        r.get("availability").cloned().unwrap_or(Value::Null),
        r.get("source").cloned().unwrap_or(Value::Null),
        r["stale"]
    ]))
}

/// `writeUsageEntry` (store.ts:31-45); lock `usage-store:<identity>`.
pub fn write_usage_entry(
    ctx: &Ctx,
    identity: &str,
    key: &str,
    reading: &Value,
    read_only: bool,
) -> Result<(), CoreError> {
    if read_only {
        return Ok(());
    }
    with_lock(
        ctx,
        &format!("usage-store:{identity}"),
        LockOptions::default(),
        || -> Result<(), CoreError> {
            let path = usage_path(ctx, identity);
            let saved = valid_file(read_file_value(&path), identity);
            let before = saved
                .as_ref()
                .and_then(|s| s["entries"].as_object())
                .cloned()
                .unwrap_or_default();
            let now = ctx.now;
            // Superseded source keys (an edited model or budget) age out instead of accumulating.
            let entries: Map<String, Value> = before
                .into_iter()
                .filter(|(k, e)| {
                    k == key
                        || e.get("savedAt")
                            .and_then(Value::as_f64)
                            .is_some_and(|at| at > now - EVIDENCE_PRUNE_AFTER_S)
                })
                .collect();
            let previous = entries.get(key).map(|e| e.get("reading"));
            let unchanged = match previous {
                Some(Some(prev)) if same_shape(prev) == same_shape(reading) => {
                    reading
                        .get("stale")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                        || !mark_freshness(prev, now + REFRESH_AHEAD_S)
                            .get("stale")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                }
                _ => false,
            };
            if unchanged {
                return Ok(());
            }
            let mut entries = entries;
            let mut entry = Map::new();
            entry.insert("savedAt".to_string(), Value::from(now));
            entry.insert("reading".to_string(), reading.clone());
            entries.insert(key.to_string(), Value::Object(entry));
            let file = json!({
                "schemaVersion": SCHEMA_VERSION,
                "identity": identity,
                "entries": Value::Object(entries),
            });
            let bytes = pacer_js_json::stringify(&file);
            pacer_foundation::fsutil::write_private(&path, bytes.as_bytes())
                .map_err(|e| CoreError::new(Code::Internal, format!("write usage store: {e}")))?;
            Ok(())
        },
    )
    .map_err(|e| CoreError::new(Code::Internal, format!("usage-store lock: {e}")))?
}
