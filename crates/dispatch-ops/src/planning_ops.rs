//! Native `dispatch.models`, `dispatch.refresh` and `dispatch.enforcement.consent`
//! (`listDispatchModels` and `refreshObservations` in `src/dispatch/refresh.ts`,
//! `buildModelInventory` in `src/dispatch/inventory.ts`, `recordConsent` in
//! `src/dispatch/certification-schedule.ts`).
//!
//! `dispatch.refresh` owns its refusals, params, the unknown-runner error and the
//! backoff reply. A refresh that would run reads `computeStatus` and calls the
//! observation plugins, so it stays forwarded. `dispatch.enforcement.consent`
//! forwards a schedule file Rust cannot rewrite with `JSON.stringify` bytes.
//! Callers holding a work grant never reach these handlers.
#![allow(clippy::result_large_err)]
use pacer_config::strategy::load_strategy;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use pacer_lifecycle::AdmissionState;
use rusqlite::{Connection, OptionalExtension, types::ValueRef};
use serde_json::{Map, Value, json};
use std::{path::PathBuf, time::Duration};

use crate::dispatch_ops::{authorize, finish, params_object, string_issues, type_name};
use crate::learning_ops::{num, truthy};

type Object = Map<String, Value>;

fn internal(error: impl ToString) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

/// The request time at the TypeScript clock resolution (`Date.now() / 1000`).
fn now(ctx: &Ctx) -> f64 {
    (ctx.now * 1000.0).floor() / 1000.0
}

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const TIERS: &[&str] = &["small", "medium", "frontier", "unknown"];
const METHODS: &[&str] = &["models", "capabilities", "usage", "health", "actual-model"];
const STATES: &[&str] = &["known", "unknown", "unsupported", "error"];

/// `z.string().min(1).max(256)`.
fn name(value: Option<&Value>) -> Option<Value> {
    let text = value?.as_str()?;
    (1..=256)
        .contains(&text.chars().count())
        .then(|| json!(text))
}

/// A `.strict()` object: unknown keys fail.
fn strict<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Object> {
    let map = value.as_object()?;
    map.keys()
        .all(|key| keys.contains(&key.as_str()))
        .then_some(map)
}

fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|_| value.is_number())
}

fn boolean(value: &Value) -> Option<Value> {
    value.is_boolean().then(|| value.clone())
}

/// `z.number().int().positive()`.
fn positive_int(value: &Value) -> Option<Value> {
    let n = number(value)?;
    (n.fract() == 0.0 && n > 0.0 && n <= MAX_SAFE).then(|| num(n))
}

/// Copies an optional key through `check`; `None` when the value fails it.
fn optional(
    map: &Object,
    key: &str,
    out: &mut Object,
    check: impl Fn(&Value) -> Option<Value>,
) -> Option<()> {
    if let Some(value) = map.get(key) {
        out.insert(key.into(), check(value)?);
    }
    Some(())
}

fn list(value: &Value, max: usize, item: impl Fn(&Value) -> Option<Value>) -> Option<Value> {
    let items = value.as_array().filter(|items| items.len() <= max)?;
    items
        .iter()
        .map(item)
        .collect::<Option<_>>()
        .map(Value::Array)
}

fn binding(value: &Value) -> Option<Value> {
    match value.get("kind")?.as_str()? {
        "exact" => {
            let map = strict(value, &["kind", "id"])?;
            Some(json!({"kind": "exact", "id": name(map.get("id"))?}))
        }
        "executor-default" => strict(value, &["kind"]).map(|_| json!({"kind": "executor-default"})),
        _ => None,
    }
}

