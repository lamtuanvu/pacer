//! Pure transformations for the frozen 2.x protocol.
use serde_json::{Value, json};
mod js;
mod snapshot;
mod surface;
use js::{spread, string};
pub use snapshot::snapshot;
pub use surface::{V2_EVENT_TYPES, V2_PROTOCOL, V3_ONLY_OPS, hello, is_v3_only_op, op_schemas};

pub const V3_CURSOR_BASE: f64 = 3_000_000_000_000.0;

fn object_without(value: &Value, keys: &[&str]) -> Value {
    let mut value = if value.is_array() {
        spread(value)
    } else {
        value.clone()
    };
    if let Some(map) = value.as_object_mut() {
        for key in keys {
            map.shift_remove(*key);
        }
    }
    value
}

pub fn params(name: &str, value: &Value) -> Result<Value, &'static str> {
    if !value.is_object() {
        return Ok(value.clone());
    }
    match name {
        "task.delegate" => Ok(object_without(value, &["dispatch"])),
        "client.register" => Ok(object_without(value, &["capture"])),
        "client.heartbeat" => Ok(object_without(value, &["notifier"])),
        "task.review" => {
            let accepted = value.get("accepted");
            if accepted.is_some_and(|v| !v.is_boolean()) {
                return Err("accepted: expected boolean");
            }
            let mut result = object_without(value, &["accepted"]);
            if value.get("verdict").is_none()
                && let Some(b) = accepted.and_then(Value::as_bool)
            {
                result["verdict"] = json!(if b { "accept" } else { "reject" });
            }
            Ok(result)
        }
        _ => Ok(value.clone()),
    }
}

fn legacy_task(value: &Value) -> Value {
    object_without(value, &["fullTitle"])
}

pub fn op_result(name: &str, value: &Value) -> Value {
    op_result_with_legacy(name, value, None)
}

/// `legacy` carries the non-JSON LEGACY_TASK_LIST symbol separately.
pub fn op_result_with_legacy(name: &str, value: &Value, legacy: Option<&Value>) -> Value {
    match name {
        "setup.check" => setup(value, true),
        "client.register" if value.is_object() || value.is_array() => {
            object_without(value, &["capture_worker"])
        }
        "version.get" => {
            let mut v = spread(value);
            if let Some(m) = v.as_object_mut() {
                m.insert("protocol".into(), json!("2.8.0"));
            }
            v
        }
        "task.diff" => {
            let mut v = spread(value);
            if let Some(m) = v.as_object_mut() {
                m.shift_remove("diff");
                if let Some(patch) = value.get("patch") {
                    m.insert("diff".into(), patch.clone());
                }
            }
            v
        }
        "task.list" => {
            let value = legacy.filter(|v| !v.is_null()).unwrap_or(value);
            if let Some(items) = value.as_array() {
                return Value::Array(items.iter().map(legacy_task).collect());
            }
            let mut v = value.clone();
            if let Some(items) = value.get("tasks").and_then(Value::as_array) {
                v["tasks"] = Value::Array(items.iter().map(legacy_task).collect());
            }
            v
        }
        "task.get" if value.is_object() || value.is_array() => {
            object_without(&legacy_task(value), &["derived", "work"])
        }
        "task.review" if value.is_object() => {
            if let Some(task) = value.get("task") {
                let mut v = value.clone();
                v["task"] = legacy_task(task);
                v
            } else {
                legacy_task(value)
            }
        }
        _ => value.clone(),
    }
}

pub fn is_discovery_item_id(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| s.starts_with("discovery:") || s.starts_with("discovery-network:"))
}

pub fn v3_only_event(event: &Value) -> bool {
    let data = &event["data"];
    match event["type"].as_str() {
        Some("discovery.found") => true,
        Some("config") => data["area"] == "discovery",
        Some("attention") => is_discovery_item_id(&data["id"]),
        Some("notify") => is_discovery_item_id(&data["key"]),
        _ => false,
    }
}

pub fn event(value: &Value, legacy: Option<&Value>) -> Value {
    let kind = value["type"].as_str().unwrap_or("");
    if kind == "desktop.update" {
        return Value::Null;
    }
    if let Some(legacy) = legacy {
        return legacy.clone();
    }
    if matches!(
        kind,
        "planner" | "assistant" | "machine" | "message" | "discovery.found"
    ) || kind == "config"
        && matches!(
            string(&value["data"]["area"]).as_str(),
            "machine" | "discovery"
        )
    {
        return Value::Null;
    }
    let mut result = value.clone();
    if let Some(seq) = value["seq"].as_f64().filter(|s| *s >= V3_CURSOR_BASE) {
        let converted = seq - V3_CURSOR_BASE;
        result["seq"] = if converted.fract() == 0.0
            && converted >= i64::MIN as f64
            && converted < i64::MAX as f64
        {
            json!(converted as i64)
        } else {
            json!(converted)
        };
    }
    result
}

