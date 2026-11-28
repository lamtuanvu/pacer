//! Evidence reconcile and merge, ported from `src/engine/evidence.ts` and
//! `src/core/evidence.ts` (B12-1).

use pacer_foundation::Ctx;
use pacer_foundation::api::{Code, CoreError};
use pacer_foundation::lock::{LockOptions, with_lock};
use serde_json::{Map, Value, json};

use crate::freshness::{EVIDENCE_PRUNE_AFTER_S, EXHAUSTED_PCT};

/// `emptyEvidence` (evidence.ts): `{"availability":[],"budget":[],"spending":[]}`.
pub fn empty_evidence() -> Value {
    json!({"availability": [], "budget": [], "spending": []})
}

/// `accountEvidenceScope(account, hosts)` (src/evidence/scope.ts): `{account, identity}`.
pub fn account_scope(account: &Value, hosts: &Value) -> Value {
    json!({
        "account": account.get("name").cloned().unwrap_or(Value::Null),
        "identity": pacer_config::evidence::evidence_identity(account, hosts),
    })
}

fn scope_str(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn optional_f(value: &Value) -> Option<f64> {
    value.as_f64().filter(|f| f.is_finite())
}

fn precedence(source: &str) -> f64 {
    if source == "configuration" {
        3.0
    } else if source == "provider-cli" {
        2.0
    } else {
        1.0
    }
}

/// `appliesTo` (evidence.ts:12-15).
pub fn applies_to(fact: &Value, scope: &Value) -> bool {
    fact["scope"]["account"] == scope["account"]
        && fact["scope"]["identity"] == scope["identity"]
        && ["runner", "model", "host"]
            .iter()
            .all(|key| fact["scope"][key].is_null() || fact["scope"][key] == scope[*key])
}

/// `observationValid` (evidence.ts:16-18).
pub fn observation_valid(fact: &Value, now: f64) -> bool {
    let at = optional_f(&fact["observedAt"]);
    at.is_some_and(|t| t >= 0.0 && t <= now)
}

/// `evidenceDeadline` (evidence.ts:19-28): when a fact stops constraining.
pub fn evidence_deadline(fact: &Value) -> Option<f64> {
    pacer_engine::deadline(fact)
}

/// `currentEvidence` (evidence.ts:29-31). A `None` deadline reads `fact.validUntil`;
/// `Some(None)` mirrors a deadline explicitly passed as `null`.
pub fn current_evidence(fact: &Value, now: f64, deadline: Option<Option<f64>>) -> bool {
    let deadline = deadline.unwrap_or_else(|| optional_f(&fact["validUntil"]));
    observation_valid(fact, now) && deadline.is_none_or(|t| t > now)
}

fn sha256_hex(text: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// `evidenceFact` (evidence.ts:7-11).
pub fn evidence_fact(
    scope: &Value,
    source: &str,
    observed_at: Option<f64>,
    valid_until: Option<f64>,
    reason: &str,
    value: Value,
    budget_policy: Option<&str>,
) -> Value {
    let mut fact = Map::new();
    fact.insert("scope".to_string(), scope.clone());
    fact.insert("source".to_string(), json!(source));
    fact.insert("observedAt".to_string(), opt_num(observed_at));
    fact.insert("validUntil".to_string(), opt_num(valid_until));
    fact.insert("reason".to_string(), json!(reason));
    fact.insert("value".to_string(), value);
    if let Some(policy) = budget_policy {
        fact.insert("budgetPolicy".to_string(), json!(policy));
    }
    let fact = Value::Object(fact);
    let id = sha256_hex(&pacer_js_json::stringify(&fact));
    let mut out = Map::new();
    out.insert("id".to_string(), json!(id[..24].to_string()));
    if let Some(map) = fact.as_object() {
        for (k, v) in map {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

/// A JSON number in TypeScript's spelling: integral values stay integers so the
/// structural golden compares match `JSON.parse` of the fixture (1000000, not
/// 1000000.0). Non-integral or out-of-range values stay binary64 floats.
fn js_number(v: f64) -> Value {
    if v.is_finite() && v.fract() == 0.0 && v >= i64::MIN as f64 && v <= i64::MAX as f64 {
        Value::Number(serde_json::Number::from(v as i64))
    } else {
        Value::from(v)
    }
}

fn opt_num(v: Option<f64>) -> Value {
    v.map_or(Value::Null, js_number)
}

fn value_string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

/// `windowUsable` (evidence.ts:35-37): a positive, finite duration.
fn window_usable(w: &Value) -> bool {
    optional_f(&w["lengthS"]).is_some_and(|len| len > 0.0)
}

/// `measuredQuota` (evidence.ts:40-42).
fn measured_quota(f: &Value) -> bool {
    f["reason"] == "quota_observed"
        && matches!(
            value_string(&f["source"]).as_deref(),
            Some("session-log" | "provider-cli")
        )
}

/// `retireInvalidZero` (evidence.ts:56-70): retire historical 0h artifacts.
fn retire_invalid_zero(budget: &[&Value], now: f64) -> std::collections::HashSet<String> {
    let witnesses: Vec<&Value> = budget
        .iter()
        .copied()
        .filter(|f| {
            measured_quota(f)
                && window_usable(&f["value"])
                && f["value"]["stale"] != true
                && f["value"]["usedPct"].is_i64()
                && f["value"]["usedPct"]
                    .as_f64()
                    .is_some_and(|n| (0.0..=100.0).contains(&n))
                && observation_valid(f, now)
                && current_evidence(f, now, Some(evidence_deadline(f)))
        })
        .collect();
    let mut retired = std::collections::HashSet::new();
    for f in budget.iter().copied() {
        if !measured_quota(f) {
            continue;
        }
        if value_string(&f["value"]["name"]) != Some("0h".into()) || f["value"]["lengthS"] != 0 {
            continue;
        }
        if f["observedAt"].is_null() {
            continue;
        }
        let f_at = f["observedAt"].as_f64();
        if witnesses.iter().any(|w| {
            w["observedAt"]
                .as_f64()
                .is_some_and(|t| f_at.is_some_and(|ft| t > ft))
                && applies_to(w, &f["scope"])
                && w["budgetPolicy"] == f["budgetPolicy"]
        }) {
            retired.insert(id_of(f));
        }
    }
    retired
}

fn id_of(f: &Value) -> String {
    f.get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// `reconcileEvidence` (evidence.ts:73-133).
pub fn reconcile_evidence(
    previous: &Value,
    incoming: &Value,
    now: f64,
    budget_policy: Option<&str>,
) -> Value {
    let mut facts = empty_evidence();
    let mut conflicts: Vec<String> = Vec::new();
    let prev_all: Vec<&Value> = array_values(&previous["budget"]);
    let inc_all: Vec<&Value> = array_values(&incoming["budget"]);
    let chain: Vec<&Value> = prev_all.iter().chain(inc_all.iter()).copied().collect();
    let retired = retire_invalid_zero(&chain, now);
    let previous_budget: Vec<&Value> = prev_all
        .into_iter()
        .filter(|f| !retired.contains(&id_of(f)))
        .collect();
    let incoming_budget: Vec<&Value> = inc_all
        .into_iter()
        .filter(|f| !retired.contains(&id_of(f)))
        .collect();

    for kind in ["availability", "budget", "spending"] {
        // First-seen key order, matching the TypeScript Map.
        let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
        let (prev, inc): (Vec<&Value>, Vec<&Value>) = if kind == "budget" {
            (previous_budget.clone(), incoming_budget.clone())
        } else {
            (array_refs(&previous[kind]), array_refs(&incoming[kind]))
        };
        for fact in prev.iter().chain(inc.iter()) {
            let key = pacer_js_json::stringify(&group_key(fact, kind));
            match groups.iter_mut().find(|(k, _)| k == &key) {
                Some((_, values)) => values.push((*fact).clone()),
                None => groups.push((key, vec![(*fact).clone()])),
            }
        }
        for (_, values) in groups {
            let valid: Vec<&Value> = values
                .iter()
                .filter(|f| observation_valid(f, now))
                .collect();
            let candidates: Vec<&Value> = if valid.is_empty() {
                values.iter().collect()
            } else {
                valid
            };
            let newest = candidates
                .iter()
                .map(|f| {
                    if observation_valid(f, now) {
                        f["observedAt"].as_f64().unwrap_or(-f64::INFINITY)
                    } else {
                        -f64::INFINITY
                    }
                })
                .fold(f64::NEG_INFINITY, f64::max);
            let contemporaries: Vec<&Value> = candidates
                .iter()
                .copied()
                .filter(|f| {
                    let t = if observation_valid(f, now) {
                        f["observedAt"].as_f64().unwrap_or(-f64::INFINITY)
                    } else {
                        -f64::INFINITY
                    };
                    t == newest
                })
                .collect();
            let priority = contemporaries
                .iter()
                .map(|f| precedence(value_string(&f["source"]).unwrap_or_default().as_str()))
                .fold(f64::NEG_INFINITY, f64::max);
            let peers: Vec<&Value> = contemporaries
                .iter()
                .copied()
                .filter(|f| {
                    precedence(value_string(&f["source"]).unwrap_or_default().as_str()) == priority
                })
                .collect();
            // Dedup by JSON.stringify([f.value, f.validUntil]), first seen wins.
            let mut seen = std::collections::HashSet::new();
            let mut unique: Vec<Value> = Vec::new();
            for f in peers {
                let k = pacer_js_json::stringify(&json!([f["value"], f["validUntil"]]));
                if seen.insert(k) {
                    unique.push(f.clone());
                }
            }
            if unique.len() > 1 {
                conflicts.extend(unique.iter().map(id_of));
            }
            append_array(&mut facts, kind, unique);
        }
    }

    // A newer under-threshold measurement drops an older execution limit.
    let measured: Vec<Value> = array_values(&facts["budget"])
        .into_iter()
        .filter(|f| {
            f["source"] != "execution"
                && f["source"] != "configuration"
                && f["value"]["name"] != "limit"
                && (f["source"] != "metered"
                    || budget_policy.is_none()
                    || f["budgetPolicy"].as_str() == budget_policy)
        })
        .cloned()
        .collect::<Vec<Value>>();
    if !measured.is_empty()
        && measured.iter().all(|f| {
            current_evidence(f, now, Some(evidence_deadline(f)))
                && !f["value"]["usedPct"].is_null()
                && f["value"]["usedPct"]
                    .as_f64()
                    .is_some_and(|pct| pct < EXHAUSTED_PCT)
        })
    {
        let budget = array_values(&facts["budget"])
            .into_iter()
            .filter(|f| {
                f["source"] != "execution"
                    || f["value"]["name"] != "limit"
                    || !measured.iter().all(|sample| {
                        let newer = sample["observedAt"]
                            .as_f64()
                            .zip(f["observedAt"].as_f64())
                            .is_some_and(|(s, fo)| s > fo);
                        newer && applies_to(sample, &f["scope"])
                    })
            })
            .cloned()
            .collect::<Vec<Value>>();
        facts["budget"] = json!(budget);
    }

    // Cooldown marks stop constraining once their stated end passes.
    facts["budget"] = json!(
        array_values(&facts["budget"])
            .into_iter()
            .filter(|f| {
                let limit = (f["source"] == "execution" || f["source"] == "configuration")
                    && f["value"]["name"] == "limit";
                if !limit {
                    return true;
                }
                let until =
                    optional_f(&f["validUntil"]).or_else(|| optional_f(&f["value"]["resetsAt"]));
                observation_valid(f, now) && until.is_none_or(|t| t > now)
            })
            .cloned()
            .collect::<Vec<Value>>()
    );

    // A newer valid read from the same source that omits a window retires it.
    let reported: std::collections::HashSet<String> = array_values(&incoming["budget"])
        .into_iter()
        .filter_map(|f| f["value"]["name"].as_str().map(str::to_owned))
        .collect();
    let witnesses: Vec<&Value> = array_values(&incoming["budget"])
        .into_iter()
        .filter(|f| {
            observation_valid(f, now)
                && f["value"]["stale"] != true
                && f["value"]["usedPct"]
                    .as_f64()
                    .is_some_and(|n| (0.0..=100.0).contains(&n))
        })
        .collect();
    let kept = |f: &Value| -> bool {
        f["value"]["name"] == "limit"
            || reported.contains(
                value_string(&f["value"]["name"])
                    .unwrap_or_default()
                    .as_str(),
            )
            || f["observedAt"].is_null()
            || (!f["value"]["usedPct"].is_null()
                && current_evidence(f, now, Some(evidence_deadline(f))))
            || (f["value"]["usedPct"]
                .as_f64()
                .is_some_and(|pct| pct >= EXHAUSTED_PCT)
                && (f["value"]["resetsAt"].is_null()
                    || f["value"]["resetsAt"].as_f64().is_some_and(|r| r > now)))
    };
    facts["budget"] = json!(
        array_values(&facts["budget"])
            .into_iter()
            .filter(|f| {
                kept(f)
                    || !witnesses.iter().any(|g| {
                        g["source"] == f["source"]
                            && applies_to(g, &f["scope"])
                            && g["observedAt"]
                                .as_f64()
                                .is_some_and(|go| f["observedAt"].as_f64().is_none_or(|fo| go > fo))
                    })
            })
            .cloned()
            .collect::<Vec<Value>>()
    );

    // Availability and spending facts whose validity ended long ago are history.
    let prune_cutoff = now - EVIDENCE_PRUNE_AFTER_S;
    facts["availability"] = json!(
        array_values(&facts["availability"])
            .into_iter()
            .filter(|f| f["validUntil"].is_null()
                || f["validUntil"].as_f64().is_some_and(|t| t > prune_cutoff))
            .cloned()
            .collect::<Vec<Value>>()
    );
    facts["spending"] = json!(
        array_values(&facts["spending"])
            .into_iter()
            .cloned()
            .filter(|f| f["validUntil"].is_null()
                || f["validUntil"].as_f64().is_some_and(|t| t > prune_cutoff))
            .collect::<Vec<Value>>()
    );

    let retained_ids: Vec<String> = array_values(&facts["availability"])
        .iter()
        .chain(array_values(&facts["budget"]).iter())
        .chain(array_values(&facts["spending"]).iter())
        .map(|f| id_of(f))
        .collect();
    let mut conflicts = conflicts
        .into_iter()
        .filter(|id| retained_ids.contains(id))
        .collect::<Vec<String>>();
    conflicts.sort();
    json!({ "facts": facts, "conflicts": conflicts })
}

fn array_values(v: &Value) -> Vec<&Value> {
    v.as_array().map(|a| a.iter().collect()).unwrap_or_default()
}

fn array_refs(v: &Value) -> Vec<&Value> {
    v.as_array().map(|a| a.iter().collect()).unwrap_or_default()
}

fn group_key(fact: &Value, kind: &str) -> Value {
    let scope = &fact["scope"];
    let inner: Value = if kind == "budget" {
        json!([fact["value"]["name"], fact["budgetPolicy"]])
    } else {
        json!(kind)
    };
    json!([
        scope["account"],
        scope["identity"],
        scope["runner"],
        scope["model"],
        scope["host"],
        inner
    ])
}

fn append_array(facts: &mut Value, kind: &str, items: Vec<Value>) {
    let mut arr = facts[kind].as_array().cloned().unwrap_or_default();
    arr.extend(items);
    facts[kind] = json!(arr);
}

/// `readingEvidence` (evidence.ts:141-161).
pub fn reading_evidence(scope: &Value, reading: &Value, usage: &str) -> Value {
    if reading.get("evidence").is_some() {
        return reading["evidence"].clone();
    }
    let mut facts = empty_evidence();
    let source = reading
        .get("source")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| "session-log".to_string());
    let contract = usage == "reactive" || usage == "unmetered";
    let captured_at = optional_f(&reading["capturedAt"]);
    for window in reading["windows"].as_array().into_iter().flatten() {
        if contract && window["name"] == "limit" && window["usedPct"] == 0 {
            continue;
        }
        let fact = evidence_fact(
            scope,
            &source,
            captured_at,
            None,
            "quota_observed",
            window.clone(),
            None,
        );
        append_array(&mut facts, "budget", vec![fact]);
    }
    let availability = reading
        .get("availability")
        .filter(|v| !v.is_null())
        .cloned();
    if let Some(av) = availability {
        let fact = evidence_fact(
            scope,
            &source,
            captured_at,
            optional_f(&av["validUntil"]),
            av["reason"].as_str().unwrap_or(""),
            av["state"].clone(),
            None,
        );
        append_array(&mut facts, "availability", vec![fact]);
    } else if contract {
        let fact = evidence_fact(
            scope,
            "configuration",
            Some(0.0),
            None,
            "measurement_contract",
            json!("ready"),
            None,
        );
        append_array(&mut facts, "availability", vec![fact]);
    } else if (!array_values(&facts["budget"]).is_empty()
        || reading.get("spendUsd").is_some_and(|v| !v.is_null()))
        && is_falsy_error(reading)
        && !reading
            .get("stale")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        let deadlines: Vec<f64> = array_values(&facts["budget"])
            .into_iter()
            .filter_map(evidence_deadline)
            .collect();
        let until = if !deadlines.is_empty() {
            Some(deadlines.into_iter().fold(f64::INFINITY, f64::min))
        } else if captured_at.is_none() {
            None
        } else {
            captured_at.map(|t| t + crate::freshness::AVAILABILITY_FALLBACK_S)
        };
        let fact = evidence_fact(
            scope,
            &source,
            captured_at,
            until,
            "usage_observed",
            json!("ready"),
            None,
        );
        append_array(&mut facts, "availability", vec![fact]);
    }
    if let Some(spending) = reading.get("spending").cloned() {
        let until = captured_at.map(|t| t + crate::freshness::SPENDING_LIFETIME_S);
        let fact = evidence_fact(
            scope,
            &source,
            captured_at,
            until,
            "spending_observed",
            spending,
            None,
        );
        append_array(&mut facts, "spending", vec![fact]);
    }
    for alternative in reading["alternatives"].as_array().into_iter().flatten() {
        let other = reading_evidence(scope, alternative, usage);
        append_array(
            &mut facts,
            "availability",
            other["availability"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
        );
        append_array(
            &mut facts,
            "budget",
            other["budget"].as_array().cloned().unwrap_or_default(),
        );
        append_array(
            &mut facts,
            "spending",
            other["spending"].as_array().cloned().unwrap_or_default(),
        );
    }
    facts
}

fn evidence_path(ctx: &Ctx, identity: &str) -> std::path::PathBuf {
    ctx.pacer_home
        .join("state/evidence")
        .join(format!("{identity}.json"))
}

fn is_64_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && (b.is_ascii_digit() || b.is_ascii_lowercase()))
}

/// `!reading.error` (evidence.ts:149): error is only truthy for a non-empty string.
fn is_falsy_error(reading: &Value) -> bool {
    !reading
        .get("error")
        .and_then(Value::as_str)
        .is_some_and(|e| !e.is_empty())
}

// Facts validation copied from `crates/account-ops/src/evidence.rs` (the same
// predicate TypeScript applies at `src/core/evidence.ts:20-34` is implemented
// there); account-ops is layer 6 so this crate re-implements it rather than
// depending on it. Cite both.
fn finite(v: &Value) -> bool {
    v.as_f64().is_some_and(f64::is_finite)
}

fn nullable_finite(v: Option<&Value>) -> bool {
    v.is_some_and(|v| v.is_null() || finite(v))
}

fn facts_valid(facts: &Value, identity: &str, account: &str) -> bool {
    let lists = ["availability", "budget", "spending"].map(|k| facts.get(k));
    let fact_ok = |f: &Value| {
        f.is_object()
            && f["id"].is_string()
            && f["scope"]["identity"] == identity
            && f["scope"]["account"] == account
            && f["source"].is_string()
            && f["reason"].is_string()
            && nullable_finite(f.get("observedAt"))
            && nullable_finite(f.get("validUntil"))
    };
    let all = |list: Option<&Value>, ok: &dyn Fn(&Value) -> bool| {
        list.and_then(Value::as_array)
            .is_some_and(|items| items.iter().all(ok))
    };
    if !lists.iter().all(|list| all(*list, &fact_ok)) {
        return false;
    }
    let availability = |f: &Value| {
        f["value"]
            .as_str()
            .is_some_and(|v| ["ready", "unavailable", "unknown"].contains(&v))
    };
    let budget = |f: &Value| {
        let w = &f["value"];
        w.is_object()
            && w["name"].is_string()
            && (w["usedPct"].is_null() && w.get("usedPct").is_some()
                || w["usedPct"]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n >= 0.0))
            && nullable_finite(w.get("resetsAt"))
            && w["lengthS"]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= 0.0)
            && w["paced"].is_boolean()
    };
    let spending = |f: &Value| {
        let v = &f["value"];
        v.is_object()
            && v["paidConsumption"]
                .as_str()
                .is_some_and(|p| ["observed", "unknown", "not_observed"].contains(&p))
            && v.get("creditsAvailable")
                .is_some_and(|c| c.is_null() || c.is_boolean())
            && nullable_finite(v.get("creditBalance"))
    };
    all(lists[0], &availability) && all(lists[1], &budget) && all(lists[2], &spending)
}

/// `readEvidence` (core/evidence.ts:17-36); returns the empty snapshot on invalid/missing.
pub fn read_evidence(ctx: &Ctx, scope: &Value) -> Value {
    let identity = scope_str(scope, "identity");
    let account = scope_str(scope, "account");
    let empty: Value = json!({
        "version": 1, "revision": 0, "identity": identity,
        "evidence": {"facts": empty_evidence(), "conflicts": []},
    });
    if !is_64_hex(&identity) {
        return empty;
    }
    let path = evidence_path(ctx, &identity);
    let saved: Value = match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => return empty,
        },
        Err(_) => return empty,
    };
    let revision = saved["revision"].as_f64().unwrap_or(f64::NAN);
    if saved["version"] != 1
        || saved["identity"] != identity
        || !revision.is_finite()
        || revision < 0.0
        || revision.fract() != 0.0
        || revision > 9_007_199_254_740_991.0
        || !saved["evidence"].is_object()
        || !saved["evidence"]["conflicts"].is_array()
    {
        return empty;
    }
    let facts = &saved["evidence"]["facts"];
    if !facts.is_object()
        || !facts_valid(facts, &identity, &account)
        || !facts["availability"].as_array().is_some_and(|a| {
            a.iter().all(|f| {
                f["value"]
                    .as_str()
                    .is_some_and(|v| ["ready", "unavailable", "unknown"].contains(&v))
            })
        })
        || !facts["budget"]
            .as_array()
            .is_some_and(|a| a.iter().all(budget_valid))
        || !facts["spending"]
            .as_array()
            .is_some_and(|a| a.iter().all(spending_valid))
    {
        return empty;
    }
    saved
}

