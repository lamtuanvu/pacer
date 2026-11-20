//! `service.handover` and `service.work`: running work inventory for post-upgrade reopen.
//!
//! Rust refuses callers and validates params. Core runs the reference operation
//! through the `handover.effects` bridge (`/_internal/handover-effects`,
//! `_internal.handover.effects`): the handover wait and the running-work
//! inventory read the service's live runners and sessions on the TypeScript
//! side. Over HTTP an admitted request crosses the bridge with no deadline; over
//! stdio it is forwarded unchanged, because an inline bridge call would hold the
//! request loop for the wait.
pub mod bridge;
pub use bridge::HandoverBridge;

use crate::{object, refuse_enforcement};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Value, json};

/// Ops a front door dispatches via [`call`] with a Core effects bridge.
pub fn uses_effects(op: &str) -> bool {
    matches!(op, "service.handover" | "service.work")
}

/// Work-grant callers, whose scope Core checks, forward like every operation.
pub fn stays_forwarded(ctx: &Ctx) -> bool {
    ctx.env
        .get("PACER_WORK_GRANT")
        .is_some_and(|grant| !grant.is_empty())
}

/// Registry stubs: the ops run only with a Core effects bridge.
pub fn handover_effect_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "handover effects bridge unavailable",
        ))
    })
}

/// `z.object({wait_s: z.number().int().min(0).max(60).optional()})` issue text.
fn wait_s_issue(value: Option<&Value>) -> Option<CoreError> {
    let wait_s = "wait_s";
    let Some(value) = value else {
        return None; // optional
    };
    let mut issues: Vec<String> = Vec::new();
    let _ = int_issues(wait_s, value, 0.0, Some(60.0), &mut issues);
    if issues.is_empty() {
        None
    } else {
        Some(CoreError::new(Code::InvalidInput, issues.join(", ")))
    }
}

/// `z.number().int()` with an inclusive range; dispatch-style issue text.
fn int_issues(
    name: &str,
    value: &Value,
    min: f64,
    max: Option<f64>,
    issues: &mut Vec<String>,
) -> Option<f64> {
    let Some(n) = value.as_f64().filter(|_| value.is_number()) else {
        issues.push(format!(
            "{name}: Invalid input: expected number, received {}",
            received(value)
        ));
        return None;
    };
    if !n.is_finite() || n.fract() != 0.0 {
        issues.push(format!(
            "{name}: Invalid input: expected int, received number"
        ));
        return None;
    }
    if n < min {
        issues.push(format!("{name}: Too small: expected number to be >={min}"));
    } else if let Some(max) = max.filter(|max| n > *max) {
        issues.push(format!("{name}: Too big: expected number to be <={max}"));
    }
    Some(n)
}

fn received(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// `service.handover` is an upgrade operation (`isUpgradeOperation`): executors are refused with
/// the same message TypeScript gives. `service.work` is not an upgrade op, so executors pass.
pub(crate) const UPGRADE_REFUSAL: &str =
    "PACER_ROLE=executor: upgrades are not allowed from a delegated task.";

fn authorize(ctx: &Ctx, op: &str) -> Result<(), CoreError> {
    if op == "service.handover" && ctx.env.get("PACER_ROLE").map(String::as_str) == Some("executor")
    {
        return Err(CoreError::new(Code::NotAllowed, UPGRADE_REFUSAL));
    }
    refuse_enforcement(ctx)
}

/// The refusals and schema; an admitted request is the reference operation's to run.
pub fn admit(ctx: &Ctx, op: &str, params: &Value) -> Result<(), CoreError> {
    authorize(ctx, op)?;
    let map = object(params)?;
    if let Some(error) = wait_s_issue(map.get("wait_s")) {
        return Err(error);
    }
    Ok(())
}

pub async fn call<'a>(
    ctx: &'a Ctx,
    op: &str,
    params: Value,
    _app: bool,
    bridge: &'a mut dyn crate::handover::HandoverBridge,
) -> Result<Value, CoreError> {
    admit(ctx, op, &params)?;
    match op {
        "service.handover" => service_handover(ctx, params, bridge).await,
        "service.work" => service_work(ctx, params, bridge).await,
        _ => Err(CoreError::new(Code::UnknownOp, "unknown operation")),
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
        match admit(&c, "service.handover", &params) {
            Ok(()) => None,
            Err(e) => Some((e.code, e.message)),
        }
    }

    #[test]
    fn admits_valid_handover_params() {
        assert_eq!(admit(&ctx(&[]), "service.handover", &json!({})), Ok(()));
        assert_eq!(
            admit(&ctx(&[]), "service.handover", &json!({"wait_s": 0})),
            Ok(())
        );
        assert_eq!(
            admit(&ctx(&[]), "service.handover", &json!({"wait_s": 60})),
            Ok(())
        );
        assert_eq!(admit(&ctx(&[]), "service.handover", &json!(null)), Ok(()));
        // Unknown keys are dropped by the loose z.object.
        assert_eq!(
            admit(
                &ctx(&[]),
                "service.handover",
                &json!({"wait_s": 5, "extra": true})
            ),
            Ok(())
        );
    }

    #[test]
    fn wait_s_issues_match_zod() {
        assert_eq!(
            err(json!([])),
            Some((
                Code::InvalidInput,
                "params: Invalid input: expected object, received array".into()
            ))
        );
        assert_eq!(
            err(json!({"wait_s": "5"})),
            Some((
                Code::InvalidInput,
                "wait_s: Invalid input: expected number, received string".into()
            ))
        );
        assert_eq!(
            err(json!({"wait_s": 1.5})),
            Some((
                Code::InvalidInput,
                "wait_s: Invalid input: expected int, received number".into()
            ))
        );
        assert_eq!(
            err(json!({"wait_s": -1})),
            Some((
                Code::InvalidInput,
                "wait_s: Too small: expected number to be >=0".into()
            ))
        );
        assert_eq!(
            err(json!({"wait_s": 61})),
            Some((
                Code::InvalidInput,
                "wait_s: Too big: expected number to be <=60".into()
            ))
        );
    }

    #[test]
    fn refuses_enforcement_identity() {
        let c = ctx(&[("PACER_ENFORCEMENT_TOKEN", "t")]);
        assert!(matches!(
            admit(&c, "service.handover", &json!({})),
            Err(e) if e.code == Code::NotAllowed
        ));
        assert!(matches!(
            admit(&c, "service.work", &json!({})),
            Err(e) if e.code == Code::NotAllowed
        ));
    }

    #[test]
    fn refuses_handover_for_executors_but_lets_work_through() {
        let c = ctx(&[("PACER_ROLE", "executor")]);
        let refused = admit(&c, "service.handover", &json!({}));
        assert!(matches!(
            refused,
            Err(e) if e.code == Code::NotAllowed && e.message == UPGRADE_REFUSAL
        ));
        // `service.work` is not an upgrade operation; executors pass.
        assert_eq!(admit(&c, "service.work", &json!({})), Ok(()));
    }

    #[test]
    fn stays_forwarded_for_work_grant_callers() {
        assert!(stays_forwarded(&ctx(&[("PACER_WORK_GRANT", "g")])));
        assert!(!stays_forwarded(&ctx(&[])));
        assert!(!stays_forwarded(&ctx(&[("PACER_WORK_GRANT", "")])));
    }
}
