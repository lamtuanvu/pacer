//! Front-door dispatch for native `onboarding.try`.
//!
//! Rust refuses executor sessions and validates the empty params schema. Core runs
//! the reference operation (`setup.onboardingTry`) through the private effects
//! bridge (`onboarding.effects`, `/_internal/onboarding-effects`) with no
//! deadline, as a forwarded request has none; the reply means Core finished the
//! delegation. Over stdio it is forwarded unchanged: an inline bridge call would
//! hold the request loop for the delegation.
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_update::onboarding::{self, OnboardingBridge};
use serde_json::{Value, json};

/// Ops a front door dispatches natively through [`admit`], then Core.
pub(crate) fn uses_effects(op: &str) -> bool {
    onboarding::uses_effects(op)
}

/// The caller refusals and schema, without any Core effect.
#[allow(clippy::result_large_err)]
pub(crate) fn admit(ctx: &Ctx, op: &str, params: &Value) -> Result<(), CoreError> {
    match op {
        "onboarding.try" => onboarding::admit(ctx, op, params),
        _ => Err(CoreError::new(Code::UnknownOp, "unknown operation")),
    }
}

#[allow(clippy::result_large_err)]
pub(crate) async fn call(
    ctx: &Ctx,
    op: &str,
    params: Value,
    bridge: &mut dyn OnboardingBridge,
) -> Result<Value, CoreError> {
    onboarding::call(ctx, op, params, false, bridge).await
}

pub(crate) struct HttpEffects {
    pub(crate) target: Option<(u16, String)>,
}

impl OnboardingBridge for HttpEffects {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            crate::native::core_bridge_sync::http(
                self.target.clone(),
                "onboarding.effects",
                json!({ "request": request }),
            )
            .await
        })
    }
}
