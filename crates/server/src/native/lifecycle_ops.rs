//! Safe P6 lifecycle ops that do not need the runner, plugins or supervision:
//! currently `task.request_review`. After P6c, delegate/stop/answer/wait/retry/
//! review/ask remain forwarded: policy, spawn, supervision, messaging and session
//! gates stay on TypeScript. P6b/`run_spawn` pins the `_run` plan; P6e-run adds
//! drain launch guards and a gated ProcessOwner spawn spec; P6c adds
//! store-only `record_review_verdict` (accept/reject fields) without registering
//! `task.review`. P6d adds `record_task_stop` and `task_wait_settled`; P6 stop
//! registers selective native `task.stop` when the Core probe reports no managed
//! work or live agent session (effects bridge otherwise). P6 wait registers
//! selective native `task.wait` when the Core probe reports the task already
//! settled (no agent-session holds); active tasks still forward for drain/supervise.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    js_semantics::JsTrim,
};
use pacer_lifecycle::{RequestReviewError, request_review};
use pacer_read_model::{ActiveCounts, tasks as read_tasks};
use pacer_store::TaskStore;
use serde_json::{Map, Value, json};

pub(super) fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

pub(super) fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub(super) fn object(params: &Value) -> Result<&Map<String, Value>, CoreError> {
    params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(params)
        ))
    })
}

pub(super) fn require_string<'a>(
    params: &'a Map<String, Value>,
    name: &str,
) -> Result<&'a str, CoreError> {
    match params.get(name) {
        Some(Value::String(s)) => Ok(s.as_str()),
        Some(other) => Err(invalid(format!(
            "{name}: Invalid input: expected string, received {}",
            type_name(other)
        ))),
        None => Err(invalid(format!(
            "{name}: Invalid input: expected string, received undefined"
        ))),
    }
}

pub(super) fn optional_expect_rev(params: &Map<String, Value>) -> Result<Option<f64>, CoreError> {
    match params.get("expect_rev") {
        None => Ok(None),
        Some(Value::Null) => Ok(None),
        Some(value) if !value.is_number() => Err(invalid(format!(
            "expect_rev: Invalid input: expected number, received {}",
            type_name(value)
        ))),
        Some(value) => {
            let Some(n) = value.as_f64() else {
                return Err(invalid(
                    "expect_rev: Invalid input: expected int, received number",
                ));
            };
            if !n.is_finite() || n.fract() != 0.0 {
                return Err(invalid(
                    "expect_rev: Invalid input: expected int, received number",
                ));
            }
            if n < 1.0 {
                return Err(invalid("expect_rev: Too small: expected number to be >=1"));
            }
            if n > 9_007_199_254_740_991.0 {
                return Err(invalid(
                    "expect_rev: Too big: expected int to be <=9007199254740991",
                ));
            }
            Ok(Some(n))
        }
    }
}

pub(super) fn project_api_task(
    ctx: &Ctx,
    store: &mut TaskStore,
    task: &Value,
) -> Result<Value, CoreError> {
    let rows = read_tasks::api_tasks(
        ctx,
        &ActiveCounts::default(),
        std::slice::from_ref(task),
        store,
        &|_| false,
    )
    .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    rows.into_iter()
        .next()
        .ok_or_else(|| CoreError::new(Code::Internal, "request_review projection produced no task"))
}

fn map_error(ctx: &Ctx, store: &mut TaskStore, error: RequestReviewError) -> CoreError {
    match error {
        RequestReviewError::InvalidInput(message) => invalid(message),
        RequestReviewError::UnknownTask(id) => {
            CoreError::new(Code::UnknownTask, format!("unknown task {id}"))
        }
        RequestReviewError::Conflict { message, task } => {
            let projected = if task.is_null() {
                None
            } else {
                project_api_task(ctx, store, &task).ok()
            };
            let mut err = CoreError::new(Code::Conflict, message);
            if let Some(task) = projected {
                let mut data = Map::new();
                data.insert("task".into(), task);
                err = err.data(data);
            }
            err
        }
        RequestReviewError::Store(error) => CoreError::new(Code::Internal, error.to_string()),
    }
}

pub(super) fn task_request_review(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let p = object(&params)?;
        let id = require_string(p, "id")?;
        let id_units = id.encode_utf16().count();
        if id.is_empty() {
            return Err(invalid(
                "id: Too small: expected string to have >=1 characters",
            ));
        }
        if id_units > 128 {
            return Err(invalid(
                "id: Too big: expected string to have <=128 characters",
            ));
        }
        let note = require_string(p, "note")?;
        // Zod `.trim().min(1).max(2000)` before the library's defensive check.
        let trimmed = note.js_trim();
        let note_units = trimmed.encode_utf16().count();
        if trimmed.is_empty() {
            return Err(invalid(
                "note: Too small: expected string to have >=1 characters",
            ));
        }
        if note_units > 2000 {
            return Err(invalid(
                "note: Too big: expected string to have <=2000 characters",
            ));
        }
        let expect_rev = optional_expect_rev(p)?;
        let mut store = TaskStore::open(&ctx.pacer_home)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        let task = match request_review(&mut store, id, trimmed, expect_rev, ctx.now) {
            Ok(task) => task,
            Err(error) => return Err(map_error(ctx, &mut store, error)),
        };
        let api = project_api_task(ctx, &mut store, &task)?;
        Ok(json!({"task": api}))
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use pacer_foundation::Ctx;
    use std::collections::HashMap;
    use tempfile::tempdir;

    fn ctx_with_task(now: f64) -> (tempfile::TempDir, Ctx, String) {
        let dir = tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let pacer_home = home.join(".pacer");
        std::fs::create_dir_all(pacer_home.join("state")).unwrap();
        std::fs::create_dir_all(pacer_home.join("tasks")).unwrap();
        let mut store = TaskStore::open(&pacer_home).unwrap();
        let id = "t-20261106-000000-abcd";
        store
            .insert(
                &json!({
                    "id": id,
                    "rev": 1,
                    "brief": {"goal": "Review permissions", "repo": home.to_string_lossy()},
                    "state": "queued",
                    "createdAt": now,
                    "attempts": [],
                    "timeoutS": 60,
                    "requestedExecutor": null,
                }),
                now,
            )
            .unwrap();
        store
            .update(id, 1, now, |t| t["state"] = json!("done"))
            .unwrap();
        let ctx = Ctx::with(home, pacer_home, HashMap::new(), now);
        (dir, ctx, id.into())
    }

    #[tokio::test]
    async fn request_review_returns_api_task() {
        let (_dir, ctx, id) = ctx_with_task(10.0);
        let result = task_request_review(
            &ctx,
            json!({"id": id, "note": "  Check access  ", "expect_rev": 2}),
        )
        .await
        .unwrap();
        assert_eq!(result["task"]["id"], id);
        assert_eq!(result["task"]["rev"], 3);
        assert_eq!(result["task"]["reviewRequest"]["note"], "Check access");
        assert_eq!(result["task"]["acceptanceState"], "none");
    }
}
