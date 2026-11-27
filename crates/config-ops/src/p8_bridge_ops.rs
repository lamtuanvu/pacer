//! Parameter validation and Core requests of `setup.check`, `setup.health` and
//! `doctor.run`; `doctor_ops::run` answers them from the parts Core returns.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{CoreError, OpFuture},
};
use serde_json::{Map, Value, json};

use crate::desktop_capture_ops;
use crate::desktop_update_ops;
use crate::host_read_ops::invalid;
use crate::repo_registry_ops::params_object;

const TRIGGERS: [&str; 3] = ["startup", "update", "manual"];

/// `trigger: z.enum(["startup", "update", "manual"]).optional()`; other keys are stripped.
fn setup_health_params(params: &Value) -> Result<Map<String, Value>, CoreError> {
    let map = params_object(params)?;
    let mut parsed = Map::new();
    if let Some(trigger) = map.get("trigger") {
        match trigger.as_str() {
            Some(name) if TRIGGERS.contains(&name) => {
                parsed.insert("trigger".into(), name.into());
            }
            _ => {
                return Err(invalid(
                    r#"trigger: Invalid option: expected one of "startup"|"update"|"manual""#,
                ));
            }
        }
    }
    Ok(parsed)
}

/// The doctor bridge request: the op and its parsed params. `doctor_ops` moved to
/// `pacer-setup-ops` (B6-2); this file keeps a copy for the transitional doctor
/// arms until B6-5 retires them.
fn doctor_bridge_params(op: &str, params: &Value) -> Result<Value, CoreError> {
    let parsed = match op {
        "doctor.run" => {
            params_object(params)?;
            Map::new()
        }
        "setup.health" => setup_health_params(params)?,
        _ => return Err(invalid("unknown core bridge op")),
    };
    Ok(json!({ "op": op, "params": parsed }))
}

pub fn needs_core_bridge(op: &str) -> bool {
    desktop_capture_ops::needs_capture_bridge(op)
        || desktop_update_ops::needs_update_bridge(op)
        || matches!(op, "setup.health" | "doctor.run")
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
        op if desktop_capture_ops::needs_capture_bridge(op) => {
            desktop_capture_ops::bridge_params(op, params)
        }
        op if desktop_update_ops::needs_update_bridge(op) => {
            desktop_update_ops::bridge_params(op, params)
        }
        op if matches!(op, "setup.health" | "doctor.run") => doctor_bridge_params(op, params),
        _ => Err(invalid("unknown core bridge op")),
    }
}
