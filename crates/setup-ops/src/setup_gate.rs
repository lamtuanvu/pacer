//! The startup gate of `src/view-model/setup-health.ts`: steps, outcome, repairs and
//! the fingerprint, over a doctor report and a setup checklist.
use serde_json::{Map, Value, json};
use std::collections::HashSet;

use crate::diagnostic_summary::diagnostic_summary;

const ORDER: [(&str, &str); 6] = [
    ("service", "Service ready"),
    ("detect_agents", "Detect agents"),
    ("integrations", "Integrations & hooks"),
    ("usage_eligibility", "Usage & eligibility"),
    ("notifications", "Turn on notifications"),
    ("ready", "Ready to take work"),
];
const REPAIR_AGENTS: [&str; 4] = ["claude-code", "codex", "cursor", "opencode"];
const WIRING_HONESTY: &str = "Wiring OK · live enforcement unverified";

fn name(check: &Value) -> &str {
    check["name"].as_str().unwrap_or("")
}

fn level(check: &Value) -> &str {
    check["level"].as_str().unwrap_or("")
}

fn attention(check: &Value) -> bool {
    matches!(level(check), "warn" | "fail")
}

fn from_levels<'a>(checks: impl Iterator<Item = &'a Value>) -> &'static str {
    let levels: Vec<&str> = checks.map(level).collect();
    if levels.contains(&"fail") {
        "failed"
    } else if levels.contains(&"warn") {
        "needs_attention"
    } else {
        "passed"
    }
}

fn checklist_item<'a>(checklist: &'a Value, id: &str) -> Option<&'a Value> {
    checklist["items"]
        .as_array()?
        .iter()
        .find(|item| item["id"] == json!(id))
}

fn service_state(checks: &[Value], checklist: &Value) -> &'static str {
    let status = checklist_item(checklist, "service").and_then(|item| item["status"].as_str());
    match status {
        Some("failed") => return "failed",
        Some("pending") => return "needs_attention",
        _ => {}
    }
    if checks.iter().any(|check| name(check) == "Service") {
        return from_levels(checks.iter().filter(|check| name(check) == "Service"));
    }
    if status == Some("done") {
        "passed"
    } else {
        "needs_attention"
    }
}

fn is_binary(check: &Value) -> bool {
    name(check).starts_with("Binary ")
}

fn detect_state(checks: &[Value]) -> &'static str {
    if checks.iter().any(is_binary) {
        from_levels(checks.iter().filter(|check| is_binary(check)))
    } else {
        "needs_attention"
    }
}

fn is_install_or_skill(name: &str) -> bool {
    name.starts_with("Install ") || name.starts_with("Skill ")
}

fn integrations_state(checks: &[Value]) -> &'static str {
    let wanted = |check: &&Value| {
        let name = name(check);
        is_install_or_skill(name)
            || name.starts_with("Integration freshness ")
            || name.starts_with("Claude ")
            || name == "Legacy guard"
            || name.starts_with("Planner check ")
    };
    from_levels(checks.iter().filter(wanted))
}

fn rank(state: &str) -> u8 {
    match state {
        "failed" => 5,
        "timed_out" => 4,
        "needs_attention" => 3,
        "running" => 2,
        "passed" => 0,
        _ => 1,
    }
}

fn usage_state(checks: &[Value], checklist: &Value) -> &'static str {
    let state = from_levels(checks.iter().filter(|c| name(c).starts_with("Usage ")));
    let floor = match checklist_item(checklist, "executor").and_then(|item| item["status"].as_str())
    {
        Some("failed") => "failed",
        Some("pending") => "needs_attention",
        _ => return state,
    };
    if rank(state) >= rank(floor) {
        state
    } else {
        floor
    }
}

fn notifications_state(checks: &[Value], skipped: bool) -> &'static str {
    if skipped {
        return "skipped";
    }
    match checks.iter().find(|check| name(check) == "Notifications") {
        Some(check) if attention(check) => "needs_attention",
        _ => "passed",
    }
}

