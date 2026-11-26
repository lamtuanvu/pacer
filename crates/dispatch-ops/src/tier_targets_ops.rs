//! `dispatch.tierTargets.get` and `dispatch.tierTargets.set`
//! (`src/core/tier-targets.ts`): the model tier each task complexity targets,
//! read and saved against the strategy file's revision under the shared
//! `executor-settings` lock. The caller syncs the endpoint configuration and
//! publishes the `strategy` area after a save.
#![allow(clippy::result_large_err)]
use crate::dispatch_ops::{authorize, finish, invalid, params_object, string_issues, type_name};
use pacer_config::{
    doc::{EditError, StrategyDoc, parse_value},
    executor_settings::revision,
    strategy::{StrategyError, migrate_strategy, validate_strategy},
    strategy_load::{load_native, node_strategy_path},
    write::atomic_strategy_write,
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    lock::{LockOptions, with_lock},
};
use serde_json::{Map, Value, json};
use std::{fs, io, path::Path};

const KEYS: [&str; 3] = ["simple", "standard", "complex"];
const TIERS: [&str; 3] = ["small", "medium", "frontier"];
const CHANGED: &str = "Executor settings changed. Reload saved settings.";
const SETTINGS_CONFLICT: &str = "Your settings changed while they were being updated. Try again.";
const MIGRATION_FAILED: &str = "Your settings file could not be updated to the current format. Check the settings and backup file, then try again.";

fn conflict(message: &str) -> CoreError {
    CoreError::new(Code::Conflict, message)
}

/// A load or read failure TypeScript throws as a plain `Error`.
fn internal(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Internal, message)
}

/// `loadStrategy` for every strategy file, with Bun's YAML errors and Node's path rules.
fn load(home: &Path) -> Result<Value, CoreError> {
    load_native(home)
        .map(|loaded| loaded.value)
        .map_err(|error| internal(error.to_string()))
}

/// Node's `readFileSync(path, "utf8")` message, which a plain `io::Error` does not match.
fn node_error(path: &Path, error: &io::Error) -> String {
    let shown = path.display();
    match error.kind() {
        io::ErrorKind::NotFound => format!("ENOENT: no such file or directory, open '{shown}'"),
        io::ErrorKind::PermissionDenied => format!("EACCES: permission denied, open '{shown}'"),
        io::ErrorKind::IsADirectory => "EISDIR: illegal operation on a directory, read".into(),
        _ => error.to_string(),
    }
}

fn read(path: &Path) -> Result<String, CoreError> {
    fs::read_to_string(path).map_err(|e| internal(node_error(path, &e)))
}

fn defaults() -> Value {
    json!({"simple": "small", "standard": "medium", "complex": "frontier"})
}

/// `tierTargetsSchema`: defaulted tiers, strict keys, then the refine, which
/// a tier outside the enum skips.
fn targets(value: Option<&Value>, issues: &mut Vec<String>) -> Value {
    let Some(Value::Object(map)) = value else {
        let got = value.map_or("undefined", type_name);
        issues.push(format!(
            "targets: Invalid input: expected object, received {got}"
        ));
        return Value::Null;
    };
    let mut out = Map::new();
    let mut ranks = Vec::new();
    for (key, default) in KEYS.into_iter().zip(TIERS) {
        let tier = match map.get(key) {
            None => default,
            Some(Value::String(tier)) if TIERS.contains(&tier.as_str()) => tier,
            Some(_) => {
                issues.push(format!(
                    "targets.{key}: Invalid option: expected one of \"small\"|\"medium\"|\"frontier\""
                ));
                continue;
            }
        };
        ranks.extend(TIERS.iter().position(|t| *t == tier));
        out.insert(key.to_owned(), json!(tier));
    }
    let unknown: Vec<String> = map
        .keys()
        .filter(|key| !KEYS.contains(&key.as_str()))
        .map(|key| format!("\"{key}\""))
        .collect();
    match unknown.len() {
        0 => {}
        1 => issues.push(format!("targets: Unrecognized key: {}", unknown[0])),
        _ => issues.push(format!(
            "targets: Unrecognized keys: {}",
            unknown.join(", ")
        )),
    }
    if ranks.len() == KEYS.len() && !ranks.is_sorted() {
        issues
            .push("targets: dispatch.tierTargets must not decrease from simple to complex".into());
    }
    Value::Object(out)
}

fn read_targets(ctx: &Ctx) -> Result<Value, CoreError> {
    let home = &ctx.pacer_home;
    let (path, _) = node_strategy_path(home);
    let text = read(&path)?;
    let strategy = load(home)?;
    if read(&path)? != text {
        return Err(conflict(CHANGED));
    }
    let targets = strategy["dispatch"].get("tierTargets").cloned();
    Ok(json!({"revision": revision(&text), "targets": targets.unwrap_or_else(defaults)}))
}

