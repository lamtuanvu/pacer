//! Reason codes and texts for route explanations (`src/dispatch/reasons.ts`).
//! A reason is `{code, outcome, subject?, facts, text}`.
use pacer_js_json::number_string;
use serde_json::{Value, json};

use crate::js::{js_round, js_string, num, truthy};

/// `num(v)`: a rounded number, or `?` for anything else.
fn count(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(n)) => number_string(js_round(n.as_f64().unwrap_or(f64::NAN))),
        _ => "?".into(),
    }
}

/// `TEXT[code](facts)`.
fn text(code: &str, f: &Value) -> String {
    let s = |key: &str| js_string(f.get(key));
    let n = |key: &str| count(f.get(key));
    let on = |key: &str| truthy(f.get(key));
    match code {
        "rank_match" => format!("Executor ranking selected this executor ({}).", s("reason")),
        "no_executor_ranked" => "No executor is available in the routing rank.".into(),
        "step_match" => {
            let kind = if on("kind") {
                format!(" for kind \"{}\"", s("kind"))
            } else {
                String::new()
            };
            format!("Ladder step \"{}\" matched{kind}.", s("stepId"))
        }
        "capacity_comfortable" => format!(
            "{}% of its budget window is free, enough to run comfortably.",
            n("headroomPct")
        ),
        "capacity_usable" => format!(
            "{}% of its budget window is free; usable, not comfortable.",
            n("headroomPct")
        ),
        "capacity_unknown" => "Its remaining capacity is not measured.".into(),
        "override" => format!("You asked for {} for this task only.", s("executor")),
        "planner_account" => "It shares the planner's account and is kept for planning.".into(),
        "runner_disabled" => "It is switched off.".into(),
        "not_configured" => "It is not fully set up.".into(),
        "blocked_by_user" => "You blocked it.".into(),
        "quota_exhausted" if on("resetsAt") => {
            format!("Its budget is used up until {}.", s("resetsAt"))
        }
        "quota_exhausted" => "Its budget is used up.".into(),
        "not_installed" => "Its command-line tool is not installed.".into(),
        "signed_out" => "It is signed out.".into(),
        "unavailable" | "other_exclusion" => "It is not available right now.".into(),
        "ineligible" => "It cannot take work right now.".into(),
        "runner_unhealthy" => "It reported itself unhealthy.".into(),
        "requirements_not_met" => "It does not meet the task's requirements.".into(),
        "pinned_to_other_model" => "The task is pinned to a different model.".into(),
        "executor_busy" => format!(
            "{} is busy ({}/{} running).",
            s("of"),
            n("used"),
            n("limit")
        ),
        "machine_busy" => format!(
            "This machine is busy ({}/{} running).",
            n("used"),
            n("limit")
        ),
        "host_unreachable" => format!("Host {} is unreachable.", s("host")),
        "host_reachability_unknown" => {
            format!("Host {} has not been checked recently.", s("host"))
        }
        "host_paused" => format!("Host {} is paused.", s("host")),
        "repo_not_on_host" => format!("The repository is not set up on host {}.", s("host")),
        "needs_new_worktree" => "Remote runners need a new worktree.".into(),
        "local_grant_required" => "Scoped child delegation needs a local executor.".into(),
        "enforcement_uncertified" => {
            format!("Its native delegation control is not verified{}.", agent(f))
        }
        "step_kind_mismatch" => "The step is for a different kind of task.".into(),
        "step_no_candidates" => "No executor qualified for this step.".into(),
        "no_step_matched" => "No ladder step has a qualifying executor.".into(),
        "paused" if on("until") => format!("Dispatch is paused until {}.", s("until")),
        "paused" => "Dispatch is paused.".into(),
        "engine_failed" => format!(
            "The decision engine returned {}; nothing was chosen.",
            s("validation")
        ),
        "override_unavailable" => format!(
            "{} cannot take the task ({}); the ladder's pick is used instead.",
            s("requested"),
            s("reason")
        ),
        "planner_not_measured" => "Planner tokens are not measured yet.".into(),
        "too_few_samples" => format!(
            "{} comparable reviewed tasks; {} needed for an estimate.",
            n("samples"),
            n("needed")
        ),
        "planner_is_executor" => "The planner's account is also the chosen executor.".into(),
        "cached_preview" => {
            "This reads cached observations and reserves nothing; the real dispatch may differ."
                .into()
        }
        "capacity_unmeasured" => "Remaining capacity is unknown for this executor.".into(),
        "default_model_unresolved" => "The executor's default model is not resolved.".into(),
        "enforcement_unverified" => format!(
            "Native delegation control has not been checked in this process{}.",
            agent(f)
        ),
        "engine_not_running" => format!(
            "The decision engine {} is not running; the ladder was used.",
            s("engine")
        ),
        "learning_unavailable" => {
            "Learned fit was skipped because no history store exists yet.".into()
        }
        "tasks_unavailable" => "Running tasks could not be read; none were counted.".into(),
        "reserved_capacity" => {
            "Capacity reserved by running work may change this at admission.".into()
        }
        "ranked_inputs_ignored" => format!(
            "Executor ranking ignores these dispatch inputs: {}.",
            s("fields")
        ),
        "admission_hooks" => "Configured admission hooks are not run by this preview.".into(),
        "classifier_unavailable" => format!(
            "The classifier plugin did not answer ({}), so the task kind is unknown.",
            s("error")
        ),
        _ => String::new(),
    }
}

