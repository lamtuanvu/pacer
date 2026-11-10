// Frozen pre-projection native cost algorithm (bec24457); semantic oracle.
use serde_json::{Value, json};
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

fn array(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

fn overlaps(account: Option<&str>, a0: f64, a1: f64, b0: f64, b1: f64) -> bool {
    account.is_some_and(|acct| !acct.is_empty()) && a0 < b1 && b0 < a1
}

/// Match `src/core/task-detail.ts` `costFor` using only stored task records.
pub fn executor_cost(task: &Value, peers: &[Value], now: f64) -> Value {
    let attempts = array(&task["attempts"]);
    let last = attempts.last().unwrap_or(&Value::Null);
    let pending = task.get("pendingAttempt").filter(|v| !v.is_null());
    let attempt = if pending.is_some() { None } else { Some(last) };
    let start = pending
        .and_then(|p| p.get("usageAtStart"))
        .or_else(|| attempt.and_then(|a| a.get("usageAtStart")));
    let Some(start) = start.filter(|s| s.is_object()) else {
        return json!({"executor": Value::Null, "planner": Value::Null});
    };
    let end = attempt.and_then(|a| a.get("usageAtEnd"));
    let from = attempt
        .and_then(|a| a.get("startedAt").and_then(Value::as_f64))
        .or_else(|| task["run"]["startedAt"].as_f64())
        .or_else(|| task["attemptStartedAt"].as_f64())
        .or_else(|| start["at"].as_f64())
        .unwrap_or(now);
    let until = attempt
        .and_then(|a| a.get("endedAt").and_then(Value::as_f64))
        .unwrap_or(now);
    let shared = peers.iter().any(|other| {
        if other["id"] == task["id"] {
            return false;
        }
        if array(&other["attempts"]).iter().any(|a| {
            overlaps(
                a["usageAtStart"]["account"]
                    .as_str()
                    .or(a["usageAtEnd"]["account"].as_str()),
                num(&a["startedAt"]),
                num(&a["endedAt"]),
                from,
                until,
            ) || overlaps(
                a["usageAtEnd"]["account"].as_str(),
                num(&a["startedAt"]),
                num(&a["endedAt"]),
                from,
                until,
            )
        }) {
            return true;
        }
        text(&other["state"]) == "running"
            && overlaps(
                other["pendingAttempt"]["usageAtStart"]["account"].as_str(),
                other["run"]["startedAt"]
                    .as_f64()
                    .or(other["attemptStartedAt"].as_f64())
                    .or(other["createdAt"].as_f64())
                    .unwrap_or(now),
                now,
                from,
                until,
            )
    });
    let comparable = end.filter(|e| e.is_object()).is_some_and(|e| {
        start["account"] == e["account"]
            && start["window"] == e["window"]
            && start["usedPct"].as_f64().is_some()
            && e["usedPct"].as_f64().is_some_and(|end_pct| {
                start["usedPct"]
                    .as_f64()
                    .is_some_and(|start_pct| end_pct >= start_pct)
            })
    });
    let reason = if shared {
        Some("shared")
    } else if comparable {
        None
    } else {
        Some("no_reading")
    };
    let delta = if reason.is_some() {
        Value::Null
    } else if let Some(end) = end {
        let end_pct = end["usedPct"].as_f64().unwrap_or(0.0);
        let start_pct = start["usedPct"].as_f64().unwrap_or(0.0);
        json!(((end_pct - start_pct) * 10.0).round() / 10.0)
    } else {
        Value::Null
    };
    let mut executor = json!({
        "account": start["account"].clone(),
        "window": start["window"].clone(),
        "deltaPct": delta,
    });
    if let Some(r) = reason {
        executor["reason"] = json!(r);
    }
    json!({"executor": executor, "planner": Value::Null})
}
