//! Native `dispatch.models`, `dispatch.refresh` and `dispatch.enforcement.consent`
//! (`listDispatchModels` and `refreshObservations` in `src/dispatch/refresh.ts`,
//! `recordConsent` in `src/dispatch/certification-schedule.ts`). The model
//! inventory and the observation schema live in `pacer-dispatch`.
//!
//! `dispatch.refresh` owns its refusals, params, the unknown-runner error and the
//! backoff reply. A refresh that would run reads `computeStatus` and calls the
//! observation plugins, so it stays forwarded. `dispatch.enforcement.consent`
//! forwards a schedule file Rust cannot rewrite with `JSON.stringify` bytes.
//! Callers holding a work grant never reach these handlers.
#![allow(clippy::result_large_err)]
use pacer_config::strategy::load_strategy;
use pacer_dispatch::{
    METHODS, decision_hash, is_exact, model_inventory, parse_observation, status_observations,
    stored_observations,
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use pacer_lifecycle::AdmissionState;
use rusqlite::OptionalExtension;
use serde_json::{Map, Value, json};
use std::{path::PathBuf, time::Duration};

use crate::dispatch_ops::{authorize, finish, params_object, string_issues, type_name};
use crate::learning_ops::num;
use crate::refresh_effects::RefreshEffects;

type Object = Map<String, Value>;

fn internal(error: impl ToString) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

/// The request time at the TypeScript clock resolution (`Date.now() / 1000`).
pub(crate) fn now(ctx: &Ctx) -> f64 {
    (ctx.now * 1000.0).floor() / 1000.0
}

pub(crate) fn open(ctx: &Ctx) -> Result<AdmissionState, CoreError> {
    AdmissionState::open(&ctx.pacer_home).map_err(|error| internal(error.0))
}

pub fn dispatch_models(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx, "dispatch.models", &params)?;
        params_object(&params)?;
        let strategy = load_strategy(&ctx.pacer_home).map_err(internal)?;
        let now = now(ctx);
        let mut state = open(ctx)?;
        let db = state.tasks.connection().map_err(internal)?;
        let observations = stored_observations(db, now).map_err(internal)?;
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
            .map(|o| o["observedAt"].as_f64().unwrap_or(f64::NAN))
            .reduce(f64::max)
            .map_or(Value::Null, num);
        Ok(json!({"models": declared, "advertised": advertised, "observedAt": observed}))
    })
}

/// What `dispatch.refresh` does with a request.
enum Refresh {
    /// A refusal or a backoff that needs no observation work.
    Reply(Result<Value, CoreError>),
    /// A due refresh: read status, call the observation plugins and write rows.
    Run,
}