fn ready_state(parts: &[&str]) -> &'static str {
    if parts.contains(&"failed") {
        "failed"
    } else if parts
        .iter()
        .any(|state| matches!(*state, "needs_attention" | "timed_out"))
    {
        "needs_attention"
    } else {
        "passed"
    }
}

fn executor_detail(checklist: &Value) -> Option<String> {
    let detail = checklist_item(checklist, "executor")?
        .get("detail")?
        .as_str()?;
    let technical = detail.contains(['#', '/', '='])
        || detail.contains("installed:")
        || detail.contains("running:");
    (!technical).then(|| detail.to_owned())
}

fn detail_for(id: &str, checks: &[Value], checklist: &Value, skipped: bool) -> Option<String> {
    let first = |wanted: &dyn Fn(&Value) -> bool| checks.iter().find(|check| wanted(check));
    match id {
        "service" => match first(&|check| name(check) == "Service") {
            Some(check) => Some(diagnostic_summary(check)),
            None => checklist_item(checklist, "service")?["detail"]
                .as_str()
                .map(str::to_owned),
        },
        "detect_agents" => {
            let binaries: Vec<_> = checks.iter().filter(|check| is_binary(check)).collect();
            let found = binaries.iter().filter(|c| level(c) == "ok").count();
            (!binaries.is_empty())
                .then(|| format!("{found} of {} agent commands found", binaries.len()))
        }
        "integrations" => first(&|check| {
            let name = name(check);
            attention(check)
                && (is_install_or_skill(name)
                    || name.starts_with("Claude ")
                    || name.starts_with("Integration freshness "))
        })
        .map(diagnostic_summary),
        "notifications" if skipped => Some("Skipped".into()),
        "notifications" => first(&|check| name(check) == "Notifications").map(diagnostic_summary),
        "usage_eligibility" => first(&|c| attention(c) && name(c).starts_with("Usage "))
            .map(diagnostic_summary)
            .or_else(|| executor_detail(checklist)),
        _ => None,
    }
}

fn param_text(remedy: &Value, key: &str) -> String {
    match remedy.pointer(&format!("/params/{key}")) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => pacer_js_json::stringify(other),
    }
}

/// One remedy fixes every check it is attached to; pacer-internal problems share one restart.
fn remedy_key(remedy: &Value) -> String {
    let op = remedy["op"].as_str();
    match remedy["kind"].as_str() {
        Some("internal") => return "internal".into(),
        Some("agent") => return format!("agent:{}", param_text(remedy, "check")),
        _ => {}
    }
    if matches!(op, Some("agent.preview" | "agent.connect")) {
        return format!("agent.connect:{}", param_text(remedy, "agent"));
    }
    let subject = op
        .or(remedy["url"].as_str())
        .or(remedy["label"].as_str())
        .unwrap_or("undefined");
    let params = remedy.get("params").cloned().unwrap_or_else(|| json!({}));
    format!("{subject}:{}", pacer_js_json::stringify(&params))
}

fn has_repair_agent(remedy: &Value) -> bool {
    matches!(
        remedy["op"].as_str(),
        Some("agent.preview" | "agent.connect")
    ) && remedy
        .pointer("/params/agent")
        .and_then(Value::as_str)
        .is_some_and(|agent| REPAIR_AGENTS.contains(&agent))
}

fn repairs(checks: &[Value], skipped: bool) -> Vec<Value> {
    let mut repairs = Vec::new();
    let mut seen = HashSet::new();
    for check in checks.iter().filter(|check| attention(check)) {
        let Some(remedy) = check.get("remedy") else {
            continue;
        };
        let notifications = name(check) == "Notifications";
        if (notifications && skipped) || !seen.insert(remedy_key(remedy)) {
            continue;
        }
        let mut repair = Map::new();
        repair.insert("kind".into(), "remedy".into());
        repair.insert("label".into(), remedy["label"].clone());
        repair.insert("check".into(), check["name"].clone());
        repair.insert("remedy".into(), remedy.clone());
        if notifications {
            repair.insert("skip".into(), true.into());
        }
        if has_repair_agent(remedy) {
            repair.insert("honesty".into(), WIRING_HONESTY.into());
        }
        repairs.push(Value::Object(repair));
    }
    let open = checks
        .iter()
        .any(|c| attention(c) && !(name(c) == "Notifications" && skipped));
    if open && repairs.is_empty() {
        repairs.push(json!({"kind": "open.diagnostics", "label": "Open Diagnostics"}));
    }
    repairs
}

