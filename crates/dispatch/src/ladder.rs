//! `evaluateLadder` (`src/dispatch/ladder.ts`): a pure recommendation; admission
//! and execution stay with the caller.
use pacer_js_json::number_string;
use serde_json::{Value, json};
use std::cmp::Ordering;

use crate::candidates::meets_requirements;
use crate::js::{Object, js_cmp, js_round, num, number, truthy};
use crate::tier_select::{target_tier, tier_buckets};

fn exact_model(candidate: &Object) -> Option<&Value> {
    let binding = candidate.get("binding")?;
    (binding.get("kind")? == "exact").then(|| binding.get("id"))?
}

/// `preference(candidate, preferences)`: earlier listed models score higher.
fn preference(candidate: &Object, preferences: &Value) -> f64 {
    let models = preferences["models"]
        .as_array()
        .map_or(&[][..], Vec::as_slice);
    let index = exact_model(candidate).and_then(|model| models.iter().position(|m| m == model));
    index.map_or(0.0, |i| (models.len() - i) as f64)
}

fn listed(list: &Value, item: Option<&Value>) -> bool {
    item.is_some_and(|item| list.as_array().is_some_and(|l| l.contains(item)))
}

/// `headroom`, `burn` or `cost` as a number; `null` is `None`.
fn measure(candidate: &Object, key: &str) -> Option<f64> {
    number(candidate.get(key))
}

fn eligible(candidate: &Object, task: &Value, step: &Value, config: &Value) -> bool {
    if !meets_requirements(candidate, &task["requirements"])
        || !meets_requirements(candidate, &step["require"])
    {
        return false;
    }
    let model = exact_model(candidate);
    if truthy(task.get("model")) && model != task.get("model") {
        return false;
    }
    let pick = |key: &str| step.get("candidates").and_then(|c| c.get(key));
    if pick("models").is_some_and(|models| !listed(models, model)) {
        return false;
    }
    if pick("executors").is_some_and(|executors| !listed(executors, candidate.get("executor"))) {
        return false;
    }
    let reserve = number(config.get("reservePct")).unwrap_or(f64::NAN);
    let headroom = measure(candidate, "headroom");
    if headroom.is_some_and(|h| h <= reserve) {
        return false;
    }
    match step["capacity"].as_str() {
        Some("unknown") => true,
        capacity => {
            let comfortable = number(config.get("comfortablePct")).unwrap_or(f64::NAN);
            truthy(candidate.get("capacityKnown"))
                && headroom.is_some_and(|h| match capacity {
                    Some("comfortable") => h - reserve >= comfortable,
                    _ => h - reserve > 0.0,
                })
        }
    }
}

struct Choice<'a> {
    candidate: &'a Object,
    id: &'a str,
    factors: Vec<f64>,
    reason: String,
}

fn choice<'a>(candidate: &'a Object, task: &Value, step: &Value) -> Choice<'a> {
    let prefer = &step["prefer"];
    let preferences = &task["preferences"];
    let strengths = match prefer["strengths"].as_array() {
        Some(s) if !s.is_empty() => s,
        _ => preferences["strengths"]
            .as_array()
            .map_or(&[][..], Vec::as_slice),
    };
    let own = candidate.get("strengths").and_then(Value::as_array);
    let fit = strengths
        .iter()
        .filter(|s| own.is_some_and(|own| own.contains(s)))
        .count();
    let learned = candidate.get("learnedFit").filter(|l| truthy(Some(l)));
    let learned_at = |key: &str| number(learned.and_then(|l| l.get(key))).unwrap_or(f64::NAN);
    let mut factors = vec![
        preference(candidate, prefer),
        preference(candidate, preferences),
    ];
    for rank in step["rank"].as_array().into_iter().flatten() {
        match rank.as_str() {
            Some("task-fit") => factors.extend([
                fit as f64,
                learned.map_or(0.0, |_| {
                    learned_at("successRate") - learned_at("uncertainty") - 0.5
                }),
            ]),
            Some("preference") => factors.extend([
                preference(candidate, prefer),
                preference(candidate, preferences),
            ]),
            rank => {
                let key = match rank {
                    Some("spare-capacity") => "headroom",
                    Some("burn-before-reset") => "burn",
                    _ => "cost",
                };
                factors.extend(match measure(candidate, key) {
                    None => [0.0, 0.0],
                    Some(v) if rank == Some("cheapest-first") => [1.0, -v],
                    Some(v) => [1.0, v],
                });
            }
        }
    }
    let capacity = match measure(candidate, "headroom") {
        None => "capacity unknown".to_owned(),
        Some(h) => format!("{}% measured headroom", number_string(h)),
    };
    let learned_text = learned.map_or(String::new(), |l| {
        let percent = |key: &str| number_string(js_round(learned_at(key) * 100.0));
        let samples = l.get("sampleCount").map_or("undefined".into(), |n| {
            number(Some(n)).map_or_else(|| n.to_string(), number_string)
        });
        format!(
            "; learned fit {}% from {samples} comparable reviews (±{}%)",
            percent("successRate"),
            percent("uncertainty")
        )
    });
    let step_id = step["id"].as_str().unwrap_or_default();
    Choice {
        candidate,
        id: candidate
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        factors,
        reason: format!("Step {step_id}; {capacity}; configured task-fit {fit}{learned_text}"),
    }
}

