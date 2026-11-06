//! P3 task list composition via read-model page helpers and injected session probe.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_read_model::{
    ActiveCounts, ActiveSession,
    tasks::{self, TaskListOptions},
};
use pacer_store::TaskStore;
use serde_json::{Map, Value, json};
use std::collections::HashSet;

const LIST_STATES: &[&str] = &[
    "queued",
    "running",
    "done",
    "partial",
    "failed",
    "limit",
    "stopped",
    "needs_input",
];

pub fn needs_session_probe(op: &str) -> bool {
    matches!(op, "task.list")
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn object(params: &Value) -> Result<&Map<String, Value>, CoreError> {
    params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(params)
        ))
    })
}

fn optional_bool(params: &Map<String, Value>, name: &str) -> Result<Option<bool>, CoreError> {
    match params.get(name) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(other) => Err(invalid(format!(
            "{name}: Invalid input: expected boolean, received {}",
            type_name(other)
        ))),
    }
}

fn optional_id<'a>(
    params: &'a Map<String, Value>,
    name: &str,
) -> Result<Option<&'a str>, CoreError> {
    let Some(value) = params.get(name) else {
        return Ok(None);
    };
    let text = value.as_str().ok_or_else(|| {
        invalid(format!(
            "{name}: Invalid input: expected string, received {}",
            type_name(value)
        ))
    })?;
    if text.is_empty() {
        return Err(invalid(format!(
            "{name}: Too small: expected string to have >=1 characters"
        )));
    }
    if text.encode_utf16().count() > 128 {
        return Err(invalid(format!(
            "{name}: Too big: expected string to have <=128 characters"
        )));
    }
    Ok(Some(text))
}

fn list_limit(params: &Map<String, Value>) -> Result<usize, CoreError> {
    match params.get("limit") {
        None => Ok(20),
        Some(v) if !v.is_number() => Err(invalid(format!(
            "limit: Invalid input: expected number, received {}",
            type_name(v)
        ))),
        Some(v)
            if !v
                .as_f64()
                .is_some_and(|n| n.is_finite() && n.fract() == 0.0) =>
        {
            Err(invalid(
                "limit: Invalid input: expected int, received number",
            ))
        }
        Some(v) => {
            let n = v.as_f64().unwrap_or(20.0);
            let mut issues = Vec::new();
            if n < 1.0 {
                issues.push("limit: Too small: expected number to be >=1");
            } else if n > 200.0 {
                issues.push("limit: Too big: expected number to be <=200");
            }
            if n < -9_007_199_254_740_991.0 {
                issues.push("limit: Too small: expected int to be >=-9007199254740991");
            } else if n > 9_007_199_254_740_991.0 {
                issues.push("limit: Too big: expected int to be <=9007199254740991");
            }
            if issues.is_empty() {
                Ok(n as usize)
            } else {
                Err(invalid(issues.join("; ")))
            }
        }
    }
}

fn optional_since(params: &Map<String, Value>) -> Result<Option<f64>, CoreError> {
    match params.get("since") {
        None => Ok(None),
        Some(v) if !v.is_number() => Err(invalid(format!(
            "since: Invalid input: expected number, received {}",
            type_name(v)
        ))),
        Some(v) => {
            let Some(n) = v.as_f64() else {
                return Err(invalid(
                    "since: Invalid input: expected number, received number",
                ));
            };
            if !n.is_finite() {
                return Err(invalid(
                    "since: Invalid input: expected number, received number",
                ));
            }
            if n < 0.0 {
                return Err(invalid("since: Too small: expected number to be >=0"));
            }
            Ok(Some(n))
        }
    }
}

fn optional_states(params: &Map<String, Value>) -> Result<Option<Vec<String>>, CoreError> {
    match params.get("states") {
        None => Ok(None),
        Some(Value::Array(values))
            if values
                .iter()
                .all(|v| v.as_str().is_some_and(|s| LIST_STATES.contains(&s))) =>
        {
            Ok(Some(
                values
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect::<Vec<_>>(),
            ))
        }
        Some(Value::Array(values)) => {
            let options = LIST_STATES
                .iter()
                .map(|s| format!("\"{s}\""))
                .collect::<Vec<_>>()
                .join("|");
            Err(invalid(
                values
                    .iter()
                    .enumerate()
                    .filter(|(_, v)| !v.as_str().is_some_and(|s| LIST_STATES.contains(&s)))
                    .map(|(index, _)| {
                        format!("states.{index}: Invalid option: expected one of {options}")
                    })
                    .collect::<Vec<_>>()
                    .join("; "),
            ))
        }
        Some(other) => Err(invalid(format!(
            "states: Invalid input: expected array, received {}",
            type_name(other)
        ))),
    }
}

pub struct SessionProbeParts {
    pub active: ActiveCounts,
    pub alive_pids: HashSet<i64>,
}

pub fn parse_probe_parts(value: Value) -> Result<SessionProbeParts, CoreError> {
    let map = value
        .as_object()
        .ok_or_else(|| invalid("session probe bridge returned a non-object payload"))?;
    let active = map
        .get("active")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("session probe bridge missing active sessions"))?;
    let mut sessions = Vec::with_capacity(active.len());
    for (index, row) in active.iter().enumerate() {
        let Some(obj) = row.as_object() else {
            return Err(invalid(format!(
                "active.{index}: Invalid input: expected object, received {}",
                type_name(row)
            )));
        };
        let task_id = obj.get("task_id").and_then(Value::as_str).ok_or_else(|| {
            invalid(format!(
                "active.{index}.task_id: Invalid input: expected string, received undefined"
            ))
        })?;
        let executor = obj.get("executor").and_then(Value::as_str).ok_or_else(|| {
            invalid(format!(
                "active.{index}.executor: Invalid input: expected string, received undefined"
            ))
        })?;
        sessions.push(ActiveSession {
            task_id: task_id.into(),
            executor: executor.into(),
        });
    }
    let alive_pids = map
        .get("alivePids")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("session probe bridge missing alivePids"))?
        .iter()
        .filter_map(|v| v.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0))
        .map(|n| n as i64)
        .collect();
    Ok(SessionProbeParts {
        active: ActiveCounts::from_sessions(&sessions),
        alive_pids,
    })
}

