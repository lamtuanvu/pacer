//! P5c usage-broker injection seam. Live plugin reads and evidence reconciliation
//! stay in TypeScript `computeStatus`; the host supplies `accounts` and `providers`
//! rows for [`status::compose_status`] / [`status::limits_rows_from_status`].
use pacer_foundation::Ctx;
use serde_json::{Value, json};

use crate::{mode_hold, pause, status};

fn disabled(ctx: &Ctx) -> bool {
    ctx.env
        .get("PACER")
        .is_some_and(|value| value.eq_ignore_ascii_case("off"))
}

/// Merge host-owned pause/hold/disabled with broker-injected budget rows and the
/// plugin policy summary, activity pace profile and warnings Core computed with them.
pub fn assemble_compose_input(ctx: &Ctx, strategy: &Value, parts: &Value) -> Value {
    let mut input = json!({
        "now": ctx.now,
        "strategy": strategy,
        "accounts": parts.get("accounts").cloned().unwrap_or(json!([])),
        "providers": parts.get("providers").cloned().unwrap_or(json!([])),
        "paused": pause::read_pause(ctx).map_or(Value::Null, |v| json!(v)),
        "modeHold": mode_hold::read_hold(ctx).map_or(Value::Null, |v| json!(v)),
        "disabled": disabled(ctx),
    });
    for key in ["policy", "calendarPace", "warnings"] {
        if let Some(value) = parts.get(key) {
            input[key] = value.clone();
        }
    }
    input
}

/// Pure `limits.check` once broker parts match a `computeStatus` snapshot.
pub fn limits_check(ctx: &Ctx, strategy: &Value, parts: &Value) -> Value {
    let status = status::compose_status(&assemble_compose_input(ctx, strategy, parts));
    status::limits_rows_from_status(&status, ctx.now)
}

/// `routing.status` envelope from the same injection contract (no classifier / remote pass).
pub fn routing_status(ctx: &Ctx, strategy: &Value, parts: &Value) -> Value {
    status::compose_status(&assemble_compose_input(ctx, strategy, parts))
}

/// Pure `routing.route` rank once broker parts match a `computeStatus` snapshot.
///
/// Does not run the classifier (`goal`) or remote eligibility (`repo`).
pub fn routing_route(_ctx: &Ctx, strategy: &Value, parts: &Value, params: &Value) -> Value {
    let kind = params.get("kind").cloned().unwrap_or(Value::Null);
    status::rank_route(&json!({
        "strategy": strategy,
        "providers": parts.get("providers").cloned().unwrap_or(json!([])),
        "kind": kind,
        "selection": Value::Null,
        "includePlanner": false,
    }))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use pacer_foundation::Ctx;
    use std::collections::HashMap;
    use tempfile::tempdir;

    fn ctx(now: f64) -> (tempfile::TempDir, Ctx) {
        let dir = tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let pacer_home = home.join(".pacer");
        std::fs::create_dir_all(pacer_home.join("state")).unwrap();
        let ctx = Ctx::with(home, pacer_home, HashMap::new(), now);
        (dir, ctx)
    }

    #[test]
    fn limits_check_projects_injected_accounts() {
        let (_dir, ctx) = ctx(100.0);
        let strategy = json!({
            "name": "default",
            "planner": {"agent": "claude-code", "account": "claude"},
            "accounts": {"claude": {"kind": "claude"}},
            "runners": {"claude-code": {"agent": "claude-code", "account": "claude", "enabled": true}},
            "runnerAliases": {},
            "routing": [{"kinds": null, "executors": ["claude-code"]}],
            "pacing": {"policy": "priority", "order": ["claude-code"], "accounts": "spread", "fillThreshold": 80},
        });
        let parts = json!({
            "accounts": [{"name": "claude", "kind": "claude", "verdict": "UNKNOWN", "capturedAt": null, "stale": false, "usedPct": null, "window": null, "resetsAt": null, "runners": ["claude-code"], "source": "native"}],
            "providers": [{
                "id": "claude-code",
                "account": "claude",
                "usage": "quota",
                "windows": [],
                "binding": null,
                "verdict": "AHEAD",
                "installed": true,
                "stale": false,
                "error": "boom",
                "eligibility": {"state": "eligible", "reasons": [], "evaluatedAt": 100, "validUntil": null, "evidenceAgeS": null, "availability": "ready", "budget": "permitted", "spendingRisk": "unknown"},
            }],
        });
        let rows = limits_check(&ctx, &strategy, &parts);
        assert_eq!(rows[0]["account"], "claude");
        assert_eq!(rows[0]["error"], "boom");
    }
}
