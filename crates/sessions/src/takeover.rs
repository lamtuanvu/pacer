//! Cheap takeover checks. No takeover request or process stop is activated here.
use serde_json::{Value, json};
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn runner(id: &str) -> Option<(&str, Option<&str>)> {
    let (left, host) = id.split_once('@').map_or((id, None), |(a, b)| (a, Some(b)));
    let (agent, account) = left
        .split_once('#')
        .map_or((left, None), |(a, b)| (a, Some(b)));
    let valid = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .next()
                .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    if !["codex", "claude-code", "cursor", "opencode", "agy"].contains(&agent)
        || !valid(agent)
        || account.is_some_and(|s| !valid(s))
        || host.is_some_and(|s| !valid(s))
    {
        return None;
    }
    Some((agent, host.filter(|h| *h != "local")))
}
pub fn availability(task: &Value, interactive_exists: bool) -> Value {
    let run = &task["run"];
    let exec = run["executor"]
        .as_str()
        .or(task["executor"].as_str())
        .unwrap_or("");
    let agent = runner(exec).map(|r| r.0).or(run["executor"].as_str());
    let missing = || {
        format!(
            "Take over needs the agent's session id; `{}` does not report one. Stop the task and retry it interactively instead.",
            run["executor"].as_str().unwrap_or("undefined")
        )
    };
    let reason = if task["state"] != "running" {
        Some("Take over requires a running task.".into())
    } else if task["executorProvider"] == "pacer-exec-direct" {
        Some("Take over is not yet extracted for provider-owned runs.".into())
    } else if truthy(&run["host"])
        || runner(run["executor"].as_str().unwrap_or("")).is_some_and(|r| r.1.is_some())
    {
        Some("Take over is not supported for remote runs.".into())
    } else if (truthy(&task["backend"]) && task["backend"] != "direct")
        || task["result"]["backend"] == "orca"
    {
        Some("Take over requires the direct backend.".into())
    } else if !truthy(run) {
        Some("Take over requires an active run.".into())
    } else if truthy(&run["takeover"])
        || task["takeover"]["state"] == "starting"
        || interactive_exists
    {
        Some("This task is already interactive or being taken over.".into())
    } else if ![
        Some("codex"),
        Some("claude-code"),
        Some("cursor"),
        Some("opencode"),
    ]
    .contains(&agent)
        || (!truthy(&run["agentSession"]) && agent != Some("opencode"))
    {
        Some(missing())
    } else {
        None
    };
    match reason {
        Some(reason) => json!({"available":false,"reason":reason}),
        None => json!({"available":true}),
    }
}