/// The Node-path equivalent of `config_writes::edit`: the caller syncs endpoints
/// and publishes the diff, so only the revised text is needed here.
fn edit_native(
    home: &Path,
    change: impl FnOnce(&mut StrategyDoc, &Value) -> Result<(), StrategyError>,
) -> Result<(), StrategyError> {
    let (path, name) = node_strategy_path(home);
    let before = fs::read_to_string(&path)?;
    let strategy = load_native(home)
        .map(|loaded| loaded.value)
        .map_err(|error| StrategyError::Other(error.to_string()))?;
    let mut doc = StrategyDoc::new(&before);
    change(&mut doc, &strategy)?;
    let after = doc.as_str();
    let raw = parse_value(after).map_err(|error| StrategyError::Other(error.to_string()))?;
    validate_strategy(&raw, &path, &name)?;
    if before == after {
        return Ok(());
    }
    if fs::read_to_string(&path).ok().as_deref() != Some(before.as_str()) {
        return Err(StrategyError::Other(SETTINGS_CONFLICT.into()));
    }
    atomic_strategy_write(&path, after)?;
    Ok(())
}

/// `ensureAccounts`: migrate a legacy strategy (with its backup), then refuse
/// any other change since the revision was read. Uses Node's strategy path,
/// which an absolute active name joins under `strategies/` rather than replacing home.
fn prepare(ctx: &Ctx, path: &Path, text: &str) -> Result<String, CoreError> {
    let home = &ctx.pacer_home;
    let (source, migrated) = match load(home) {
        Err(error) => return Err(error),
        Ok(strategy) if strategy["legacy"] != true => (read(path)?, false),
        Ok(_) => {
            let before = read(path)?;
            if let Err(error) = migrate_strategy(path, Some(&before)) {
                let message = error.to_string();
                let changed = read(path).map_or(true, |now| now != before);
                return Err(
                    if message == SETTINGS_CONFLICT
                        || changed
                        || message.contains("changed during migration")
                    {
                        conflict(SETTINGS_CONFLICT)
                    } else {
                        invalid(MIGRATION_FAILED)
                    },
                );
            }
            (read(path)?, true)
        }
    };
    if !migrated && source != text {
        return Err(conflict(CHANGED));
    }
    Ok(source)
}

fn save_targets(ctx: &Ctx, expected: &str, targets: Value) -> Result<Value, CoreError> {
    let home = &ctx.pacer_home;
    let (path, _) = node_strategy_path(home);
    with_lock(ctx, "executor-settings", LockOptions::default(), || {
        let text = read(&path)?;
        if expected != revision(&text) {
            return Err(conflict("Executor settings changed elsewhere.")
                .hint("Reload saved settings, then reapply your changes."));
        }
        let source = prepare(ctx, &path, &text)?;
        let other = |e: EditError| StrategyError::Other(e.to_string());
        edit_native(home, |doc, _| {
            if doc.as_str() != source {
                return Err(StrategyError::Other(
                    "strategy changed during edit; retry".into(),
                ));
            }
            doc.set_in(&[json!("dispatch"), json!("tierTargets")], &targets)
                .map_err(other)
        })
        .map_err(|error| {
            let message = error.to_string();
            if message == SETTINGS_CONFLICT || message.contains("changed during edit") {
                conflict(SETTINGS_CONFLICT)
            } else {
                invalid(message).hint("Check the strategy values and retry.")
            }
        })?;
        let updated = load(home)?;
        Ok(json!({"revision": revision(&read(&path)?), "targets": updated["dispatch"]["tierTargets"]}))
    })
    .map_err(|e| CoreError::new(Code::Unavailable, e.to_string()))?
}

pub fn dispatch_tier_targets_get(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx, "dispatch.tierTargets.get", &params)?;
        params_object(&params)?;
        read_targets(ctx)
    })
}

pub fn dispatch_tier_targets_set(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx, "dispatch.tierTargets.set", &params)?;
        let map = params_object(&params)?;
        let mut issues = Vec::new();
        string_issues(
            "expectedRevision",
            map.get("expectedRevision"),
            None,
            &mut issues,
        );
        let targets = targets(map.get("targets"), &mut issues);
        finish(issues)?;
        let expected = map["expectedRevision"].as_str().unwrap_or_default();
        save_targets(ctx, expected, targets)
    })
}

#[cfg(test)]
mod tests;
