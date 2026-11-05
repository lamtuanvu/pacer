use crate::strategy::resolve_runner;
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlotLimits {
    pub executor: usize,
    pub host: Option<usize>,
    pub local: Option<usize>,
}

/// Whether a task occupies an executor slot. Matches `holdsSlot` in `src/engine/slots.ts`.
pub fn holds_slot(task: &Value) -> bool {
    task["state"] == "running"
        || (task["state"] == "needs_input" && truthy(&task["live"]) && !truthy(&task["retriedBy"]))
}

/// A live `needs_input` worker retains its slot until a retry takes it over.
pub fn slot_use(tasks: &[Value]) -> Value {
    let mut by_executor: HashMap<String, usize> = HashMap::new();
    let mut by_host: HashMap<String, usize> = HashMap::new();
    let mut local = 0;
    for task in tasks {
        if !holds_slot(task) {
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

/// Derive hard caps from a validated strategy snapshot. Matches `slotLimit`.
///
/// Expects the TypeScript `Strategy` snapshot shape: camelCase runner/host
/// `maxTasks`, and snake_case `execution.local_max_tasks` (pass-through from
/// `validateStrategy`).
pub fn slot_limit(strategy: &Value, runner_id: &str) -> SlotLimits {
    let runner = resolve_runner(strategy, runner_id);
    let host_limit = runner
        .and_then(|r| r.get("host").and_then(Value::as_str))
        .and_then(|host| strategy["hosts"][host]["maxTasks"].as_u64())
        .map(|n| n as usize);
    let executor = runner
        .and_then(|r| r.get("maxTasks").and_then(Value::as_u64))
        .map(|n| n as usize)
        .or(host_limit)
        .unwrap_or(1);
    let local = if host_limit.is_none() {
        // Strategy keeps the raw execution mapping; validateExecution reads this key.
        strategy["execution"]["local_max_tasks"]
            .as_u64()
            .map(|n| n as usize)
    } else {
        None
    };
    SlotLimits {
        executor,
        host: host_limit,
        local,
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
    machine_guard.map(|guard| {
        json!({"reason":guard["reason"],"limit":"machine","detail":guard["detail"],"machine":guard["machine"]})
    })
}

/// Strategy-aware capacity check matching `queueCapacity` in `src/tasks/capacity.ts`.
///
/// Looks up usage under the resolved runner id (aliases resolve first). Machine
/// guards apply only to local runners; remote hosts keep hard caps only. Callers
/// supply an already-evaluated guard snapshot — signal collection stays with the
/// effectful owner (engine machine readers / P6b).
pub fn queue_capacity_for(
    strategy: &Value,
    executor: &str,
    use_: &Value,
    machine_guard: Option<Value>,
) -> Option<Value> {
    let runner = resolve_runner(strategy, executor);
    let limits = slot_limit(strategy, executor);
    let id = runner
        .and_then(|r| r.get("id").and_then(Value::as_str))
        .unwrap_or(executor);
    let host = runner.and_then(|r| r.get("host").and_then(Value::as_str));
    let guard = if host.is_none() {
        machine_guard
    } else {
        None
    };
    queue_capacity(id, host, limits, use_, guard)
}