/// The comparator `b.factors[i] - a.factors[i]`, then ids ascending.
fn order(a: &Choice, b: &Choice) -> Ordering {
    for (x, y) in a.factors.iter().zip(&b.factors) {
        if x != y {
            return (y - x).partial_cmp(&0.0).unwrap_or(Ordering::Equal);
        }
    }
    js_cmp(a.id, b.id)
}

/// `evaluateLadder(request, config)`: the proposal in TypeScript's key order.
pub fn evaluate_ladder(request: &Value, config: &Value) -> Value {
    let task = &request["task"];
    let difficulty = task["difficulty"].as_str().unwrap_or("standard");
    let min_tier = task["requirements"]["minTier"].as_str();
    let target = target_tier(difficulty, &config["tierTargets"], min_tier);
    let candidates: Vec<&Object> = request["candidates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .collect();
    let pinned = truthy(task.get("model"));
    let buckets: Vec<Vec<&Object>> = if pinned {
        vec![candidates.clone()]
    } else {
        tier_buckets(&candidates, target)
            .into_iter()
            .map(|bucket| bucket.into_iter().copied().collect())
            .collect()
    };
    let steps = config["steps"].as_array().map_or(&[][..], Vec::as_slice);
    let mut skipped: Vec<Value> = Vec::new();
    let skip = |skipped: &mut Vec<Value>, step: &Value| {
        let id = step.get("id").cloned().unwrap_or(Value::Null);
        if !skipped.contains(&id) {
            skipped.push(id);
        }
    };
    for bucket in buckets.iter().filter(|b| !b.is_empty()) {
        for step in steps {
            let kind = step.get("match").and_then(|m| m.get("kind"));
            if kind.is_some_and(|kind| Some(kind) != task.get("kind")) {
                skip(&mut skipped, step);
                continue;
            }
            let eligible: Vec<&Object> = bucket
                .iter()
                .copied()
                .filter(|c| eligible(c, task, step, config))
                .collect();
            if eligible.is_empty() {
                skip(&mut skipped, step);
                continue;
            }
            let mut choices: Vec<Choice> = eligible.iter().map(|c| choice(c, task, step)).collect();
            choices.sort_by(order);
            let selected = choices[0].candidate;
            let selected = eligible
                .iter()
                .find(|c| c.get("id") == selected.get("id"))
                .copied()
                .unwrap_or(selected);
            let selected_tier = selected.get("tier").cloned().unwrap_or(Value::Null);
            let reason = if pinned {
                "explicit-override"
            } else if selected_tier == "unknown" {
                "unknown-tier-fallback"
            } else if target.is_some_and(|t| selected_tier == t) {
                "target-match"
            } else {
                "upward-fallback"
            };
            let mut tier = Object::new();
            if let Some(target) = target {
                tier.insert("targetTier".into(), json!(target));
            }
            tier.insert("selectedTier".into(), selected_tier);
            tier.insert("reason".into(), json!(reason));
            let choices: Vec<Value> = choices
                .into_iter()
                .map(|c| {
                    let factors: Vec<Value> = c.factors.into_iter().map(num).collect();
                    json!({"id": c.id, "factors": factors, "reason": c.reason})
                })
                .collect();
            return json!({"state": "ranked", "choices": choices, "step": step.get("id"),
                "skipped": skipped, "tier": tier});
        }
    }
    json!({"state": "no-match", "reason": "No strategy step has qualifying candidates",
        "skipped": skipped})
}
