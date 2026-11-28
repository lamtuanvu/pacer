//! Account auth marks (`state/auth-failed.json` / `state/auth-evidence.json`),
//! limit marks and block/broken reads, ported from `src/usage/auth.ts`,
//! `src/usage/reactive.ts`, `src/executors/blocked.ts` and `src/exec/broken.ts`
//! (B12-2).
#![allow(clippy::unwrap_used)] // statically-valid compiled regexes.

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
    fsutil::{read_json, write_private},
};
use pacer_js_json::js_semantics::truthy;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::evidence::read_evidence;
use crate::freshness::AUTH_LIFETIME_S;

fn auth_failed_path(ctx: &Ctx) -> std::path::PathBuf {
    ctx.pacer_home.join("state").join("auth-failed.json")
}

fn auth_evidence_path(ctx: &Ctx) -> std::path::PathBuf {
    ctx.pacer_home.join("state").join("auth-evidence.json")
}

/// `readAuthFailures` (auth.ts:15-17).
pub fn read_auth_failures(ctx: &Ctx) -> Map<String, Value> {
    read_json::<Map<String, Value>>(&auth_failed_path(ctx)).unwrap_or_default()
}

/// `authError` (auth.ts:11).
fn auth_error() -> Regex {
    Regex::new(r"(?i)not logged in|please log in|401|unauthorized|authentication").unwrap()
}

/// `attemptAuthError` (auth.ts:13).
fn attempt_auth_error() -> Regex {
    Regex::new(
        r"(?i)not logged in|please (?:log|sign) in|login required|401 unauthorized|invalid api key|authentication (?:failed|required)",
    )
    .unwrap()
}

/// `authObservation` (auth.ts:44-47): the current auth failure observation, if
/// it matches the account's identity and still stands against the retired
/// boundary. Returns `(at, scope)`.
pub fn auth_observation(ctx: &Ctx, scope: &Value) -> Option<(f64, Value)> {
    let evidence: Map<String, Value> = read_json(&auth_evidence_path(ctx)).unwrap_or_default();
    let account = scope.get("account").and_then(Value::as_str).unwrap_or("");
    let value = evidence.get(account)?;
    if value.get("scope").and_then(|s| s.get("identity")) != scope.get("identity") {
        return None;
    }
    let at = value.get("at").and_then(Value::as_f64)?;
    let fail = read_auth_failures(ctx).get(account).and_then(Value::as_f64);
    if fail != Some(at) || !at.is_finite() || at > ctx.now {
        return None;
    }
    let retired = read_evidence(ctx, scope)
        .get("retiredAt")
        .and_then(Value::as_f64);
    if retired.is_some_and(|r| at <= r) {
        return None;
    }
    Some((at, value.get("scope").cloned().unwrap_or(Value::Null)))
}

/// `accountAuthFailure` (auth.ts:49-52): whether a fresh, unfettered auth
/// failure is on the account right now.
pub fn account_auth_failure(ctx: &Ctx, scope: &Value) -> bool {
    let Some((at, obs_scope)) = auth_observation(ctx, scope) else {
        return false;
    };
    at + AUTH_LIFETIME_S > ctx.now
        && obs_scope.get("runner").is_none_or(|v| !truthy(v))
        && obs_scope.get("model").is_none_or(|v| !truthy(v))
        && obs_scope.get("host").is_none_or(|v| !truthy(v))
}

/// `markAuthFailed` (auth.ts:20-31). Only authentication errors change state.
/// `read_only` skips the writes.
pub fn mark_auth_failed(
    ctx: &Ctx,
    account: &str,
    text: &str,
    attempt: bool,
    scope: Option<&Value>,
    read_only: bool,
) -> Result<(), CoreError> {
    let re = if attempt {
        attempt_auth_error()
    } else {
        auth_error()
    };
    if !re.is_match(text) {
        return Ok(());
    }
    if read_only {
        return Ok(());
    }
    let mut marks = read_auth_failures(ctx);
    marks.insert(account.to_owned(), js_number(ctx.now));
    write_private(
        &auth_failed_path(ctx),
        pacer_js_json::stringify(&Value::Object(marks)).as_bytes(),
    )
    .map_err(|e| CoreError::new(Code::Internal, format!("write auth mark: {e}")))?;
    let mut evidence: Map<String, Value> = read_json(&auth_evidence_path(ctx)).unwrap_or_default();
    let mut entry = Map::new();
    entry.insert("at".to_owned(), js_number(ctx.now));
    entry.insert("scope".to_owned(), scope.cloned().unwrap_or(Value::Null));
    evidence.insert(account.to_owned(), Value::Object(entry));
    write_private(
        &auth_evidence_path(ctx),
        pacer_js_json::stringify(&Value::Object(evidence)).as_bytes(),
    )
    .map_err(|e| CoreError::new(Code::Internal, format!("write auth evidence: {e}")))?;
    Ok(())
}

