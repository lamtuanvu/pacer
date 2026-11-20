//! Front-door dispatch for native `service.handover` and `service.work`.
//!
//! Rust refuses callers and validates params. Core runs the handover wait and the
//! running-work inventory (live runners and sessions) through the reference
//! operation. Over HTTP an admitted request crosses the private effects bridge
//! (`handover.effects`, `/_internal/handover-effects`) with no deadline, as a
//! forwarded request has none; the reply means Core finished the wait. Over stdio
//! it is forwarded unchanged: the bridge would hold the request loop for the wait,
//! while the core child answers forwarded requests concurrently.
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_update::handover::{self, HandoverBridge};
use serde_json::{Value, json};

/// Ops a front door dispatches natively through [`admit`], then Core.
pub(crate) fn uses_effects(op: &str) -> bool {
    handover::uses_effects(op)
}

/// Work-grant callers forward; Core checks their scope.
pub(crate) fn stays_forwarded(ctx: &Ctx) -> bool {
    handover::stays_forwarded(ctx)
}

/// The caller refusals and schema, without any Core effect.
#[allow(clippy::result_large_err)]
pub(crate) fn admit(ctx: &Ctx, op: &str, params: &Value) -> Result<(), CoreError> {
    match op {
        "service.handover" | "service.work" => handover::admit(ctx, op, params),
        _ => Err(CoreError::new(Code::UnknownOp, "unknown operation")),
    }
}

#[allow(clippy::result_large_err)]
pub(crate) async fn call(
    ctx: &Ctx,
    op: &str,
    params: Value,
    bridge: &mut dyn HandoverBridge,
) -> Result<Value, CoreError> {
    handover::call(ctx, op, params, false, bridge).await
}

pub(crate) struct HttpEffects {
    pub(crate) target: Option<(u16, String)>,
}

impl HandoverBridge for HttpEffects {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            crate::native::core_bridge_sync::http(
                self.target.clone(),
                "handover.effects",
                json!({ "request": request }),
            )
            .await
        })
    }
}
