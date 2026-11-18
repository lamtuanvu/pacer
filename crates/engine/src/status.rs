//! Status composition bridge for P5b.
//!
//! Callers supply usage readings / provider rows / pause / hold / installed flags.
//! This module never probes usage plugins, login PATH, endpoints, evidence stores
//! or activity logs. Native ops compose through the usage-broker injection seam;
//! selective `routing.route` params still forward for classifier / remote eligibility.
use serde_json::{Map, Value, json};

use crate::{planner_mode, rank_executors};

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}
fn truth(value: &Value) -> bool {
    value.as_bool().unwrap_or(false)
}
fn optional_number(value: &Value) -> Option<f64> {
    value.as_f64()
}
fn string(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

/// Pure `limits.check` rows from an already-composed status document.
///
/// Matches `src/core/limits.ts` `check` once `computeStatus` has produced
/// `accounts` + `providers`.
pub fn limits_rows_from_status(status: &Value, now: f64) -> Value {
    let accounts = status["accounts"].as_array().map_or(&[][..], Vec::as_slice);
    let providers = status["providers"]
        .as_array()
        .map_or(&[][..], Vec::as_slice);
    let rows: Vec<Value> = accounts
        .iter()
        .map(|account| {
            let name = string(&account["name"]);
            let kind = string(&account["kind"]);
            let captured = optional_number(&account["capturedAt"]);
            let error = providers
                .iter()
                .find(|p| {
                    string(&p["account"]) == name
                        && p.get("error").is_some_and(|error| !error.is_null())
                })
                .and_then(|p| p.get("error").cloned())
                .unwrap_or(Value::Null);
            let no_data = captured.is_none() && matches!(kind, "claude" | "codex");
            let hint = if no_data && kind == "claude" {
                json!("start a Claude Code session with pacer's status line, or rely on limit errors")
            } else if no_data && kind == "codex" {
                json!("run codex once with this account so it writes session logs")
            } else if truth(&account["stale"]) {
                json!("numbers are older than the freshness limit; they no longer decide routing")
            } else {
                Value::Null
            };
            let source = if no_data {
                Value::Null
            } else if let Some(host) = account.get("remoteHost").and_then(Value::as_str) {
                json!(format!("{} (via {host})", string(&account["source"])))
            } else {
                account.get("source").cloned().unwrap_or(Value::Null)
            };
            json!({
                "account": name,
                "kind": kind,
                "source": source,
                "capturedAt": account.get("capturedAt").cloned().unwrap_or(Value::Null),
                "ageS": captured.map(|at| (now - at).max(0.0).round()).map_or(Value::Null, |v| json!(v)),
                "stale": account.get("stale").cloned().unwrap_or(json!(false)),
                "verdict": account.get("verdict").cloned().unwrap_or(json!("UNKNOWN")),
                "usedPct": account.get("usedPct").cloned().unwrap_or(Value::Null),
                "window": account.get("window").cloned().unwrap_or(Value::Null),
                "resetsAt": account.get("resetsAt").cloned().unwrap_or(Value::Null),
                "runners": account.get("runners").cloned().unwrap_or(json!([])),
                "error": error,
                "hint": hint,
            })
        })
        .collect();
    Value::Array(rows)
}

/// Default `mode.hold` `until` from the planner account reset window.
///
/// Falls back to `now + 7d` when the planner has no `resetsAt`, matching
/// `src/core/mode-hold.ts`.
pub fn default_mode_hold_until(status: &Value, planner_account: &str, now: f64) -> f64 {
    status["accounts"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| string(&a["name"]) == planner_account)
        .and_then(|a| optional_number(&a["resetsAt"]))
        .unwrap_or(now + 7.0 * 86400.0)
}

/// The `planner` runner id `computeStatus` reports (`src/engine/status.ts`):
/// the planner's agent, plus `#account` unless it is that agent's only default
/// account. OpenCode never has a default account.
pub fn planner_runner_id(strategy: &Value) -> String {
    let agent = string(&strategy["planner"]["agent"]);
    let account = string(&strategy["planner"]["account"]);
    if agent == "opencode" && strategy["accounts"][account].is_null() {
        return "opencode".into();
    }
    let kind = match agent {
        "claude-code" => "claude",
        "codex" => "codex",
        "cursor" => "cursor",
        "agy" => "agy",
        _ => "",
    };
    let defaults: Vec<&str> = strategy["accounts"]
        .as_object()
        .into_iter()
        .flat_map(|accounts| accounts.values())
        .filter(|a| {
            !kind.is_empty()
                && a["kind"] == kind
                && !js_truthy(&a["home"])
                && !js_truthy(&a["orcaAccount"])
        })
        .map(|a| string(&a["name"]))
        .collect();
    let default = (defaults.len() == 1).then(|| defaults[0]);
    if account.is_empty() || Some(account) == default {
        agent.to_string()
    } else {
        format!("{agent}#{account}")
    }
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn providers_by_id(providers: &Value) -> Map<String, Value> {
    let mut map = Map::new();
    match providers {
        Value::Object(object) => {
            for (id, status) in object {
                map.insert(id.clone(), status.clone());
            }
        }
        Value::Array(list) => {
            for status in list {
                let id = string(&status["id"]);
                if !id.is_empty() {
                    map.insert(id.to_string(), status.clone());
                }
            }
        }
        _ => {}
    }
    map
}

/// Compose a Status-shaped document from injected parts.
///
/// Required keys: `now`, `strategy` (validated strategy JSON), `providers`
/// (array or id→status map of ProviderStatus rows). Optional: `accounts`,
/// `paused`, `modeHold`, `disabled`, `calendarPace`, `warnings`, `policy`,
/// `planner` (display id; defaults to [`planner_runner_id`]).
///
/// Ranking uses [`rank_executors`]. Mode prefers an active hold, else the
/// planner account provider verdict via [`planner_mode`].
pub fn compose_status(input: &Value) -> Value {
    let now = number(&input["now"]);
    let strategy = &input["strategy"];
    let by_id = providers_by_id(&input["providers"]);
    let providers: Vec<Value> = by_id.values().cloned().collect();
    let ranking = rank_executors(&json!({
        "strategy": strategy,
        "statuses": Value::Object(by_id.clone()),
        "selection": Value::Null,
        "kind": Value::Null,
        "includePlanner": false,
    }));
    let mode_hold = input.get("modeHold").cloned().unwrap_or(Value::Null);
    let planner_account = string(&strategy["planner"]["account"]);
    let planner_verdict = by_id
        .values()
        .find(|p| string(&p["account"]) == planner_account)
        .map(|p| string(&p["verdict"]))
        .unwrap_or("UNKNOWN");
    let mode = mode_hold
        .get("mode")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| planner_mode(planner_verdict).to_string());
    let planner = input
        .get("planner")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| planner_runner_id(strategy));
    // TypeScript `computeStatus` key order; `policy` and `warnings` only when supplied.
    let mut status = json!({});
    if let Some(policy) = input.get("policy") {
        status["policy"] = policy.clone();
    }
    status["paused"] = input.get("paused").cloned().unwrap_or(Value::Null);
    status["modeHold"] = mode_hold;
    status["generatedAt"] = json!(now);
    status["strategy"] = strategy.get("name").cloned().unwrap_or(json!("default"));
    status["planner"] = json!(planner);
    status["mode"] = json!(mode);
    status["disabled"] = json!(truth(field(input, "disabled")));
    status["calendarPace"] = input.get("calendarPace").cloned().unwrap_or(json!(true));
    if let Some(warnings) = input.get("warnings") {
        status["warnings"] = warnings.clone();
    }
    status["accounts"] = input.get("accounts").cloned().unwrap_or(json!([]));
    status["providers"] = json!(providers);
    status["executors"] = json!({
        "ranked": ranking.get("ranked").cloned().unwrap_or(json!([])),
        "excluded": ranking.get("excluded").cloned().unwrap_or(json!([])),
        "uncertain": ranking.get("uncertain").cloned().unwrap_or(json!([])),
    });
    if let Some(reason) = ranking.get("reason") {
        status["executors"]["reason"] = reason.clone();
    }
    status
}