fn refresh_plan(ctx: &Ctx, params: &Value) -> Refresh {
    let checked = authorize(ctx, "dispatch.refresh", params).and_then(|()| {
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
        return Refresh::Reply(Err(internal("the dispatch store is unavailable")));
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
        _ => Refresh::Run,
    }
}

/// `collectObservations`'s per-adapter normalization for a plugin's rows. The
/// plugin adapter overwrites `source` before the schema parse and discards any
/// payload that disagrees with the scope, method or clock (`src/dispatch/
/// observations.ts:14-38`, `src/dispatch/plugin-adapters.ts:8-14`).
fn plugin_rows(id: &str, scope: &Value, method: &str, raw: &Value, now: f64) -> Vec<Map<String, Value>> {
    let empty = |state: &str| {
        json!({"source": format!("plugin:{id}"), "scope": scope, "method": method,
            "state": state, "observedAt": num(now), "expiresAt": num(now)})
        .as_object()
        .cloned()
        .unwrap_or_default()
    };
    let Some(rows) = raw.as_array() else {
        return vec![empty("error")];
    };
    if rows.len() > 64 {
        return vec![empty("error")];
    }
    let mut parsed = Vec::with_capacity(rows.len());
    for row in rows {
        let mut row = row.clone();
        if let Some(object) = row.as_object_mut() {
            object.insert("source".into(), Value::String(format!("plugin:{id}")));
        }
        let Some(observation) = parse_observation(&row) else {
            return vec![empty("error")];
        };
        parsed.push(observation);
    }
    let mut out = Vec::new();
    for mut o in parsed {
        let o_scope = &o["scope"];
        if o["method"] != method
            || o["source"] != format!("plugin:{id}")
            || o_scope.get("runner") != scope.get("runner")
            || o_scope.get("account") != scope.get("account")
            || o_scope.get("binding") != scope.get("binding")
            || o["observedAt"].as_f64().unwrap_or(f64::NAN) > now
            || o["expiresAt"].as_f64().unwrap_or(f64::NAN)
                < o["observedAt"].as_f64().unwrap_or(f64::NAN)
        {
            out.push(empty("error"));
            continue;
        }
        if o["expiresAt"].as_f64().unwrap_or(f64::NAN) <= now && o["state"] == "known" {
            o.insert("state".into(), Value::String("unknown".into()));
            o.remove("value");
        }
        out.push(o);
    }
    out
}

/// The immediate `work_observations` and `work_refresh` write of
/// `refreshObservations` (`src/dispatch/refresh.ts:34-37`), with JavaScript
/// `JSON.stringify` bytes and the shared `decisionHash` row ids.
fn write_refresh(
    ctx: &Ctx,
    observations: &[Map<String, Value>],
    key: &str,
    now: f64,
    failures: i64,
    retry_at: f64,
) -> Result<(), CoreError> {
    let mut state = open(ctx)?;
    let db = state.tasks.connection().map_err(internal)?;
    let tx = db.unchecked_transaction().map_err(internal)?;
    {
        let mut insert = tx
            .prepare("INSERT OR REPLACE INTO work_observations(id,at,data) VALUES(?1,?2,?3)")
            .map_err(internal)?;
        for o in observations.iter().filter(|o| o["state"] == "known") {
            let value = Value::Object(o.clone());
            let id = decision_hash(&json!({
                "source": o["source"], "scope": o["scope"], "method": o["method"],
            }));
            let mut data = String::new();
            stringify(&value, &mut data);
            if data.len() > 256 * 1024 {
                return Err(internal("Work record exceeds 256 KiB"));
            }
            insert
                .execute((id, o["observedAt"].as_f64().unwrap_or(now), data))
                .map_err(internal)?;
        }
    }
    tx.execute(
        "INSERT OR REPLACE INTO work_refresh(scope,attempted,retry_at,failures) VALUES(?1,?2,?3,?4)",
        rusqlite::params![key, now, retry_at, failures],
    )
    .map_err(internal)?;
    tx.commit().map_err(internal)
}

async fn refresh_run(
    ctx: &Ctx,
    params: &Value,
    effects: &mut dyn RefreshEffects,
) -> Result<Value, CoreError> {
    let p = params_object(params)?;
    let strategy = load_strategy(&ctx.pacer_home).map_err(internal)?;
    let now = now(ctx);
    let runner = p.get("runner").and_then(Value::as_str);
    let runners = strategy["runners"].as_object();
    let mut scopes: Vec<Value> = Vec::new();
    for (id, r) in runners.into_iter().flatten() {
        if runner.is_some_and(|wanted| wanted != id.as_str()) {
            continue;
        }
        let account = r.get("account").cloned().unwrap_or(Value::Null);
        scopes.push(json!({"runner": id, "account": account}));
        for model in model_inventory(&strategy, &[], now) {
            if model.get("runner").and_then(Value::as_str) == Some(id.as_str()) {
                scopes.push(json!({
                    "runner": id, "account": account, "binding": model["binding"],
                }));
            }
        }
    }
    if runner.is_some() && scopes.is_empty() {
        return Err(CoreError::new(Code::InvalidInput, "Unknown runner"));
    }
    let key = runner.unwrap_or("all").to_owned();
    let status = effects.status().await?;
    let mut observations: Vec<Map<String, Value>> = Vec::new();
    let plugins = effects.observation_plugins();
    for scope in &scopes {
        // The status adapter is always first, as in `collectObservations`.
        for o in status_observations(&status, std::slice::from_ref(scope), now) {
            observations.push(o);
        }
        for plugin in &plugins {
            for method in METHODS {
                let input = json!({"scope": scope, "method": method});
                let empty = json!({"source": format!("plugin:{plugin}"), "scope": scope,
                    "method": method, "state": "error", "observedAt": num(now),
                    "expiresAt": num(now)}).as_object().cloned().unwrap_or_default();
                match effects.observe(plugin, input).await {
                    Ok(raw) => observations.extend(plugin_rows(plugin, scope, method, &raw, now)),
                    Err(_) => observations.push(empty),
                }
            }
        }
    }
    let errors = observations.iter().filter(|o| o["state"] == "error").count();
    let previous = {
        let mut state = open(ctx)?;
        let db = state.tasks.connection().map_err(internal)?;
        db.query_row(
            "SELECT failures FROM work_refresh WHERE scope=?",
            [&key],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(internal)?
        .unwrap_or(0)
    };
    let failures = if errors > 0 {
        (previous + 1).min(8)
    } else {
        0
    };
    let retry_at = now
        + if failures > 0 {
            (30.0 * 2_f64.powi(failures as i32)).min(3600.0)
        } else {
            60.0
        };
    write_refresh(ctx, &observations, &key, now, failures, retry_at)?;
    Ok(json!({
        "state": if errors > 0 { "partial" } else { "ok" },
        "observations": observations.len(),
        "known": observations.iter().filter(|o| o["state"] == "known").count(),
        "errors": errors,
        "retryAt": num(retry_at),
    }))
}

/// Registry placeholder: both front doors dispatch `dispatch.refresh` through
/// [`dispatch_refresh`] with their native effects before the generic registry.
pub fn dispatch_refresh_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async {
        Err(CoreError::new(
            Code::Unavailable,
            "dispatch.refresh requires the native refresh effects",
        ))
    })
}

pub fn dispatch_refresh<'a>(
    ctx: &'a Ctx,
    params: Value,
    effects: &'a mut dyn RefreshEffects,
) -> OpFuture<'a> {
    Box::pin(async move {
        match refresh_plan(ctx, &params) {
            Refresh::Reply(reply) => reply,
            Refresh::Run => refresh_run(ctx, &params, effects).await,
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
pub(crate) fn read_schedule(ctx: &Ctx) -> Option<(Object, Value)> {
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
        authorize(ctx, "dispatch.enforcement.consent", &params)?;
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

/// The only planning input still needing TypeScript: a certification schedule
/// whose object spread or number text Rust cannot reproduce byte for byte.
/// `dispatch.refresh` is fully native and no longer appears here.
pub fn planning_stays_forwarded(ctx: &Ctx, op: &str) -> bool {
    op == "dispatch.enforcement.consent" && read_schedule(ctx).is_none()
}

#[cfg(test)]
#[path = "planning_ops/tests.rs"]
mod tests;
