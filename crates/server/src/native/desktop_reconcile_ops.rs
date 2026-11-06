//! Native `desktop.reconcile.*` (`src/api/ops-desktop-reconciliation.ts`).
//! Status is the fixed assessment without peer data; request and cancel stay
//! unavailable until reconciliation exists. An Orca task worktree as the
//! process directory needs the strategy provider match, so it stays forwarded.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Map, Value, json};

use super::lifecycle_ops::{invalid, type_name};
use super::msg_ops::{current_dir, orca_worktree, own_worktree};

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const UPGRADE_REFUSAL: &str =
    "PACER_ROLE=executor: upgrades are not allowed from a delegated task.";

pub fn desktop_reconcile_stays_forwarded(op: &str) -> bool {
    matches!(op, "desktop.reconcile.request" | "desktop.reconcile.cancel")
        && current_dir().is_some_and(|cwd| orca_worktree(&cwd))
}

/// `parseOpParams` refusals that precede the schema: executor upgrades, then enforcement.
fn authorize(ctx: &Ctx, upgrade: bool) -> Result<(), CoreError> {
    let executor = ctx.env.get("PACER_ROLE").map(String::as_str) == Some("executor")
        || current_dir().is_some_and(|cwd| own_worktree(ctx, &cwd));
    if upgrade && executor {
        return Err(CoreError::new(Code::NotAllowed, UPGRADE_REFUSAL));
    }
    if ctx
        .env
        .get("PACER_ENFORCEMENT_TOKEN")
        .is_some_and(|token| !token.is_empty())
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial",
        ));
    }
    Ok(())
}

/// `/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`
fn identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn string_issue(name: &str, value: Option<&Value>, issues: &mut Vec<String>) {
    match value {
        Some(Value::String(s)) if identifier(s) => {}
        Some(Value::String(_)) => issues.push(format!(
            "{name}: Invalid string: must match pattern /^[A-Za-z0-9][A-Za-z0-9_-]{{0,127}}$/"
        )),
        other => issues.push(format!(
            "{name}: Invalid input: expected string, received {}",
            other.map_or("undefined", type_name)
        )),
    }
}

/// `z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)`
fn revision_issue(value: Option<&Value>, issues: &mut Vec<String>) {
    let Some(n) = value.and_then(Value::as_f64) else {
        issues.push(format!(
            "expectRevision: Invalid input: expected number, received {}",
            value.map_or("undefined", type_name)
        ));
        return;
    };
    if n.fract() != 0.0 {
        issues.push("expectRevision: Invalid input: expected int, received number".into());
        return;
    }
    if n > MAX_SAFE {
        issues.push("expectRevision: Too big: expected int to be <=9007199254740991".into());
    }
    if n < -MAX_SAFE {
        issues.push("expectRevision: Too small: expected int to be >=-9007199254740991".into());
    }
    if n < 0.0 {
        issues.push("expectRevision: Too small: expected number to be >=0".into());
    }
    if n > MAX_SAFE {
        issues.push("expectRevision: Too big: expected number to be <=9007199254740991".into());
    }
}

/// The strict operation schemas, with Zod issue text and order.
fn parse(params: &Value, fields: &[&str]) -> Result<(), CoreError> {
    let empty = Map::new();
    let map = match params {
        Value::Null => &empty,
        Value::Object(map) => map,
        other => {
            return Err(invalid(format!(
                "params: Invalid input: expected object, received {}",
                type_name(other)
            )));
        }
    };
    let mut issues = Vec::new();
    for field in fields {
        match *field {
            "expectRevision" => revision_issue(map.get(*field), &mut issues),
            name => string_issue(name, map.get(name), &mut issues),
        }
    }
    let unknown: Vec<String> = map
        .keys()
        .filter(|key| !fields.contains(&key.as_str()))
        .map(|key| format!("\"{key}\""))
        .collect();
    match unknown.len() {
        0 => {}
        1 => issues.push(format!("params: Unrecognized key: {}", unknown[0])),
        _ => issues.push(format!("params: Unrecognized keys: {}", unknown.join(", "))),
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(invalid(issues.join("; ")))
    }
}

pub(super) fn desktop_reconcile_status(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx, false)?;
        parse(&params, &[])?;
        Ok(json!({
            "status": "unknown",
            "reason": "peer-data-unavailable",
            "capability": "unavailable",
            "revision": 0,
        }))
    })
}

