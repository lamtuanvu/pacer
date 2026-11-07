//! P5c/P5d status ops that compose from usage-broker injections.
#![allow(clippy::result_large_err)]
use pacer_config::strategy::load_strategy;
use pacer_engine::usage_broker;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_read_model::retry;
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
    matches!(
        op,
        "limits.check"
            | "routing.status"
            | "routing.route"
            | "task.retry_options"
            | "strategy.preview"
            | "runner.list"
    )
}

/// `task.retry_options` needs TypeScript for project policy (any
/// `project-strategies.json`, including one that cannot be read) and for remote
/// eligibility (any runner on a host). A strategy Rust cannot load also forwards.
pub(crate) fn task_retry_options_stays_forwarded(ctx: &Ctx) -> bool {
    let Ok(strategy) = load_strategy(&ctx.pacer_home) else {
        return true;
    };
    let remote = strategy["runners"]
        .as_object()
        .is_some_and(|runners| runners.values().any(|r| r["host"].is_string()));
    let policy = !matches!(
        std::fs::metadata(ctx.pacer_home.join("project-strategies.json")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    );
    remote || policy
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

pub(super) fn task_retry_options_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    broker_unavailable("task.retry_options requires the usage broker bridge")
}

fn parse_retry_id(params: &Value) -> Result<&str, CoreError> {
    let id = match params {
        Value::Null => None,
        Value::Object(map) => map.get("id"),
        other => {
            return Err(invalid(format!(
                "params: Invalid input: expected object, received {}",
                type_name(other)
            )));
        }
    };
    let id = match id {
        None => {
            return Err(invalid(
                "id: Invalid input: expected string, received undefined",
            ));
        }
        Some(Value::String(id)) => id,
        Some(other) => {
            return Err(invalid(format!(
                "id: Invalid input: expected string, received {}",
                type_name(other)
            )));
        }
    };
    if id.is_empty() {
        return Err(invalid(
            "id: Too small: expected string to have >=1 characters",
        ));
    }
    if id.encode_utf16().count() > 128 {
        return Err(invalid(
            "id: Too big: expected string to have <=128 characters",
        ));
    }
    Ok(id)
}

fn read_model_error(error: pacer_read_model::Error) -> CoreError {
    match error {
        pacer_read_model::Error::Store(pacer_store::StoreError::UnknownTask(id)) => {
            CoreError::new(Code::UnknownTask, format!("unknown task {id}"))
        }
        other => CoreError::new(Code::Internal, other.to_string()),
    }
}

/// Broker readings are requested only after the task resolves, as TS reads
/// status only after `get`.
pub(crate) async fn task_retry_options(
    ctx: &Ctx,
    params: Value,
    parts: OpFuture<'_>,
) -> Result<Value, CoreError> {
    let id = parse_retry_id(&params)?;
    let mut store = pacer_store::TaskStore::open(&ctx.pacer_home)
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    let task = retry::retry_task(&mut store, id).map_err(read_model_error)?;
    let parts = parts.await?;
    retry::retry_options(ctx, &mut store, &task, &parts).map_err(read_model_error)
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
    fn retry_id_errors_match_the_zod_schema() {
        let message = |params: Value| parse_retry_id(&params).unwrap_err().message;
        let undefined = "id: Invalid input: expected string, received undefined";
        assert_eq!(message(json!({})), undefined);
        assert_eq!(message(Value::Null), undefined);
        assert_eq!(
            message(json!({"id": 1})),
            "id: Invalid input: expected string, received number"
        );
        assert_eq!(
            message(json!([])),
            "params: Invalid input: expected object, received array"
        );
        assert_eq!(
            message(json!({"id": ""})),
            "id: Too small: expected string to have >=1 characters"
        );
        assert_eq!(
            message(json!({"id": "x".repeat(129)})),
            "id: Too big: expected string to have <=128 characters"
        );
        assert_eq!(
            parse_retry_id(&json!({"id": "t", "extra": 1})).unwrap(),
            "t"
        );
    }

    #[tokio::test]
    async fn retry_options_forward_for_policy_remote_or_unloadable_strategy() {
        let dir = tempdir().unwrap();
        let pacer_home = dir.path().join(".pacer");
        std::fs::create_dir_all(&pacer_home).unwrap();
        let ctx = Ctx::with(dir.path().into(), pacer_home.clone(), HashMap::new(), 1.0);
        assert!(task_retry_options_stays_forwarded(&ctx));
        let local = "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n";
        std::fs::write(pacer_home.join("strategy.yaml"), local).unwrap();
        assert!(!task_retry_options_stays_forwarded(&ctx));
        std::fs::write(pacer_home.join("project-strategies.json"), "{}").unwrap();
        assert!(task_retry_options_stays_forwarded(&ctx));
        std::fs::remove_file(pacer_home.join("project-strategies.json")).unwrap();
        let accounts = "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nhosts:\n  devbox: {ssh: devbox, repos: {}}\nrunners:\n  claude-code: {}\n";
        std::fs::write(pacer_home.join("strategy.yaml"), accounts).unwrap();
        assert!(!task_retry_options_stays_forwarded(&ctx));
        let remote = format!("{accounts}  codex@devbox: {{}}\n");
        std::fs::write(pacer_home.join("strategy.yaml"), remote).unwrap();
        assert!(load_strategy(&pacer_home).is_ok());
        assert!(task_retry_options_stays_forwarded(&ctx));
        let missing = task_retry_options(&ctx, json!({"id": "t-20990101-000000-abcd"}), {
            Box::pin(async { Ok(json!({})) })
        })
        .await
        .unwrap_err();
        assert_eq!(missing.code, Code::UnknownTask);
        assert_eq!(missing.message, "unknown task t-20990101-000000-abcd");
    }

    #[test]
    fn routing_route_stays_forwarded_for_goal_or_repo() {
        assert!(routing_route_stays_forwarded(&json!({"goal": "add tests"})));
        assert!(routing_route_stays_forwarded(&json!({"repo": "/tmp/x"})));
        assert!(!routing_route_stays_forwarded(&json!({})));
        assert!(!routing_route_stays_forwarded(&json!({"kind": "tests"})));
    }
}
