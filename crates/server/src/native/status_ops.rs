//! P5c status ops that compose from usage-broker injections (`limits.check`).
#![allow(clippy::result_large_err)]
use pacer_config::strategy::load_strategy;
use pacer_engine::usage_broker;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::Value;

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

pub(super) fn limits_check_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "limits.check requires the usage broker bridge",
        ))
    })
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
    }
}