/// Shared by request and cancel: both validate the request, then refuse.
pub(super) fn desktop_reconcile_unavailable(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx, true)?;
        parse(&params, &["candidateId", "expectRevision", "requestId"])?;
        Err(CoreError::new(
            Code::Unavailable,
            "Service reconciliation is unavailable",
        ))
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn ctx(env: &[(&str, &str)]) -> Ctx {
        let env = env
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect();
        Ctx::with("/nonexistent".into(), "/nonexistent".into(), env, 1.0)
    }

    async fn error(future: OpFuture<'_>) -> (Code, String) {
        let error = future.await.unwrap_err();
        (error.code, error.message)
    }

    #[tokio::test]
    async fn status_is_the_fixed_assessment() {
        let c = ctx(&[]);
        let expected = r#"{"status":"unknown","reason":"peer-data-unavailable","capability":"unavailable","revision":0}"#;
        for params in [json!({}), Value::Null] {
            let value = desktop_reconcile_status(&c, params).await.unwrap();
            assert_eq!(serde_json::to_string(&value).unwrap(), expected);
        }
        assert_eq!(
            error(desktop_reconcile_status(&c, json!({"a":1}))).await,
            (Code::InvalidInput, "params: Unrecognized key: \"a\"".into())
        );
        assert_eq!(
            error(desktop_reconcile_status(&c, json!("x"))).await,
            (
                Code::InvalidInput,
                "params: Invalid input: expected object, received string".into()
            )
        );
        // Status is not an upgrade operation.
        let executor = ctx(&[("PACER_ROLE", "executor")]);
        assert!(desktop_reconcile_status(&executor, json!({})).await.is_ok());
    }

    #[tokio::test]
    async fn request_issues_match_zod_then_refuse() {
        let c = ctx(&[]);
        assert_eq!(
            error(desktop_reconcile_unavailable(&c, json!({}))).await.1,
            "candidateId: Invalid input: expected string, received undefined; expectRevision: Invalid input: expected number, received undefined; requestId: Invalid input: expected string, received undefined"
        );
        assert_eq!(
            error(desktop_reconcile_unavailable(
                &c,
                json!({"candidateId":"-","requestId":5,"expectRevision":1e300,"z":1})
            ))
            .await
            .1,
            "candidateId: Invalid string: must match pattern /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/; expectRevision: Too big: expected int to be <=9007199254740991; expectRevision: Too big: expected number to be <=9007199254740991; requestId: Invalid input: expected string, received number; params: Unrecognized key: \"z\""
        );
        assert_eq!(
            error(desktop_reconcile_unavailable(
                &c,
                json!({"candidateId":"a","requestId":"b","expectRevision":-9007199254740992.0})
            ))
            .await
            .1,
            "expectRevision: Too small: expected int to be >=-9007199254740991; expectRevision: Too small: expected number to be >=0"
        );
        assert_eq!(
            error(desktop_reconcile_unavailable(
                &c,
                json!({"candidateId":"a","requestId":"b","expectRevision":-1.5})
            ))
            .await
            .1,
            "expectRevision: Invalid input: expected int, received number"
        );
        assert_eq!(
            error(desktop_reconcile_unavailable(
                &c,
                json!({"candidateId":"a","requestId":"b","expectRevision":0})
            ))
            .await,
            (
                Code::Unavailable,
                "Service reconciliation is unavailable".into()
            )
        );
        assert!(identifier(&"a".repeat(128)));
        assert!(!identifier(&"a".repeat(129)));
        assert!(!identifier("_a"));
    }

    #[tokio::test]
    async fn executor_and_enforcement_refusals_precede_params() {
        let executor = ctx(&[("PACER_ROLE", "executor")]);
        assert_eq!(
            error(desktop_reconcile_unavailable(&executor, json!("x"))).await,
            (Code::NotAllowed, UPGRADE_REFUSAL.into())
        );
        let enforcement = ctx(&[("PACER_ENFORCEMENT_TOKEN", "t")]);
        for future in [
            desktop_reconcile_status(&enforcement, json!("x")),
            desktop_reconcile_unavailable(&enforcement, json!("x")),
        ] {
            assert_eq!(
                error(future).await,
                (
                    Code::NotAllowed,
                    "Enforcement identity only reports a native child denial".into()
                )
            );
        }
        assert!(!desktop_reconcile_stays_forwarded(
            "desktop.reconcile.status"
        ));
    }
}
