//! Release-feed checks and the login service (`update.check`, `service.status`).
//!
//! Both handlers run their probes from Rust: the release feed through `ureq`, and the
//! service manager (`launchctl` or `systemctl --user`) as an argv subprocess (SEC-5).
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.

pub mod apply;
mod check;
mod feed;
pub mod handover;
mod js;
mod service;
#[cfg(test)]
mod tests;

pub use check::update_check;
pub use handover::{service_handover, service_work};
pub use service::service_status;

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use serde_json::{Map, Value};

/// `update.check` and `service.status` inputs that only the TypeScript core reproduces.
pub fn service_update_stays_forwarded(ctx: &Ctx, op: &str) -> bool {
    if ctx
        .env
        .get("PACER_ENFORCEMENT_TOKEN")
        .is_some_and(|token| !token.is_empty())
    {
        return false;
    }
    match op {
        "service.status" => service::stays_forwarded(ctx),
        "update.check" => check::stays_forwarded(ctx),
        _ => false,
    }
}

/// `authorizeWorkOperation`: an enforcement identity may only report a native child denial.
fn refuse_enforcement(ctx: &Ctx) -> Result<(), CoreError> {
    if ctx
        .env
        .get("PACER_ENFORCEMENT_TOKEN")
        .is_some_and(|token| !token.is_empty())
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial",
        ));
    }
    Ok(())
}

fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// A non-strict `z.object`: unknown keys are dropped; `null` params read as `{}`.
fn object(params: &Value) -> Result<Map<String, Value>, CoreError> {
    match params {
        Value::Null => Ok(Map::new()),
        Value::Object(map) => Ok(map.clone()),
        other => Err(CoreError::new(
            Code::InvalidInput,
            format!(
                "params: Invalid input: expected object, received {}",
                received(Some(other))
            ),
        )),
    }
}
