//! `runner.models.get`, `runner.models.set` and `runner.models.set_many`
//! (`src/core/runner-models.ts`): an executor's default model and allowed
//! tiered models, read and saved against the strategy file's revision under
//! the shared `executor-settings` lock. The caller syncs the endpoint
//! configuration and publishes the `runners` area after a save.
#![allow(clippy::result_large_err)]
use pacer_config::{
    config_writes::{edit, ensure_migrated, planner, resolve},
    executor_settings::revision,
    strategy::{StrategyError, load_strategy, strategy_path},
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    lock::{LockOptions, with_lock},
};
use pacer_models::{
    AvailableModels, Listing, Refusal, available_models,
    declarations::{array_bounds, at, issue, model_declarations, received, string},
    model_declaration_warnings, provider_name, validate_runner_models,
};
use serde_json::{Map, Value, json};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

const CHANGED: &str = "Executor settings changed. Reload saved settings.";
const SETTINGS_CONFLICT: &str = "Your settings changed while they were being updated. Try again.";
const MIGRATION_FAILED: &str = "Your settings file could not be updated to the current format. Check the settings and backup file, then try again.";
const FORWARDED: &str = "runner.models.set model check requires the forwarded operation";

/// One executor's requested default and declarations, Zod-parsed.
struct Entry {
    id: String,
    default: String,
    models: Vec<Value>,
}

