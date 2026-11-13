//! `TIERS`, `meetsRequirements` and `buildCandidates` (`src/dispatch/candidates.ts`).
use pacer_js_json::stringify;
use serde_json::{Value, json};

use crate::js::{Object, js_cmp, js_max, js_min, num, number, same_json, truthy};
use crate::observation::live;

/// `TIERS[tier]`; `None` is `undefined`, which every comparison rejects.
pub fn tier_rank(tier: &str) -> Option<i8> {
    match tier {
        "unknown" => Some(-1),
        "small" => Some(0),
        "medium" => Some(1),
        "frontier" => Some(2),
        _ => None,
    }
}

pub(crate) fn rank_of(tier: Option<&Value>) -> Option<i8> {
    tier.and_then(Value::as_str).and_then(tier_rank)
}

/// `TIERS[a] >= TIERS[b]`.
pub(crate) fn tier_at_least(a: Option<&Value>, b: Option<&Value>) -> bool {
    matches!((rank_of(a), rank_of(b)), (Some(a), Some(b)) if a >= b)
}

/// `meetsRequirements(model, requirements)`; an absent key is `undefined`.
pub fn meets_requirements(model: &Object, requirements: &Value) -> bool {
    let min_tier = requirements.get("minTier");
    let context = || {
        let have = match model.get("context") {
            None | Some(Value::Null) => 0.0,
            Some(value) => number(Some(value)).unwrap_or(f64::NAN),
        };
        number(requirements.get("context")).is_some_and(|need| have >= need)
    };
    (min_tier.is_none() || tier_at_least(model.get("tier"), min_tier))
        && requirements
            .get("tools")
            .is_none_or(|tools| model.get("tools") == Some(tools))
        && (requirements.get("context").is_none() || context())
}

/// The result of [`build_candidates`]: candidates in inventory order, and
/// `{id, reason}` exclusions.
#[derive(Debug, Default)]
pub struct Built {
    pub candidates: Vec<Object>,
    pub excluded: Vec<Value>,
}

fn value_of<'a>(observation: &'a Object, key: &str) -> Option<&'a Value> {
    observation.get("value").and_then(|v| v.get(key))
}

/// `buildCandidates(strategy, task, inventory, observations, now)`.
pub fn build_candidates(
    strategy: &Value,
    task: &Value,
    inventory: &[Object],
    observations: &[Object],
    now: f64,
) -> Built {
    let mut built = Built::default();
    let pinned = task.get("model").filter(|m| truthy(Some(m)));
    for model in inventory {
        let field = |key: &str| model.get(key).cloned().unwrap_or(Value::Null);
        let id = stringify(&json!([field("runner"), field("binding")]));
        let mut reject = |reason: &str| built.excluded.push(json!({"id": id, "reason": reason}));
        let runner = model
            .get("runner")
            .and_then(Value::as_str)
            .and_then(|r| strategy.get("runners")?.get(r));
        if runner.is_none_or(|r| r.get("enabled") == Some(&Value::Bool(false))) {
            reject("Runner unavailable or disabled");
            continue;
        }
        if !meets_requirements(model, &task["requirements"]) {
            reject("Task requirements not satisfied");
            continue;
        }
        let binding = model.get("binding");
        if pinned.is_some_and(|pin| {
            binding.and_then(|b| b.get("kind")) != Some(&json!("exact"))
                || binding.and_then(|b| b.get("id")) != Some(pin)
        }) {
            reject("Different pinned model");
            continue;
        }
        let current: Vec<&Object> = observations
            .iter()
            .filter(|o| {
                let scope = &o["scope"];
                scope.get("runner") == model.get("runner")
                    && scope.get("account") == model.get("account")
                    && (scope.get("binding").is_none() || same_json(scope.get("binding"), binding))
                    && live(o, now)
            })
            .collect();
        let health: Vec<&Object> = current
            .iter()
            .copied()
            .filter(|o| o["method"] == "health")
            .collect();
        if health
            .iter()
            .any(|o| value_of(o, "healthy") == Some(&Value::Bool(false)))
        {
            reject("Runner not healthy");
            continue;
        }
        let usage: Vec<&Object> = current
            .iter()
            .copied()
            .filter(|o| o["method"] == "usage")
            .collect();
        let windows: Vec<&Value> = usage
            .iter()
            .flat_map(|o| value_of(o, "windows").and_then(Value::as_array))
            .flatten()
            .collect();
        let mut pools: Vec<(&str, f64)> = Vec::new();
        for window in &windows {
            let pool = window["pool"].as_str().unwrap_or_default();
            let used = number(window.get("usedPct")).unwrap_or(f64::NAN);
            match pools.iter_mut().find(|(p, _)| *p == pool) {
                Some((_, max)) => *max = js_max([*max, used]),
                None => pools.push((pool, js_max([0.0, used]))),
            }
        }
        if pools.iter().any(|(_, used)| *used >= 100.0) {
            reject("Quota exhausted");
            continue;
        }
        let known = health
            .iter()
            .any(|o| value_of(o, "healthy") == Some(&Value::Bool(true)))
            && !usage.is_empty()
            && (!pools.is_empty()
                || usage
                    .iter()
                    .any(|o| value_of(o, "unmetered") == Some(&Value::Bool(true))));
        let headroom = match (known, pools.is_empty()) {
            (false, _) => Value::Null,
            (true, true) => num(100.0),
            (true, false) => num(js_min(pools.iter().map(|(_, used)| 100.0 - used))),
        };
        let burns: Vec<f64> = windows
            .iter()
            .filter(|w| w.get("hoursLeft").is_some())
            .map(|w| {
                let used = number(w.get("usedPct")).unwrap_or(f64::NAN);
                let hours = number(w.get("hoursLeft")).unwrap_or(f64::NAN);
                (100.0 - used) / js_max([1.0, hours])
            })
            .collect();
        let costs: Vec<f64> = usage
            .iter()
            .filter_map(|o| value_of(o, "cost"))
            .map(|cost| number(Some(cost)).unwrap_or(f64::NAN))
            .collect();
        let mut pool_ids: Vec<&str> = pools.iter().map(|(p, _)| *p).collect();
        pool_ids.sort_by(|a, b| js_cmp(a, b));
        let mut candidate = model.clone();
        candidate.insert("id".into(), json!(id));
        candidate.insert("poolIds".into(), json!(pool_ids));
        candidate.insert("headroom".into(), headroom);
        candidate.insert("capacityKnown".into(), json!(known));
        let burn = match burns.is_empty() {
            true => Value::Null,
            false => num(js_min(burns)),
        };
        let cost = match costs.is_empty() {
            true => Value::Null,
            false => num(js_max(costs)),
        };
        candidate.insert("burn".into(), burn);
        candidate.insert("cost".into(), cost);
        built.candidates.push(candidate);
    }
    built
}
