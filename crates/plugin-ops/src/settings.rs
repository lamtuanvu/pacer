//! TypeScript-compatible plugin settings reads and JSON output.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use serde_json::{Value, json};
use std::fs;

fn empty() -> Value {
    json!({"rev":0,"values":{},"hidden":[]})
}
fn store(ctx: &Ctx) -> Result<Value, CoreError> {
    let path = ctx.pacer_home.join("plugin-settings.json");
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = match fs::read(&path).map(|bytes| crate::json::parse_file(&bytes)) {
        Ok(Err(error)) if error == crate::json::NESTING_FALLBACK => {
            // Unsupported native decoding is not evidence of corrupt state.
            // Leave the source intact and let the read dispatcher use TS.
            return Err(CoreError::new(Code::Unavailable, error));
        }
        Ok(Ok(value)) => Some(value),
        _ => None,
    };
    let Some(Value::Object(raw)) = raw else {
        let _ = fs::rename(
            &path,
            path.with_file_name(format!(
                "plugin-settings.json.corrupt-{}",
                (pacer_foundation::ctx::unix_now() * 1000.0) as u64
            )),
        );
        return Ok(json!({}));
    };
    let mut out = json!({});
    for (id, r) in raw {
        if crate::json::number(&r["rev"]).is_some() && r["values"].is_object() {
            out[&id] = json!({"rev":r["rev"],"values":r["values"],"hidden":r["hidden"].as_array().map(|a| a.iter().filter(|v| v.is_string() && !crate::json::nonfinite(v)).cloned().collect::<Vec<_>>()).unwrap_or_default()});
        }
    }
    Ok(out)
}
pub fn read(ctx: &Ctx, id: &str) -> Result<Value, CoreError> {
    Ok(store(ctx)?.get(id).cloned().unwrap_or_else(empty))
}
pub fn js_number(n: f64) -> String {
    ryu_js::Buffer::new().format(n).to_owned()
}
/// JSON.stringify's number rendering and integer-index key enumeration.
pub fn js_json(value: &Value) -> String {
    stringify(value, false)
}
/// Private IPC must let JSON.parse recover Infinity before Zod validates it.
pub fn ipc_json(value: &Value) -> String {
    stringify(value, true)
}
fn stringify(value: &Value, ipc: bool) -> String {
    if crate::json::nonfinite(value) {
        return if ipc {
            if crate::json::number(value).is_some_and(f64::is_sign_negative) {
                "-1e400"
            } else {
                "1e400"
            }
        } else {
            "null"
        }
        .into();
    }
    match value {
        Value::String(s) => crate::json::string(s),
        Value::Number(n) => js_number(n.as_f64().unwrap_or(0.0)),
        Value::Array(a) => format!(
            "[{}]",
            a.iter()
                .map(|v| stringify(v, ipc))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(o) => {
            let mut indexes = o
                .keys()
                .filter_map(|k| {
                    k.parse::<u32>()
                        .ok()
                        .filter(|i| *i < u32::MAX && i.to_string() == *k)
                        .map(|i| (i, k))
                })
                .collect::<Vec<_>>();
            indexes.sort_by_key(|(i, _)| *i);
            let mut keys = indexes.into_iter().map(|(_, k)| k).collect::<Vec<_>>();
            keys.extend(o.keys().filter(|k| !keys_contains_index(k)));
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!("{}:{}", crate::json::string(k), stringify(&o[k], ipc)))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => value.to_string(),
    }
}
fn keys_contains_index(k: &str) -> bool {
    k.parse::<u32>()
        .is_ok_and(|i| i < u32::MAX && i.to_string() == k)
}
