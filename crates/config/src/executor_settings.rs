//! `runner.settings.get` / `runner.settings.save` document effects.
//! Caller owns the cross-process lock, endpoint sync and config publication.

use crate::{
    config_writes::{ensure_migrated, ordered_executor_ids, resolve},
    doc::StrategyDoc,
    strategy::{StrategyError, load_strategy, strategy_path},
    write::atomic_strategy_write,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, path::Path};

fn revision(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

fn executor_max_tasks(strategy: &Value, runner_id: &str) -> u64 {
    let runner = resolve(strategy, runner_id);
    let host_limit = runner
        .and_then(|r| r.get("host").and_then(Value::as_str))
        .and_then(|host| strategy["hosts"][host]["maxTasks"].as_u64());
    runner
        .and_then(|r| r.get("maxTasks").and_then(Value::as_u64))
        .or(host_limit)
        .unwrap_or(1)
}

fn projection(strategy: &Value, text: &str) -> Value {
    let order = ordered_executor_ids(strategy);
    let runners: Vec<Value> = order
        .iter()
        .map(|id| {
            let runner = &strategy["runners"][id];
            json!({
                "id": id,
                "enabled": runner["enabled"] != false,
                "maxTasks": executor_max_tasks(strategy, id),
            })
        })
        .collect();
    json!({"revision": revision(text), "order": order, "runners": runners})
}

fn selected_settings_match(home: &Path, path: &Path, before: &str) -> bool {
    strategy_path(home).is_ok_and(|(selected, _)| selected == path)
        && fs::read_to_string(path).is_ok_and(|current| current == before)
}

fn invalid(message: &str) -> StrategyError {
    StrategyError::Other(message.into())
}

/// Read the editable executor projection and opaque file revision.
pub fn read_executor_settings(home: &Path) -> Result<Value, StrategyError> {
    let (path, _) = strategy_path(home)?;
    let text = fs::read_to_string(&path)?;
    let strategy = load_strategy(home)?;
    if !selected_settings_match(home, &path, &text) {
        return Err(invalid("Executor settings changed. Reload saved settings."));
    }
    Ok(projection(&strategy, &text))
}

/// Atomically save order/enabled/max_tasks against the expected revision.
pub fn save_executor_settings(home: &Path, input: &Value) -> Result<Value, StrategyError> {
    let expected = input["expectedRevision"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("expectedRevision is required"))?;
    let order = input["order"]
        .as_array()
        .ok_or_else(|| invalid("order must be an array"))?;
    let runners = input["runners"]
        .as_array()
        .ok_or_else(|| invalid("runners must be an array"))?;

    let (path, name) = strategy_path(home)?;
    let text = fs::read_to_string(&path)?;
    let strategy = load_strategy(home)?;
    if !selected_settings_match(home, &path, &text) {
        return Err(invalid("Executor settings changed. Reload saved settings."));
    }
    if expected != revision(&text) {
        return Err(invalid("Executor settings changed elsewhere."));
    }

    let ids = ordered_executor_ids(&strategy);
    let order_ids: Vec<String> = order
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let runner_ids: Vec<String> = runners
        .iter()
        .filter_map(|r| r["id"].as_str().map(str::to_owned))
        .collect();
    let permutation = |values: &[String]| {
        values.len() == ids.len()
            && values.iter().collect::<HashSet<_>>().len() == ids.len()
            && values.iter().all(|id| ids.contains(id))
    };
    let runners_ok = runners.iter().all(|r| {
        r.get("enabled").and_then(Value::as_bool).is_some()
            && crate::js_semantics::integer(&r["maxTasks"])
                .is_some_and(|n| (1.0..=16.0).contains(&n))
    });
    if !permutation(&order_ids) || !permutation(&runner_ids) || !runners_ok {
        return Err(invalid(
            "Provide every executor once, with parallel tasks from 1 to 16.",
        ));
    }

    // Migration may rewrite the file after the revision check, matching TS ensureAccounts.
    let migrated = ensure_migrated(home)?;
    let source = fs::read_to_string(&path)?;
    if migrated.is_none() && source != text {
        return Err(invalid("Executor settings changed. Reload saved settings."));
    }
    let strategy = load_strategy(home)?;

    let mut doc = StrategyDoc::new(&source);
    let declarations = doc
        .get_in(&[json!("runners")])
        .map_err(|e| invalid(&e.to_string()))?
        .and_then(|value| value.as_object().cloned());
    for runner in runners {
        let id = runner["id"].as_str().unwrap_or("");
        let key = declarations
            .as_ref()
            .and_then(|map| {
                map.keys()
                    .find(|key| resolve(&strategy, key).is_some_and(|r| r["id"] == id))
                    .cloned()
            })
            .unwrap_or_else(|| id.to_owned());
        let max_tasks = crate::js_semantics::integer(&runner["maxTasks"]).unwrap_or(1.0) as i64;
        doc.set_in(
            &[json!("runners"), json!(key.clone()), json!("enabled")],
            &json!(runner["enabled"]),
        )
        .map_err(|e| invalid(&e.to_string()))?;
        doc.set_in(
            &[json!("runners"), json!(key), json!("max_tasks")],
            &json!(max_tasks),
        )
        .map_err(|e| invalid(&e.to_string()))?;
    }
    doc.set_list(
        &[json!("pacing"), json!("order")],
        &order_ids.iter().map(|id| json!(id)).collect::<Vec<_>>(),
    )
    .map_err(|e| invalid(&e.to_string()))?;

    let after = doc.as_str();
    let raw =
        crate::doc::parse_yaml_value(after).map_err(|e| StrategyError::Other(e.to_string()))?;
    crate::strategy::validate_yaml_strategy(&raw, &path, &name)?;
    if source != after {
        if !selected_settings_match(home, &path, &source) {
            return Err(invalid("strategy changed during edit; retry"));
        }
        atomic_strategy_write(&path, after)?;
    }

    let updated = load_strategy(home)?;
    let updated_text = fs::read_to_string(&path)?;
    let warnings: Vec<Value> = updated["routing"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|rule| {
            !rule["executors"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|reference| {
                    let Some(runner) = resolve(&updated, reference.as_str().unwrap_or("")) else {
                        return false;
                    };
                    let id = runner["id"].as_str().unwrap_or("");
                    ids.iter().any(|known| known == id) && runner["enabled"] != false
                })
        })
        .map(|rule| {
            let label = match rule.get("kinds") {
                Some(Value::Array(kinds)) if !kinds.is_empty() => kinds
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", "),
                _ => "default".into(),
            };
            json!(format!(
                "Routing rule '{label}' has no enabled executor left."
            ))
        })
        .collect();

    let mut result = projection(&updated, &updated_text);
    result["warnings"] = Value::Array(warnings);
    if let Some(migrated) = migrated {
        result["migrated"] = migrated;
    }
    Ok(result)
}
