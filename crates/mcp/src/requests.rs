//! The SDK validates method parameters before it enters a tool handler. Keep
//! these failures as JSON-RPC errors, separate from tool input-validation results.
use serde_json::{Value, json};

fn check(value: Option<&Value>, expected: &str, path: &[&str], errors: &mut Vec<Value>) -> bool {
    let good = value.is_some_and(|v| {
        super::json::nonfinite(v).is_none()
            && match expected {
                "string" => v.is_string(),
                "number" => v.as_f64().is_some_and(f64::is_finite),
                "object" | "record" => v.is_object(),
                "array" => v.is_array(),
                "boolean" => v.is_boolean(),
                _ => true,
            }
    });
    if !good {
        let received = value
            .and_then(super::json::nonfinite)
            .unwrap_or(match value {
                None => "undefined",
                Some(Value::Null) => "null",
                Some(Value::Bool(_)) => "boolean",
                Some(Value::String(_)) => "string",
                Some(Value::Number(_)) => "number",
                Some(Value::Array(_)) => "array",
                Some(Value::Object(_)) => "object",
            });
        errors.push(json!({"expected":expected,"code":"invalid_type","path":path,"message":format!("Invalid input: expected {expected}, received {received}")}));
    }
    good
}

pub(super) fn validate(method: &str, params: Option<&Value>) -> Option<Value> {
    let mut errors = Vec::new();
    let required = matches!(method, "initialize" | "tools/call");
    if (required || params.is_some()) && check(params, "object", &["params"], &mut errors) {
        let params = params?;
        if let Some(meta) = params.get("_meta") {
            check(Some(meta), "object", &["params", "_meta"], &mut errors);
        }
        match method {
            "initialize" => {
                check(
                    params.get("protocolVersion"),
                    "string",
                    &["params", "protocolVersion"],
                    &mut errors,
                );
                check(
                    params.get("capabilities"),
                    "object",
                    &["params", "capabilities"],
                    &mut errors,
                );
                if check(
                    params.get("clientInfo"),
                    "object",
                    &["params", "clientInfo"],
                    &mut errors,
                ) {
                    for field in ["name", "title", "version", "websiteUrl", "description"] {
                        if matches!(field, "name" | "version")
                            || params["clientInfo"].get(field).is_some()
                        {
                            check(
                                params["clientInfo"].get(field),
                                "string",
                                &["params", "clientInfo", field],
                                &mut errors,
                            );
                        }
                    }
                }
            }
            "tools/call" => {
                if let Some(task) = params.get("task")
                    && check(Some(task), "object", &["params", "task"], &mut errors)
                    && task.get("ttl").is_some()
                {
                    check(
                        task.get("ttl"),
                        "number",
                        &["params", "task", "ttl"],
                        &mut errors,
                    );
                }
                check(
                    params.get("name"),
                    "string",
                    &["params", "name"],
                    &mut errors,
                );
                if let Some(args) = params.get("arguments") {
                    check(Some(args), "record", &["params", "arguments"], &mut errors);
                }
            }
            "tools/list" => {
                if let Some(cursor) = params.get("cursor") {
                    check(Some(cursor), "string", &["params", "cursor"], &mut errors);
                }
            }
            _ => {}
        }
    }
    if errors.is_empty() {
        None
    } else {
        Some(
            json!({"code":-32603,"message":super::wire::stringify(&Value::Array(errors), Some(2))}),
        )
    }
}
