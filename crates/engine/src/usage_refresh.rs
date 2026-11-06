//! P5b usage-refresh library seam. Live plugin reads and the in-process refresh
//! coordinator stay in TypeScript (`src/usage/refresh.ts`); this module mirrors the
//! pure capability and outcome rules for cross-runtime parity.

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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use serde_json::json;

    #[test]
    fn capability_matches_adapter_matrix() {
        assert_eq!(
            refresh_capability(&json!({"kind":"claude","usage":"quota"})),
            "passive-log"
        );
        assert_eq!(
            refresh_capability(&json!({"kind":"codex","usage":"quota"})),
            "provider-command"
        );
        assert_eq!(
            refresh_capability(
                &json!({"kind":"endpoint","name":"plan","usage":"quota","quotaSource":"arkcli"})
            ),
            "provider-command"
        );
        assert_eq!(
            refresh_capability(&json!({"kind":"cursor","usage":"reactive"})),
            "unavailable"
        );
    }

    #[test]
    fn outcome_updated_when_captured_at_advances() {
        let prior = json!({"capturedAt": 100.0, "stale": false});
        let current = json!({"capturedAt": 200.0, "stale": false});
        assert_eq!(
            refresh_outcome("provider-command", &prior, &current),
            "updated"
        );
    }

    #[test]
    fn passive_log_error_stays_unchanged() {
        let prior = json!({"capturedAt": null, "stale": false});
        let current = json!({"capturedAt": null, "stale": false, "error": "boom"});
        assert_eq!(
            refresh_outcome("passive-log", &prior, &current),
            "unchanged"
        );
    }
}
