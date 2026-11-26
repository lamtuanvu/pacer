//! Pure usage-refresh rules, shared by the lower-layer account and limits ops
//! and re-exported as `pacer_status::refresh::rules`. Moved unchanged from
//! `pacer_engine::usage_refresh` (B12-4): the Rust layer rule keeps a layer-6
//! crate from owning code that layer-6 `pacer-account-ops` must also call.

use serde_json::Value;

pub const AUTOMATIC_INTERVAL_S: f64 = 15.0 * 60.0;

fn optional_number(value: &Value) -> Option<f64> {
    value.as_f64()
}

fn string(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

/// Provider id for adapter matching (aligned with `readAccountUsage` / `usageRefreshCapability`).
pub fn provider_id(account: &Value) -> String {
    let kind = string(&account["kind"]);
    if kind == "claude" {
        return "claude-code".into();
    }
    if kind == "endpoint" {
        return string(&account["name"]).into();
    }
    kind.into()
}

/// Refresh source capability for an account row (aligned with `src/usage/adapter.ts`).
pub fn refresh_capability(account: &Value) -> &'static str {
    let usage = string(&account["usage"]);
    let id = provider_id(account);
    let arkcli =
        string(&account["quotaSource"]) == "arkcli" || string(&account["usageSource"]) == "arkcli";
    match usage {
        "quota" if id == "claude-code" => "passive-log",
        "quota" if id == "codex" => "provider-command",
        "quota" if arkcli => "provider-command",
        "metered" => "provider-command",
        "reactive" | "unmetered" => "unavailable",
        _ => "unavailable",
    }
}

/// Outcome for one refresh attempt once prior/current readings are known.
pub fn refresh_outcome(capability: &str, prior: &Value, current: &Value) -> &'static str {
    if capability == "unavailable" {
        return "unsupported";
    }
    let has_error = current
        .get("error")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.is_empty());
    if has_error && capability != "passive-log" {
        return "failed";
    }
    let stale = current
        .get("stale")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let captured = optional_number(&current["capturedAt"]);
    let prior_captured = optional_number(&prior["capturedAt"]).unwrap_or(f64::NEG_INFINITY);
    if !stale && captured.is_some() && captured.unwrap_or(f64::NEG_INFINITY) > prior_captured {
        "updated"
    } else {
        "unchanged"
    }
}

/// Automatic service timer throttle (15 minutes per account key).
pub fn automatic_refresh_suppressed(
    now: f64,
    last_automatic_at: Option<f64>,
    automatic: bool,
) -> bool {
    automatic && now - last_automatic_at.unwrap_or(f64::NEG_INFINITY) < AUTOMATIC_INTERVAL_S
}
