#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::work_node_exists;
use pacer_store::TaskStore;
use serde_json::{Map, Value};

use super::lifecycle_ops::{invalid, object, optional_expect_rev, require_string};

/// Native effects of `task.stop`, implemented in `pacer-server` over
/// `pacer_delegation::stop`. The bridge probe and post-store effects are gone.
pub trait StopEffects: Send + Sync {
    /// Port of `taskStop` plus `taskStopAfterStore` for a human-started task.
    fn stop<'a>(
        &'a self,
        ctx: &'a Ctx,
        id: &'a str,
        signal: bool,
        expect_rev: Option<i64>,
    ) -> OpFuture<'a>;

    /// Port of `stopWork` for a managed root and its descendants.
    fn stop_work<'a>(
        &'a self,
        ctx: &'a Ctx,
        id: &'a str,
        expect_rev: Option<i64>,
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

fn managed(ctx: &Ctx, id: &str) -> bool {
    TaskStore::open(&ctx.pacer_home)
        .ok()
        .and_then(|mut store| work_node_exists(&mut store, id))
        .unwrap_or(false)
}

/// Validate the operation and dispatch to the native stop effect. `expect_rev`
/// is checked by the effect under the task lock, as `taskMutation` does in TS.
pub fn task_stop<'a>(
    ctx: &'a Ctx,
    params: Value,
    effects: &'a dyn StopEffects,
) -> OpFuture<'a> {
    Box::pin(async move {
        let p = object(&params)?;
        let id = require_task_id(p, "id")?;
        let expect_rev = optional_expect_rev(p)?.map(|rev| rev as i64);
        let signal = p.get("signal").and_then(Value::as_bool).unwrap_or(true);
        if managed(ctx, &id) {
            effects.stop_work(ctx, &id, expect_rev).await
        } else {
            effects.stop(ctx, &id, signal, expect_rev).await
        }
    })
}

/// Fallback in the registry; the doors dispatch `task.stop` before `call_native`.
pub fn task_stop_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "task stop effects unavailable",
        ))
    })
}
