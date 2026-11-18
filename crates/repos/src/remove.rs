//! `removeRepo` from `src/core/repos.ts`: under the `repos` lock, drop every registry entry
//! whose `key` matches and every linked-checkout alias naming a dropped root, then rewrite
//! both files with `writeJsonAtomic`. Both files are read as `readJson` does (`JSON.parse` of
//! the lossy UTF-8 text, `null` on any read or parse failure); the registry also goes through
//! the object spread of `registry()`, while the aliases are written back without spreading.
use crate::read::{NeedsCore, read_json, spread};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use pacer_js_json::quoted;
use serde_json::{Map, Value, json};
use std::{collections::HashSet, fs, io::ErrorKind, path::Path};

/// The registry and aliases `removeRepo` writes. Besides unreadable inputs, a state path that
/// is not a usable directory and the engine `TypeError`s of a `null` registry entry or a
/// deletion from a string alias file need the core.
fn plan(home: &Path, key: &str) -> Result<(Map<String, Value>, Value), NeedsCore> {
    let state = home.join("state");
    match fs::metadata(&state) {
        Ok(metadata) if metadata.is_dir() => {}
        Err(error)
            if error.kind() == ErrorKind::NotFound && fs::symlink_metadata(&state).is_err() => {}
        _ => return Err(NeedsCore),
    }
    let mut registry = spread(read_json(&state.join("repos.json"), false)?);
    if registry.values().any(Value::is_null) {
        return Err(NeedsCore);
    }
    let key = quoted::from_utf8(Value::String(key.to_owned()));
    let removed: HashSet<String> = registry
        .iter()
        .filter(|(_, entry)| entry.get("key") == Some(&key))
        .map(|(path, _)| path.clone())
        .collect();
    registry.retain(|path, _| !removed.contains(path));
    let mut aliases = match read_json(&state.join("repo-paths.json"), false)? {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(value) => value,
    };
    let gone = |main: &Value| main.as_str().is_some_and(|main| removed.contains(main));
    let infinite = quoted::nonfinite(&aliases);
    match &mut aliases {
        Value::Object(map) => map.retain(|_, main| !gone(main)),
        // `delete` leaves holes, which JSON.stringify writes as null.
        Value::Array(items) => {
            for item in items.iter_mut().filter(|item| gone(item)) {
                *item = Value::Null;
            }
        }
        Value::String(text)
            if !infinite
                && quoted::utf16(text)
                    .into_iter()
                    .any(|unit| removed.contains(&quoted::from_units(&[unit]))) =>
        {
            return Err(NeedsCore);
        }
        _ => {}
    }
    Ok((registry, aliases))
}

/// Whether `repo.remove` of `key` must run in TypeScript; see `plan`.
pub fn remove_needs_core(pacer_home: &Path, key: &str) -> bool {
    plan(pacer_home, key).is_err()
}

fn internal(error: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

/// `removeRepo(ctx, key)`. Writes replace a symlinked registry file with a regular file and
/// leave its target untouched; a symlinked state directory is written through.
pub fn remove_repo(ctx: &Ctx, key: &str) -> Result<Value, CoreError> {
    with_lock(ctx, "repos", LockOptions::default(), || {
        let (registry, aliases) = plan(&ctx.pacer_home, key).map_err(|NeedsCore| {
            CoreError::new(Code::Conflict, "repository registry changed during removal")
        })?;
        let state = ctx.pacer_home.join("state");
        let registry = quoted::stringify(&Value::Object(registry));
        write_private(&state.join("repos.json"), registry.as_bytes()).map_err(internal)?;
        let aliases = quoted::stringify(&aliases);
        write_private(&state.join("repo-paths.json"), aliases.as_bytes()).map_err(internal)?;
        Ok(json!({"removed": true}))
    })
    .map_err(internal)?
}
