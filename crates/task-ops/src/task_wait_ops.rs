#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Map, Value};

use super::lifecycle_ops::{invalid, object, require_string};

/// Native effects of `task.wait`, implemented in `pacer-server` over
/// `pacer_delegation::wait`. The settle probe is gone.
pub trait WaitEffects: Send + Sync {
    fn wait<'a>(
        &'a self,
        ctx: &'a Ctx,
        id: &'a str,
        timeout_s: u32,
    ) -> OpFuture<'a>;
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

/// `timeout_s` is 1..=3000 and defaults to 600, as the operation schema says.
fn timeout_s(params: &Map<String, Value>) -> Result<u32, CoreError> {
    match params.get("timeout_s") {
        None | Some(Value::Null) => Ok(600),
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
            Ok(n as u32)
        }
    }
}

/// Validate the operation and dispatch to the native wait effect.
pub fn task_wait<'a>(
    ctx: &'a Ctx,
    params: Value,
    effects: &'a dyn WaitEffects,
) -> OpFuture<'a> {
    Box::pin(async move {
        let p = object(&params)?;
        let id = require_task_id(p, "id")?;
        let seconds = timeout_s(p)?;
        effects.wait(ctx, &id, seconds).await
    })
}

/// Fallback in the registry; the doors dispatch `task.wait` before `call_native`.
pub fn task_wait_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "task wait effects unavailable",
        ))
    })
}
