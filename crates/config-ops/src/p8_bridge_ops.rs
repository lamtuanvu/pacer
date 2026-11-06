//! P8/P9 ops validated in Rust and executed via the TypeScript core bridge.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{CoreError, OpFuture},
};
use serde_json::Value;

use crate::params::{invalid, object, type_name};

pub fn needs_core_bridge(op: &str) -> bool {
    matches!(op, "setup.check" | "repo.list" | "repo.add")
}

pub fn bridge_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(pacer_foundation::api::CoreError::new(
            pacer_foundation::api::Code::Unavailable,
            "core bridge unavailable",
        ))
    })
}

fn empty_object(params: &Value) -> Result<(), CoreError> {
    let map = object(params)?;
    if !map.is_empty() {
        return Err(invalid("params: Unrecognized key(s) in object"));
    }
    Ok(())
}

fn parse_repo_add(params: &Value) -> Result<Value, CoreError> {
    let map = object(params)?;
    for key in map.keys() {
        if key != "path" {
            return Err(invalid("params: Unrecognized key(s) in object"));
        }
    }
    let path = map
        .get("path")
        .ok_or_else(|| invalid("path: Invalid input: expected string, received undefined"))?;
    let text = path.as_str().ok_or_else(|| {
        invalid(format!(
            "path: Invalid input: expected string, received {}",
            type_name(path)
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
    Ok(serde_json::json!({"path": text}))
}

pub fn bridge_params(op: &str, params: &Value) -> Result<Value, CoreError> {
    match op {
        "setup.check" | "repo.list" => {
            empty_object(params)?;
            Ok(params.clone())
        }
        "repo.add" => parse_repo_add(params),
        _ => Err(invalid("unknown core bridge op")),
    }
}
