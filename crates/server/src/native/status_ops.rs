//! P5c/P5d status ops that compose from usage-broker injections.
#![allow(clippy::result_large_err)]
use pacer_config::strategy::load_strategy;
use pacer_engine::usage_broker;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::Value;

const TASK_KINDS: &[&str] = &[
    "boilerplate",
    "tests",
    "docs",
    "rename",
    "migration",
    "feature",
    "debug",
    "refactor",
    "performance",
    "unfamiliar-code",
    "research",
];

pub(crate) fn needs_usage_broker(op: &str) -> bool {
    matches!(op, "limits.check" | "routing.status" | "routing.route")
}

/// `routing.route` with `goal` or `repo` needs classifier / project policy + remote eligibility (TS).
pub(crate) fn routing_route_stays_forwarded(params: &Value) -> bool {
    params
        .get("goal")
        .is_some_and(|g| g.as_str().is_some_and(|s| !s.is_empty()))
        || params
            .get("repo")
            .is_some_and(|r| r.as_str().is_some_and(|s| !s.is_empty()))
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn object(params: &Value) -> Result<&serde_json::Map<String, Value>, CoreError> {
    params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(params)
        ))
    })
}

fn broker_unavailable(message: &str) -> OpFuture<'_> {
    Box::pin(async move { Err(CoreError::new(Code::Unavailable, message)) })
}

pub(super) fn limits_check_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    broker_unavailable("limits.check requires the usage broker bridge")
}

pub(super) fn routing_status_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    broker_unavailable("routing.status requires the usage broker bridge")
}

pub(super) fn routing_route_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    broker_unavailable("routing.route requires the usage broker bridge")
}

pub(crate) async fn limits_check(
    ctx: &Ctx,
    params: Value,
    parts: Value,
) -> Result<Value, CoreError> {
    let map = object(&params)?;
    if !map.is_empty() {
        return Err(invalid("params: Unrecognized key(s) in object"));
    }
    let strategy = load_strategy(&ctx.pacer_home).map_err(|e| invalid(e.to_string()))?;
    Ok(usage_broker::limits_check(ctx, &strategy, &parts))
}

pub(crate) async fn routing_status(
    ctx: &Ctx,
    params: Value,
    parts: Value,
) -> Result<Value, CoreError> {
    let map = object(&params)?;
    if !map.is_empty() {
        return Err(invalid("params: Unrecognized key(s) in object"));
    }
    let strategy = load_strategy(&ctx.pacer_home).map_err(|e| invalid(e.to_string()))?;
    Ok(usage_broker::routing_status(ctx, &strategy, &parts))
}

fn parse_route_params(params: &Value) -> Result<Option<String>, CoreError> {
    let map = object(params)?;
    for key in map.keys() {
        if key != "kind" {
            return Err(invalid("params: Unrecognized key(s) in object"));
        }
    }
    match map.get("kind") {
        None => Ok(None),
        Some(Value::Null) => Ok(None),
        Some(Value::String(kind)) if TASK_KINDS.contains(&kind.as_str()) => Ok(Some(kind.clone())),
        Some(Value::String(kind)) => Err(invalid(format!(
            "kind: Invalid enum value. Expected 'boilerplate' | 'tests' | 'docs' | 'rename' | 'migration' | 'feature' | 'debug' | 'refactor' | 'performance' | 'unfamiliar-code' | 'research', received '{kind}'"
        ))),
        Some(other) => Err(invalid(format!(
            "kind: Invalid input: expected string, received {}",
            type_name(other)
        ))),
    }
}

pub(crate) async fn routing_route(
    ctx: &Ctx,
    params: Value,
    parts: Value,
) -> Result<Value, CoreError> {
    let kind = parse_route_params(&params)?;
    let strategy = load_strategy(&ctx.pacer_home).map_err(|e| invalid(e.to_string()))?;
    let mut params = params;
    if let Some(kind) = kind {
        if let Some(map) = params.as_object_mut() {
            map.insert("kind".into(), Value::String(kind));
        }
    } else if let Some(map) = params.as_object_mut() {
        map.remove("kind");
        map.insert("kind".into(), Value::Null);
    }
    Ok(usage_broker::routing_route(ctx, &strategy, &parts, &params))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use pacer_foundation::Ctx;
    use serde_json::json;
    use std::collections::HashMap;
    use tempfile::tempdir;

    #[tokio::test]
    async fn rejects_unknown_params() {
        let dir = tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let pacer_home = home.join(".pacer");
        std::fs::create_dir_all(&pacer_home).unwrap();
        std::fs::write(
            pacer_home.join("strategy.yaml"),
            "planner: claude-code\nproviders:\n  claude-code: {}\n",
        )
        .unwrap();
        let ctx = Ctx::with(home, pacer_home, HashMap::new(), 1.0);
        assert!(
            limits_check(&ctx, json!({"refresh": true}), json!({}))
                .await
                .is_err()
        );
        assert!(
            routing_status(&ctx, json!({"refresh": true}), json!({}))
                .await
                .is_err()
        );
        assert!(
            routing_route(&ctx, json!({"goal": "x"}), json!({}))
                .await
                .is_err()
        );
    }

    #[test]
    fn routing_route_stays_forwarded_for_goal_or_repo() {
        assert!(routing_route_stays_forwarded(&json!({"goal": "add tests"})));
        assert!(routing_route_stays_forwarded(&json!({"repo": "/tmp/x"})));
        assert!(!routing_route_stays_forwarded(&json!({})));
        assert!(!routing_route_stays_forwarded(&json!({"kind": "tests"})));
    }
}