/// Rank executors for `routing.route` once providers are already composed.
///
/// Optional `selection` / `kind` / `includePlanner` mirror the TypeScript
/// `rankExecutors` call site. Does not run the classifier or remote eligibility.
/// The reply has `route`'s key order: `policy` (when given), `kind`, `ranked`,
/// `uncertain`, `excluded`, then `reason` when nothing is configured.
pub fn rank_route(input: &Value) -> Value {
    let by_id = providers_by_id(&input["providers"]);
    let ranking = rank_executors(&json!({
        "strategy": input["strategy"],
        "statuses": Value::Object(by_id),
        "selection": input.get("selection").cloned().unwrap_or(Value::Null),
        "kind": input.get("kind").cloned().unwrap_or(Value::Null),
        "includePlanner": truth(field(input, "includePlanner")),
    }));
    let mut result = json!({});
    if let Some(policy) = input.get("policy") {
        result["policy"] = policy.clone();
    }
    result["kind"] = input.get("kind").cloned().unwrap_or(Value::Null);
    result["ranked"] = ranking.get("ranked").cloned().unwrap_or(json!([]));
    result["uncertain"] = ranking.get("uncertain").cloned().unwrap_or(json!([]));
    result["excluded"] = ranking.get("excluded").cloned().unwrap_or(json!([]));
    if let Some(reason) = ranking.get("reason") {
        result["reason"] = reason.clone();
    }
    result
}