fn broker_unavailable(message: &str) -> OpFuture<'_> {
    Box::pin(async move { Err(CoreError::new(Code::Unavailable, message)) })
}

pub fn task_list_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    broker_unavailable("task.list requires the session probe bridge")
}

struct ParsedListOptions {
    all: bool,
    limit: Option<usize>,
    before: Option<String>,
    repo: Option<String>,
    states: Option<Vec<String>>,
    executor: Option<String>,
    since: Option<f64>,
}

fn parse_options(params: &Value) -> Result<ParsedListOptions, CoreError> {
    let params = if params.is_null() {
        json!({})
    } else {
        params.clone()
    };
    let p = object(&params)?;
    let mut issues = Vec::new();
    let all = match optional_bool(p, "all") {
        Ok(v) => v,
        Err(error) => {
            issues.push(error.message);
            None
        }
    };
    let limit = match list_limit(p) {
        Ok(v) => Some(v),
        Err(error) => {
            issues.push(error.message);
            None
        }
    };
    let before = match optional_id(p, "before") {
        Ok(v) => v.map(str::to_owned),
        Err(error) => {
            issues.push(error.message);
            None
        }
    };
    let repo = match optional_id(p, "repo") {
        Ok(v) => v.map(str::to_owned),
        Err(error) => {
            issues.push(error.message);
            None
        }
    };
    let states = match optional_states(p) {
        Ok(v) => v,
        Err(error) => {
            issues.push(error.message);
            None
        }
    };
    let executor = match optional_id(p, "executor") {
        Ok(v) => v.map(str::to_owned),
        Err(error) => {
            issues.push(error.message);
            None
        }
    };
    let since = match optional_since(p) {
        Ok(v) => v,
        Err(error) => {
            issues.push(error.message);
            None
        }
    };
    if !issues.is_empty() {
        return Err(invalid(issues.join("; ")));
    }
    Ok(ParsedListOptions {
        all: all.unwrap_or(false),
        limit,
        before,
        repo,
        states,
        executor,
        since,
    })
}

pub async fn task_list(
    ctx: &Ctx,
    params: Value,
    probe: SessionProbeParts,
) -> Result<Value, CoreError> {
    let parsed = parse_options(&params)?;
    let state_refs = parsed
        .states
        .as_ref()
        .map(|values| values.iter().map(String::as_str).collect::<Vec<_>>());
    let state_slice = state_refs.as_deref();
    let options = TaskListOptions {
        all: parsed.all,
        limit: parsed.limit,
        before: parsed.before.as_deref(),
        repo: parsed.repo.as_deref(),
        states: state_slice,
        executor: parsed.executor.as_deref(),
        since: parsed.since,
    };
    let mut store = TaskStore::open(&ctx.pacer_home)
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    let alive_pids = probe.alive_pids;
    let alive = move |pid: i64| alive_pids.contains(&pid);
    tasks::task_list_page(ctx, &probe.active, &mut store, &options, &alive)
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use pacer_foundation::Ctx;
    use std::collections::HashMap;
    use tempfile::tempdir;

    fn ctx_with_tasks() -> (tempfile::TempDir, Ctx) {
        let dir = tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let pacer_home = home.join(".pacer");
        std::fs::create_dir_all(pacer_home.join("state")).unwrap();
        std::fs::create_dir_all(pacer_home.join("tasks")).unwrap();
        let now = 100.0;
        let mut store = TaskStore::open(&pacer_home).unwrap();
        for (index, state) in ["done", "done", "failed"].iter().enumerate() {
            let id = format!("t-20261106-00000{index}-abcd");
            store
                .insert(
                    &json!({
                        "id": id,
                        "rev": 1,
                        "brief": {"goal": format!("Goal {index}"), "repo": home.to_string_lossy()},
                        "state": state,
                        "createdAt": now + f64::from(index as u32),
                        "attempts": [],
                        "timeoutS": 60,
                        "requestedExecutor": "cursor",
                        "executor": "cursor",
                    }),
                    now + f64::from(index as u32),
                )
                .unwrap();
        }
        let ctx = Ctx::with(home, pacer_home, HashMap::new(), now + 10.0);
        (dir, ctx)
    }

    #[test]
    fn parse_probe_parts_builds_counts_and_alive_set() {
        let parts = parse_probe_parts(json!({
            "revision": "abc",
            "active": [{"task_id": "t-1", "executor": "codex"}, {"task_id": "t-1", "executor": "cursor"}],
            "alivePids": [42.0, 9007199254740991.0]
        }))
        .unwrap();
        assert_eq!(parts.active.task("t-1"), 2);
        assert!(parts.alive_pids.contains(&42));
    }

    #[tokio::test]
    async fn task_list_pages_done_tasks() {
        let (_dir, ctx) = ctx_with_tasks();
        let probe = SessionProbeParts {
            active: ActiveCounts::default(),
            alive_pids: HashSet::new(),
        };
        let page = task_list(&ctx, json!({"states": ["done"], "limit": 2}), probe)
            .await
            .unwrap();
        assert_eq!(page["tasks"].as_array().unwrap().len(), 2);
        assert!(page["next"].is_null());
    }
}
