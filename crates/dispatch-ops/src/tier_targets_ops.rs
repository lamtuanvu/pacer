//! `dispatch.tierTargets.get` and `dispatch.tierTargets.set`
//! (`src/core/tier-targets.ts`): the model tier each task complexity targets,
//! read and saved against the strategy file's revision under the shared
//! `executor-settings` lock. The caller syncs the endpoint configuration and
//! publishes the `strategy` area after a save.
#![allow(clippy::result_large_err)]
use crate::dispatch_ops::{authorize, finish, invalid, params_object, string_issues, type_name};
use pacer_config::{
    config_writes::{edit, ensure_migrated},
    doc::EditError,
    executor_settings::revision,
    strategy::{StrategyError, load_strategy, strategy_path},
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    lock::{LockOptions, with_lock},
};
use serde_json::{Map, Value, json};
use std::{fs, path::Path};

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

fn load_error(error: StrategyError) -> CoreError {
    internal(error.to_string())
}

fn read(path: &Path) -> Result<String, CoreError> {
    fs::read_to_string(path).map_err(|e| internal(e.to_string()))
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
    let (path, _) = strategy_path(home).map_err(load_error)?;
    let text = read(&path)?;
    let strategy = load_strategy(home).map_err(load_error)?;
    if read(&path)? != text {
        return Err(conflict(CHANGED));
    }
    let targets = strategy["dispatch"].get("tierTargets").cloned();
    Ok(json!({"revision": revision(&text), "targets": targets.unwrap_or_else(defaults)}))
}

/// `ensureAccounts`: migrate a legacy strategy (with its backup), then refuse
/// any other change since the revision was read.
fn prepare(ctx: &Ctx, path: &Path, text: &str) -> Result<String, CoreError> {
    let home = &ctx.pacer_home;
    let migrated = match ensure_migrated(home) {
        Ok(migrated) => migrated.is_some(),
        Err(error) => {
            let message = error.to_string();
            let changed = fs::read_to_string(path).map_or(true, |now| now != text);
            return Err(
                if message == SETTINGS_CONFLICT
                    || changed
                    || message.contains("changed during migration")
                {
                    conflict(SETTINGS_CONFLICT)
                } else if load_strategy(home).is_ok_and(|s| s["legacy"] == true) {
                    invalid(MIGRATION_FAILED)
                } else {
                    internal(message)
                },
            );
        }
    };
    let source = read(path)?;
    if !migrated && source != text {
        return Err(conflict(CHANGED));
    }
    Ok(source)
}

fn save_targets(ctx: &Ctx, expected: &str, targets: Value) -> Result<Value, CoreError> {
    let home = &ctx.pacer_home;
    let (path, _) = strategy_path(home).map_err(load_error)?;
    with_lock(ctx, "executor-settings", LockOptions::default(), || {
        let text = read(&path)?;
        if expected != revision(&text) {
            return Err(conflict("Executor settings changed elsewhere.")
                .hint("Reload saved settings, then reapply your changes."));
        }
        let source = prepare(ctx, &path, &text)?;
        let other = |e: EditError| StrategyError::Other(e.to_string());
        edit(home, |doc, _| {
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
        let updated = load_strategy(home).map_err(load_error)?;
        Ok(json!({"revision": revision(&read(&path)?), "targets": updated["dispatch"]["tierTargets"]}))
    })
    .map_err(|e| CoreError::new(Code::Unavailable, e.to_string()))?
}

pub fn dispatch_tier_targets_get(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        params_object(&params)?;
        read_targets(ctx)
    })
}

pub fn dispatch_tier_targets_set(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
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