/// `modelDeclarationSchema`, with its `tier` and `strengths` defaults.
fn declaration(value: &Value) -> Option<Value> {
    let map = strict(value, &["id", "tier", "strengths", "tools", "context"])?;
    let mut out = Object::new();
    out.insert("id".into(), name(map.get("id"))?);
    let tier = match map.get("tier") {
        None => "unknown",
        Some(tier) => tier.as_str().filter(|tier| TIERS.contains(tier))?,
    };
    out.insert("tier".into(), json!(tier));
    let strengths = match map.get("strengths") {
        None => json!([]),
        Some(strengths) => list(strengths, 64, |s| name(Some(s)))?,
    };
    out.insert("strengths".into(), strengths);
    optional(map, "tools", &mut out, boolean)?;
    optional(map, "context", &mut out, positive_int)?;
    Some(Value::Object(out))
}

fn window(value: &Value) -> Option<Value> {
    let map = strict(value, &["pool", "usedPct", "hoursLeft"])?;
    let used = map
        .get("usedPct")
        .and_then(number)
        .filter(|n| (0.0..=100.0).contains(n))?;
    let mut out = Object::new();
    out.insert("pool".into(), name(map.get("pool"))?);
    out.insert("usedPct".into(), num(used));
    optional(map, "hoursLeft", &mut out, |v| {
        number(v).filter(|n| *n > 0.0).map(num)
    })?;
    Some(Value::Object(out))
}

fn observation_value(value: &Value) -> Option<Value> {
    let keys = [
        "models",
        "tools",
        "context",
        "model",
        "healthy",
        "unmetered",
        "windows",
        "cost",
    ];
    let map = strict(value, &keys)?;
    let mut out = Object::new();
    optional(map, "models", &mut out, |v| list(v, 512, declaration))?;
    optional(map, "tools", &mut out, boolean)?;
    optional(map, "context", &mut out, positive_int)?;
    optional(map, "model", &mut out, |v| name(Some(v)))?;
    optional(map, "healthy", &mut out, boolean)?;
    optional(map, "unmetered", &mut out, boolean)?;
    optional(map, "windows", &mut out, |v| list(v, 64, window))?;
    optional(map, "cost", &mut out, |v| {
        number(v).filter(|n| *n >= 0.0).map(num)
    })?;
    Some(Value::Object(out))
}

/// `observationSchema.safeParse`: the parsed observation in schema key order.
pub(crate) fn parse_observation(value: &Value) -> Option<Object> {
    let keys = [
        "source",
        "scope",
        "method",
        "state",
        "observedAt",
        "expiresAt",
        "value",
    ];
    let map = strict(value, &keys)?;
    let scope = strict(map.get("scope")?, &["runner", "account", "binding"])?;
    let mut parsed_scope = Object::new();
    parsed_scope.insert("runner".into(), name(scope.get("runner"))?);
    parsed_scope.insert("account".into(), name(scope.get("account"))?);
    optional(scope, "binding", &mut parsed_scope, binding)?;
    let pick = |key: &str, options: &[&str]| {
        let text = map.get(key)?.as_str()?;
        options.contains(&text).then(|| json!(text))
    };
    let mut out = Object::new();
    out.insert("source".into(), name(map.get("source"))?);
    out.insert("scope".into(), Value::Object(parsed_scope));
    out.insert("method".into(), pick("method", METHODS)?);
    out.insert("state".into(), pick("state", STATES)?);
    for key in ["observedAt", "expiresAt"] {
        out.insert(key.into(), num(map.get(key).and_then(number)?));
    }
    optional(map, "value", &mut out, observation_value)?;
    Some(out)
}

fn at(observation: &Object, key: &str) -> f64 {
    observation[key].as_f64().unwrap_or(f64::NAN)
}

fn text<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

