//! `runDecision(request, ladderEngine)` (`src/dispatch/engines.ts`): the request as
//! `decisionRequestSchema` returns it, its size and duplicate-id checks, the ladder
//! proposal as `proposalSchema` accepts it, and both hashes.
//!
//! The task, observations and config already come in schema key order (the caller
//! builds the task, observations passed [`crate::parse_observation`], the config
//! is the loaded `dispatch` section); candidates are reordered here.
#![allow(clippy::result_large_err)]
use pacer_foundation::api::{Code, CoreError};
use pacer_js_json::stringify;
use serde_json::{Value, json};

use crate::hash::decision_hash;
use crate::js::Object;
use crate::ladder::evaluate_ladder;

const LIMIT: usize = 256 * 1024;

/// `candidateSchema`'s keys in order.
const CANDIDATE: [&str; 17] = [
    "runner",
    "account",
    "executor",
    "binding",
    "actualModel",
    "tier",
    "strengths",
    "tools",
    "context",
    "provenance",
    "id",
    "poolIds",
    "headroom",
    "burn",
    "cost",
    "capacityKnown",
    "learnedFit",
];

fn chars(value: &Value, min: usize, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|s| (min..=max).contains(&s.chars().count()))
}

fn name(value: &Value) -> bool {
    chars(value, 1, 256)
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

fn candidate(c: &Value) -> Option<Value> {
    let c = c.as_object()?;
    let names = ["runner", "account", "executor"]
        .iter()
        .all(|k| name(&c[*k]))
        && list(&c["strengths"]).iter().all(name)
        && list(&c["poolIds"]).iter().all(name)
        && chars(&c["id"], 1, 1024);
    let out: Object = CANDIDATE
        .iter()
        .filter_map(|k| Some(((*k).to_owned(), c.get(*k)?.clone())))
        .collect();
    (names && out.len() == c.len()).then_some(Value::Object(out))
}

/// `decisionRequestSchema.safeParse(request).data`, or `None` where it fails.
fn parse(mut request: Value) -> Option<Value> {
    let candidates = list(&request["candidates"]);
    if candidates.len() > 512 || list(&request["observations"]).len() > 2048 {
        return None;
    }
    let candidates = candidates
        .iter()
        .map(candidate)
        .collect::<Option<Vec<_>>>()?;
    request["candidates"] = Value::Array(candidates);
    Some(request)
}

/// `proposalSchema.safeParse(output).success` for a ladder proposal.
fn valid_proposal(p: &Value) -> bool {
    let skipped = list(&p["skipped"]);
    let tier = p.get("tier").is_none_or(|t| {
        t.as_object().is_some_and(|t| t.len() == 3)
            && ["small", "medium", "frontier"].contains(&t["targetTier"].as_str().unwrap_or(""))
    });
    let common = skipped.len() <= 64 && skipped.iter().all(name) && tier;
    match p["state"].as_str() {
        Some("ranked") => {
            let choices = list(&p["choices"]);
            common
                && name(&p["step"])
                && (1..=512).contains(&choices.len())
                && choices.iter().all(|c| {
                    chars(&c["id"], 1, 1024)
                        && list(&c["factors"]).len() <= 16
                        && list(&c["factors"]).iter().all(Value::is_number)
                        && chars(&c["reason"], 0, 1000)
                })
        }
        Some("abstain" | "no-match") => common && chars(&p["reason"], 0, 1000),
        _ => false,
    }
}

/// `runDecision(request, ladderEngine, now)`: `now` reads the clock as the
/// decision runs (`ctx.now` plus the time since it started).
pub fn run_ladder(request: Value, now: impl Fn() -> f64) -> Result<Value, CoreError> {
    if stringify(&request).len() > LIMIT {
        return Err(CoreError::new(
            Code::TooLarge,
            "Decision input exceeds 256 KiB",
        ));
    }
    let invalid = || CoreError::new(Code::InvalidInput, "Invalid decision request");
    let request = parse(request).ok_or_else(invalid)?;
    let ids: Vec<&Value> = list(&request["candidates"])
        .iter()
        .map(|c| &c["id"])
        .collect();
    if ids.iter().enumerate().any(|(i, id)| ids[..i].contains(id)) {
        return Err(CoreError::new(
            Code::InvalidInput,
            "Duplicate candidate IDs",
        ));
    }
    let config = &request["config"];
    let deadline = request["deadline"].as_f64().unwrap_or(f64::NAN);
    let on_no_match = config["onNoMatch"].clone();
    let input_hash = decision_hash(&request);
    let timeout_ms = config["timeoutMs"].as_f64().unwrap_or(f64::NAN);
    let output = (timeout_ms.min((deadline - now()) * 1000.0) > 0.0)
        .then(|| evaluate_ladder(&request, config))
        .filter(|_| now() < deadline);
    let accepted = output.as_ref().map(|output| {
        let choices: Vec<&Value> = list(&output["choices"]).iter().map(|c| &c["id"]).collect();
        let unique = !choices
            .iter()
            .enumerate()
            .any(|(i, id)| choices[..i].contains(id));
        let known = choices.iter().all(|id| ids.contains(id));
        stringify(output).len() <= LIMIT
            && valid_proposal(output)
            && (output["state"] != "ranked" || unique && known)
    });
    let mut result = json!({
        "schemaVersion": 1,
        "engine": {"id": "ladder", "version": "1"},
        "request": null,
        "inputHash": input_hash,
        "proposal": null,
        "outputHash": null,
        "validation": if output.is_some() { "invalid" } else { "timeout" },
        "recommendedAction": on_no_match,
        "excluded": [],
        "uncertainty": [],
    });
    if let (Some(output), Some(true)) = (output, accepted) {
        result["outputHash"] = json!(decision_hash(&output));
        if output["state"] == "ranked" {
            result["recommendedAction"] = json!("select");
        }
        result["proposal"] = output;
        result["validation"] = json!("valid");
    }
    result["request"] = request;
    Ok(result)
}
