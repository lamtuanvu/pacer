//! `buildModelInventory` (`src/dispatch/inventory.ts`).
use serde_json::{Value, json};

use crate::js::{Object, at, same_json, truthy};
use crate::observation::live;

fn text<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

fn record(runner: &Value, binding: Value, tier: Value, strengths: Value) -> Object {
    let mut out = Object::new();
    for (key, value) in [
        ("runner", runner.get("id")),
        ("account", runner.get("account")),
        ("executor", runner.get("agent")),
    ] {
        out.insert(key.into(), value.cloned().unwrap_or(Value::Null));
    }
    out.insert("actualModel".into(), Value::Null);
    out.insert("provenance".into(), json!("declared"));
    out.insert("binding".into(), binding);
    out.insert("tier".into(), tier);
    out.insert("strengths".into(), strengths);
    out
}

/// The declared records of one runner, with endpoint model capabilities.
fn declared(strategy: &Value, runner: &Value) -> Vec<Object> {
    let models = match runner.get("models").and_then(Value::as_array) {
        Some(models) => models.clone(),
        None if truthy(runner.get("model")) => {
            vec![json!({"id": runner["model"], "tier": "unknown", "strengths": []})]
        }
        None => Vec::new(),
    };
    if models.is_empty() {
        let binding = json!({"kind": "executor-default"});
        return vec![record(runner, binding, json!("unknown"), json!([]))];
    }
    let account = runner
        .get("account")
        .and_then(Value::as_str)
        .and_then(|account| strategy.get("accounts")?.get(account));
    let prefix = format!(
        "pacer-{}/",
        account
            .and_then(|a| text(a, "/name"))
            .unwrap_or("undefined")
    );
    let offered = account
        .and_then(|a| a.pointer("/connection/models"))
        .and_then(Value::as_array);
    models
        .iter()
        .map(|model| {
            let id = model.get("id").cloned().unwrap_or(Value::Null);
            let technical = offered.and_then(|offered| {
                offered.iter().find(|m| {
                    m.get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|m| Some(format!("{prefix}{m}").as_str()) == id.as_str())
                })
            });
            let binding = json!({"kind": "exact", "id": id});
            let tier = model.get("tier").cloned().unwrap_or(Value::Null);
            let strengths = model.get("strengths").cloned().unwrap_or(json!([]));
            let mut out = record(runner, binding, tier, strengths);
            for key in ["tools", "context"] {
                let value = model
                    .get(key)
                    .or_else(|| technical.and_then(|t| t.get(key)));
                if let Some(value) = value.filter(|v| !v.is_null()) {
                    out.insert(key.into(), value.clone());
                }
            }
            out
        })
        .collect()
}

/// A record of `runner` bound to the exact model `id`.
pub fn is_exact(record: &Object, runner: &Value, id: &Value) -> bool {
    record.get("runner") == Some(runner)
        && record["binding"]["kind"] == "exact"
        && &record["binding"]["id"] == id
}

/// `buildModelInventory`: explicit permission, opted-in discovery, then observed capabilities.
/// TypeScript's default `now` (`+Infinity`) is `f64::INFINITY`.
pub fn model_inventory(strategy: &Value, observations: &[Object], now: f64) -> Vec<Object> {
    let empty = Object::new();
    let runners = strategy
        .get("runners")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let mut inventory: Vec<Object> = runners
        .values()
        .flat_map(|runner| declared(strategy, runner))
        .collect();
    let discovery = strategy.pointer("/dispatch/discovery");
    if truthy(discovery.and_then(|d| d.get("enabled"))) {
        let opted = |key: &str, id: &Value| {
            discovery
                .and_then(|d| d.get(key))
                .and_then(Value::as_array)
                .is_some_and(|ids| ids.contains(id))
        };
        for observation in observations {
            let scope = &observation["scope"];
            if observation["method"] != "models"
                || !live(observation, now)
                || !opted("runners", &scope["runner"])
            {
                continue;
            }
            let Some(runner) = scope["runner"].as_str().and_then(|id| runners.get(id)) else {
                continue;
            };
            if runner.get("account") != Some(&scope["account"]) {
                continue;
            }
            let offered = observation
                .get("value")
                .and_then(|v| v.get("models"))
                .and_then(Value::as_array);
            for model in offered.into_iter().flatten() {
                let id = &model["id"];
                let runner_id = runner.get("id").unwrap_or(&Value::Null);
                if !opted("models", id) || inventory.iter().any(|m| is_exact(m, runner_id, id)) {
                    continue;
                }
                let mut out = Object::new();
                for (key, value) in [
                    ("runner", runner_id.clone()),
                    (
                        "account",
                        runner.get("account").cloned().unwrap_or(Value::Null),
                    ),
                    (
                        "executor",
                        runner.get("agent").cloned().unwrap_or(Value::Null),
                    ),
                    ("binding", json!({"kind": "exact", "id": id})),
                    ("actualModel", Value::Null),
                    ("tier", json!("unknown")),
                    ("strengths", json!([])),
                    ("provenance", json!("observed")),
                ] {
                    out.insert(key.into(), value);
                }
                inventory.push(out);
            }
        }
    }
    for model in &mut inventory {
        let mut evidence: Vec<&Object> = observations
            .iter()
            .filter(|o| {
                let scope = &o["scope"];
                scope["runner"] == model["runner"]
                    && scope["account"] == model["account"]
                    && scope.get("binding").is_some()
                    && same_json(scope.get("binding"), model.get("binding"))
                    && live(o, now)
            })
            .collect();
        evidence.sort_by(|a, b| {
            at(a, "observedAt")
                .partial_cmp(&at(b, "observedAt"))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        for observation in evidence {
            let value = observation.get("value");
            if observation["method"] == "capabilities" {
                for key in ["tools", "context"] {
                    if let Some(v) = value.and_then(|v| v.get(key)) {
                        model.insert(key.into(), v.clone());
                    }
                }
                model.insert("provenance".into(), json!("mixed"));
            }
            if observation["method"] == "actual-model"
                && let Some(actual) = value
                    .and_then(|v| v.get("model"))
                    .filter(|m| truthy(Some(m)))
            {
                model.insert("actualModel".into(), actual.clone());
            }
        }
    }
    inventory
}
