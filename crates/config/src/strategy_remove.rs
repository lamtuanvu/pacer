//! Conservative native named strategy removal.

use crate::strategy_list::use_selection;
use pacer_foundation::{
    Ctx,
    api::{
        error::{Code, CoreError},
        registry::NativeOp,
    },
    lock::{LockOptions, with_lock_async},
};
use rustix::fs::{AtFlags, CWD, Mode, OFlags, openat, unlinkat};
use serde_json::{Value, json};
use std::fs::File;

const HINT: &str =
    "Use strategy.list to choose a strategy and strategy.preview to validate a draft.";
const PROTECTED_HINT: &str = "Switch to another strategy first; default cannot be removed.";

fn changed() -> CoreError {
    CoreError::new(Code::Conflict, "strategy changed during removal; retry").hint(HINT)
}

fn unlink_named(ctx: &Ctx, name: &str) -> std::io::Result<()> {
    let pacer = File::from(openat(
        CWD,
        &ctx.pacer_home,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    let strategies = File::from(openat(
        &pacer,
        "strategies",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    unlinkat(&strategies, format!("{name}.yaml"), AtFlags::empty()).map_err(Into::into)
}

/// Forward unsupported input/file shapes to TypeScript before native dispatch.
pub fn requires_core_strategy_remove_parser(ctx: &Ctx, params: &Value) -> bool {
    use_selection(ctx, params).is_none()
}

async fn remove_op(ctx: &Ctx, params: Value) -> Result<Value, CoreError> {
    remove_op_with(ctx, params, || {}).await
}

async fn remove_op_with(
    ctx: &Ctx,
    params: Value,
    before_lock: impl FnOnce(),
) -> Result<Value, CoreError> {
    let (name, _) = use_selection(ctx, &params).ok_or_else(changed)?;
    before_lock();
    with_lock_async(ctx, "strategy", LockOptions::default(), || async {
        let (_, active) = use_selection(ctx, &params).ok_or_else(changed)?;
        if name == "default" || name == active {
            let which = if name == "default" {
                "default"
            } else {
                "active"
            };
            return Err(CoreError::new(
                Code::NotAllowed,
                format!("cannot delete the {which} strategy"),
            )
            .hint(PROTECTED_HINT));
        }
        unlink_named(ctx, &name)
            .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()).hint(HINT))?;
        pacer_store::record_strategy_change(ctx)
            .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()))?;
        Ok(json!({"removed":true}))
    })
    .await
    .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()))?
}

fn op(ctx: &Ctx, params: Value) -> pacer_foundation::api::registry::OpFuture<'_> {
    Box::pin(remove_op(ctx, params))
}

pub fn ops() -> &'static [NativeOp] {
    &[NativeOp {
        name: "strategy.remove",
        call: op,
    }]
}

#[cfg(test)]
mod tests;
