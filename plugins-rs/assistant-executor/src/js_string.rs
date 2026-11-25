//! ECMAScript `String(x)` semantics for the assistant executor port.
//!
//! The TypeScript reads JSON event payloads and coerces values with `String(...)`
//! (e.g. `String(part.tool ?? "")`, `String(server.name ?? "mcp")`). This
//! module reproduces `String.prototype` conversion so the Rust ports match
//! byte-for-byte: `null` → `"null"`, arrays joined with `,`, plain objects →
//! `"[object Object]"`, numbers through `js::number_string`.

use pacer_plugin::js::number_string;
use serde_json::{Map, Value};

/// ECMAScript `String(value)` for a JSON value.
pub fn to_js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(true) => "true".into(),
        Value::Bool(false) => "false".into(),
        Value::Number(n) => number_string(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(to_js_string)
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `String(x ?? "")`: `null` (or a missing `x`) is an empty string, any other
/// value goes through [`to_js_string`].
pub fn js_str_or(value: Option<&Value>, fallback: &str) -> String {
    match value {
        None | Some(Value::Null) => fallback.to_owned(),
        Some(v) => to_js_string(v),
    }
}

/// `String(name ?? "fallback")` where `name` may be missing from an object.
/// A present, non-null value is stringified; otherwise the fallback.
pub fn obj_string(map: &Map<String, Value>, key: &str, fallback: &str) -> String {
    js_str_or(map.get(key), fallback)
}