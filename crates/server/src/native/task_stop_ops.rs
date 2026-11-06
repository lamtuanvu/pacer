#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::{RecordStopError, record_task_stop};
use pacer_read_model::tasks::task_data;
use pacer_store::{TaskStore, publish};
use serde_json::{Map, Value, json};

use super::lifecycle_ops::{invalid, object, optional_expect_rev, project_api_task, require_string};

pub(crate) fn needs_task_stop_bridge(op: &str) -> bool {
    matches!(op, "task.stop")
}

pub(crate) fn task_stop_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "task stop effects bridge unavailable",
        ))
    })
}

fn publish_report(report: pacer_store::PublishReport) {
    for error in report.errors {
        eprintln!("pacer: task.stop publication failed: {error}");
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

fn map_stop_error(ctx: &Ctx, store: &mut TaskStore, error: RecordStopError) -> CoreError {
    match error {
        RecordStopError::InvalidInput(message) => invalid(message),
        RecordStopError::UnknownTask(id) => {
            CoreError::new(Code::UnknownTask, format!("unknown task {id}"))
        }
        RecordStopError::Conflict { message, task } => {
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
        RecordStopError::Store(error) => CoreError::new(Code::Internal, error.to_string()),
    }
}

pub(crate) fn task_stop<'a>(
    ctx: &'a Ctx,
    params: Value,
    probe: Value,
    effects: OpFuture<'a>,
) -> OpFuture<'a> {
    Box::pin(async move {
        let p = object(&params)?;
        let id = require_task_id(p, "id")?;
        let expect_rev = optional_expect_rev(p)?;
        let runner_alive = probe
            .get("runnerAlive")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut store = TaskStore::open(&ctx.pacer_home)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        let task = match record_task_stop(&mut store, &id, expect_rev, ctx.now, runner_alive) {
            Ok(task) => task,
            Err(error) => return Err(map_stop_error(ctx, &mut store, error)),
        };
        let event = json!({"type":"task","data": task_data(&task, &|_| false)});
        publish_report(publish(ctx, &[event]));
        effects.await
    })
}
