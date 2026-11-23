//! `onboarding.try`: the scratch-repo first delegation exercise.
//!
//! Rust refuses executor sessions and validates the empty `z.object({})` params
//! schema. Core runs the reference operation (`setup.onboardingTry`) through the
//! `onboarding.effects` bridge (`/_internal/onboarding-effects`): routing, the
//! scratch git repo, delegate and spawn all need the live TypeScript core. Over
//! HTTP an admitted request crosses the bridge with no deadline; over stdio it is
//! forwarded unchanged, because an inline bridge call would hold the request
//! loop for the delegation.
pub mod bridge;
pub use bridge::OnboardingBridge;

use crate::{object, refuse_enforcement};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Value, json};

/// Ops a front door dispatches via [`call`] with a Core whole-operation bridge.
pub fn uses_effects(op: &str) -> bool {
    matches!(op, "onboarding.try")
}

/// Registry stub: the op runs only with a Core whole-operation bridge.
pub fn onboarding_effect_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "onboarding effects bridge unavailable",
        ))
    })
}

/// `isExecutorSession` (PACER_ROLE === "executor") refusal, matching `tryDelegation`.
pub(crate) const EXECUTOR_REFUSAL: &str = "PACER_ROLE=executor: pacer executors cannot delegate onward; complete the assigned task directly.";

fn authorize(ctx: &Ctx) -> Result<(), CoreError> {
    if ctx.env.get("PACER_ROLE").map(String::as_str) == Some("executor") {
        return Err(CoreError::new(Code::NotAllowed, EXECUTOR_REFUSAL));
    }
    Ok(())
}

/// The refusals and schema; an admitted request is the reference operation's to run.
///
/// The order mirrors the TypeScript pipeline: `parseOpParams` runs the enforcement
/// gate (`authorizeWorkOperation`) and then the params schema; `tryDelegation`
/// refuses executor sessions after that, so an executor with non-object params is
/// rejected for the schema first (like a full forward) rather than as an
/// executor.
pub fn admit(ctx: &Ctx, op: &str, params: &Value) -> Result<(), CoreError> {
    if op != "onboarding.try" {
        return Err(CoreError::new(Code::UnknownOp, "unknown operation"));
    }
    refuse_enforcement(ctx)?;
    let _ = object(params)?;
    authorize(ctx)?;
    Ok(())
}

pub async fn call<'a>(
    ctx: &'a Ctx,
    op: &str,
    params: Value,
    _app: bool,
    bridge: &'a mut dyn OnboardingBridge,
) -> Result<Value, CoreError> {
    admit(ctx, op, &params)?;
    match op {
        "onboarding.try" => onboarding_try(ctx, params, bridge).await,
        _ => Err(CoreError::new(Code::UnknownOp, "unknown operation")),
    }
}

pub fn onboarding_try<'a>(
    ctx: &'a Ctx,
    params: Value,
    bridge: &'a mut dyn OnboardingBridge,
) -> OpFuture<'a> {
    Box::pin(async move {
        refuse_enforcement(ctx)?;
        object(&params)?;

        // Call the bridge for the whole tryDelegation effect
        bridge.call(json!({"kind": "onboarding-try"})).await
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pacer_foundation::api::Code;

    fn ctx(env: &[(&str, &str)]) -> Ctx {
        let env = env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        Ctx::with("/nonexistent".into(), "/nonexistent".into(), env, 1.0)
    }

    fn err(params: Value) -> Option<(Code, String)> {
        let c = ctx(&[]);
        match admit(&c, "onboarding.try", &params) {
            Ok(()) => None,
            Err(e) => Some((e.code, e.message)),
        }
    }

    #[test]
    fn admits_valid_onboarding_params() {
        assert_eq!(admit(&ctx(&[]), "onboarding.try", &json!({})), Ok(()));
        assert_eq!(admit(&ctx(&[]), "onboarding.try", &json!(null)), Ok(()));
        // Unknown keys are dropped by the loose z.object.
        assert_eq!(
            admit(&ctx(&[]), "onboarding.try", &json!({"extra": true})),
            Ok(())
        );
        assert!(matches!(
            admit(&ctx(&[]), "not.onboarding", &json!({})),
            Err(e) if e.code == Code::UnknownOp
        ));
    }

    #[test]
    fn params_match_zod_empty_object() {
        assert_eq!(
            err(json!([])),
            Some((
                Code::InvalidInput,
                "params: Invalid input: expected object, received array".into()
            ))
        );
        assert_eq!(
            err(json!("x")),
            Some((
                Code::InvalidInput,
                "params: Invalid input: expected object, received string".into()
            ))
        );
    }

    #[test]
    fn refuses_executor_sessions_and_enforcement_identity() {
        let c = ctx(&[("PACER_ROLE", "executor")]);
        assert!(matches!(
            admit(&c, "onboarding.try", &json!({})),
            Err(e) if e.code == Code::NotAllowed && e.message == EXECUTOR_REFUSAL
        ));
        let e = ctx(&[("PACER_ENFORCEMENT_TOKEN", "t")]);
        assert!(matches!(
            admit(&e, "onboarding.try", &json!({})),
            Err(e) if e.code == Code::NotAllowed
        ));
    }
}
