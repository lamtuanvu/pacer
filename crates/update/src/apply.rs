//! Native `update.apply` (`applyUpdate` in `src/api/ops.ts`).
//!
//! Rust owns the `parseOpParams` refusals and the empty schema. The install-method preflight
//! (package-manager and source installs are refused) and the shared update job (download,
//! verify, replace, refresh integrations, restart) run in Core: over HTTP through its private
//! effects bridge (`/_internal/update-effects`), over stdio as the forwarded request.
use crate::{Code, CoreError, object, refuse_enforcement};
use pacer_foundation::{Ctx, api::OpFuture};
use serde_json::{Value, json};

const UPGRADE_REFUSAL: &str =
    "PACER_ROLE=executor: upgrades are not allowed from a delegated task.";

/// One Core effect per call; requests are `{"kind": ...}` objects.
pub trait UpdateEffects: Send {
    fn call(&mut self, request: Value) -> OpFuture<'_>;
}

/// Ops a front door dispatches through [`update_apply`] with a Core effects bridge.
pub fn uses_effects(op: &str) -> bool {
    op == "update.apply"
}

/// Registry entry for `update.apply`, which runs only with a Core effects bridge.
pub fn update_apply_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "update effects bridge unavailable",
        ))
    })
}

/// Work-grant callers, whose scope Core checks.
pub fn stays_forwarded(ctx: &Ctx) -> bool {
    ctx.env
        .get("PACER_WORK_GRANT")
        .is_some_and(|grant| !grant.is_empty())
}

/// The refusals and schema; an admitted request is the reference operation's to run.
pub fn admit(ctx: &Ctx, params: &Value) -> Result<(), CoreError> {
    if ctx.env.get("PACER_ROLE").map(String::as_str) == Some("executor") {
        return Err(CoreError::new(Code::NotAllowed, UPGRADE_REFUSAL));
    }
    refuse_enforcement(ctx)?;
    object(params).map(drop)
}

pub async fn update_apply(
    ctx: &Ctx,
    params: Value,
    effects: &mut dyn UpdateEffects,
) -> Result<Value, CoreError> {
    admit(ctx, &params)?;
    effects.call(json!({"kind": "apply"})).await
}
