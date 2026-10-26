//! Configuration operations that have a verified native implementation.

use pacer_foundation::{
    Ctx,
    api::{
        error::{Code, CoreError},
        registry::NativeOp,
    },
    fsutil::{read_json, write_private},
};
use serde_json::{Map, Value, json};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

const LEVELS: [&str; 3] = ["off", "important", "all"];

fn write_string_spread(path: &Path, text: &str, level: &str) -> io::Result<()> {
    // JSON.stringify({ ...text, notifications: level }) indexes UTF-16 code
    // units, including each half of a non-BMP surrogate pair. serde_json::Value
    // cannot hold a lone surrogate, so serialize this unusual input as bytes.
    let mut body = String::from("{");
    for (index, unit) in text.encode_utf16().enumerate() {
        if index != 0 {
            body.push(',');
        }
        body.push_str(&format!("\"{index}\":"));
        if (0xd800..=0xdfff).contains(&unit) {
            body.push_str(&format!("\"\\u{unit:04x}\""));
        } else {
            let scalar = char::from_u32(u32::from(unit))
                .ok_or_else(|| io::Error::other("invalid UTF-16 code unit"))?;
            body.push_str(&serde_json::to_string(&scalar.to_string())?);
        }
    }
    if !text.is_empty() {
        body.push(',');
    }
    body.push_str("\"notifications\":");
    body.push_str(&serde_json::to_string(level)?);
    body.push('}');
    write_private(path, body.as_bytes())
}

/// The core's JSON.parse accepts lone-surrogate escapes that serde_json rejects.
/// Keep the original request with the core for those files, including the output
/// of a previous native string-spread migration.
pub fn requires_core_parser(ctx: &Ctx) -> bool {
    fs::read(ctx.pacer_home.join("settings.json"))
        .ok()
        .is_some_and(|bytes| serde_json::from_slice::<Value>(&bytes).is_err())
}

fn legacy_settings(ctx: &Ctx) -> PathBuf {
    let orca = ctx
        .env
        .get("PACER_ORCA_USER_DATA")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            #[cfg(target_os = "macos")]
            {
                ctx.home.join("Library/Application Support/orca")
            }
            #[cfg(target_os = "windows")]
            {
                ctx.env
                    .get("APPDATA")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| ctx.home.join("AppData/Roaming"))
                    .join("orca")
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                ctx.env
                    .get("XDG_CONFIG_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| ctx.home.join(".config"))
                    .join("orca")
            }
        });
    orca.join("plugins-data/lamtuanvu.pacer/settings.json")
}

fn notification_level(ctx: &Ctx) -> Result<Value, CoreError> {
    let path = ctx.pacer_home.join("settings.json");
    let settings = read_json::<Value>(&path).unwrap_or_else(|| json!({}));
    if let Some(level) = settings
        .get("notifications")
        .and_then(Value::as_str)
        .filter(|level| LEVELS.contains(level))
    {
        return Ok(json!({"level":level}));
    }
    let legacy = read_json::<Value>(&legacy_settings(ctx));
    let level = legacy
        .as_ref()
        .and_then(|value| value.get("notifications"))
        .and_then(Value::as_str)
        .filter(|level| LEVELS.contains(level))
        .unwrap_or("important");
    if let Value::String(text) = &settings {
        write_string_spread(&path, text, level)
            .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()))?;
        return Ok(json!({"level":level}));
    }
    // JavaScript object spread on a non-object contributes its enumerable entries.
    let mut merged = match settings {
        Value::Object(map) => map,
        Value::Array(items) => Map::from_iter(
            items
                .into_iter()
                .enumerate()
                .map(|(index, value)| (index.to_string(), value)),
        ),
        _ => Map::new(),
    };
    merged.insert("notifications".into(), json!(level));
    let bytes = serde_json::to_vec(&merged)
        .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()))?;
    write_private(&path, &bytes)
        .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()))?;
    Ok(json!({"level":level}))
}

fn get(ctx: &Ctx, params: Value) -> pacer_foundation::api::registry::OpFuture<'_> {
    Box::pin(async move {
        if !params.is_object() && !params.is_null() {
            let received = match params {
                Value::Array(_) => "array",
                Value::String(_) => "string",
                Value::Number(_) => "number",
                Value::Bool(_) => "boolean",
                _ => "unknown",
            };
            return Err(CoreError::new(
                Code::InvalidInput,
                format!("params: Invalid input: expected object, received {received}"),
            ));
        }
        notification_level(ctx)
    })
}

pub fn ops() -> &'static [NativeOp] {
    &[NativeOp {
        name: "notifications.get",
        call: get,
    }]
}

#[cfg(test)]
mod tests;
