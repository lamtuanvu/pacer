//! Plugin-side installer helpers, ported from `@pacer/plugin/install`.
//!
//! This is a library-only feature: no plugin is switched by adding it, and no
//! filesystem effect is committed here. The host owns commit and recovery.

mod blocks;
mod helpers;
mod hookjson;
mod jsonc;
mod undo;

pub use blocks::{BlockStyle, block_text, has_block, remove_block, upsert_block};
pub use helpers::{backup_path, sha256, shell_command, shq, zone};
pub use hookjson::{
    HookFormat, HookSpec, RemovedHook, add_hooks, edit_hooks_file, is_pacer_hook, remove_hooks,
    restore_hooks, upsert_hooks,
};
pub use jsonc::{
    JsoncError, get_member, is_empty_object, parse_jsonc, remove_member, set_member, strip_jsonc,
};
pub use undo::{
    CommandUndo, FileChange, InstallManifest, Integration, ManagedHash, Manifest, PlannerRecord,
    RestoreBlock, UndoOp, UndoSnapshot, UndoSnapshotFile, apply_undo, merge_undo, pieces_present,
    remove_toml_table,
};

use std::{fmt, future::Future, pin::Pin};

#[derive(Clone, Debug)]
pub struct InstallError(pub String);

impl fmt::Display for InstallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for InstallError {}

/// Boxed async closure result used by the install I/O traits.
pub(crate) type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// ECMAScript own-property order: canonical array indices ascending first, then
/// the remaining keys in insertion order. `serde_json` is built with
/// `preserve_order`, so `Map` iteration is insertion order.
pub(crate) fn object_key_order(
    map: serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    use serde_json::Value;
    let mut indices: Vec<u32> = Vec::new();
    let mut others: Vec<String> = Vec::new();
    for key in map.keys() {
        if let Some(i) = array_index(key) {
            indices.push(i);
        } else {
            others.push(key.clone());
        }
    }
    indices.sort_unstable();
    let mut out = serde_json::Map::new();
    for i in indices {
        let key = i.to_string();
        if let Some(v) = map.get(&key) {
            out.insert(key, v.clone());
        }
    }
    for key in others {
        if let Some(v) = map.get(&key) {
            out.insert(key, v.clone());
        }
    }
    // Recurse so nested objects get the same order as JSON.stringify.
    for value in out.values_mut() {
        normalize_value(value);
    }
    fn normalize_value(value: &mut Value) {
        match value {
            Value::Object(m) => {
                let reordered = object_key_order(std::mem::take(m));
                *m = reordered;
            }
            Value::Array(items) => items.iter_mut().for_each(normalize_value),
            _ => {}
        }
    }
    out
}

fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n < u32::MAX)
}

/// `JSON.stringify(value, null, 2)`: ECMAScript key order, then serde's
/// two-space pretty rendering.
pub(crate) fn stringify(value: &serde_json::Value) -> String {
    let ordered = match value {
        serde_json::Value::Object(m) => serde_json::Value::Object(object_key_order(m.clone())),
        other => other.clone(),
    };
    serde_json::to_string_pretty(&ordered).unwrap_or_default()
}

/// Compact `JSON.stringify(value)` with ECMAScript key order.
pub(crate) fn stringify_compact(value: &serde_json::Value) -> String {
    let ordered = match value {
        serde_json::Value::Object(m) => serde_json::Value::Object(object_key_order(m.clone())),
        other => other.clone(),
    };
    serde_json::to_string(&ordered).unwrap_or_default()
}

/// serde_json writes integral floats as `1.0`; JavaScript writes `1`.
pub(crate) fn normalize_numbers(value: &mut serde_json::Value) {
    use serde_json::Value;
    match value {
        Value::Number(n) => {
            if let Some(f) = n.as_f64()
                && f.is_finite()
                && f.fract() == 0.0
                && f >= i64::MIN as f64
                && f <= i64::MAX as f64
            {
                *n = serde_json::Number::from(f as i64);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(normalize_numbers),
        Value::Object(m) => m.values_mut().for_each(normalize_numbers),
        _ => {}
    }
}

/// Byte position to UTF-16 code-unit offset, for JS-compatible error text.
pub(crate) fn utf16_offset(text: &str, byte: usize) -> usize {
    let end = byte.min(text.len());
    text.get(..end)
        .map_or(end, |prefix| prefix.encode_utf16().count())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}