/// `recordAuthReading` (auth.ts:34-41). `read_only` skips writes.
pub fn record_auth_reading(
    ctx: &Ctx,
    account: &str,
    reading: &Value,
    scope: Option<&Value>,
    read_only: bool,
) -> Result<(), CoreError> {
    if reading.get("error").is_some_and(truthy) {
        let err = reading.get("error").and_then(Value::as_str).unwrap_or("");
        return mark_auth_failed(ctx, account, err, false, scope, read_only);
    }
    let stale = reading
        .get("stale")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let captured_at = reading.get("capturedAt").and_then(Value::as_f64);
    let source = reading.get("source").and_then(Value::as_str).unwrap_or("");
    if stale
        || captured_at.is_none()
        || captured_at.is_some_and(|c| c > ctx.now)
        || source == "reactive"
        || source == "unmetered"
    {
        return Ok(());
    }
    let mut marks = read_auth_failures(ctx);
    let Some(captured_at) = captured_at else {
        return Ok(());
    };
    if !marks.contains_key(account)
        || captured_at
            <= marks
                .get(account)
                .and_then(Value::as_f64)
                .unwrap_or(f64::INFINITY)
    {
        return Ok(());
    }
    if read_only {
        return Ok(());
    }
    marks.remove(account);
    write_private(
        &auth_failed_path(ctx),
        pacer_js_json::stringify(&Value::Object(marks)).as_bytes(),
    )
    .map_err(|e| CoreError::new(Code::Internal, format!("write auth mark: {e}")))?;
    Ok(())
}

/// A single active limit observation, read from `exhausted.json` —
/// `activeLimitObservations` (reactive.ts:38-43).
pub struct LimitObservation {
    pub key: String,
    pub observation: Value,
}

/// `activeLimitObservations` (reactive.ts:38-43): demand marks that are still
/// in effect right now, in file order.
pub fn active_limit_observations(ctx: &Ctx) -> Vec<LimitObservation> {
    let marks: Map<String, Value> =
        read_json(&ctx.pacer_home.join("exhausted.json")).unwrap_or_default();
    let evidence: Map<String, Value> =
        read_json(&ctx.pacer_home.join("state").join("exhausted-evidence.json"))
            .unwrap_or_default();
    marks
        .iter()
        .filter(|(_, until)| until.as_f64().is_some_and(|u| u > ctx.now))
        .map(|(key, until)| {
            let observation = if evidence.get(key).and_then(|v| v.get("until")) == Some(until) {
                evidence.get(key).cloned().unwrap_or(Value::Null)
            } else {
                json!({ "observedAt": Value::Null, "until": until, "manual": false })
            };
            LimitObservation {
                key: key.clone(),
                observation,
            }
        })
        .collect()
}

/// `readBlocked` (blocked.ts): current block reasons (`blocked.json`).
pub fn read_blocked(ctx: &Ctx) -> Map<String, Value> {
    let raw: Map<String, Value> =
        read_json(&ctx.pacer_home.join("blocked.json")).unwrap_or_default();
    raw.into_iter()
        .filter(|(_, m)| {
            m.get("reason").is_some_and(Value::is_string)
                && (m.get("until").is_some_and(Value::is_null)
                    || m.get("until")
                        .and_then(Value::as_f64)
                        .is_some_and(|u| u > ctx.now))
        })
        .collect()
}

/// `readBroken` (broken.ts): current broken marks (`broken.json`).
pub fn read_broken(ctx: &Ctx) -> Map<String, Value> {
    let raw: Map<String, Value> =
        read_json(&ctx.pacer_home.join("broken.json")).unwrap_or_default();
    raw.into_iter()
        .filter(|(_, m)| {
            m.get("until")
                .and_then(Value::as_f64)
                .is_some_and(|u| u > ctx.now)
                && m.get("reason").is_some_and(Value::is_string)
        })
        .collect()
}

/// A JSON number in TypeScript's spelling (integral values stay integers).
fn js_number(v: f64) -> Value {
    if v.is_finite() && v.fract() == 0.0 && v >= i64::MIN as f64 && v <= i64::MAX as f64 {
        Value::Number(serde_json::Number::from(v as i64))
    } else {
        Value::from(v)
    }
}
