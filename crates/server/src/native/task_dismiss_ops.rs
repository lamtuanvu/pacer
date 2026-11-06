#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::{DismissError, dismiss_tasks};
use pacer_read_model::tasks::{full_title, task_data};
use pacer_store::{TaskStore, append_activity, publish};
use serde_json::{Map, Value, json};

use super::lifecycle_ops::{invalid, object, optional_expect_rev, project_api_task, type_name};

pub(crate) fn needs_task_clean_bridge(op: &str) -> bool {
    matches!(op, "task.dismiss")
}

pub(crate) fn ids_from_params(params: &Value) -> Result<Vec<String>, CoreError> {
    let p = object(params)?;
    let ids_value = p
        .get("ids")
        .ok_or_else(|| invalid("ids: Invalid input: expected array, received undefined"))?;
    let Some(ids_array) = ids_value.as_array() else {
        return Err(invalid(format!(
            "ids: Invalid input: expected array, received {}",
            type_name(ids_value)
        )));
    };
    let mut ids = Vec::with_capacity(ids_array.len());
    for (index, value) in ids_array.iter().enumerate() {
        let Some(id) = value.as_str() else {
            return Err(invalid(format!(
                "ids.{index}: Invalid input: expected string, received {}",
                type_name(value)
            )));
        };
        ids.push(id.to_owned());
    }
    Ok(ids)
}

pub(crate) fn task_dismiss_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "task clean bridge unavailable",
        ))
    })
}

fn executor_for(task: &Value) -> Option<String> {
    let attempts = task.get("attempts").and_then(Value::as_array);
    let last = attempts.and_then(|a| a.last()).unwrap_or(&Value::Null);
    for key in ["result", "executor", "requestedExecutor"] {
        if key == "result" {
            if let Some(v) = task.pointer("/result/executor").and_then(Value::as_str)
                && !v.is_empty()
            {
                return Some(v.to_owned());
            }
            continue;
        }
        if let Some(v) = task.get(key).and_then(Value::as_str)
            && !v.is_empty()
        {
            return Some(v.to_owned());
        }
        if let Some(v) = last.get(key).and_then(Value::as_str)
            && !v.is_empty()
        {
            return Some(v.to_owned());
        }
    }
    None
}

fn repo_for(task: &Value) -> Option<String> {
    task.get("repo")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            task.pointer("/brief/repo")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        })
}

fn map_error(ctx: &Ctx, store: &mut TaskStore, error: DismissError) -> CoreError {
    match error {
        DismissError::InvalidInput(message) => invalid(message),
        DismissError::Conflict { message, task } => {
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
        DismissError::Store(error) => CoreError::new(Code::Internal, error.to_string()),
    }
}

fn publish_report(report: pacer_store::PublishReport) {
    for error in report.errors {
        eprintln!("pacer: task.dismiss publication failed: {error}");
    }
}

pub(crate) fn task_dismiss<'a>(ctx: &'a Ctx, params: Value, clean: OpFuture<'a>) -> OpFuture<'a> {
    Box::pin(async move {
        let p = object(&params)?;
        let expect_rev = optional_expect_rev(p)?;
        let ids_value = p
            .get("ids")
            .ok_or_else(|| invalid("ids: Invalid input: expected array, received undefined"))?;
        let Some(ids_array) = ids_value.as_array() else {
            return Err(invalid(format!(
                "ids: Invalid input: expected array, received {}",
                type_name(ids_value)
            )));
        };
        if ids_array.is_empty() || ids_array.len() > 100 {
            return Err(invalid("ids: Invalid input: expected array length 1–100"));
        }
        let mut ids = Vec::with_capacity(ids_array.len());
        for (index, value) in ids_array.iter().enumerate() {
            let Some(id) = value.as_str() else {
                return Err(invalid(format!(
                    "ids.{index}: Invalid input: expected string, received {}",
                    type_name(value)
                )));
            };
            ids.push(id.to_owned());
        }
        let mut store = TaskStore::open(&ctx.pacer_home)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        let batch = match dismiss_tasks(&mut store, &ids, expect_rev, ctx.now) {
            Ok(batch) => batch,
            Err(error) => return Err(map_error(ctx, &mut store, error)),
        };
        let dismissed_ids: Vec<String> = batch
            .dismissed
            .iter()
            .filter_map(|t| t.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect();
        for task in &batch.dismissed {
            let title = full_title(task);
            let mut activity = json!({
                "kind": "verdict",
                "level": "info",
                "text": format!("Dismissed “{title}”"),
                "taskId": task["id"],
            });
            if let Some(repo) = repo_for(task) {
                activity["repo"] = json!(repo);
            }
            if let Some(executor) = executor_for(task) {
                activity["executor"] = json!(executor);
            }
            if let Some(host) = task.pointer("/run/host").and_then(Value::as_str) {
                activity["host"] = json!(host);
            }
            append_activity(ctx, activity).map_err(|error| invalid(error.to_string()))?;
            let event = json!({"type":"task","data": task_data(task, &|_| false)});
            publish_report(publish(ctx, &[event]));
        }
        clean.await?;
        Ok(json!({
            "dismissed": dismissed_ids,
            "unknown": batch.unknown,
        }))
    })
}
