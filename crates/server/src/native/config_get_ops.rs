//! Native `config.get` via pure settings read model and injected host fields.
#![allow(clippy::result_large_err)]
use pacer_config::{
    settings::{SettingsError, get_settings},
    strategy::strategy_path,
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Map, Value, json};

pub(crate) fn needs_config_host_bridge(op: &str) -> bool {
    matches!(op, "config.get")
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

fn object(params: &Value) -> Result<&Map<String, Value>, CoreError> {
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

pub(super) fn config_get_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    broker_unavailable("config.get requires the config host bridge")
}

pub(crate) fn host_fields_for_settings(parts: Value) -> Result<Value, CoreError> {
    let map = parts
        .as_object()
        .ok_or_else(|| invalid("config host bridge returned a non-object payload"))?;
    for key in ["terminalChoices", "machine", "planners"] {
        if !map.contains_key(key) {
            return Err(invalid(format!("config host bridge missing {key}")));
        }
    }
    Ok(json!({
        "terminalChoices": map["terminalChoices"].clone(),
        "machine": map["machine"].clone(),
        "planners": map["planners"].clone(),
    }))
}

pub(crate) async fn config_get(ctx: &Ctx, params: Value, parts: Value) -> Result<Value, CoreError> {
    let map = object(&params)?;
    if !map.is_empty() {
        return Err(invalid("params: Unrecognized key(s) in object"));
    }
    let (path, name) = strategy_path(&ctx.pacer_home).map_err(|error| invalid(error.to_string()))?;
    let backend = ctx.env.get("PACER_BACKEND").map(|s| s.as_str());
    let host_fields = host_fields_for_settings(parts)?;
    get_settings(&path, &name, backend, &host_fields).map_err(map_settings_error)
}

fn map_settings_error(error: SettingsError) -> CoreError {
    let code = match error.code {
        "conflict" => Code::Conflict,
        "unavailable" => Code::Unavailable,
        _ => Code::InvalidInput,
    };
    let mut out = CoreError::new(code, error.message);
    if let Some(hint) = error.hint {
        out = out.hint(hint);
    }
    out
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use pacer_foundation::Ctx;
    use std::collections::HashMap;
    use tempfile::tempdir;

    #[test]
    fn host_fields_require_injection_keys() {
        let err = host_fields_for_settings(json!({"machine": {}})).unwrap_err();
        assert!(err.message.contains("terminalChoices"));
    }

    #[tokio::test]
    async fn config_get_reads_keys_with_injected_host_fields() {
        let dir = tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let pacer_home = home.clone();
        std::fs::write(
            pacer_home.join("strategy.yaml"),
            "planner: claude-code\nproviders:\n  claude-code: {}\n",
        )
        .unwrap();
        let ctx = Ctx::with(home, pacer_home, HashMap::new(), 1_700_000_000.0);
        let parts = json!({
            "terminalChoices": [{"value":"auto","label":"Automatic"}],
            "machine": {"used": 0, "open": true},
            "planners": ["claude-code"],
        });
        let result = config_get(&ctx, json!({}), parts).await.unwrap();
        assert_eq!(
            result["keys"]["planner"]["value"],
            json!("claude-code")
        );
        assert_eq!(result["planners"], json!(["claude-code"]));
    }
}