struct Params {
    expected: String,
    entries: Vec<Entry>,
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

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

fn refused(Refusal { message, hint }: Refusal) -> CoreError {
    match hint {
        Some(hint) => invalid(message).hint(hint),
        None => invalid(message),
    }
}

fn entry(map: &Map<String, Value>, path: &str, id: bool, issues: &mut Vec<String>) -> Entry {
    let id = if id {
        string(map.get("id"), &at(path, "id"), 1, Some(128), issues)
    } else {
        None
    };
    let default = string(map.get("default"), &at(path, "default"), 1, None, issues);
    let models = model_declarations(map.get("models"), &at(path, "models"), issues);
    Entry {
        id: id.unwrap_or_default(),
        default: default.unwrap_or_default(),
        models,
    }
}

/// The operation's params schema, in Zod's issue order.
fn parse(op: &str, mut params: Value) -> Result<Params, CoreError> {
    pacer_config::normalize_json(&mut params);
    let map = match params {
        Value::Null => Map::new(),
        Value::Object(map) => map,
        other => {
            let got = received(Some(&other));
            return Err(invalid(format!(
                "params: Invalid input: expected object, received {got}"
            )));
        }
    };
    let mut issues = Vec::new();
    let mut parsed = Params {
        expected: String::new(),
        entries: Vec::new(),
    };
    match op {
        "runner.models.get" => {
            let id = string(map.get("id"), "id", 1, Some(128), &mut issues);
            parsed.entries.push(Entry {
                id: id.unwrap_or_default(),
                default: String::new(),
                models: Vec::new(),
            });
        }
        "runner.models.set" => {
            let id = string(map.get("id"), "id", 1, Some(128), &mut issues);
            let expected = string(
                map.get("expectedRevision"),
                "expectedRevision",
                1,
                None,
                &mut issues,
            );
            let mut entry = entry(&map, "", false, &mut issues);
            entry.id = id.unwrap_or_default();
            parsed.expected = expected.unwrap_or_default();
            parsed.entries.push(entry);
        }
        _ => {
            let expected = string(
                map.get("expectedRevision"),
                "expectedRevision",
                1,
                None,
                &mut issues,
            );
            parsed.expected = expected.unwrap_or_default();
            match map.get("runners") {
                Some(Value::Array(items)) => {
                    for (i, item) in items.iter().enumerate() {
                        let path = at("runners", i);
                        match item {
                            Value::Object(item) => {
                                parsed.entries.push(entry(item, &path, true, &mut issues))
                            }
                            other => {
                                let got = received(Some(other));
                                issue(
                                    &mut issues,
                                    &path,
                                    format!("Invalid input: expected object, received {got}"),
                                );
                            }
                        }
                    }
                    array_bounds(items, "runners", 1, 64, &mut issues);
                }
                other => {
                    let got = received(other);
                    issue(
                        &mut issues,
                        "runners",
                        format!("Invalid input: expected array, received {got}"),
                    );
                }
            }
        }
    }
    if issues.is_empty() {
        Ok(parsed)
    } else {
        Err(invalid(issues.join("; ")))
    }
}

/// The strategy text, its load and path, refusing a change between them.
fn snapshot(ctx: &Ctx) -> Result<(PathBuf, String, Value), CoreError> {
    let home = &ctx.pacer_home;
    let (path, _) = strategy_path(home).map_err(load_error)?;
    let text = read(&path)?;
    let strategy = load_strategy(home).map_err(load_error)?;
    if read(&path)? != text {
        return Err(conflict(CHANGED));
    }
    Ok((path, text, strategy))
}

/// The resolved, editable runner id, refusing unknown ids and the planner.
fn editable(strategy: &Value, reference: &str) -> Result<String, CoreError> {
    let runner = resolve(strategy, reference)
        .ok_or_else(|| invalid(format!("unknown runner {reference}")))?;
    if planner(strategy, runner) {
        return Err(CoreError::new(
            Code::NotAllowed,
            "cannot edit the planner runner",
        ));
    }
    Ok(runner["id"].as_str().unwrap_or(reference).to_owned())
}

fn listing(ctx: &Ctx, strategy: &Value, id: &str) -> Result<AvailableModels, CoreError> {
    match available_models(&ctx.pacer_home, ctx.now, strategy, id) {
        Listing::Known(list) => Ok(list),
        _ => Err(CoreError::new(Code::Unavailable, FORWARDED)),
    }
}

fn read_models(ctx: &Ctx, p: &Params) -> Result<Value, CoreError> {
    let reference = &p.entries[0].id;
    let (_, text, strategy) = snapshot(ctx)?;
    let runner = resolve(&strategy, reference)
        .ok_or_else(|| invalid(format!("unknown runner {reference}")))?;
    Ok(json!({
        "revision": revision(&text),
        "runner": runner["id"],
        "default": runner.get("model").cloned().unwrap_or(Value::Null),
        "models": runner.get("models").cloned().unwrap_or_else(|| json!([])),
    }))
}

/// `ensureAccounts`: migrate a legacy strategy (with its backup), then refuse
/// any other change since the revision was read.
fn prepare(ctx: &Ctx, path: &Path, text: &str, legacy: bool) -> Result<String, CoreError> {
    let migrated = match ensure_migrated(&ctx.pacer_home) {
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
                } else if legacy {
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

/// One validated strategy edit of every runner's `model` and `models`.
fn write(ctx: &Ctx, source: &str, planned: &[Entry]) -> Result<(), CoreError> {
    let key = |p: &[&str]| p.iter().map(|s| json!(s)).collect::<Vec<_>>();
    let other = |e: pacer_config::doc::EditError| StrategyError::Other(e.to_string());
    edit(&ctx.pacer_home, |doc, current| {
        if doc.as_str() != source {
            return Err(StrategyError::Other(
                "strategy changed during edit; retry".into(),
            ));
        }
        let declarations = doc.get_in(&key(&["runners"])).map_err(other)?;
        for entry in planned {
            let name = declarations
                .as_ref()
                .and_then(Value::as_object)
                .and_then(|map| {
                    map.keys()
                        .find(|k| resolve(current, k).is_some_and(|r| r["id"] == entry.id.as_str()))
                })
                .cloned()
                .unwrap_or_else(|| entry.id.clone());
            let model = key(&["runners", &name, "model"]);
            let models = key(&["runners", &name, "models"]);
            if entry.models.is_empty() {
                doc.delete_in(&models).map_err(other)?;
                doc.set_in(&model, &json!(entry.default)).map_err(other)?;
            } else {
                doc.set_in(&model, &json!(entry.default)).map_err(other)?;
                doc.set_in(&models, &Value::Array(entry.models.clone()))
                    .map_err(other)?;
            }
        }
        Ok(())
    })
    .map(|_| ())
    .map_err(|error| {
        let message = error.to_string();
        if message == SETTINGS_CONFLICT || message.contains("changed during edit") {
            conflict(SETTINGS_CONFLICT)
        } else {
            invalid(message).hint("Check the strategy values and retry.")
        }
    })
}

/// The saved runners with the new revision; declaration warnings follow the validation ones.
fn saved(
    ctx: &Ctx,
    path: &Path,
    planned: &[Entry],
    warnings: &mut Vec<String>,
) -> Result<(String, Vec<Value>), CoreError> {
    let updated = load_strategy(&ctx.pacer_home).map_err(load_error)?;
    let revision = revision(&read(path)?);
    let runners = planned
        .iter()
        .map(|entry| {
            let runner = &updated["runners"][&entry.id];
            warnings.extend(model_declaration_warnings(runner));
            json!({
                "revision": revision,
                "runner": entry.id,
                "default": runner.get("model").cloned().unwrap_or(Value::Null),
                "models": runner.get("models").cloned().unwrap_or_else(|| json!([])),
            })
        })
        .collect();
    Ok((revision, runners))
}

fn locked<T>(ctx: &Ctx, f: impl FnOnce() -> Result<T, CoreError>) -> Result<T, CoreError> {
    with_lock(ctx, "executor-settings", LockOptions::default(), f)
        .map_err(|e| CoreError::new(Code::Unavailable, e.to_string()))?
}

/// The locked read and revision check every save starts with.
fn current(ctx: &Ctx, expected: &str) -> Result<(PathBuf, String, Value), CoreError> {
    let (path, _) = strategy_path(&ctx.pacer_home).map_err(load_error)?;
    let text = read(&path)?;
    let strategy = load_strategy(&ctx.pacer_home).map_err(load_error)?;
    if expected != revision(&text) {
        return Err(conflict("Executor settings changed elsewhere.")
            .hint("Reload saved settings, then reapply your changes."));
    }
    Ok((path, text, strategy))
}

fn save_models(ctx: &Ctx, p: Params) -> Result<Value, CoreError> {
    let Entry {
        id,
        default,
        models,
    } = p.entries.into_iter().next().unwrap_or(Entry {
        id: String::new(),
        default: String::new(),
        models: Vec::new(),
    });
    let before = load_strategy(&ctx.pacer_home).map_err(load_error)?;
    let resolved = resolve(&before, &id).ok_or_else(|| invalid(format!("unknown runner {id}")))?;
    let list = listing(ctx, &before, resolved["id"].as_str().unwrap_or(&id))?;
    locked(ctx, || {
        let (path, text, s) = current(ctx, &p.expected)?;
        let runner = editable(&s, &id)?;
        let mut warnings = Vec::new();
        let provider = provider_name(&s, &s["runners"][&runner]);
        let models = validate_runner_models(provider, &list, &default, &models, &mut warnings)
            .map_err(refused)?;
        let source = prepare(ctx, &path, &text, s["legacy"] == true)?;
        let planned = [Entry {
            id: runner,
            default,
            models,
        }];
        write(ctx, &source, &planned)?;
        let (_, runners) = saved(ctx, &path, &planned, &mut warnings)?;
        let mut reply = runners.into_iter().next().unwrap_or(Value::Null);
        reply["warnings"] = json!(warnings);
        Ok(reply)
    })
}

fn save_many(ctx: &Ctx, p: Params) -> Result<Value, CoreError> {
    let ids: HashSet<&str> = p.entries.iter().map(|e| e.id.as_str()).collect();
    if ids.len() != p.entries.len() {
        return Err(invalid("duplicate runner ids"));
    }
    let before = load_strategy(&ctx.pacer_home).map_err(load_error)?;
    let mut warnings = Vec::new();
    let mut validated = Vec::new();
    for entry in p.entries {
        let runner = editable(&before, &entry.id)?;
        let list = listing(ctx, &before, &runner)?;
        let provider = provider_name(&before, &before["runners"][&runner]);
        let models = validate_runner_models(
            provider,
            &list,
            &entry.default,
            &entry.models,
            &mut warnings,
        )
        .map_err(refused)?;
        validated.push(Entry {
            id: runner,
            default: entry.default,
            models,
        });
    }
    locked(ctx, || {
        let (path, text, s) = current(ctx, &p.expected)?;
        let mut planned = Vec::new();
        for entry in validated {
            let id = editable(&s, &entry.id)?;
            planned.push(Entry { id, ..entry });
        }
        let source = prepare(ctx, &path, &text, s["legacy"] == true)?;
        write(ctx, &source, &planned)?;
        let (revision, runners) = saved(ctx, &path, &planned, &mut warnings)?;
        Ok(json!({"revision": revision, "runners": runners, "warnings": warnings}))
    })
}

fn run<'a>(ctx: &'a Ctx, op: &'static str, params: Value) -> OpFuture<'a> {
    Box::pin(async move {
        crate::runner_ops::authorize(ctx)?;
        let p = parse(op, params)?;
        match op {
            "runner.models.get" => read_models(ctx, &p),
            "runner.models.set" => save_models(ctx, p),
            _ => save_many(ctx, p),
        }
    })
}

pub fn runner_models_get(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    run(ctx, "runner.models.get", params)
}
pub fn runner_models_set(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    run(ctx, "runner.models.set", params)
}
pub fn runner_models_set_many(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    run(ctx, "runner.models.set_many", params)
}

/// A save whose runners only TypeScript can list (an OpenCode provider
/// without a fresh listing cache, or a cache shape only TypeScript serves)
/// forwards whole, before the lock: TypeScript lists every runner first.
pub fn runner_models_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    if !matches!(op, "runner.models.set" | "runner.models.set_many") {
        return false;
    }
    let Ok(p) = parse(op, params.clone()) else {
        return false;
    };
    let Ok(strategy) = load_strategy(&ctx.pacer_home) else {
        return true;
    };
    p.entries.iter().any(|entry| {
        resolve(&strategy, &entry.id).is_some_and(|runner| {
            let id = runner["id"].as_str().unwrap_or(&entry.id);
            !matches!(
                available_models(&ctx.pacer_home, ctx.now, &strategy, id),
                Listing::Known(_)
            )
        })
    })
}

#[cfg(test)]
mod tests;
