//! Pure engine calculations. Inputs and outputs use the TypeScript JSON shapes until
//! the M2 operation boundary is ready to introduce protocol types.
use chrono::{Datelike, TimeZone, Timelike};
use chrono_tz::Tz;
use serde_json::{Value, json};

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}
fn optional_number(value: &Value) -> Option<f64> {
    value.as_f64()
}
fn string(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}
fn truth(value: &Value) -> bool {
    value.as_bool().unwrap_or(false)
}
fn field(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

fn hour_bin(ts: f64, zone: Tz) -> usize {
    let Some(local) = zone.timestamp_opt(ts.floor() as i64, 0).single() else {
        return 0;
    };
    (local.weekday().num_days_from_sunday() * 24 + local.hour()) as usize
}
fn active_seconds(start: f64, end: f64, profile: &Value, zone: Tz) -> f64 {
    if end <= start {
        return 0.0;
    }
    let active = array(&profile["active"]);
    if number(&profile["days"]) < 7.0 || !active.iter().any(truth) {
        return end - start;
    }
    let mut total = 0.0;
    let mut t = start;
    while t < end {
        let next = ((t / 3600.0).floor() + 1.0) * 3600.0;
        let segment_end = end.min(next);
        if truth(&active[hour_bin(t, zone)]) {
            total += segment_end - t;
        }
        t = segment_end;
    }
    total
}
pub fn pace_pct(start: f64, end: f64, now: f64, profile: &Value, zone: Tz) -> f64 {
    let total = active_seconds(start, end, profile, zone);
    if total <= 0.0 {
        0.0
    } else {
        100.0 * active_seconds(start, now.min(end), profile, zone) / total
    }
}
pub fn active_hours_left(now: f64, end: f64, profile: &Value, zone: Tz) -> f64 {
    active_seconds(now, end, profile, zone) / 3600.0
}
pub fn evaluate_window(input: &Value, zone: Tz) -> Value {
    let now = number(&input["now"]);
    let usage = &input["usage"];
    let mut output = usage.clone();
    output["verdict"] = json!("UNKNOWN");
    if optional_number(&usage["resetsAt"]).is_some_and(|reset| reset <= now) {
        output["stale"] = json!(true);
        output["rolled"] = json!(true);
        return output;
    }
    if truth(&usage["stale"]) || usage["usedPct"].is_null() {
        return output;
    }
    let used = number(&usage["usedPct"]);
    if used >= 97.0 {
        output["verdict"] = json!("EXHAUSTED");
        return output;
    }
    if !truth(&usage["paced"]) || usage["resetsAt"].is_null() {
        output["verdict"] = json!(if used >= 90.0 { "NEAR_LIMIT" } else { "OK" });
        return output;
    }
    let reset = number(&usage["resetsAt"]);
    let profile = &input["profile"];
    let pace = pace_pct(reset - number(&usage["lengthS"]), reset, now, profile, zone)
        * number(&input["thresholds"]["paceScale"]);
    let hours = active_hours_left(now, reset, profile, zone);
    let delta = used - pace;
    let verdict = if hours <= 9.0 && 100.0 - used >= 25.0 {
        "EXPIRING"
    } else if delta > number(&input["thresholds"]["ahead"]) {
        "AHEAD"
    } else if delta < number(&input["thresholds"]["behind"]) {
        "BEHIND"
    } else {
        "ON_PACE"
    };
    output["verdict"] = json!(verdict);
    output["pace"] = json!(pace);
    output["delta"] = json!(delta);
    output["activeHoursLeft"] = json!(hours);
    output
}
fn verdict_rank(verdict: &str) -> i32 {
    match verdict {
        "EXHAUSTED" => 0,
        "NEAR_LIMIT" => 1,
        "AHEAD" => 2,
        "ON_PACE" => 4,
        "BEHIND" => 5,
        "EXPIRING" => 6,
        _ => 3,
    }
}
pub fn binding_window(windows: &[Value]) -> Value {
    let known: Vec<&Value> = windows
        .iter()
        .filter(|w| string(&w["verdict"]) != "UNKNOWN")
        .collect();
    if known.is_empty() {
        return windows.first().cloned().unwrap_or(Value::Null);
    }
    let hard: Vec<&Value> = known
        .iter()
        .copied()
        .filter(|w| matches!(string(&w["verdict"]), "EXHAUSTED" | "NEAR_LIMIT" | "AHEAD"))
        .collect();
    if !hard.is_empty() {
        return hard
            .into_iter()
            .min_by_key(|w| verdict_rank(string(&w["verdict"])))
            .cloned()
            .unwrap_or(Value::Null);
    }
    let paced: Vec<&Value> = known
        .iter()
        .copied()
        .filter(|w| w.get("pace").is_some())
        .collect();
    if !paced.is_empty() {
        return paced
            .into_iter()
            .max_by_key(|w| verdict_rank(string(&w["verdict"])))
            .cloned()
            .unwrap_or(Value::Null);
    }
    known[0].clone()
}
fn applies_to(fact: &Value, scope: &Value) -> bool {
    if fact["scope"]["account"] != scope["account"]
        || fact["scope"]["identity"] != scope["identity"]
    {
        return false;
    }
    ["runner", "model", "host"]
        .iter()
        .all(|key| fact["scope"][key].is_null() || fact["scope"][key] == scope[*key])
}
fn current(fact: &Value, now: f64, deadline: Option<f64>) -> bool {
    optional_number(&fact["observedAt"])
        .is_some_and(|time| time.is_finite() && time >= 0.0 && time <= now)
        && deadline.is_none_or(|time| time > now)
}
fn deadline(fact: &Value) -> Option<f64> {
    let observed = optional_number(&fact["observedAt"])?;
    if string(&fact["source"]) == "configuration" {
        return optional_number(&fact["validUntil"])
            .or_else(|| optional_number(&fact["value"]["resetsAt"]));
    }
    let age = if number(&fact["value"]["lengthS"]) <= 21600.0 {
        7200.0
    } else {
        86400.0
    };
    Some(
        [
            Some(observed + age),
            optional_number(&fact["validUntil"]),
            optional_number(&fact["value"]["resetsAt"]),
        ]
        .into_iter()
        .flatten()
        .fold(f64::INFINITY, f64::min),
    )
}
pub fn evaluate_eligibility(input: &Value) -> Value {
    let now = number(&input["now"]);
    let scope = &input["scope"];
    let facts = &input["evidence"]["facts"];
    let availability: Vec<&Value> = array(&facts["availability"])
        .iter()
        .filter(|f| applies_to(f, scope))
        .collect();
    let budget: Vec<&Value> = array(&facts["budget"])
        .iter()
        .filter(|f| applies_to(f, scope))
        .collect();
    let spending: Vec<&Value> = array(&facts["spending"])
        .iter()
        .filter(|f| applies_to(f, scope))
        .collect();
    let live_availability: Vec<&Value> = availability
        .iter()
        .copied()
        .filter(|f| current(f, now, optional_number(&f["validUntil"])))
        .collect();
    let live_budget: Vec<&Value> = budget
        .iter()
        .copied()
        .filter(|f| current(f, now, deadline(f)) && !truth(&f["value"]["stale"]))
        .collect();
    let live_spending: Vec<&Value> = spending
        .iter()
        .copied()
        .filter(|f| current(f, now, optional_number(&f["validUntil"])))
        .collect();
    let all: Vec<&Value> = availability
        .iter()
        .chain(&budget)
        .chain(&spending)
        .copied()
        .collect();
    let unavailable: Vec<&Value> = live_availability
        .iter()
        .copied()
        .filter(|f| string(&f["value"]) == "unavailable")
        .collect();
    let exhausted: Vec<&Value> = live_budget
        .iter()
        .copied()
        .filter(|f| optional_number(&f["value"]["usedPct"]).is_some_and(|v| v >= 97.0))
        .collect();
    let no_budget = input["budgetRequired"] == false
        || matches!(string(&input["usage"]), "reactive" | "unmetered");
    let unknown_budget = !no_budget
        && (budget.is_empty()
            || live_budget.len() != budget.len()
            || live_budget.iter().any(|f| f["value"]["usedPct"].is_null()));
    let valid_until = availability
        .iter()
        .filter_map(|f| optional_number(&f["validUntil"]))
        .chain(budget.iter().filter_map(|f| deadline(f)))
        .filter(|v| *v > now)
        .reduce(f64::min);
    let evidence_age = all
        .iter()
        .filter(|f| string(&f["source"]) != "configuration")
        .filter_map(|f| optional_number(&f["observedAt"]))
        .filter(|v| *v <= now)
        .reduce(f64::min)
        .map(|v| (now - v).max(0.0));
    let availability_state = if !unavailable.is_empty() {
        "unavailable"
    } else if live_availability
        .iter()
        .any(|f| string(&f["value"]) == "ready")
    {
        "ready"
    } else {
        "unknown"
    };
    let budget_state = if !exhausted.is_empty() {
        "exhausted"
    } else if unknown_budget {
        "unknown"
    } else if no_budget {
        "not_required"
    } else {
        "permitted"
    };
    let risk = if live_spending
        .iter()
        .any(|f| string(&f["value"]["paidConsumption"]) == "observed")
    {
        "observed"
    } else if !live_spending.is_empty()
        && live_spending
            .iter()
            .all(|f| string(&f["value"]["paidConsumption"]) == "not_observed")
    {
        "not_observed"
    } else {
        "unknown"
    };
    let mut reasons = array(&input["restrictions"]).to_vec();
    for fact in unavailable {
        reasons.push(json!({"code": field(fact, "reason"), "evidenceIds": [field(fact, "id")]}));
    }
    if !exhausted.is_empty() && !truth(&input["allowPaid"]) {
        reasons.push(json!({"code": "budget_exhausted", "evidenceIds": exhausted.iter().map(|f| field(f, "id")).collect::<Vec<_>>()}));
    }
    let state = if !reasons.is_empty() {
        "ineligible"
    } else {
        let conflicts: Vec<Value> = all
            .iter()
            .filter(|f| array(&input["evidence"]["conflicts"]).contains(&f["id"]))
            .map(|f| field(f, "id"))
            .collect();
        if !conflicts.is_empty() {
            reasons.push(json!({"code": "evidence_conflicting", "evidenceIds": conflicts}));
        }
        if availability_state == "unknown" {
            reasons.push(json!({"code": "availability_unknown", "evidenceIds": availability.iter().map(|f| field(f, "id")).collect::<Vec<_>>()}));
        }
        if unknown_budget {
            reasons.push(json!({"code": if budget.is_empty() { "budget_missing" } else { "budget_expired_or_unknown" }, "evidenceIds": budget.iter().map(|f| field(f, "id")).collect::<Vec<_>>()}));
        }
        if reasons.is_empty() {
            "eligible"
        } else {
            "uncertain"
        }
    };
    json!({"state": state, "reasons": reasons, "evaluatedAt": now, "validUntil": valid_until, "evidenceAgeS": evidence_age,
        "availability": availability_state, "budget": budget_state, "spendingRisk": risk})
}
pub fn machine_guard(input: &Value) -> Value {
    let config = &input["config"];
    let signals = &input["signals"];
    let limit = config["localMemoryPressureLimit"]
        .as_str()
        .unwrap_or("critical");
    let pressure = string(&signals["memoryPressure"]);
    let rank = |value: &str| match value {
        "normal" => 0,
        "warning" => 1,
        "critical" => 2,
        _ => -1,
    };
    if limit != "off" && rank(pressure) >= rank(limit) && rank(pressure) >= 0 {
        return json!({"reason": "machine_memory_pressure", "detail": format!("memory pressure {pressure}"), "machine": {"memoryPressure": pressure, "memoryPressureLimit": limit}});
    }
    if let (Some(load), Some(max)) = (
        optional_number(&signals["loadPerCore"]),
        optional_number(&config["localLoadLimit"]),
    ) && load > max
    {
        let format_load = |v: f64| {
            let rounded = (v * 10.0).round() / 10.0;
            if rounded.fract() == 0.0 {
                format!("{rounded:.0}")
            } else {
                rounded.to_string()
            }
        };
        return json!({"reason": "machine_load", "detail": format!("load {}/core over limit {}", format_load(load), format_load(max)), "machine": {"loadPerCore": load, "loadLimit": max}});
    }
    Value::Null
}
fn restriction(mut decision: Value, code: Option<&str>) -> Value {
    if decision.is_null() {
        decision = json!({"state": "uncertain", "reasons": [{"code": "evidence_missing", "evidenceIds": []}], "evaluatedAt": 0,
            "validUntil": null, "evidenceAgeS": null, "availability": "unknown", "budget": "unknown", "spendingRisk": "unknown"});
    }
    if let Some(code) = code {
        decision["state"] = json!("ineligible");
        let mut reasons: Vec<Value> = array(&decision["reasons"])
            .iter()
            .filter(|r| string(&r["code"]) != code)
            .cloned()
            .collect();
        reasons.push(json!({"code": code, "evidenceIds": []}));
        decision["reasons"] = json!(reasons);
    }
    decision
}
fn eligibility_detail(decision: &Value) -> String {
    array(&decision["reasons"])
        .iter()
        .map(|reason| match string(&reason["code"]) {
            "budget_exhausted" => "Budget exhausted; paid execution is not allowed",
            "budget_missing" => "No budget observation is available",
            "budget_expired_or_unknown" => "Budget evidence has expired or is incomplete",
            "evidence_conflicting" => "Current observations disagree",
            "evidence_missing" => "Execution evidence is missing",
            "availability_unknown" => "Executor availability is not confirmed",
            "subscription_missing" => "No active subscription",
            "subscription_failed" => "Subscription is unavailable",
            "subscription_response_invalid" => "Subscription status could not be read",
            "authentication_failed" => "Sign-in is required",
            "refresh_failed" => "Could not refresh execution evidence",
            "disabled" => "Disabled",
            "not_installed" => "Not installed",
            "signed_out" => "Sign-in is required",
            "blocked" => "Blocked by you",
            "broken" => "Executor is not working",
            "unavailable" => "Executor is unavailable",
            "planner" => "Reserved for planning",
            "not_configured" => "Not configured",
            "quota_failure" => "The executor reported a quota limit",
            "machine_load" | "machine_memory_pressure" => "Execution evidence needs attention",
            _ => "Execution evidence needs attention",
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Map a provider verdict to the planner's operating mode.
pub fn planner_mode(verdict: &str) -> &'static str {
    match verdict {
        "EXHAUSTED" => "emergency",
        "AHEAD" | "NEAR_LIMIT" => "strict",
        "BEHIND" | "EXPIRING" => "relaxed",
        _ => "normal",
    }
}
#[derive(Clone)]
struct Candidate {
    output: Value,
    unknown: bool,
    order: usize,
    id: String,
}
fn candidate_score(status: &Value, policy: &str) -> f64 {
    let binding = &status["binding"];
    let behind = optional_number(&binding["delta"]).map_or(0.0, |v| -v);
    let mut base = match policy {
        "priority" => 0.0,
        "burn-before-reset" => {
            (100.0 - optional_number(&binding["usedPct"]).unwrap_or(100.0))
                / optional_number(&binding["activeHoursLeft"])
                    .unwrap_or(168.0)
                    .max(1.0)
        }
        "cheapest-first" => {
            let tier = match string(&status["usage"]) {
                "unmetered" => 0.0,
                "metered" => 2.0,
                _ => 1.0,
            };
            -tier * 1000.0 + behind
        }
        _ => behind,
    };
    if string(&status["verdict"]) == "EXPIRING" && policy != "cheapest-first" {
        base += 50.0;
    }
    base
}
fn status_reason(status: &Value) -> String {
    let mut reason = string(&status["verdict"])
        .to_lowercase()
        .replacen('_', " ", 1);
    if let Some(used) = optional_number(&status["binding"]["usedPct"]) {
        if let Some(pace) = optional_number(&status["binding"]["pace"]) {
            reason.push_str(&format!(", used {used:.0}% / pace {pace:.0}%"));
        } else {
            reason.push_str(&format!(", used {used:.0}%"));
        }
    }
    reason
}
fn account<'a>(strategy: &'a Value, id: &str) -> &'a Value {
    &strategy["runners"][id]["account"]
}
fn agent<'a>(strategy: &'a Value, id: &str) -> &'a str {
    string(&strategy["runners"][id]["agent"])
}
fn configured(strategy: &Value, id: &str, include_planner: bool) -> bool {
    let runner = &strategy["runners"][id];
    !runner.is_null()
        && (include_planner
            || !(runner["agent"] == strategy["planner"]["agent"]
                && runner["account"] == strategy["planner"]["account"]))
}
fn canonical_id(strategy: &Value, id: &str) -> String {
    if !strategy["runners"][id].is_null() {
        id.to_string()
    } else if let Some(alias) = strategy["runnerAliases"][id].as_str() {
        alias.to_string()
    } else {
        id.to_string()
    }
}
fn default_executors(strategy: &Value, kind: &Value) -> Vec<String> {
    let routing = array(&strategy["routing"]);
    let specific = routing
        .iter()
        .find(|rule| !kind.is_null() && array(&rule["kinds"]).contains(kind));
    let selected = specific.or_else(|| routing.iter().find(|rule| rule["kinds"].is_null()));
    selected.map_or_else(
        || {
            strategy["runners"]
                .as_object()
                .map_or_else(Vec::new, |r| r.keys().cloned().collect())
        },
        |rule| {
            array(&rule["executors"])
                .iter()
                .map(|v| canonical_id(strategy, string(v)))
                .collect()
        },
    )
}
fn group(strategy: &Value, id: &str) -> String {
    format!(
        "{}:{}",
        agent(strategy, id),
        string(&strategy["accounts"][string(account(strategy, id))]["kind"])
    )
}
fn headroom(status: &Value) -> f64 {
    optional_number(&status["binding"]["delta"]).map_or(
        100.0 - optional_number(&status["binding"]["usedPct"]).unwrap_or(100.0),
        |v| -v,
    )
}
fn yielded(status: &Value, threshold: f64) -> bool {
    array(&status["windows"]).iter().any(|w| {
        matches!(string(&w["verdict"]), "BEHIND" | "AHEAD") || number(&w["usedPct"]) >= threshold
    })
}
fn account_preference(strategy: &Value, id: &str, preference: &[String]) -> usize {
    preference
        .iter()
        .position(|name| account(strategy, name) == account(strategy, id))
        .unwrap_or(preference.len())
}
/// Rank statuses using the current TS routing and account ordering rules.
pub fn rank_executors(input: &Value) -> Value {
    let strategy = &input["strategy"];
    let mut normalized = serde_json::Map::new();
    if let Some(source) = input["statuses"].as_object() {
        for (id, status) in source {
            normalized.insert(canonical_id(strategy, id), status.clone());
        }
    }
    let statuses = Value::Object(normalized);
    let statuses = &statuses;
    let selection = &input["selection"];
    let include_planner = truth(&input["includePlanner"]);
    let kind = &input["kind"];
    let configured_ids = default_executors(strategy, kind);
    let ids: Vec<String> = if selection.is_null() {
        configured_ids.clone()
    } else {
        array(&selection["executors"])
            .iter()
            .map(|v| string(v).to_string())
            .collect()
    };
    let policy = string(&strategy["pacing"]["policy"]);
    let mut candidates = Vec::<Candidate>::new();
    let mut excluded = Vec::<Value>::new();
    for (order, id) in ids.iter().enumerate() {
        if ids[..order].contains(id) {
            continue;
        }
        let runner = &strategy["runners"][id];
        let status = &statuses[id];
        let account_id = account(strategy, id);
        let account_field = if runner.is_null() {
            Value::Null
        } else {
            account_id.clone()
        };
        let exclude_reason = if !include_planner && !configured(strategy, id, false) {
            Some("planner".to_string())
        } else if runner["enabled"] == false {
            Some("disabled".to_string())
        } else if status.is_null()
            || runner.is_null()
            || strategy["accounts"][string(account_id)].is_null()
        {
            Some("not configured".to_string())
        } else if !status["unavailableReason"].is_null() {
            Some(string(&status["unavailableReason"]).to_string())
        } else if !status["blockedReason"].is_null() {
            Some("Blocked by you".to_string())
        } else if !status["brokenReason"].is_null() {
            Some(format!("Not working · {}", string(&status["brokenReason"])))
        } else if !truth(&status["installed"]) {
            Some("not installed".to_string())
        } else if !status["signedOutReason"].is_null() {
            Some(string(&status["signedOutReason"]).to_string())
        } else {
            None
        };
        if let Some(reason) = exclude_reason {
            let mut value = json!({"id": id, "reason": reason, "eligibility": restriction(field(status, "eligibility"), Some(if reason == "planner" { "planner" } else { "unavailable" }))});
            if !account_field.is_null() {
                value["account"] = account_field;
            }
            excluded.push(value);
            continue;
        }
        let decision = restriction(field(status, "eligibility"), None);
        if string(&decision["state"]) == "ineligible" {
            let mut value =
                json!({"id": id, "reason": eligibility_detail(&decision), "eligibility": decision});
            if !account_field.is_null() {
                value["account"] = account_field;
            }
            excluded.push(value);
            continue;
        }
        let unknown = string(&decision["state"]) == "uncertain";
        let reason = if unknown {
            format!("Uncertain fallback: {}", eligibility_detail(&decision))
        } else {
            status_reason(status)
        };
        let mut output = json!({"id": id, "eligibility": decision, "score": candidate_score(status, policy), "verdict": status["verdict"], "reason": reason});
        if !account_field.is_null() {
            output["account"] = account_field;
        }
        if unknown {
            output["fallback"] = json!("uncertain");
        }
        candidates.push(Candidate {
            output,
            unknown,
            order,
            id: id.clone(),
        });
    }
    let mut selection_uncertain = Vec::<Value>::new();
    if !selection.is_null() {
        candidates.sort_by_key(|c| (c.unknown, c.order));
        selection_uncertain = candidates
            .iter()
            .filter(|c| c.unknown)
            .map(|c| c.output.clone())
            .collect();
        let len = candidates.len();
        for (index, candidate) in candidates.iter_mut().enumerate() {
            candidate.output["score"] = json!(len - index);
        }
    } else {
        if policy == "priority" {
            let mut sequence = Vec::<Candidate>::new();
            for reference in array(&strategy["pacing"]["order"]) {
                let name = canonical_id(strategy, string(reference));
                for candidate in &candidates {
                    if (name == "opencode" && agent(strategy, &candidate.id) == "opencode"
                        || name == candidate.id)
                        && !sequence.iter().any(|c| c.id == candidate.id)
                    {
                        sequence.push(candidate.clone());
                    }
                }
            }
            for candidate in &candidates {
                if !sequence.iter().any(|c| c.id == candidate.id) {
                    sequence.push(candidate.clone());
                }
            }
            candidates = ["EXPIRING", "MIDDLE", "AHEAD"]
                .into_iter()
                .flat_map(|phase| {
                    sequence
                        .iter()
                        .filter(move |c| {
                            let verdict = string(&c.output["verdict"]);
                            match phase {
                                "EXPIRING" => verdict == "EXPIRING",
                                "AHEAD" => verdict == "AHEAD",
                                _ => verdict != "EXPIRING" && verdict != "AHEAD",
                            }
                        })
                        .cloned()
                })
                .collect();
            for i in (0..candidates.len().saturating_sub(1)).rev() {
                if candidates[i].unknown && !candidates[i + 1].unknown {
                    candidates.swap(i, i + 1);
                }
            }
        } else {
            candidates.sort_by(|a, b| {
                a.unknown
                    .cmp(&b.unknown)
                    .then_with(|| number(&b.output["score"]).total_cmp(&number(&a.output["score"])))
                    .then(a.order.cmp(&b.order))
            });
        }
        let groups: Vec<String> = candidates.iter().map(|c| group(strategy, &c.id)).collect();
        let mut seen = Vec::<String>::new();
        for key in groups {
            if seen.contains(&key) {
                continue;
            }
            seen.push(key.clone());
            let positions: Vec<usize> = candidates
                .iter()
                .enumerate()
                .filter(|(_, c)| {
                    group(strategy, &c.id) == key
                        && string(&strategy["accounts"][string(account(strategy, &c.id))]["kind"])
                            != "endpoint"
                        && !(string(&strategy["pacing"]["accounts"]) == "spread"
                            && statuses[&c.id]["binding"]["usedPct"].is_null())
                })
                .map(|(i, _)| i)
                .collect();
            let accounts: Vec<Value> = positions
                .iter()
                .map(|&i| account(strategy, &candidates[i].id).clone())
                .collect();
            if accounts
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                < 2
            {
                continue;
            }
            let preference: Vec<String> = array(&strategy["pacing"]["order"])
                .iter()
                .flat_map(|v| {
                    if string(v) == "opencode" {
                        configured_ids
                            .iter()
                            .filter(|id| agent(strategy, id) == "opencode")
                            .cloned()
                            .collect::<Vec<_>>()
                    } else {
                        vec![string(v).to_string()]
                    }
                })
                .collect();
            let mut sorted: Vec<Candidate> =
                positions.iter().map(|&i| candidates[i].clone()).collect();
            sorted.sort_by(|a, b| {
                let comparison = if string(&strategy["pacing"]["accounts"]) == "fill" {
                    yielded(
                        &statuses[&a.id],
                        number(&strategy["pacing"]["fillThreshold"]),
                    )
                    .cmp(&yielded(
                        &statuses[&b.id],
                        number(&strategy["pacing"]["fillThreshold"]),
                    ))
                } else {
                    a.unknown.cmp(&b.unknown).then_with(|| {
                        headroom(&statuses[&b.id]).total_cmp(&headroom(&statuses[&a.id]))
                    })
                };
                comparison
                    .then(
                        account_preference(strategy, &a.id, &preference).cmp(&account_preference(
                            strategy,
                            &b.id,
                            &preference,
                        )),
                    )
                    .then(a.order.cmp(&b.order))
            });
            for (i, candidate) in positions.into_iter().zip(sorted) {
                candidates[i] = candidate;
            }
        }
        candidates.sort_by_key(|c| c.unknown);
        if policy == "priority" {
            let len = candidates.len();
            for (i, c) in candidates.iter_mut().enumerate() {
                c.output["score"] = json!(len - i);
            }
        }
    }
    let configured = if selection.is_null() {
        configured_ids
            .iter()
            .any(|id| configured(strategy, id, false))
    } else {
        ids.iter()
            .any(|id| configured(strategy, id, include_planner))
    };
    let ranked: Vec<Value> = candidates.iter().map(|c| c.output.clone()).collect();
    let uncertain: Vec<Value> = if selection.is_null() {
        candidates
            .iter()
            .filter(|c| c.unknown)
            .map(|c| c.output.clone())
            .collect()
    } else {
        selection_uncertain
    };
    let mut result = json!({"ranked": ranked, "excluded": excluded, "uncertain": uncertain});
    if !configured {
        result["reason"] = json!("no executor configured");
    }
    result
}