fn budget_valid(f: &Value) -> bool {
    let w = &f["value"];
    w.is_object()
        && w["name"].is_string()
        && (w["usedPct"].is_null()
            || w["usedPct"]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= 0.0))
        && (w["resetsAt"].is_null() || w["resetsAt"].as_f64().is_some_and(f64::is_finite))
        && w["lengthS"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n >= 0.0)
        && w["paced"].is_boolean()
}

fn spending_valid(f: &Value) -> bool {
    let v = &f["value"];
    v.is_object()
        && v["paidConsumption"]
            .as_str()
            .is_some_and(|p| ["observed", "unknown", "not_observed"].contains(&p))
        && (v["creditsAvailable"].is_null() || v["creditsAvailable"].is_boolean())
        && (v["creditBalance"].is_null() || v["creditBalance"].as_f64().is_some_and(f64::is_finite))
}

/// `mergeEvidence` (core/evidence.ts:38-60).
pub async fn merge_evidence(
    ctx: &Ctx,
    scope: &Value,
    incoming: &Value,
    budget_policy: Option<&str>,
    read_only: bool,
) -> Result<Value, CoreError> {
    let identity = scope_str(scope, "identity");
    let merge = || -> Result<Value, CoreError> {
        let previous = read_evidence(ctx, scope);
        let retired_at = optional_f(&previous["retiredAt"]);
        let mut accepted = empty_evidence();
        for kind in ["availability", "budget", "spending"] {
            let filtered: Vec<Value> = incoming[kind]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|f| {
                    f["source"] == "configuration"
                        || match retired_at {
                            None => true,
                            Some(r) => f["observedAt"].as_f64().is_some_and(|t| t > r),
                        }
                })
                .cloned()
                .collect();
            append_array(&mut accepted, kind, filtered);
        }
        let evidence = reconcile_evidence(
            &previous["evidence"]["facts"],
            &accepted,
            ctx.now,
            budget_policy,
        );
        if pacer_js_json::stringify(&evidence) == pacer_js_json::stringify(&previous["evidence"]) {
            return Ok(previous);
        }
        let mut next = Map::new();
        if let Some(at) = retired_at {
            next.insert("retiredAt".to_string(), Value::from(at));
        }
        next.insert("version".to_string(), json!(1));
        next.insert(
            "revision".to_string(),
            json!(previous["revision"].as_f64().unwrap_or(0.0) + 1.0),
        );
        next.insert("identity".to_string(), json!(identity));
        next.insert("evidence".to_string(), evidence);
        let next = Value::Object(next);
        if !read_only {
            let path = evidence_path(ctx, &identity);
            let bytes = pacer_js_json::stringify(&next);
            write_evidence_file(&path, &bytes)
                .map_err(|e| CoreError::new(Code::Internal, format!("write evidence: {e}")))?;
        }
        Ok(next)
    };
    if read_only {
        merge()
    } else {
        with_lock(
            ctx,
            &format!("evidence-{identity}"),
            LockOptions::default(),
            merge,
        )
        .map_err(|e| CoreError::new(Code::Internal, format!("evidence lock: {e}")))
        .and_then(|v| v)
    }
}

fn write_evidence_file(path: &std::path::Path, bytes: &str) -> std::io::Result<()> {
    pacer_foundation::fsutil::write_private(path, bytes.as_bytes())
}
