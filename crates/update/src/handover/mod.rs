//! `service.handover` and `service.work`: running work inventory for post-upgrade reopen.
//! These read from the task store and session store via the pacer-store crate.
//! Neither op is registered native: both stay forwarded until Core serves a `handover.effects` bridge.
pub mod bridge;
pub use bridge::{HandoverBridge, handover_stub};

use crate::{object, refuse_enforcement};
use pacer_foundation::{Ctx, api::OpFuture};
use serde_json::{Value, json};

/// `service.handover` and `service.work` inputs that only the TypeScript core reproduces.
pub fn handover_stays_forwarded(ctx: &Ctx, op: &str) -> bool {
    if ctx
        .env
        .get("PACER_ENFORCEMENT_TOKEN")
        .is_some_and(|token| !token.is_empty())
    {
        return false;
    }
    match op {
        "service.handover" | "service.work" => true, // blocked on store bridge
        _ => false,
    }
}

pub async fn call<'a>(
    ctx: &'a Ctx,
    op: &str,
    params: Value,
    _app: bool,
    bridge: &'a mut dyn crate::handover::HandoverBridge,
) -> Result<Value, pacer_foundation::api::CoreError> {
    match op {
        "service.handover" => service_handover(ctx, params, bridge).await,
        "service.work" => service_work(ctx, params, bridge).await,
        _ => Err(pacer_foundation::api::CoreError::new(
            pacer_foundation::api::Code::UnknownOp,
            "unknown operation",
        )),
    }
}

pub fn service_handover<'a>(
    ctx: &'a Ctx,
    params: Value,
    bridge: &'a mut dyn crate::handover::HandoverBridge,
) -> OpFuture<'a> {
    Box::pin(async move {
        refuse_enforcement(ctx)?;
        object(&params)?;
        let wait_s = params
            .get("wait_s")
            .and_then(Value::as_u64)
            .unwrap_or(60)
            .min(60);

        // Call the bridge for the handover effect
        bridge
            .call(json!({"kind": "handover", "wait_s": wait_s}))
            .await
    })
}

pub fn service_work<'a>(
    ctx: &'a Ctx,
    params: Value,
    bridge: &'a mut dyn crate::handover::HandoverBridge,
) -> OpFuture<'a> {
    Box::pin(async move {
        refuse_enforcement(ctx)?;
        object(&params)?;

        // Call the bridge for the work inventory effect
        bridge.call(json!({"kind": "work"})).await
    })
}
