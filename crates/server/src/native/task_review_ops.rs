#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::{RecordReviewError, record_review_verdict};
use pacer_read_model::tasks::task_data;
use pacer_store::{TaskStore, publish};
use serde_json::{Map, Value, json};

use super::lifecycle_ops::{invalid, object, optional_expect_rev, project_api_task, require_string, type_name};

pub(crate) fn needs_task_review_bridge(op: &str) -> bool {
    matches!(op, "task.review")
}

pub(crate) fn task_review_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "task review effects bridge unavailable",
        ))
    })
}

fn publish_report(report: pacer_store::PublishReport) {
    for error in report.errors {
        eprintln!("pacer: task.review publication failed: {error}");
    }
}

fn require_task_id(params: &Map<String, Value>, name: &str) -> Result<String, CoreError> {
    let id = require_string(params, name)?;
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
    Ok(id.to_owned())
}

fn optional_kind(params: &Map<String, Value>) -> Result<Option<String>, CoreError> {
    match params.get("kind") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(other) => Err(invalid(format!(
            "kind: Invalid input: expected string, received {}",
            type_name(other)
        ))),
    }
}

fn optional_note(params: &Map<String, Value>) -> Result<Option<String>, CoreError> {
    match params.get("note") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(other) => Err(invalid(format!(
            "note: Invalid input: expected string, received {}",
            type_name(other)
        ))),
    }
}

fn optional_expect_state(params: &Map<String, Value>) -> Result<Option<String>, CoreError> {
    match params.get("expect_state") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(other) => Err(invalid(format!(
            "expect_state: Invalid input: expected string, received {}",
            type_name(other)
        ))),
    }
}

fn parse_verdict(params: &Map<String, Value>) -> Result<(&'static str, bool), CoreError> {
    match require_string(params, "verdict")? {
        "accept" => Ok(("accept", true)),
        "reject" => Ok(("reject", false)),
        other => Err(invalid(format!(
            "verdict: Invalid option: expected one of \"accept\"|\"reject\"|\"send_back\"|\"retry\", received \"{other}\""
        ))),
    }
}

fn map_review_error(ctx: &Ctx, store: &mut TaskStore, error: RecordReviewError) -> CoreError {
    match error {
        RecordReviewError::InvalidInput(message) => invalid(message),
        RecordReviewError::UnknownTask(id) => {
            CoreError::new(Code::UnknownTask, format!("unknown task {id}"))
        }
        RecordReviewError::Conflict { message, task } => {
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
        RecordReviewError::Store(error) => CoreError::new(Code::Internal, error.to_string()),
    }
}

pub(crate) fn task_review<'a>(
    ctx: &'a Ctx,
    params: Value,
    _probe: Value,
    effects: OpFuture<'a>,
) -> OpFuture<'a> {
    Box::pin(async move {
        let p = object(&params)?;
        let id = require_task_id(p, "id")?;
        let (_verdict, accepted) = parse_verdict(p)?;
        let kind = optional_kind(p)?;
        let note = optional_note(p)?;
        let expect_rev = optional_expect_rev(p)?;
        let expect_state = optional_expect_state(p)?;
        let mut store = TaskStore::open(&ctx.pacer_home)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        if let Some(expected) = &expect_state {
            let current = store
                .read(&id)
                .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
            let Some(task) = current else {
                return Err(CoreError::new(Code::UnknownTask, format!("unknown task {id}")));
            };
            let state = task.get("state").and_then(Value::as_str).unwrap_or("");
            if state != expected.as_str() {
                let projected = project_api_task(ctx, &mut store, &task).ok();
                let mut err = CoreError::new(Code::Conflict, "task state changed");
                if let Some(task) = projected {
                    let mut data = Map::new();
                    data.insert("task".into(), task);
                    err = err.data(data);
                }
                return Err(err);
            }
        }
        let kind_ref = kind.as_deref();
        let note_ref = note.as_deref();
        let task = match record_review_verdict(
            &mut store,
            &id,
            accepted,
            kind_ref,
            note_ref,
            expect_rev,
            ctx.now,
        ) {
            Ok(task) => task,
            Err(error) => return Err(map_review_error(ctx, &mut store, error)),
        };
        let event = json!({"type":"task","data": task_data(&task, &|_| false)});
        publish_report(publish(ctx, &[event]));
        effects.await
    })
}
