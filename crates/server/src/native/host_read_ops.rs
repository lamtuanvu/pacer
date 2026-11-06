//! Native host read ops that do not need SSH execution or live runtime bridges.
#![allow(clippy::result_large_err)]
use pacer_config::{ssh_config::suggest_hosts, strategy::load_strategy};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Map, Value};

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

pub(super) fn host_suggest(ctx: &Ctx, params: Value) -> OpFuture<'_> {
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