/// `storedObservations`: the newest 2,048 rows that parse and have not expired.
fn stored_observations(db: &Connection, now: f64) -> Result<Vec<Object>, CoreError> {
    let mut stmt = db
        .prepare("SELECT data FROM work_observations ORDER BY at DESC LIMIT 2048")
        .map_err(internal)?;
    let mut rows = stmt.query([]).map_err(internal)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(internal)? {
        let ValueRef::Text(data) = row.get_ref(0).map_err(internal)? else {
            continue;
        };
        if let Some(observation) = serde_json::from_slice::<Value>(data)
            .ok()
            .and_then(|value| parse_observation(&value))
            .filter(|o| at(o, "expiresAt") > now)
        {
            out.push(observation);
        }
    }
    Ok(out)
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

fn live(observation: &Object, now: f64) -> bool {
    observation["state"] == "known"
        && at(observation, "observedAt") <= now
        && at(observation, "expiresAt") > now
}

fn is_exact(record: &Object, runner: &Value, id: &Value) -> bool {
    &record["runner"] == runner
        && record["binding"]["kind"] == "exact"
        && &record["binding"]["id"] == id
}

/// `buildModelInventory`: explicit permission, opted-in discovery, then observed capabilities.
pub(crate) fn model_inventory(strategy: &Value, observations: &[Object], now: f64) -> Vec<Object> {
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
                    && scope.get("binding") == Some(&model["binding"])
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

fn open(ctx: &Ctx) -> Result<AdmissionState, CoreError> {
    AdmissionState::open(&ctx.pacer_home).map_err(|error| internal(error.0))
}

pub fn dispatch_models(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        params_object(&params)?;
        let strategy = load_strategy(&ctx.pacer_home).map_err(internal)?;
        let now = now(ctx);
        let mut state = open(ctx)?;
        let observations = stored_observations(state.tasks.connection().map_err(internal)?, now)?;
        let declared = model_inventory(&strategy, &observations, now);
        let mut advertised = Vec::new();
        for o in observations
            .iter()
            .filter(|o| o["method"] == "models" && o["state"] == "known")
        {
            let models = o
                .get("value")
                .and_then(|v| v.get("models"))
                .and_then(Value::as_array);
            for model in models.into_iter().flatten() {
                let runner = &o["scope"]["runner"];
                let authorized = declared.iter().any(|d| is_exact(d, runner, &model["id"]));
                advertised.push(json!({"source": o["source"], "runner": runner, "account": o["scope"]["account"], "model": model, "authorized": authorized}));
            }
        }
        let observed = observations
            .iter()
            .map(|o| at(o, "observedAt"))
            .reduce(f64::max)
            .map_or(Value::Null, num);
        Ok(json!({"models": declared, "advertised": advertised, "observedAt": observed}))
    })
}

/// What `dispatch.refresh` does with a request.
enum Refresh {
    Reply(Result<Value, CoreError>),
    /// A refresh that reads status and observation plugins in TypeScript.
    Forward,
}

fn refresh_plan(ctx: &Ctx, params: &Value) -> Refresh {
    let checked = authorize(ctx).and_then(|()| {
        let p = params_object(params)?;
        let mut issues = Vec::new();
        if p.contains_key("runner") {
            string_issues("runner", p.get("runner"), Some(128), &mut issues);
        }
        if let Some(force) = p.get("force").filter(|f| !f.is_boolean()) {
            issues.push(format!(
                "force: Invalid input: expected boolean, received {}",
                type_name(force)
            ));
        }
        finish(issues).map(|()| p)
    });
    let p = match checked {
        Ok(p) => p,
        Err(error) => return Refresh::Reply(Err(error)),
    };
    let (Ok(strategy), Ok(mut state)) = (load_strategy(&ctx.pacer_home), open(ctx)) else {
        return Refresh::Forward;
    };
    let runner = p.get("runner").and_then(Value::as_str);
    if let Some(runner) = runner {
        let known = strategy
            .get("runners")
            .and_then(Value::as_object)
            .is_some_and(|runners| {
                runners
                    .values()
                    .any(|r| r.get("id").and_then(Value::as_str) == Some(runner))
            });
        if !known {
            return Refresh::Reply(Err(CoreError::new(Code::InvalidInput, "Unknown runner")));
        }
    }
    let previous = state.tasks.connection().ok().and_then(|db| {
        db.query_row(
            "SELECT retry_at FROM work_refresh WHERE scope=?",
            [runner.unwrap_or("all")],
            |row| row.get::<_, f64>(0),
        )
        .optional()
        .ok()
        .flatten()
    });
    match previous {
        Some(retry) if p.get("force") != Some(&Value::Bool(true)) && retry > ctx.now => {
            Refresh::Reply(Ok(
                json!({"state": "backoff", "retryAt": num(retry), "observations": 0}),
            ))
        }
        _ => Refresh::Forward,
    }
}

