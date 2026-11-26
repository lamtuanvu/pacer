//! Native `dispatch.models`, `dispatch.refresh` and `dispatch.enforcement.consent`
//! (`listDispatchModels` and `refreshObservations` in `src/dispatch/refresh.ts`,
//! `recordConsent` in `src/dispatch/certification-schedule.ts`). The model
//! inventory and the observation schema live in `pacer-dispatch`.
//!
//! `dispatch.refresh` owns its refusals, params, the unknown-runner error and the
//! backoff reply. A refresh that would run reads `computeStatus` and calls the
//! observation plugins, so it stays forwarded. `dispatch.enforcement.consent`
//! rewrites the schedule with JavaScript's quoted JSON bytes, including non-object
//! consent spread the way `{...consent}` does. Callers holding a work grant never
//! reach these handlers.
#![allow(clippy::result_large_err)]
use pacer_config::strategy::load_strategy;
use pacer_dispatch::{is_exact, model_inventory, stored_observations};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use pacer_js_json::quoted;
use pacer_lifecycle::AdmissionState;
use rusqlite::OptionalExtension;
use serde_json::{Map, Value, json};
use std::{path::PathBuf, time::Duration};

use crate::dispatch_ops::{authorize, finish, params_object, string_issues, type_name};
use crate::learning_ops::num;

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
    Reply(Result<Value, CoreError>),
    /// A refresh that reads status and observation plugins in TypeScript.
    Forward,
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

/// JS `{...consent}` for a string: own enumerable index keys, one per code point.
fn spread_string(text: &str) -> Object {
    let mut spread = Object::new();
    for (index, point) in char::decode_utf16(quoted::utf16(text)).enumerate() {
        let mut buffer = [0; 2];
        let units = match point {
            Ok(c) => c.encode_utf16(&mut buffer).to_vec(),
            Err(lone) => vec![lone.unpaired_surrogate()],
        };
        spread.insert(index.to_string(), Value::String(quoted::from_units(&units)));
    }
    spread
}

/// `readScheduleState` as consent and attempts. Bun's `JSON.parse` accepts lone
/// surrogates and overflow numbers, and an object spread coerces every other type:
/// a string or array gains index keys, a number, bool or null becomes `{}`.
pub(crate) fn read_schedule(ctx: &Ctx) -> (Object, Value) {
    let bytes = match std::fs::read(schedule_path(ctx)) {
        Ok(bytes) => bytes,
        Err(_) => return (Object::new(), json!({})),
    };
    let Value::Object(stored) = quoted::parse_file(&bytes).unwrap_or(Value::Null) else {
        return (Object::new(), json!({}));
    };
    let consent = match stored.get("consent") {
        None | Some(Value::Null) => Object::new(),
        Some(Value::Object(consent)) => consent.clone(),
        Some(Value::String(text)) => spread_string(text),
        Some(Value::Array(items)) => Object::from_iter(
            items
                .iter()
                .enumerate()
                .map(|(index, value)| (index.to_string(), value.clone())),
        ),
        Some(_) => Object::new(),
    };
    let attempts = match stored.get("attempts") {
        None | Some(Value::Null) => json!({}),
        Some(attempts) => attempts.clone(),
    };
    (consent, attempts)
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
            let (mut consent, attempts) = read_schedule(ctx);
            consent.insert(account.into(), json!(answer));
            let text = quoted::stringify(&json!({"consent": consent, "attempts": attempts}));
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
        _ => false,
    }
}

#[cfg(test)]
#[path = "planning_ops/tests.rs"]
mod tests;