fn outcome(states: &[(&str, &str)]) -> &'static str {
    if states
        .iter()
        .any(|(id, state)| *state == "failed" && *id != "notifications")
    {
        "hard_fail"
    } else if states
        .iter()
        .any(|(_, state)| matches!(*state, "needs_attention" | "timed_out"))
    {
        "warnings"
    } else {
        "ok"
    }
}

/// The gate's inputs; `checks` already leave out the removable-volume probes.
pub struct GateInput<'a> {
    pub checks: &'a [Value],
    pub checklist: &'a Value,
    pub trigger: &'a str,
    pub checked_at: Value,
    pub duration_seconds: Value,
    pub notifications_skipped: bool,
}

/// `aggregateSetupHealth` without timed-out steps, which the service never reports.
pub fn aggregate(input: GateInput<'_>) -> Map<String, Value> {
    let GateInput {
        checks, checklist, ..
    } = input;
    let skipped = input.notifications_skipped;
    let parts = [
        service_state(checks, checklist),
        detect_state(checks),
        integrations_state(checks),
        usage_state(checks, checklist),
        notifications_state(checks, skipped),
    ];
    let ready = ready_state(&parts);
    let states: Vec<(&str, &str)> = ORDER
        .iter()
        .map(|(id, _)| *id)
        .zip(parts.into_iter().chain([ready]))
        .collect();
    let steps: Vec<Value> = ORDER
        .iter()
        .zip(&states)
        .map(|((id, title), (_, state))| {
            let mut step = Map::new();
            step.insert("id".into(), (*id).into());
            step.insert("title".into(), (*title).into());
            step.insert("state".into(), (*state).into());
            if let Some(detail) = detail_for(id, checks, checklist, skipped) {
                step.insert("detail".into(), detail.into());
            }
            Value::Object(step)
        })
        .collect();
    let attention_count = states
        .iter()
        .filter(|(_, state)| matches!(*state, "needs_attention" | "failed" | "timed_out"))
        .count();
    let mut report = Map::new();
    report.insert("trigger".into(), input.trigger.into());
    if input.trigger == "update" {
        report.insert("eyebrow".into(), "After update · checking setup".into());
    }
    report.insert("title".into(), "Checking setup".into());
    report.insert(
        "support".into(),
        "Making sure agents can work through pacer.".into(),
    );
    report.insert("steps".into(), steps.into());
    report.insert("outcome".into(), outcome(&states).into());
    report.insert("attentionCount".into(), attention_count.into());
    report.insert("checkedAt".into(), input.checked_at);
    report.insert("durationSeconds".into(), input.duration_seconds);
    let repairs = repairs(checks, skipped);
    if !repairs.is_empty() {
        report.insert("repairs".into(), repairs.into());
    }
    report
}

