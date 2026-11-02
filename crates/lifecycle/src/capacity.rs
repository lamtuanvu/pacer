use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy)]
pub struct SlotLimits {
    pub executor: usize,
    pub host: Option<usize>,
    pub local: Option<usize>,
}

/// A live `needs_input` worker retains its slot until a retry takes it over.
pub fn slot_use(tasks: &[Value]) -> Value {
    let mut by_executor: HashMap<String, usize> = HashMap::new();
    let mut by_host: HashMap<String, usize> = HashMap::new();
    let mut local = 0;
    for task in tasks {
        let holds = task["state"] == "running"
            || (task["state"] == "needs_input"
                && truthy(&task["live"])
                && !truthy(&task["retriedBy"]));
        if !holds {
            continue;
        }
        let executor = task
            .pointer("/run/executor")
            .and_then(Value::as_str)
            .or_else(|| task.get("executor").and_then(Value::as_str));
        if let Some(id) = executor.filter(|id| !id.is_empty()) {
            *by_executor.entry(id.into()).or_default() += 1;
        }
        let host = task
            .pointer("/run/host")
            .and_then(Value::as_str)
            .or_else(|| executor.and_then(runner_host));
        if let Some(id) = host.filter(|id| !id.is_empty()) {
            *by_host.entry(id.into()).or_default() += 1;
        } else {
            local += 1;
        }
    }
    json!({"byExecutor":by_executor,"byHost":by_host,"local":local})
}

fn runner_host(id: &str) -> Option<&str> {
    let (runner, host) = id.rsplit_once('@')?;
    if host == "local" || !runner_segment(host) {
        return None;
    }
    let mut parts = runner.split('#');
    let agent = parts.next()?;
    if !["claude-code", "codex", "cursor", "agy", "opencode"].contains(&agent) {
        return None;
    }
    if let Some(account) = parts.next()
        && !runner_segment(account)
    {
        return None;
    }
    if parts.next().is_some() {
        return None;
    }
    Some(host)
}

fn runner_segment(value: &str) -> bool {
    value
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Bool(true) | Value::Array(_) | Value::Object(_) => true,
    }
}

/// Capacity precedence matches `slotBlock`: executor, host, then local machine.
pub fn queue_capacity(
    executor: &str,
    host: Option<&str>,
    limits: SlotLimits,
    use_: &Value,
    machine_guard: Option<Value>,
) -> Option<Value> {
    let used = use_["byExecutor"][executor].as_u64().unwrap_or(0) as usize;
    if used >= limits.executor {
        return Some(
            json!({"reason":"no_slot","limit":"executor","capacity":{"used":used,"max":limits.executor}}),
        );
    }
    if let (Some(host), Some(max)) = (host, limits.host) {
        let used = use_["byHost"][host].as_u64().unwrap_or(0) as usize;
        if used >= max {
            return Some(
                json!({"reason":"no_slot","limit":"host","capacity":{"used":used,"max":max}}),
            );
        }
    }
    if let Some(max) = limits.local {
        let used = use_["local"].as_u64().unwrap_or(0) as usize;
        if used >= max {
            return Some(
                json!({"reason":"no_slot","limit":"machine","capacity":{"used":used,"max":max}}),
            );
        }
    }
    machine_guard.map(|guard| json!({"reason":guard["reason"],"limit":"machine","detail":guard["detail"],"machine":guard["machine"]}))
}
