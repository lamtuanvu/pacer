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

fn optional_query(params: &Map<String, Value>, name: &str) -> Result<Option<String>, CoreError> {
    match params.get(name) {
        None => Ok(None),
        // An empty string fails the schema's min(1); other whitespace-only
        // queries are treated as absent, like TypeScript (a whitespace `q`
        // passes zod and splits into no words, so nothing is filtered).
        Some(Value::String(value)) if value.is_empty() => Err(invalid(format!(
            "{name}: Too small: expected string to have >=1 characters"
        ))),
        Some(Value::String(value)) if value.trim().is_empty() => Ok(None),
        Some(Value::String(value)) => {
            if value.encode_utf16().count() > 200 {
                return Err(invalid(format!(
                    "{name}: Too big: expected string to have <=200 characters"
                )));
            }
            Ok(Some(value.to_owned()))
        }
        Some(other) => Err(invalid(format!(
            "{name}: Invalid input: expected string, received {}",
            type_name(other)
        ))),
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
    query: Option<String>,
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
    let query = match optional_query(p, "q") {
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
        query,
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
        query: parsed.query.as_deref(),
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

    fn probe_parts() -> SessionProbeParts {
        SessionProbeParts {
            active: ActiveCounts::default(),
            alive_pids: HashSet::new(),
        }
    }

    #[tokio::test]
    async fn task_list_pages_done_tasks() {
        let (_dir, ctx) = ctx_with_tasks();
        let page = task_list(&ctx, json!({"states": ["done"], "limit": 2}), probe_parts())
            .await
            .unwrap();
        assert_eq!(page["tasks"].as_array().unwrap().len(), 2);
        assert!(page["next"].is_null());
    }

    #[tokio::test]
    async fn task_list_query_filters_by_id_suffix_and_goal_words() {
        let (_dir, ctx) = ctx_with_tasks();
        // One row whose goal words collide with no other row's id or goal.
        {
            let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
            store
                .insert(
                    &json!({
                        "id": "t-20261106-000003-ffff",
                        "rev": 1,
                        "brief": {"goal": "Payments webhook timeout", "repo": ctx.pacer_home.to_string_lossy()},
                        "state": "done",
                        "createdAt": 103.0,
                        "attempts": [],
                        "timeoutS": 60,
                        "requestedExecutor": "cursor",
                        "executor": "cursor",
                    }),
                    103.0,
                )
                .unwrap();
        }
        // Fixture ids: t-20261106-000000-abcd … -000002-abcd; goals "Goal 0" … "Goal 2".
        let page = task_list(&ctx, json!({"q": "000001"}), probe_parts())
            .await
            .unwrap();
        assert_eq!(page["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(page["tasks"][0]["id"], "t-20261106-000001-abcd");
        // Case-insensitive goal words across the fixture rows.
        let page = task_list(&ctx, json!({"q": "GOAL"}), probe_parts())
            .await
            .unwrap();
        assert_eq!(page["tasks"].as_array().unwrap().len(), 3);
        // Every word must appear in the same row: one row has the id fragment, another the goal word.
        let page = task_list(&ctx, json!({"q": "payments 000001"}), probe_parts())
            .await
            .unwrap();
        assert_eq!(page["tasks"].as_array().unwrap().len(), 0);
        // A whitespace-only query is treated as absent.
        let page = task_list(&ctx, json!({"q": "   "}), probe_parts())
            .await
            .unwrap();
        assert_eq!(page["tasks"].as_array().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn task_list_rejects_an_empty_query_like_the_frozen_schema() {
        let (_dir, ctx) = ctx_with_tasks();
        let error = task_list(&ctx, json!({"q": ""}), probe_parts())
            .await
            .unwrap_err();
        assert_eq!(error.code, Code::InvalidInput);
        assert_eq!(
            error.message,
            "q: Too small: expected string to have >=1 characters"
        );
    }

    #[tokio::test]
    async fn task_list_query_folds_unicode_titles_and_goals() {
        let (_dir, ctx) = ctx_with_tasks();
        // A row whose title words collide with no other row's id or goal, and a
        // goal in another script.
        {
            let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
            for (id, title, goal) in [
                ("t-20261106-000003-ffff", "Überprüfung der Gateways", ""),
                ("t-20261106-000004-ffff", "", "Đồng bộ Élan cache"),
            ] {
                store
                    .insert(
                        &json!({
                            "id": id,
                            "rev": 1,
                            "title": title,
                            "brief": {"goal": goal, "repo": ctx.pacer_home.to_string_lossy()},
                            "state": "done",
                            "createdAt": 103.0,
                            "attempts": [],
                            "timeoutS": 60,
                            "requestedExecutor": "cursor",
                            "executor": "cursor",
                        }),
                        103.0,
                    )
                    .unwrap();
            }
        }
        // Lower-case, upper-case and the exact word all find the same rows,
        // folded per character on the decoded records in both runtimes.
        let page = task_list(&ctx, json!({"q": "überprüfung"}), probe_parts())
            .await
            .unwrap();
        assert_eq!(page["tasks"][0]["id"], "t-20261106-000003-ffff");
        let page = task_list(&ctx, json!({"q": "ÜBER"}), probe_parts())
            .await
            .unwrap();
        assert_eq!(page["tasks"][0]["id"], "t-20261106-000003-ffff");
        let page = task_list(&ctx, json!({"q": "đồng bộ"}), probe_parts())
            .await
            .unwrap();
        assert_eq!(page["tasks"][0]["id"], "t-20261106-000004-ffff");
        let page = task_list(&ctx, json!({"q": "ĐỒNG ÉLAN"}), probe_parts())
            .await
            .unwrap();
        assert_eq!(page["tasks"][0]["id"], "t-20261106-000004-ffff");
        // Every word must appear: the ASCII word rides the SQL filter, the
        // Unicode word is folded after decoding.
        let page = task_list(&ctx, json!({"q": "cache t-2026"}), probe_parts())
            .await
            .unwrap();
        assert_eq!(page["tasks"][0]["id"], "t-20261106-000004-ffff");
    }

    #[tokio::test]
    async fn task_list_rejects_query_over_200_code_units_or_of_the_wrong_type() {
        let (_dir, ctx) = ctx_with_tasks();
        let error = task_list(&ctx, json!({"q": "a".repeat(201)}), probe_parts())
            .await
            .unwrap_err();
        assert_eq!(error.code, Code::InvalidInput);
        let error = task_list(&ctx, json!({"q": 5}), probe_parts())
            .await
            .unwrap_err();
        assert_eq!(error.code, Code::InvalidInput);
        // 200 code units (100 surrogate pairs) stay inside the limit, like TypeScript's length.
        let page = task_list(&ctx, json!({"q": "😀".repeat(100)}), probe_parts())
            .await
            .unwrap();
        assert_eq!(page["tasks"].as_array().unwrap().len(), 0);
    }
}
