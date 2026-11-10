//! Core effects bridge transports for `service.handover` and `service.work`.
use pacer_foundation::api::OpFuture;
use serde_json::Value;

/// Core effects bridge for `service.handover` and `service.work`.
/// The bridge runs on the Core (TypeScript) side and executes the
/// handover logic that needs the running service's HTTP API.
pub trait HandoverBridge: Send {
    fn call(&mut self, request: Value) -> OpFuture<'_>;
}
