//! File-backed repository registration removal during TypeScript coexistence.

use pacer_foundation::{
    Ctx,
    api::{
        error::{Code, CoreError},
        registry::NativeOp,
    },
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use serde_json::{Map, Value, json};
use std::{fs, path::Path};

fn state_file(ctx: &Ctx, name: &str) -> std::path::PathBuf {
    ctx.pacer_home.join("state").join(name)
}

fn read_map(path: &Path) -> Map<String, Value> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn js_compatible(value: &Value) -> bool {
    match value {
        Value::Number(n) => n
            .as_i64()
            .is_some_and(|i| i.unsigned_abs() <= 9_007_199_254_740_991),
        Value::Array(items) => items.iter().all(js_compatible),
        Value::Object(map) => map.iter().all(|(key, value)| {
            !key.parse::<u32>()
                .is_ok_and(|n| n < u32::MAX && n.to_string() == *key)
                && js_compatible(value)
        }),
        _ => true,
    }
}

// Date.now()/1000 yields a millisecond-derived fractional second. For this
// bounded range, JSON.stringify and serde_json both emit the same plain decimal
// bytes. Keep legacy/exotic number forms on the core-owned path.
fn js_compatible_last_used(value: &Value) -> bool {
    if js_compatible(value) {
        return true;
    }
    let Some(seconds) = value.as_f64() else {
        return false;
    };
    if !seconds.is_finite() || !(1_000_000_000.0..10_000_000_000.0).contains(&seconds) {
        return false;
    }
    let millis = (seconds * 1000.0).round() as u64;
    if millis as f64 / 1000.0 != seconds {
        return false;
    }
    let fraction = millis % 1000;
    let canonical = if fraction == 0 {
        (millis / 1000).to_string()
    } else {
        format!("{}.{fraction:03}", millis / 1000)
            .trim_end_matches('0')
            .to_owned()
    };
    serde_json::to_string(value).is_ok_and(|encoded| encoded == canonical)
}

/// Retain JS-owned parsing for legacy or unusual registries until their exact
/// JSON.stringify behavior is ported. Missing files follow the core's `{}` default.
pub fn requires_core_repo_parser(ctx: &Ctx) -> bool {
    let repos = state_file(ctx, "repos.json");
    let aliases = state_file(ctx, "repo-paths.json");
    for path in [&repos, &aliases] {
        match fs::metadata(path) {
            Ok(metadata) if metadata.is_dir() => return true,
            Ok(metadata) if !metadata.is_file() => return false,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return false,
            Ok(_) => {}
        }
        let Ok(bytes) = fs::read(path) else {
            return false;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            return true;
        };
        let Some(map) = value.as_object() else {
            return true;
        };
        if path == &repos
            && map.values().any(|entry| {
                let Some(object) = entry.as_object() else {
                    return true;
                };
                object.len() != 3
                    || !object.get("key").is_some_and(Value::is_string)
                    || !object.get("path").is_some_and(Value::is_string)
                    || !object.get("lastUsed").is_some_and(Value::is_number)
                    || !object.get("lastUsed").is_some_and(js_compatible_last_used)
            })
        {
            return true;
        }
        if map.keys().any(|key| {
            key.parse::<u32>()
                .is_ok_and(|n| n < u32::MAX && n.to_string() == *key)
        }) {
            return true;
        }
        if path == &aliases && !js_compatible(&value) {
            return true;
        }
        if path == &aliases && map.values().any(|value| !value.is_string()) {
            return true;
        }
    }
    false
}

fn io_error(error: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::InvalidInput, error.to_string())
}

pub fn remove_repo(ctx: &Ctx, key: &str) -> Result<Value, CoreError> {
    if key.is_empty() {
        return Err(CoreError::new(
            Code::InvalidInput,
            "key: Too small: expected string to have >=1 characters",
        ));
    }
    with_lock(ctx, "repos", LockOptions::default(), || {
        let state = ctx.pacer_home.join("state");
        if fs::symlink_metadata(&state).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(io_error("state directory is a symlink"));
        }
        let repos_path = state_file(ctx, "repos.json");
        let aliases_path = state_file(ctx, "repo-paths.json");
        for path in [&repos_path, &aliases_path] {
            match fs::metadata(path) {
                Ok(metadata) if metadata.is_file() && fs::read(path).is_err() => {
                    return Err(CoreError::new(
                        Code::Conflict,
                        "repository registry is unreadable",
                    ));
                }
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(CoreError::new(
                        Code::Conflict,
                        "repository registry is unreadable",
                    ));
                }
                _ => {}
            }
        }
        // Dispatch selects the runtime before this lock. A core writer may have
        // replaced either file while we waited, so never reinterpret it as `{}`.
        if requires_core_repo_parser(ctx) {
            return Err(CoreError::new(
                Code::Conflict,
                "repository registry changed during removal",
            ));
        }
        for path in [&repos_path, &aliases_path] {
            if fs::symlink_metadata(path).is_ok_and(|metadata| {
                metadata.file_type().is_symlink() || !(metadata.is_file() || metadata.is_dir())
            }) {
                return Err(io_error("repository state file must be regular"));
            }
        }
        let mut repos = read_map(&repos_path);
        let removed: Vec<String> = repos
            .iter()
            .filter(|(_, entry)| entry.get("key").and_then(Value::as_str) == Some(key))
            .map(|(path, _)| path.clone())
            .collect();
        for path in &removed {
            repos.remove(path);
        }
        let removed: std::collections::HashSet<&str> = removed.iter().map(String::as_str).collect();
        let mut aliases = read_map(&aliases_path);
        aliases.retain(|_, main| !main.as_str().is_some_and(|main| removed.contains(main)));
        // The core writes these in order and has no rollback after the first rename.
        write_private(&repos_path, &serde_json::to_vec(&repos).map_err(io_error)?)
            .map_err(io_error)?;
        write_private(
            &aliases_path,
            &serde_json::to_vec(&aliases).map_err(io_error)?,
        )
        .map_err(io_error)?;
        Ok(json!({"removed":true}))
    })
    .map_err(io_error)?
}

fn remove(ctx: &Ctx, params: Value) -> pacer_foundation::api::registry::OpFuture<'_> {
    Box::pin(async move {
        if !params.is_object() && !params.is_null() {
            let received = match params {
                Value::Array(_) => "array",
                Value::String(_) => "string",
                Value::Number(_) => "number",
                Value::Bool(_) => "boolean",
                _ => "unknown",
            };
            return Err(CoreError::new(
                Code::InvalidInput,
                format!("params: Invalid input: expected object, received {received}"),
            ));
        }
        let key = params.get("key").and_then(Value::as_str).ok_or_else(|| {
            let received = match params.get("key") {
                None => "undefined",
                Some(Value::Number(_)) => "number",
                Some(Value::Bool(_)) => "boolean",
                Some(Value::Null) => "null",
                Some(Value::Array(_)) => "array",
                Some(Value::Object(_)) => "object",
                Some(Value::String(_)) => unreachable!(),
            };
            CoreError::new(
                Code::InvalidInput,
                format!("key: Invalid input: expected string, received {received}"),
            )
        })?;
        remove_repo(ctx, key)
    })
}

pub fn ops() -> &'static [NativeOp] {
    &[NativeOp {
        name: "repo.remove",
        call: remove,
    }]
}
