//! Pure metadata and registry introspection (`version.get`, `api.list`, `api.describe`).
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Map, Value, json};
use std::sync::OnceLock;

const PROTOCOL_VERSION: &str = "3.0.0";

fn pacer_version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION.get_or_init(|| {
        option_env!("PACER_BUILD_VERSION")
            .map(str::to_owned)
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").into())
    })
}

fn catalog() -> &'static Map<String, Value> {
    static CATALOG: OnceLock<Map<String, Value>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let value: Value = match serde_json::from_str(include_str!("../op_catalog.json")) {
            Ok(value) => value,
            Err(error) => panic!("invalid op_catalog.json: {error}"),
        };
        match value.as_object() {
            Some(object) => object.clone(),
            None => panic!("op catalog must be a JSON object"),
        }
    })
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

fn empty_object(params: &Value) -> Result<(), CoreError> {
    let map = params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(params)
        ))
    })?;
    if !map.is_empty() {
        return Err(invalid("params: Unrecognized key(s) in object"));
    }
    Ok(())
}

fn optional_bounded_string(
    map: &Map<String, Value>,
    name: &str,
    max_utf16: usize,
) -> Result<Option<String>, CoreError> {
    match map.get(name) {
        None => Ok(None),
        Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            if text.encode_utf16().count() > max_utf16 {
                return Err(invalid(format!(
                    "{name}: Too big: expected string to have <={max_utf16} characters"
                )));
            }
            Ok(Some(text.clone()))
        }
        Some(value) => Err(invalid(format!(
            "{name}: Invalid input: expected string, received {}",
            type_name(value)
        ))),
    }
}

fn parse_list_params(params: &Value) -> Result<(Option<String>, Option<String>), CoreError> {
    let map = params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(params)
        ))
    })?;
    for key in map.keys() {
        if key != "prefix" && key != "search" {
            return Err(invalid("params: Unrecognized key(s) in object"));
        }
    }
    let prefix = optional_bounded_string(map, "prefix", 128)?;
    let search = optional_bounded_string(map, "search", 256)?;
    Ok((prefix, search))
}

fn parse_describe_params(params: &Value) -> Result<String, CoreError> {
    let map = params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(params)
        ))
    })?;
    if map.len() != 1 || !map.contains_key("name") {
        return Err(invalid("params: Unrecognized key(s) in object"));
    }
    match map.get("name") {
        Some(Value::String(name)) => {
            if name.is_empty() {
                return Err(invalid(
                    "name: Too small: expected string to have >=1 character",
                ));
            }
            if name.encode_utf16().count() > 128 {
                return Err(invalid(
                    "name: Too big: expected string to have <=128 characters",
                ));
            }
            Ok(name.clone())
        }
        Some(value) => Err(invalid(format!(
            "name: Invalid input: expected string, received {}",
            type_name(value)
        ))),
        None => Err(invalid(
            "name: Invalid input: expected string, received undefined",
        )),
    }
}

fn sorted_op_names() -> Vec<&'static str> {
    let mut names: Vec<&str> = catalog().keys().map(String::as_str).collect();
    names.sort_unstable();
    names
}

fn describe_unknown_op() -> CoreError {
    CoreError::new(Code::UnknownOp, "Unknown operation")
        .hint("Use api.list to discover supported operation names.")
}

pub(super) fn version_get(_: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        empty_object(&params)?;
        Ok(json!({
            "pacer": pacer_version(),
            "protocol": PROTOCOL_VERSION,
        }))
    })
}

pub(super) fn api_list(_: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let (prefix, search) = parse_list_params(&params)?;
        let search_needle = search.as_deref().map(str::to_lowercase);
        let mut ops = Vec::new();
        for name in sorted_op_names() {
            if prefix
                .as_deref()
                .is_some_and(|prefix| !name.starts_with(prefix))
            {
                continue;
            }
            let entry = &catalog()[name];
            let description = entry["description"].as_str().unwrap_or("");
            if search_needle.as_ref().is_some_and(|needle| {
                !format!("{name} {description}")
                    .to_lowercase()
                    .contains(needle)
            }) {
                continue;
            }
            ops.push(json!({"name": name, "description": description}));
        }
        let mut out = Map::new();
        out.insert("protocol".into(), json!(PROTOCOL_VERSION));
        out.insert("pacer".into(), json!(pacer_version()));
        if let Some(prefix) = prefix {
            out.insert("prefix".into(), json!(prefix));
        }
        if let Some(search) = search {
            out.insert("search".into(), json!(search));
        }
        out.insert("ops".into(), Value::Array(ops));
        Ok(Value::Object(out))
    })
}

pub(super) fn api_describe(_: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let name = parse_describe_params(&params)?;
        let Some(entry) = catalog().get(&name) else {
            return Err(describe_unknown_op());
        };
        Ok(json!({
            "protocol": PROTOCOL_VERSION,
            "pacer": pacer_version(),
            "name": name,
            "description": entry["description"],
            "params": entry["params"],
        }))
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use pacer_foundation::Ctx;
    use serde_json::json;
    use std::collections::HashMap;

    fn call(op: fn(&Ctx, Value) -> OpFuture<'_>, params: Value) -> Value {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let ctx = Ctx::with(home.clone(), home, HashMap::new(), 0.0);
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(op(&ctx, params))
            .unwrap()
    }

    #[test]
    fn version_get_returns_package_metadata() {
        let value = call(version_get, json!({}));
        assert_eq!(value["protocol"], PROTOCOL_VERSION);
        assert!(value["pacer"].as_str().is_some());
        assert!(value.get("service").is_none());
    }

    #[test]
    fn api_list_filters_prefix_and_search() {
        let all = call(api_list, json!({}));
        assert!(all["ops"].as_array().unwrap().len() > 10);
        let filtered = call(api_list, json!({"prefix": "runner.", "search": "SETTINGS"}));
        assert!(
            filtered["ops"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["name"].as_str().unwrap().starts_with("runner."))
        );
        let empty = call(api_list, json!({"search": "no-such-capability-xyz"}));
        assert_eq!(empty["ops"], json!([]));
    }

    #[test]
    fn api_describe_unknown_op_matches_typescript() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let ctx = Ctx::with(home.clone(), home, HashMap::new(), 0.0);
        let error = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(api_describe(&ctx, json!({"name": "__proto__"})))
            .unwrap_err();
        assert_eq!(error.code, Code::UnknownOp);
        assert_eq!(error.message, "Unknown operation");
    }

    #[test]
    fn api_describe_returns_schema_for_known_op() {
        let info = call(api_describe, json!({"name": "runner.settings.save"}));
        assert_eq!(info["name"], "runner.settings.save");
        assert!(info["params"].is_object());
    }
}