/// Convert the setup checklist to the frozen v2 shape.
pub fn setup(value: &Value, check: bool) -> Value {
    let empty = Vec::new();
    let source = value["items"].as_array().unwrap_or(&empty);
    let find = |id: &str| source.iter().find(|i| i["id"] == id);
    let planner = find("planner");
    let connect = find("connect");
    let strategy_status = if planner.is_some_and(|p| p["status"] == "failed") {
        "failed"
    } else if planner
        .and_then(|p| p["detail"].as_str())
        .is_some_and(|d| !d.is_empty() && d != "Choose a planner")
    {
        "done"
    } else {
        "pending"
    };
    let definitions = [
        ("binary", "Binary", true),
        ("strategy", "Strategy", true),
        ("service", "Login service", true),
        ("link", "Link", true),
        ("live", "Live plugin", false),
        ("agent:claude-code", "Claude Code", false),
        ("agent:codex", "Codex", false),
        ("agent:cursor", "Cursor", false),
        ("agent:opencode", "OpenCode", false),
    ];
    let mut items = Vec::new();
    for (id, title, required) in definitions {
        let original = find(id);
        let status = if id == "strategy" {
            strategy_status
        } else {
            original
                .and_then(|i| i["status"].as_str())
                .or_else(|| {
                    id.strip_prefix("agent:")
                        .and_then(|agent| connect.filter(|c| c["agent"] == agent))
                        .and_then(|c| c["status"].as_str())
                })
                .unwrap_or("pending")
        };
        let mut item = json!({"id":id,"title":title,"status":status,"required":required});
        if check {
            let agent = id.starts_with("agent:");
            if agent {
                let installed = original
                    .and_then(|x| x.get("installed"))
                    .filter(|x| !x.is_null())
                    .or_else(|| {
                        connect
                            .filter(|c| id.strip_prefix("agent:").is_some_and(|a| c["agent"] == a))
                            .and_then(|c| c.get("installed"))
                    })
                    .cloned()
                    .unwrap_or(json!(false));
                item["installed"] = installed;
            }
            let detail = if id == "strategy" {
                planner.and_then(|p| p["detail"].as_str()).and_then(|d| {
                    if strategy_status == "failed" {
                        Some(d.to_string())
                    } else if !d.is_empty() && d != "Choose a planner" {
                        Some(format!(
                            "Planner: {}",
                            d.strip_suffix(" · signed out").unwrap_or(d)
                        ))
                    } else {
                        None
                    }
                })
            } else if agent {
                Some(
                    if status == "done" {
                        "Connected"
                    } else {
                        "Optional · not connected"
                    }
                    .to_string(),
                )
            } else {
                original
                    .and_then(|x| x["detail"].as_str())
                    .map(str::to_string)
            };
            if let Some(d) = detail.filter(|d| !d.is_empty()) {
                item["detail"] = json!(d);
            }
            if status != "done" {
                item["command"] = json!("pacer init");
            }
        }
        items.push(item);
    }
    let open = items
        .iter()
        .filter(|i| i["required"] == true && i["status"] != "done")
        .count();
    if check {
        json!({"checkedAt":value["checkedAt"],"complete":open == 0,"items":items})
    } else {
        json!({"complete":open == 0,"open":open,"items":items})
    }
}

/// Validate visibility and adapt arguments before a caller invokes its dispatcher.
/// No operations are registered or executed here; TS remains the runtime fallback.
#[allow(clippy::result_large_err)] // Match the dispatcher's CoreError API by value.
pub fn call_params(name: &str, value: &Value) -> Result<Value, pacer_foundation::api::CoreError> {
    use pacer_foundation::api::{Code, CoreError};
    if is_v3_only_op(name) {
        return Err(
            CoreError::new(Code::UnknownOp, format!("unknown operation \"{name}\""))
                .hint(format!("{name} requires protocol 3")),
        );
    }
    let value = if name == "client.register" && value.is_array() {
        object_without(value, &["capture"])
    } else {
        value.clone()
    };
    params(name, &value).map_err(|message| CoreError::new(Code::InvalidInput, message))
}
