#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::{CommandGit, DiffOptions, TaskDiffError, task_diff, task_diff_to_json};
use pacer_store::TaskStore;
use serde_json::Value;

use super::lifecycle_ops::{invalid, type_name};

fn parse_params(params: &Value) -> Result<(String, Option<String>), CoreError> {
    let map = params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(params)
        ))
    })?;
    let id_value = map.get("id").ok_or_else(|| invalid("id: Required"))?;
    let id = id_value.as_str().ok_or_else(|| {
        invalid(format!(
            "id: Invalid input: expected string, received {}",
            type_name(id_value)
        ))
    })?;
    if id.is_empty() {
        return Err(invalid(
            "id: Too small: expected string to have >=1 characters",
        ));
    }
    if id.encode_utf16().count() > 128 {
        return Err(invalid(
            "id: Too big: expected string to have <=128 characters",
        ));
    }
    let path = match map.get("path") {
        None => None,
        Some(value) => {
            let text = value.as_str().ok_or_else(|| {
                invalid(format!(
                    "path: Invalid input: expected string, received {}",
                    type_name(value)
                ))
            })?;
            if text.is_empty() {
                return Err(invalid(
                    "path: Too small: expected string to have >=1 characters",
                ));
            }
            if text.encode_utf16().count() > 4096 {
                return Err(invalid(
                    "path: Too big: expected string to have <=4096 characters",
                ));
            }
            if text.contains('\0') {
                return Err(invalid("path: path must not contain NUL"));
            }
            Some(text.to_owned())
        }
    };
    Ok((id.to_owned(), path))
}

fn map_error(id: &str, error: TaskDiffError) -> CoreError {
    match error {
        TaskDiffError::NotFound => {
            CoreError::new(Code::NotFound, format!("task \"{id}\" not found"))
        }
        TaskDiffError::InvalidInput(message) => invalid(message),
        TaskDiffError::Git(message) => invalid(message),
        TaskDiffError::Io(error) => CoreError::new(Code::Internal, error.to_string()),
        TaskDiffError::Json(error) => CoreError::new(Code::Internal, error.to_string()),
    }
}

pub(crate) fn task_diff_op(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    let ctx = ctx.clone();
    Box::pin(async move {
        tokio::task::spawn_blocking(move || task_diff_native(&ctx, params))
            .await
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?
    })
}

pub(crate) fn task_diff_native(ctx: &Ctx, params: Value) -> Result<Value, CoreError> {
    let (id, path) = parse_params(&params)?;
    let mut store = TaskStore::open(&ctx.pacer_home)
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    let task_value = store
        .read(&id)
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?
        .ok_or_else(|| CoreError::new(Code::NotFound, format!("task \"{id}\" not found")))?;
    let options = DiffOptions {
        path: path.as_deref(),
        summary_only: false,
        snapshot: false,
    };
    let git = CommandGit;
    let diff = task_diff(&ctx.pacer_home, &task_value, options, &git)
        .map_err(|error| map_error(&id, error))?;
    Ok(task_diff_to_json(&diff))
}
