//! Parameter validation and Core requests of `setup.check`, `setup.health` and
//! `doctor.run`; `doctor_ops::run` answers them from the parts Core returns.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{CoreError, OpFuture},
};
use serde_json::{Value, json};

use crate::desktop_capture_ops;
use crate::doctor_ops;
use crate::host_read_ops::invalid;
use crate::repo_registry_ops::params_object;

pub fn needs_core_bridge(op: &str) -> bool {
    op == "setup.check"
        || desktop_capture_ops::needs_capture_bridge(op)
        || doctor_ops::needs_setup_doctor_bridge(op)
}

pub fn bridge_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(pacer_foundation::api::CoreError::new(
            pacer_foundation::api::Code::Unavailable,
            "core bridge unavailable",
        ))
    })
}

pub fn bridge_params(op: &str, params: &Value) -> Result<Value, CoreError> {
    match op {
        // The stripping `z.object({})`: `null` reads as `{}` and other keys are dropped.
        "setup.check" => {
            params_object(params)?;
            Ok(json!({}))
        }
        op if desktop_capture_ops::needs_capture_bridge(op) => {
            desktop_capture_ops::bridge_params(op, params)
        }
        op if doctor_ops::needs_setup_doctor_bridge(op) => doctor_ops::bridge_params(op, params),
        _ => Err(invalid("unknown core bridge op")),
    }
}
