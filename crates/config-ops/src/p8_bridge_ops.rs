//! P9 `setup.check`, validated in Rust and executed via the TypeScript core bridge.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{CoreError, OpFuture},
};
use serde_json::Value;

use crate::host_read_ops::{invalid, object};

pub fn needs_core_bridge(op: &str) -> bool {
    op == "setup.check"
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

pub fn bridge_params(op: &str, params: &Value) -> Result<Value, CoreError> {
    match op {
        "setup.check" => {
            empty_object(params)?;
            Ok(params.clone())
        }
        _ => Err(invalid("unknown core bridge op")),
    }
}
