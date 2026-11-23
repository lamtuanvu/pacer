//! Mapping of host wait / failed-start results onto the #461 disposition (M3 C5).
//!
//! Port of `plugins/pacer-exec-orca/index.ts:22-49` (`mapWait`,
//! `mapFailedStart`). Summaries are copied verbatim; the `tail` key is kept
//! only when the host supplied it; a failed stage that names an agent launch
//! marks the attempt broken.

use std::sync::LazyLock;

use pacer_plugin::js::trim;
use regex::Regex;
use serde_json::{Value, json};

/// `agent launch` / `launch agent` (case-insensitive); a failed stage matching
/// it marks the attempt broken.
static LAUNCH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)agent[ _-]?launch|launch[ _-]?agent")
        .unwrap_or_else(|e| panic!("the launch regex must be valid: {e}"))
});

/// Map a supervised wait result to the run outcome (`mapWait`). `of_kind` is
/// the `WaitResult.kind` discriminant; every other field is read when the kind
/// calls for it.
pub fn map_wait(w: &Value) -> Value {
    match w.get("kind").and_then(Value::as_str) {
        Some("done") => {
            let outcome = w.get("outcome").and_then(Value::as_str).unwrap_or("");
            let parts: Vec<&str> = ["subject", "body"]
                .iter()
                .filter_map(|k| w.get(*k).and_then(Value::as_str))
                .filter(|x| !trim(x).is_empty())
                .collect();
            let summary = if parts.is_empty() {
                format!("worker_done: {outcome}")
            } else {
                parts.join("\n\n")
            };
            json!({
                "code": if outcome == "succeeded" { 0 } else { 1 },
                "timedOut": false,
                "settled": true,
                "summary": summary,
            })
        }
        Some("settled") => {
            let state = w.get("state").and_then(Value::as_str).unwrap_or("");
            let error = w.get("error").and_then(Value::as_str);
            let needs_stop = w.get("needsStop").and_then(Value::as_bool).unwrap_or(false);
            let mut out = serde_json::Map::new();
            out.insert(
                "code".into(),
                json!(if state == "succeeded" { 0 } else { 1 }),
            );
            out.insert("timedOut".into(), json!(false));
            out.insert("settled".into(), json!(!needs_stop));
            if let Some(tail) = w.get("tail").and_then(Value::as_str) {
                out.insert("tail".into(), json!(tail));
            }
            let error_part = match error {
                Some(e) => format!(" ({e})"),
                None => String::new(),
            };
            out.insert(
                "summary".into(),
                json!(format!(
                    "orca worker {state} without a worker_done report{error_part}"
                )),
            );
            Value::Object(out)
        }
        Some("timeout") => json!({
            "code": 1,
            "timedOut": true,
            "settled": false,
            "summary": "orca worker timed out at the task timeout; stopped it",
        }),
        Some("stopped") => json!({
            "code": 1,
            "timedOut": false,
            "settled": false,
            "summary": "stopped by the planner; stopped the orca worker",
        }),
        _ => Value::Null,
    }
}

/// A worker that did not start ready. An agent-launch failure marks the
/// attempt broken (`mapFailedStart`).
pub fn map_failed_start(start: &Value) -> (Value, Option<String>) {
    let failed_stage = start
        .get("failedStage")
        .and_then(Value::as_str)
        .unwrap_or("");
    let stage = start.get("stage").and_then(Value::as_str).unwrap_or("");
    let last_error = start.get("lastError").and_then(Value::as_str);
    let launch_broken = if LAUNCH_RE.is_match(failed_stage) {
        Some(format!(
            "orca agent launch failed: {}",
            last_error.unwrap_or("no error given")
        ))
    } else {
        None
    };
    let stage_name = if !failed_stage.is_empty() {
        failed_stage
    } else if !stage.is_empty() {
        stage
    } else {
        "an unknown stage"
    };
    let mapped = json!({
        "code": 1,
        "timedOut": false,
        "settled": true,
        "summary": format!(
            "orca worker failed to start at {stage_name}: {}",
            last_error.unwrap_or("no error given")
        ),
    });
    (mapped, launch_broken)
}
