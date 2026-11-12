//! `removeRepo` from `src/core/repos.ts`: under the `repos` lock, drop every registry entry
//! whose `key` matches and every linked-checkout alias naming a dropped root, then rewrite
//! both files with `writeJsonAtomic`. Both files are read as `readJson` does (`JSON.parse` of
//! the lossy UTF-8 text, `null` on any read or parse failure); the registry also goes through
//! the object spread of `registry()`, while the aliases are written back without spreading.
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use pacer_js_json::quoted;
use serde_json::{Map, Value, json};
use std::{
    collections::HashSet,
    fs,
    io::{ErrorKind, Read},
    path::Path,
};

/// Deepest node (root 0) a native registry read accepts.
const DEPTH: usize = 128;

/// Inputs whose TypeScript outcome is not reproduced: a lone UTF-16 surrogate, nesting deeper
/// than `DEPTH`, a registry path that is a directory or another non-regular file (reading a
/// FIFO blocks), a state directory that is not a usable directory, and the engine `TypeError`s
/// of a `null` registry entry or a deletion from a string alias file.
struct NeedsCore;

fn open(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    options.open(path)
}

fn plain(value: &Value) -> bool {
    let lone = |text: &str| char::decode_utf16(quoted::utf16(text)).any(|c| c.is_err());
    let mut stack = vec![(value, 0)];
    while let Some((value, depth)) = stack.pop() {
        if depth > DEPTH {
            return false;
        }
        match value {
            Value::String(text) if lone(text) => return false,
            Value::Array(items) => stack.extend(items.iter().map(|item| (item, depth + 1))),
            Value::Object(map) => {
                for (key, item) in map {
                    if lone(key) {
                        return false;
                    }
                    stack.push((item, depth + 1));
                }
            }
            _ => {}
        }
    }
    true
}

/// `readJson(path)` in the quoted representation; `None` stands for its `null`. Symlinks are
/// followed, and an unreadable regular file reads as `null`.
fn read_json(path: &Path) -> Result<Option<Value>, NeedsCore> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => {}
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        _ => return Err(NeedsCore),
    }
    let mut bytes = Vec::new();
    let regular = open(path).and_then(|mut file| {
        if !file.metadata()?.is_file() {
            return Ok(false);
        }
        file.read_to_end(&mut bytes).map(|_| true)
    });
    match regular {
        Ok(true) => {}
        Ok(false) => return Err(NeedsCore),
        Err(_) => return Ok(None),
    }
    match quoted::parse_file(&bytes) {
        Ok(value) if plain(&value) => Ok(Some(value)),
        Ok(_) => Err(NeedsCore),
        Err(error) if error == quoted::NESTING_FALLBACK => Err(NeedsCore),
        Err(_) => Ok(None),
    }
}

/// `{ ...(value ?? {}) }`: arrays and strings spread into index keys, other primitives into
/// nothing.
fn spread(value: Option<Value>) -> Map<String, Value> {
    match value.filter(|value| !quoted::nonfinite(value)) {
        Some(Value::Object(map)) => map,
        Some(Value::Array(items)) => items
            .into_iter()
            .enumerate()
            .map(|(i, item)| (i.to_string(), item))
            .collect(),
        Some(Value::String(text)) => quoted::utf16(&text)
            .into_iter()
            .enumerate()
            .map(|(i, unit)| (i.to_string(), Value::String(quoted::from_units(&[unit]))))
            .collect(),
        _ => Map::new(),
    }
}

/// The registry and aliases `removeRepo` writes.
fn plan(home: &Path, key: &str) -> Result<(Map<String, Value>, Value), NeedsCore> {
    let state = home.join("state");
    match fs::metadata(&state) {
        Ok(metadata) if metadata.is_dir() => {}
        Err(error)
            if error.kind() == ErrorKind::NotFound && fs::symlink_metadata(&state).is_err() => {}
        _ => return Err(NeedsCore),
    }
    let mut registry = spread(read_json(&state.join("repos.json"))?);
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
    let mut aliases = match read_json(&state.join("repo-paths.json"))? {
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

/// Whether `repo.remove` of `key` must run in TypeScript; see `NeedsCore`.
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