fn agent(f: &Value) -> String {
    if truthy(f.get("agent")) {
        format!(" for {}", js_string(f.get("agent")))
    } else {
        String::new()
    }
}

/// `reason(code, outcome, facts, subject, text)`: `text` replaces the code's text.
/// `facts` is a JSON object.
pub fn reason(
    code: &str,
    outcome: &str,
    facts: Value,
    subject: Option<&str>,
    text: Option<&str>,
) -> Value {
    let text = text.map_or_else(|| self::text(code, &facts), str::to_owned);
    let mut out = json!({"code": code, "outcome": outcome});
    if let (Some(subject), Some(map)) = (subject, out.as_object_mut()) {
        map.insert("subject".into(), json!(subject));
    }
    if let Some(map) = out.as_object_mut() {
        map.insert("facts".into(), facts);
        map.insert("text".into(), json!(text));
    }
    out
}

/// JavaScript's `\n`, `\r`, U+2028 and U+2029: what `.` does not match.
fn line_break(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// JavaScript's `\s`.
fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// A `(.+)` capture: at least one character and no line break.
fn dot_plus(capture: &str) -> Option<&str> {
    (!capture.is_empty() && !capture.contains(line_break)).then_some(capture)
}

/// `\d+`, read as `+digits`.
fn digits(text: &str) -> Option<f64> {
    (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// `(\d+)\/(\d+)\)$` after the opening parenthesis.
fn used_of(rest: &str) -> Option<(f64, f64)> {
    let (used, limit) = rest.strip_suffix(')')?.split_once('/')?;
    Some((digits(used)?, digits(limit)?))
}

/// The code for a fixed exclusion text.
fn fixed(text: &str) -> Option<&'static str> {
    Some(match text {
        "planner" => "planner_account",
        "disabled" | "Runner unavailable or disabled" => "runner_disabled",
        "not configured" => "not_configured",
        "Blocked by you" => "blocked_by_user",
        "exhausted" | "Quota exhausted" => "quota_exhausted",
        "not installed" => "not_installed",
        "Runner not healthy" => "runner_unhealthy",
        "Task requirements not satisfied" => "requirements_not_met",
        "Different pinned model" => "pinned_to_other_model",
        "remote runners need a new worktree" => "needs_new_worktree",
        "scoped child delegation requires local grant transport" => "local_grant_required",
        _ => return None,
    })
}

/// `exclusionReason(subject, text, eligibility)`: the free-text exclusions from
/// ranking, slots, remote and candidate checks as codes. Unknown text becomes
/// `other_exclusion` with the text kept.
pub fn exclusion_reason(subject: &str, text: &str, eligibility: Option<&Value>) -> Value {
    let make = |code: &str, facts: Value| reason(code, "fail", facts, Some(subject), None);
    if let Some(code) = fixed(text) {
        return make(code, json!({}));
    }
    if let Some(eligibility) = eligibility.filter(|e| e.get("state") == Some(&json!("ineligible")))
    {
        let budget = eligibility["reasons"].as_array().is_some_and(|reasons| {
            reasons
                .iter()
                .any(|r| r.get("code") == Some(&json!("budget_exhausted")))
        });
        let code = if budget {
            "quota_exhausted"
        } else {
            "ineligible"
        };
        return reason(code, "fail", json!({}), Some(subject), Some(text));
    }
    if let Some(rest) = text.strip_prefix("host ") {
        let line = &rest[..rest.find(line_break).unwrap_or(rest.len())];
        let host = line.rfind(" reachability unknown").filter(|&end| end > 0);
        if let Some(end) = host {
            return make("host_reachability_unknown", json!({"host": &rest[..end]}));
        }
        if let Some(host) = rest.strip_suffix(" unreachable").and_then(dot_plus) {
            return make("host_unreachable", json!({"host": host}));
        }
    }
    if let Some(host) = text.strip_suffix(" paused").and_then(dot_plus) {
        return make("host_paused", json!({"host": host}));
    }
    if let Some(rest) = text.strip_prefix("repo not set up on ") {
        let host = &rest[..rest.find(js_space).unwrap_or(rest.len())];
        if !host.is_empty() {
            return make("repo_not_on_host", json!({"host": host}));
        }
    }
    let machine = text.strip_prefix("this machine busy (").and_then(used_of);
    if let Some((used, limit)) = machine {
        return make(
            "machine_busy",
            json!({"used": num(used), "limit": num(limit)}),
        );
    }
    if let Some((of, rest)) = text.rsplit_once(" busy (")
        && let (Some(of), Some((used, limit))) = (dot_plus(of), used_of(rest))
    {
        let facts = json!({"used": num(used), "limit": num(limit), "of": of});
        return make("executor_busy", facts);
    }
    let lower = text.to_ascii_lowercase();
    let enforcement = [
        "native",
        "could not verify",
        "executor account is unavailable",
    ];
    if enforcement.iter().any(|needle| lower.contains(needle)) {
        return make("enforcement_uncertified", json!({}));
    }
    if text.starts_with("Not working") {
        return make("unavailable", json!({}));
    }
    reason(
        "other_exclusion",
        "fail",
        json!({}),
        Some(subject),
        Some(text),
    )
}