#[cfg(test)]
pub(crate) mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    pub(crate) fn strategy() -> Value {
        json!({
            "name": "default",
            "planner": {"agent": "claude-code", "account": "claude"},
            "accounts": {
                "claude": {"kind": "claude"},
                "codex": {"kind": "codex"},
            },
            "runners": {
                "claude-code": {"agent": "claude-code", "account": "claude", "enabled": true},
                "codex": {"agent": "codex", "account": "codex", "enabled": true},
            },
            "runnerAliases": {},
            "routing": [{"kinds": null, "executors": ["codex", "claude-code"]}],
            "pacing": {"policy": "priority", "order": ["codex", "claude-code"], "accounts": "spread", "fillThreshold": 80},
        })
    }

    pub(crate) fn provider(id: &str, account: &str, verdict: &str) -> Value {
        json!({
            "id": id,
            "account": account,
            "usage": "quota",
            "windows": [],
            "binding": null,
            "verdict": verdict,
            "installed": true,
            "stale": false,
            "eligibility": {
                "state": "eligible",
                "reasons": [],
                "evaluatedAt": 100,
                "validUntil": null,
                "evidenceAgeS": null,
                "availability": "ready",
                "budget": "permitted",
                "spendingRisk": "unknown",
            },
        })
    }

    #[test]
    fn compose_ranks_and_derives_mode_from_planner_verdict() {
        let status = compose_status(&json!({
            "now": 100.0,
            "strategy": strategy(),
            "providers": [
                provider("codex", "codex", "ON_PACE"),
                provider("claude-code", "claude", "AHEAD"),
            ],
            "accounts": [{"name": "claude", "kind": "claude", "verdict": "AHEAD", "resetsAt": 200.0, "runners": ["claude-code"], "stale": false, "capturedAt": 90.0, "usedPct": 50.0, "window": "5h", "source": "native"}],
        }));
        assert_eq!(status["mode"], "strict");
        assert_eq!(status["generatedAt"], 100.0);
        assert!(!status["executors"]["ranked"].as_array().unwrap().is_empty());
    }

    fn keys(value: &Value) -> Vec<&str> {
        value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect()
    }

    #[test]
    fn compose_keeps_typescript_status_key_order() {
        let mut down = provider("codex", "codex", "ON_PACE");
        down["installed"] = json!(false);
        let status = compose_status(&json!({
            "now": 100.0,
            "strategy": strategy(),
            "policy": {"mode": "open", "plugins": 0},
            "warnings": ["w"],
            "providers": [down, provider("claude-code", "claude", "ON_PACE")],
        }));
        assert_eq!(
            keys(&status),
            [
                "policy",
                "paused",
                "modeHold",
                "generatedAt",
                "strategy",
                "planner",
                "mode",
                "disabled",
                "calendarPace",
                "warnings",
                "accounts",
                "providers",
                "executors"
            ]
        );
        assert_eq!(
            keys(&status["executors"]),
            ["ranked", "excluded", "uncertain"]
        );
        assert_eq!(
            keys(&status["executors"]["excluded"][0]),
            ["id", "account", "reason", "eligibility"]
        );
    }

    #[test]
    fn compose_spells_the_planner_account_as_compute_status_does() {
        let mut strategy = strategy();
        strategy["accounts"] = json!({
            "claude": {"name": "claude", "kind": "claude"},
            "work": {"name": "work", "kind": "claude"},
        });
        let status = compose_status(&json!({"now": 100.0, "strategy": strategy, "providers": []}));
        assert_eq!(status["planner"], "claude-code#claude");
    }

    #[test]
    fn mode_hold_overrides_planner_verdict() {
        let status = compose_status(&json!({
            "now": 100.0,
            "strategy": strategy(),
            "modeHold": {"mode": "emergency", "until": 160.0},
            "providers": [provider("claude-code", "claude", "ON_PACE")],
        }));
        assert_eq!(status["mode"], "emergency");
    }

    #[test]
    fn limits_rows_match_typescript_hints() {
        let status = json!({
            "accounts": [
                {"name": "claude", "kind": "claude", "verdict": "UNKNOWN", "capturedAt": null, "stale": false, "usedPct": null, "window": null, "resetsAt": null, "runners": ["claude-code"], "source": "native"},
                {"name": "codex", "kind": "codex", "verdict": "ON_PACE", "capturedAt": 50.0, "stale": true, "usedPct": 10.0, "window": "5h", "resetsAt": 200.0, "runners": ["codex"], "source": "native", "remoteHost": "box"},
            ],
            "providers": [
                {"account": "claude", "error": "boom"},
                {"account": "codex"},
            ],
        });
        let rows = limits_rows_from_status(&status, 100.0);
        assert_eq!(
            rows[0]["hint"],
            "start a Claude Code session with pacer's status line, or rely on limit errors"
        );
        assert_eq!(rows[0]["error"], "boom");
        assert_eq!(rows[0]["source"], Value::Null);
        assert_eq!(rows[1]["source"], "native (via box)");
        assert_eq!(rows[1]["ageS"], 50.0);
        assert_eq!(
            rows[1]["hint"],
            "numbers are older than the freshness limit; they no longer decide routing"
        );
    }

    #[test]
    fn default_hold_until_uses_planner_reset_or_week() {
        let with_reset = json!({"accounts": [{"name": "claude", "resetsAt": 250.0}]});
        assert_eq!(default_mode_hold_until(&with_reset, "claude", 100.0), 250.0);
        assert_eq!(
            default_mode_hold_until(&json!({"accounts": []}), "claude", 100.0),
            100.0 + 7.0 * 86400.0
        );
    }

    #[test]
    fn rank_route_returns_kind_and_lists() {
        let result = rank_route(&json!({
            "strategy": strategy(),
            "kind": "docs",
            "providers": [provider("codex", "codex", "ON_PACE")],
        }));
        assert_eq!(result["kind"], "docs");
        assert!(result.get("ranked").is_some());
        assert!(result.get("excluded").is_some());
    }
}
