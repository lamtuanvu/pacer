//! Core effects bridge transports for `service.handover` and `service.work`.
use pacer_foundation::api::OpFuture;
use serde_json::Value;

/// Core effects bridge for `service.handover` and `service.work`.
/// The bridge runs on the Core (TypeScript) side and executes the
/// handover logic that needs the running service's HTTP API.
pub trait HandoverBridge: Send {
    fn call(&mut self, request: Value) -> OpFuture<'_>;
}

/// Registry entry for ops that run only through [`call`] with a Core handover bridge.
pub fn handover_stub(_: &crate::handover::Ctx, _: serde_json::Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(pacer_foundation::api::CoreError::new(
            pacer_foundation::api::Code::Unavailable,
            "handover bridge unavailable",
        ))
    })
}
