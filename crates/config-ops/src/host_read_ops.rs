//! Native host read ops; list/get compose lifecycle hosts over injected snapshots.
#![allow(clippy::result_large_err)]
use pacer_config::{ssh_config::suggest_hosts, strategy::load_strategy};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::hosts;
use serde_json::{Map, Value};

pub fn needs_host_read_bridge(op: &str) -> bool {
    matches!(op, "host.list" | "host.get")
}

pub fn needs_host_read_injection(op: &str) -> bool {
    matches!(op, "host.list" | "host.get" | "host.set")
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

fn used_ssh_from_strategy(strategy: &Value) -> Vec<String> {
    strategy["hosts"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(_, host)| host["ssh"].as_str().map(str::to_owned))
        .collect()
}

pub fn host_suggest(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let map = object(&params)?;
        let details = match map.get("details") {
            None => false,
            Some(Value::Bool(v)) => *v,
            Some(other) => {
                return Err(invalid(format!(
                    "details: Invalid input: expected boolean, received {}",
                    type_name(other)
                )));
            }
        };
        for key in map.keys() {
            if key != "details" {
                return Err(invalid("params: Unrecognized key(s) in object"));
            }
        }
        let strategy = load_strategy(&ctx.pacer_home).map_err(|e| invalid(e.to_string()))?;
        let used_ssh = used_ssh_from_strategy(&strategy);
        let used: Vec<&str> = used_ssh.iter().map(String::as_str).collect();
        Ok(suggest_hosts(&ctx.home, &used, details))
    })
}

pub fn host_list_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "host.list requires the host read bridge",
        ))
    })
}

pub fn host_get_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "host.get requires the host read bridge",
        ))
    })
}

fn parse_alias(params: &Value) -> Result<&str, CoreError> {
    let map = object(params)?;
    let value = map.get("alias").ok_or_else(|| invalid("alias: Required"))?;
    let text = value.as_str().ok_or_else(|| {
        invalid(format!(
            "alias: Invalid input: expected string, received {}",
            type_name(value)
        ))
    })?;
    if text.is_empty() {
        return Err(invalid(
            "alias: Too small: expected string to have >=1 characters",
        ));
    }
    if text.encode_utf16().count() > 128 {
        return Err(invalid(
            "alias: Too big: expected string to have <=128 characters",
        ));
    }
    Ok(text)
}

pub async fn host_list(_: &Ctx, params: Value, parts: Value) -> Result<Value, CoreError> {
    let map = object(&params)?;
    if !map.is_empty() {
        return Err(invalid("params: Unrecognized key(s) in object"));
    }
    Ok(hosts::list(&parts))
}

pub async fn host_get(_: &Ctx, params: Value, parts: Value) -> Result<Value, CoreError> {
    let alias = parse_alias(&params)?;
    if parts.get("alias").and_then(Value::as_str) != Some(alias) {
        return Err(invalid(format!("unknown host {alias}")));
    }
    hosts::detail(&parts).map_err(|error| {
        if error.code == "invalid_input" {
            CoreError::new(Code::InvalidInput, error.message)
        } else {
            CoreError::new(Code::Internal, error.message)
        }
    })
}