pub fn dispatch_refresh(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        match refresh_plan(ctx, &params) {
            Refresh::Reply(reply) => reply,
            Refresh::Forward => Err(CoreError::new(
                Code::Unavailable,
                "The observation backoff ended while the refresh was being routed",
            )
            .hint("Try again.")),
        }
    })
}

fn schedule_path(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home
        .join("state")
        .join("certification-schedule.json")
}

/// `readScheduleState` as consent and attempts, or `None` when the file must stay
/// with TypeScript: unreadable, text `serde_json` rejects, or a `consent` that the
/// object spread would coerce.
fn read_schedule(ctx: &Ctx) -> Option<(Object, Value)> {
    let bytes = match std::fs::read(schedule_path(ctx)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Some((Object::new(), json!({})));
        }
        Err(_) => return None,
    };
    let Value::Object(stored) = serde_json::from_slice::<Value>(&bytes).ok()? else {
        return Some((Object::new(), json!({})));
    };
    let consent = match stored.get("consent") {
        None | Some(Value::Null) => Object::new(),
        Some(Value::Object(consent)) => consent.clone(),
        Some(_) => return None,
    };
    let attempts = match stored.get("attempts") {
        None | Some(Value::Null) => json!({}),
        Some(attempts) => attempts.clone(),
    };
    Some((consent, attempts))
}

/// `JSON.stringify`: ECMAScript numbers and integer-index keys first.
fn stringify(value: &Value, out: &mut String) {
    fn index(key: &str) -> Option<u32> {
        key.parse::<u32>()
            .ok()
            .filter(|n| *n != u32::MAX && n.to_string() == key)
    }
    match value {
        Value::Number(n) => {
            out.push_str(ryu_js::Buffer::new().format(n.as_f64().unwrap_or(f64::NAN)))
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                stringify(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by_key(|key| index(key).map_or((1, 0), |n| (0, n)));
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                stringify(&map[key], out);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

pub fn dispatch_enforcement_consent(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        let p = params_object(&params)?;
        let mut issues = Vec::new();
        string_issues("account", p.get("account"), Some(128), &mut issues);
        if !p.get("granted").is_some_and(Value::is_boolean) {
            issues.push(format!(
                "granted: Invalid input: expected boolean, received {}",
                p.get("granted").map_or("undefined", type_name)
            ));
        }
        finish(issues)?;
        let account = p["account"].as_str().unwrap_or_default();
        let answer = if p["granted"] == true {
            "granted"
        } else {
            "declined"
        };
        let options = LockOptions {
            timeout: Duration::from_secs(10),
            stale: Duration::from_secs(30),
        };
        with_lock(ctx, "certification-schedule", options, || {
            let (mut consent, attempts) = read_schedule(ctx).ok_or_else(|| {
                CoreError::new(
                    Code::Unavailable,
                    "The certification schedule changed while it was being updated",
                )
                .hint("Try again.")
            })?;
            consent.insert(account.into(), json!(answer));
            let mut text = String::new();
            stringify(
                &json!({"consent": consent, "attempts": attempts}),
                &mut text,
            );
            write_private(&schedule_path(ctx), text.as_bytes()).map_err(internal)
        })
        .map_err(internal)??;
        Ok(json!({"account": account, "consent": answer}))
    })
}

/// Inputs of these operations that only the TypeScript core handles.
pub fn planning_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    match op {
        "dispatch.refresh" => matches!(refresh_plan(ctx, params), Refresh::Forward),
        "dispatch.enforcement.consent" => read_schedule(ctx).is_none(),
        _ => false,
    }
}

#[cfg(test)]
#[path = "planning_ops/tests.rs"]
mod tests;
