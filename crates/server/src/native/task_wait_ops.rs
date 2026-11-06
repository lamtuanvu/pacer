#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::task_wait_settled;
use pacer_store::TaskStore;
use serde_json::{Map, Value};

use super::lifecycle_ops::{invalid, object, require_string};
use super::task_reads::summarize_api_task;

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

fn optional_timeout_s(params: &Map<String, Value>) -> Result<(), CoreError> {
    match params.get("timeout_s") {
        None => Ok(()),
        Some(Value::Null) => Ok(()),
        Some(value) if !value.is_number() => Err(invalid(format!(
            "timeout_s: Invalid input: expected number, received {}",
            super::lifecycle_ops::type_name(value)
        ))),
        Some(value) => {
            let Some(n) = value.as_f64() else {
                return Err(invalid(
                    "timeout_s: Invalid input: expected int, received number",
                ));
            };
            if !n.is_finite() || n.fract() != 0.0 {
                return Err(invalid(
                    "timeout_s: Invalid input: expected int, received number",
                ));
            }
            if n < 1.0 {
                return Err(invalid("timeout_s: Too small: expected number to be >=1"));
            }
            if n > 3000.0 {
                return Err(invalid("timeout_s: Too big: expected number to be <=3000"));
            }
            Ok(())
        }
    }
}

pub(crate) fn task_wait(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let p = object(&params)?;
        let id = require_task_id(p, "id")?;
        optional_timeout_s(p)?;
        let mut store = TaskStore::open(&ctx.pacer_home)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        let task = store
            .read(&id)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        let Some(task) = task else {
            return Err(CoreError::new(
                Code::UnknownTask,
                format!("unknown task {id}"),
            ));
        };
        if !task_wait_settled(&task, false, false) {
            return Err(CoreError::new(
                Code::Unavailable,
                "task wait requires supervision while the task is active",
            ));
        }
        Ok(summarize_api_task(&task))
    })
}