/// `fingerprintFromReport`.
pub fn fingerprint(report: &Map<String, Value>, version: &Value, hashes: &Value) -> Value {
    let verdicts: Map<String, Value> = report["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|step| Some((step["id"].as_str()?.to_owned(), step["state"].clone())))
        .collect();
    json!({
        "schema": 1,
        "appVersion": version,
        "serviceVersion": version,
        "integrationHashes": hashes,
        "attentionCount": report["attentionCount"],
        "checkedAt": report["checkedAt"],
        "stepVerdicts": verdicts,
    })
}

/// `shouldSkipFullWindow` against a validated stored fingerprint.
pub fn should_skip_full_window(last: Option<&Value>, version: &Value, hashes: &Value) -> bool {
    let Some(last) = last else {
        return false;
    };
    if last["attentionCount"].as_f64() != Some(0.0)
        || &last["appVersion"] != version
        || &last["serviceVersion"] != version
    {
        return false;
    }
    let empty = Map::new();
    let stored = last["integrationHashes"].as_object().unwrap_or(&empty);
    let current = hashes.as_object().unwrap_or(&empty);
    let hash = |map: &Map<String, Value>, key: &str| {
        map.get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    stored
        .keys()
        .chain(current.keys())
        .all(|key| hash(stored, key) == hash(current, key))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn checklist(service: &str, executor: &str) -> Value {
        json!({"items": [
            {"id": "service", "status": service},
            {"id": "executor", "status": executor, "detail": "codex"},
        ]})
    }

    fn report(checks: &[Value], list: &Value, skipped: bool) -> Map<String, Value> {
        aggregate(GateInput {
            checks,
            checklist: list,
            trigger: "update",
            checked_at: json!(5),
            duration_seconds: json!(0.5),
            notifications_skipped: skipped,
        })
    }

    #[test]
    fn a_clean_run_passes_every_step() {
        let checks = [
            json!({"name": "Service", "level": "ok", "detail": "fine"}),
            json!({"name": "Binary codex", "level": "ok", "detail": "codex installed"}),
        ];
        let gate = report(&checks, &checklist("done", "done"), false);
        assert_eq!(gate["outcome"], json!("ok"));
        assert_eq!(gate["attentionCount"], json!(0));
        assert_eq!(gate["eyebrow"], json!("After update · checking setup"));
        assert_eq!(
            gate["steps"][1]["detail"],
            json!("1 of 1 agent commands found")
        );
        assert_eq!(gate["steps"][3]["detail"], json!("codex"));
        assert!(!gate.contains_key("repairs"));
    }

    #[test]
    fn repairs_are_deduplicated_and_skipped_notifications_add_none() {
        let review = json!({"kind": "review", "label": "Review", "op": "agent.preview", "params": {"agent": "codex"}});
        let connect = json!({"kind": "auto", "label": "Update", "op": "agent.connect", "params": {"agent": "codex"}});
        let notify = json!({"kind": "user", "label": "Allow"});
        let checks = [
            json!({"name": "Install codex", "level": "warn", "detail": "x", "remedy": review}),
            json!({"name": "Skill codex", "level": "warn", "detail": "x", "remedy": connect}),
            json!({"name": "Notifications", "level": "warn", "detail": "off", "remedy": notify}),
        ];
        let gate = report(&checks, &checklist("failed", "pending"), true);
        assert_eq!(gate["outcome"], json!("hard_fail"));
        let repairs = gate["repairs"].as_array().unwrap();
        assert_eq!(repairs.len(), 1);
        assert_eq!(repairs[0]["honesty"], json!(WIRING_HONESTY));
        assert_eq!(gate["steps"][4]["state"], json!("skipped"));
    }

    #[test]
    fn checks_without_a_remedy_open_diagnostics() {
        let checks = [json!({"name": "Orca", "level": "warn", "detail": "x"})];
        let gate = report(&checks, &checklist("done", "done"), false);
        assert_eq!(
            gate["repairs"],
            json!([{"kind": "open.diagnostics", "label": "Open Diagnostics"}])
        );
    }

    #[test]
    fn the_full_window_skips_only_for_a_matching_clean_pass() {
        let version = json!("1.0.0");
        let hashes = json!({"codex": "a"});
        let last = json!({"attentionCount": 0, "appVersion": "1.0.0", "serviceVersion": "1.0.0", "integrationHashes": {"codex": "a"}});
        assert!(should_skip_full_window(Some(&last), &version, &hashes));
        assert!(!should_skip_full_window(None, &version, &hashes));
        assert!(!should_skip_full_window(
            Some(&last),
            &json!("2.0.0"),
            &hashes
        ));
        assert!(!should_skip_full_window(
            Some(&last),
            &version,
            &json!({"codex": "b"})
        ));
        assert!(!should_skip_full_window(Some(&last), &version, &json!({})));
    }
}
