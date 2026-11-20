//! The Core whole-operation bridge trait a native `onboarding.try` would call.
use pacer_foundation::api::OpFuture;
use serde_json::Value;

/// Core whole-operation bridge for `onboarding.try`.
/// The bridge runs on the Core (TypeScript) side and executes the full
/// `tryDelegation` (routing, scratch-repo git, delegate, spawn).
pub trait OnboardingBridge: Send {
    fn call(&mut self, request: Value) -> OpFuture<'_>;
}