/// Append a conversation-requested executor that was left out of the routing pool.
/// Mutates `ranking` in place, matching the TypeScript helper.
pub fn conversation_fallback(ranking: &mut Value, input: &Value) {
    let requested = match input["requested"].as_str() {
        Some(id) if !id.is_empty() => id,
        _ => return,
    };
    let ranked = array(&ranking["ranked"]);
    let excluded = array(&ranking["excluded"]);
    if ranked.iter().any(|e| string(&e["id"]) == requested)
        || excluded.iter().any(|e| string(&e["id"]) == requested)
    {
        return;
    }
    let mut solo_input = input.clone();
    if let Some(obj) = solo_input.as_object_mut() {
        obj.insert(
            "selection".into(),
            json!({"executors": [requested], "order": "configured"}),
        );
        obj.insert("includePlanner".into(), json!(true));
    }
    let solo = rank_executors(&solo_input);
    let solo_ranked = array(&solo["ranked"]);
    if solo_ranked.is_empty() {
        if let Some(list) = ranking["excluded"].as_array_mut() {
            list.extend(array(&solo["excluded"]).iter().cloned());
        }
        return;
    }
    let floor = ranked
        .iter()
        .filter_map(|e| optional_number(&e["score"]))
        .fold(1.0_f64, f64::min);
    let mut candidate = solo_ranked[0].clone();
    candidate["score"] = json!(floor - 1.0);
    if let Some(list) = ranking["ranked"].as_array_mut() {
        list.push(candidate);
    }
    let solo_uncertain = array(&solo["uncertain"]);
    if !solo_uncertain.is_empty() {
        if ranking["uncertain"].is_null() {
            ranking["uncertain"] = json!([]);
        }
        if let Some(list) = ranking["uncertain"].as_array_mut() {
            list.extend(solo_uncertain.iter().cloned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar_fallback_and_boundary() {
        let profile = json!({"days": 3, "active": [true]});
        assert_eq!(pace_pct(0.0, 100.0, 25.0, &profile, chrono_tz::UTC), 25.0);
        assert_eq!(
            active_hours_left(100.0, 100.0, &profile, chrono_tz::UTC),
            0.0
        );
        assert_eq!(
            active_hours_left(101.0, 100.0, &profile, chrono_tz::UTC),
            0.0
        );
    }

    #[test]
    fn unknown_evidence_is_not_permission() {
        let input = json!({"now": 100, "scope": {"account": "a", "identity": "u"}, "usage": "quota", "allowPaid": false,
            "evidence": {"facts": {"availability": [], "budget": [], "spending": []}, "conflicts": []}, "restrictions": []});
        let decision = evaluate_eligibility(&input);
        assert_eq!(decision["state"], "uncertain");
        assert_eq!(decision["reasons"][0]["code"], "availability_unknown");
        assert_eq!(decision["reasons"][1]["code"], "budget_missing");
    }

    #[test]
    fn unknown_machine_signals_leave_guard_open() {
        let input = json!({"config": {"localMemoryPressureLimit": "critical", "localLoadLimit": 1},
            "signals": {"memoryPressure": null, "loadPerCore": null}});
        assert!(machine_guard(&input).is_null());
    }

    #[test]
    fn planner_mode_matches_typescript() {
        assert_eq!(planner_mode("EXHAUSTED"), "emergency");
        assert_eq!(planner_mode("AHEAD"), "strict");
        assert_eq!(planner_mode("NEAR_LIMIT"), "strict");
        assert_eq!(planner_mode("BEHIND"), "relaxed");
        assert_eq!(planner_mode("EXPIRING"), "relaxed");
        assert_eq!(planner_mode("ON_PACE"), "normal");
        assert_eq!(planner_mode("UNKNOWN"), "normal");
        assert_eq!(planner_mode("OK"), "normal");
    }
}
