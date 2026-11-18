//! `statusObservationAdapter` as `collectObservations` runs it
//! (`src/dispatch/observations.ts`). The adapter reads the cache-only status and
//! never refreshes timestamps.
use pacer_js_json::stringify;
use serde_json::{Value, json};

use crate::js::{Object, at, js_min, num, number, same_json, truthy};
use crate::observation::{METHODS, parse_observation};

/// The adapter id, which is every observation's `source`.
pub const STATUS_SOURCE: &str = "status-cache";

fn find<'a>(list: Option<&'a Value>, key: &str, value: Option<&Value>) -> Option<&'a Value> {
    list.and_then(Value::as_array)?
        .iter()
        .find(|item| item.get(key) == value)
}

/// `statusObservationAdapter(status).observe(ctx, scope, method)` for `health`
/// and `usage`. `Err` stands for a thrown error.
fn observe(status: &Value, scope: &Value, method: &str, now: f64) -> Result<Vec<Value>, ()> {
    if scope.get("binding").is_some() {
        return Ok(Vec::new());
    }
    let provider = find(status.get("providers"), "id", scope.get("runner"));
    let account = find(status.get("accounts"), "name", scope.get("account"));
    let observed = account
        .and_then(|a| a.get("capturedAt"))
        .filter(|v| !v.is_null())
        .or_else(|| status.get("generatedAt"));
    let observed = observed.map_or(f64::NAN, |v| number(Some(v)).unwrap_or(f64::NAN));
    let windows = provider.and_then(|p| p.get("windows"));
    let resets = windows
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|w| w.get("resetsAt") != Some(&Value::Null))
        .map(|w| number(w.get("resetsAt")).unwrap_or(f64::NAN));
    let expires = js_min(std::iter::once(observed + 60.0).chain(resets));
    let base = |state: &str| {
        json!({"source": STATUS_SOURCE, "scope": scope, "method": method,
            "observedAt": num(observed), "expiresAt": num(expires), "state": state})
    };
    let Some(provider) = provider
        .filter(|p| !truthy(p.get("stale")) && !account.is_some_and(|a| truthy(a.get("stale"))))
    else {
        return Ok(vec![base("unknown")]);
    };
    if method == "health" {
        let installed = provider.get("installed");
        let healthy = if !truthy(installed) {
            installed.cloned()
        } else {
            let reason = |key: &str| truthy(provider.get(key));
            let ineligible = provider.pointer("/eligibility/state") == Some(&json!("ineligible"));
            Some(json!(
                !reason("unavailableReason")
                    && !reason("signedOutReason")
                    && !reason("blockedReason")
                    && !reason("brokenReason")
                    && !ineligible
            ))
        };
        let mut value = Object::new();
        if let Some(healthy) = healthy {
            value.insert("healthy".into(), healthy);
        }
        let mut out = base("known");
        out["value"] = Value::Object(value);
        return Ok(vec![out]);
    }
    let all = windows.and_then(Value::as_array).ok_or(())?;
    let usable: Vec<Value> = all
        .iter()
        .filter(|w| !truthy(w.get("stale")) && !truthy(w.get("rolled")))
        .filter(|w| w.get("usedPct") != Some(&Value::Null))
        .map(|w| {
            let mut out = Object::new();
            let name = w.get("name").cloned().unwrap_or(Value::Null);
            let pool = stringify(&json!([scope.get("account").cloned(), name]));
            out.insert("pool".into(), json!(pool));
            if let Some(used) = w.get("usedPct") {
                out.insert("usedPct".into(), used.clone());
            }
            let resets = w.get("resetsAt").filter(|r| !r.is_null());
            if let Some(resets) = number(resets).filter(|r| *r > now) {
                out.insert("hoursLeft".into(), num((resets - now) / 3600.0));
            }
            Value::Object(out)
        })
        .collect();
    let captured = account
        .and_then(|a| a.get("capturedAt"))
        .is_some_and(|c| !c.is_null());
    let complete = !usable.is_empty() && usable.len() == all.len() && captured;
    let unmetered = provider.get("usage") == Some(&json!("unmetered"));
    if !unmetered && !complete {
        return Ok(vec![base("unknown")]);
    }
    let mut out = base("known");
    out["value"] = json!({"windows": usable, "unmetered": unmetered});
    Ok(vec![out])
}

/// `collectObservations(ctx, [statusObservationAdapter(status)], scopes)`: for each
/// scope and method, `unsupported` for methods the adapter lacks, `error` for
/// malformed or inconsistent output, and `unknown` for a known reading that has
/// already expired.
pub fn status_observations(status: &Value, scopes: &[Value], now: f64) -> Vec<Object> {
    let mut out = Vec::new();
    for scope in scopes {
        for method in METHODS {
            let empty = |state: &str| {
                let value = json!({"source": STATUS_SOURCE, "scope": scope, "method": method,
                    "state": state, "observedAt": num(now), "expiresAt": num(now)});
                value.as_object().cloned().unwrap_or_default()
            };
            if !matches!(*method, "health" | "usage") {
                out.push(empty("unsupported"));
                continue;
            }
            let Ok(raw) = observe(status, scope, method, now) else {
                out.push(empty("error"));
                continue;
            };
            let parsed: Option<Vec<Object>> = raw.iter().map(parse_observation).collect();
            let Some(parsed) = parsed else {
                out.push(empty("error"));
                continue;
            };
            for mut o in parsed {
                let field = |key: &str| o["scope"].get(key);
                if o["source"] != STATUS_SOURCE
                    || o["method"] != *method
                    || field("runner") != scope.get("runner")
                    || field("account") != scope.get("account")
                    || !same_json(field("binding"), scope.get("binding"))
                    || at(&o, "observedAt") > now
                    || at(&o, "expiresAt") < at(&o, "observedAt")
                {
                    out.push(empty("error"));
                    continue;
                }
                if at(&o, "expiresAt") <= now && o["state"] == "known" {
                    o.insert("state".into(), json!("unknown"));
                    o.remove("value");
                }
                out.push(o);
            }
        }
    }
    out
}
