//! Core-bridge param validation for `desktop.capture.*`
//! (`src/api/ops-desktop.ts`). The capture broker is an in-memory map only the
//! TypeScript service owns, so Rust validates each param set with Zod-order
//! issue text, then the sealed bridge runs the real handler for the reply.
//! Successful PNG bytes stay on the bounded authenticated image route.
#![allow(clippy::result_large_err)]
use pacer_foundation::api::CoreError;
use serde_json::{Map, Value, json};

use crate::host_read_ops::{invalid, type_name};

const CREDENTIAL: &str = "^[0-9a-f]{64}$";
const WINDOW_OPTION: &str = r#"one of "main"|"tray""#;
const MODE_OPTION: &str = r#"one of "window"|"content""#;
const ERROR_OPTION: &str = r#"one of "permission_denied"|"window_unavailable"|"unsupported_platform"|"capture_failed"|"capture_timeout""#;

const CAPTURE_OPS: [&str; 6] = [
    "desktop.capture.register",
    "desktop.capture.targets",
    "desktop.capture.request",
    "desktop.capture.claim",
    "desktop.capture.complete",
    "desktop.capture.result",
];

pub fn needs_capture_bridge(op: &str) -> bool {
    CAPTURE_OPS.contains(&op)
}

/// `z.string().regex(/^[0-9a-f]{64}$/)`: lowercase hex only, matching the
/// regex (Zod would reject uppercase A-F even though `is_ascii_hexdigit`
/// would accept them).
fn hex64(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}

fn digits(text: &str, max: usize) -> bool {
    !text.is_empty() && text.len() <= max && text.bytes().all(|b| b.is_ascii_digit())
}

/// `z.string().min(1).max(128)` with Zod's UTF-16 (`length`) count.
fn id_issue(name: &str, value: Option<&Value>, issues: &mut Vec<String>) {
    let Some(Value::String(text)) = value else {
        issues.push(format!(
            "{name}: Invalid input: expected string, received {}",
            value.map_or("undefined", type_name)
        ));
        return;
    };
    if text.is_empty() {
        issues.push(format!(
            "{name}: Too small: expected string to have >=1 characters"
        ));
        return;
    }
    if text.encode_utf16().count() > 128 {
        issues.push(format!(
            "{name}: Too big: expected string to have <=128 characters"
        ));
    }
}

/// `z.string().regex(/^[0-9a-f]{64}$/)`.
fn credential_issue(value: Option<&Value>, issues: &mut Vec<String>) {
    match value {
        Some(Value::String(text)) if hex64(text) => {}
        Some(Value::String(_)) => {
            issues.push(format!(
                "worker_token: Invalid string: must match pattern /{CREDENTIAL}/"
            ));
        }
        other => {
            issues.push(format!(
                "worker_token: Invalid input: expected string, received {}",
                other.map_or("undefined", type_name)
            ));
        }
    }
}

/// `z.enum(["main", "tray"])`; any non-member value (including a missing
/// key) is `Invalid option`, matching Zod.
fn window_enum_issue(value: Option<&Value>, issues: &mut Vec<String>) {
    match value {
        Some(Value::String(text)) if matches!(text.as_str(), "main" | "tray") => {}
        _ => issues.push(format!("window: Invalid option: expected {WINDOW_OPTION}")),
    }
}

fn error_enum_issue(value: Option<&Value>, issues: &mut Vec<String>) {
    match value {
        Some(Value::String(text)) => {
            let ok = matches!(
                text.as_str(),
                "permission_denied"
                    | "window_unavailable"
                    | "unsupported_platform"
                    | "capture_failed"
                    | "capture_timeout"
            );
            if !ok {
                issues.push(format!("error: Invalid option: expected {ERROR_OPTION}"));
            }
        }
        _ => issues.push(format!("error: Invalid option: expected {ERROR_OPTION}")),
    }
}

/// `z.number().int().min(2)` minus the safe-integer range (capture pid).
fn pid_issue(name: &str, value: Option<&Value>, issues: &mut Vec<String>) {
    let Some(n) = value.and_then(Value::as_f64) else {
        issues.push(format!(
            "{name}: Invalid input: expected number, received {}",
            value.map_or("undefined", type_name)
        ));
        return;
    };
    if n.fract() != 0.0 {
        issues.push(format!(
            "{name}: Invalid input: expected int, received number"
        ));
        return;
    }
    if n < 2.0 {
        issues.push(format!("{name}: Too small: expected number to be >=2"));
    }
}

/// A single `windows` element: non-strict `z.object({label, window_id, pid})`.
fn window_params(
    name: &str,
    value: Option<&Value>,
    issues: &mut Vec<String>,
) -> Option<Map<String, Value>> {
    let Some(Value::Object(map)) = value else {
        issues.push(format!(
            "{name}: Invalid input: expected object, received {}",
            value.map_or("undefined", type_name)
        ));
        return None;
    };
    let mut parsed = Map::new();
    match map.get("label") {
        Some(Value::String(text)) if matches!(text.as_str(), "main" | "tray") => {
            parsed.insert("label".into(), text.clone().into());
        }
        _ => issues.push(format!(
            "{name}.label: Invalid option: expected {WINDOW_OPTION}"
        )),
    }
    match map.get("window_id") {
        Some(Value::String(text)) if digits(text, usize::MAX) => {
            parsed.insert("window_id".into(), text.clone().into());
        }
        Some(Value::String(_)) => {
            issues.push(format!(
                "{name}.window_id: Invalid string: must match pattern /^[0-9]+$/"
            ));
        }
        other => {
            issues.push(format!(
                "{name}.window_id: Invalid input: expected string, received {}",
                other.map_or("undefined", type_name)
            ));
        }
    }
    let pid_field = format!("{name}.pid");
    pid_issue(&pid_field, map.get("pid"), issues);
    if let Some(Value::Number(n)) = map.get("pid")
        && n.as_f64().is_some_and(|f| f.fract() == 0.0 && f >= 2.0)
    {
        parsed.insert("pid".into(), n.clone().into());
    }
    if parsed.contains_key("label")
        && parsed.contains_key("window_id")
        && parsed.contains_key("pid")
    {
        Some(parsed)
    } else {
        None
    }
}

/// `z.array(window).max(2).optional()`. Zod 4.6.5 parses each element and
/// reports element issues (`windows.<i>.<field>`) and, for an over-length
/// array, also reports the array's own `max(2)` size error; both appear in
/// the combined message (verified against zod 4.6.5 with invalid elements
/// in an over-length array). We mirror that: collect the element issues
/// first, then the size error, so the order matches zod.
fn windows_issue(value: Option<&Value>, issues: &mut Vec<String>) -> Option<Vec<Value>> {
    let Some(Value::Array(items)) = value else {
        if let Some(other) = value {
            issues.push(format!(
                "windows: Invalid input: expected array, received {}",
                type_name(other)
            ));
        }
        return None;
    };
    let mut parsed = Vec::new();
    for (index, item) in items.iter().enumerate() {
        if let Some(window) = window_params(&format!("windows.{index}"), Some(item), issues) {
            parsed.push(Value::Object(window));
        }
    }
    if items.len() > 2 {
        issues.push("windows: Too big: expected array to have <=2 items".into());
    }
    Some(parsed)
}

/// Captures the validated params into `parsed` for the bridge body. Like
/// TypeScript's `params ?? {}` (src/api/ops.ts), an explicit `null` params
/// object reads as an empty object rather than a type error.
pub fn bridge_params(op: &str, params: &Value) -> Result<Value, CoreError> {
    let empty = Map::new();
    let map = if params.is_null() {
        // TypeScript's `params ?? {}` (src/api/ops.ts) reads an explicit
        // `null` params object as empty rather than as a type error.
        &empty
    } else {
        params.as_object().ok_or_else(|| {
            invalid(format!(
                "params: Invalid input: expected object, received {}",
                type_name(params)
            ))
        })?
    };
    let mut parsed = Map::new();
    let mut issues = Vec::new();
    match op {
        "desktop.capture.register" => {
            id_issue("client_id", map.get("client_id"), &mut issues);
            credential_issue(map.get("worker_token"), &mut issues);
            if issues.is_empty() {
                parsed.insert("client_id".into(), map["client_id"].clone());
                parsed.insert("worker_token".into(), map["worker_token"].clone());
            }
        }
        "desktop.capture.targets" => {}
        "desktop.capture.request" => {
            id_issue("client_id", map.get("client_id"), &mut issues);
            window_enum_issue(map.get("window"), &mut issues);
            match map.get("mode") {
                None => parsed.insert("mode".into(), json!("window")),
                Some(Value::String(text)) if matches!(text.as_str(), "window" | "content") => {
                    parsed.insert("mode".into(), text.clone().into())
                }
                _ => {
                    enum_issue(map.get("mode"), MODE_OPTION, &mut issues);
                    None
                }
            };
            match map.get("window_id") {
                None => {}
                Some(Value::String(text)) if digits(text, 20) => {
                    parsed.insert("window_id".into(), text.clone().into());
                }
                Some(Value::String(_)) => {
                    issues.push(
                        "window_id: Invalid string: must match pattern /^[0-9]{1,20}$/".into(),
                    );
                }
                Some(other) => {
                    issues.push(format!(
                        "window_id: Invalid input: expected string, received {}",
                        type_name(other)
                    ));
                }
            }
            if issues.is_empty() {
                parsed.insert("client_id".into(), map["client_id"].clone());
                parsed.insert("window".into(), map["window"].clone());
            }
        }
        "desktop.capture.claim" => {
            id_issue("client_id", map.get("client_id"), &mut issues);
            credential_issue(map.get("worker_token"), &mut issues);
            let windows = windows_issue(map.get("windows"), &mut issues);
            if issues.is_empty() {
                parsed.insert("client_id".into(), map["client_id"].clone());
                parsed.insert("worker_token".into(), map["worker_token"].clone());
                if let Some(items) = windows {
                    parsed.insert("windows".into(), Value::Array(items));
                }
            }
        }
        "desktop.capture.complete" => {
            id_issue("request_id", map.get("request_id"), &mut issues);
            credential_issue(map.get("worker_token"), &mut issues);
            error_enum_issue(map.get("error"), &mut issues);
            if issues.is_empty() {
                parsed.insert("request_id".into(), map["request_id"].clone());
                parsed.insert("worker_token".into(), map["worker_token"].clone());
                parsed.insert("error".into(), map["error"].clone());
            }
        }
        "desktop.capture.result" => {
            id_issue("request_id", map.get("request_id"), &mut issues);
            if issues.is_empty() {
                parsed.insert("request_id".into(), map["request_id"].clone());
            }
        }
        _ => return Err(invalid("unknown desktop capture bridge op")),
    }
    if !issues.is_empty() {
        return Err(invalid(issues.join("; ")));
    }
    Ok(json!({ "op": op, "params": parsed }))
}

fn enum_issue(_value: Option<&Value>, option: &str, issues: &mut Vec<String>) {
    issues.push(format!("mode: Invalid option: expected {option}"));
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn message(op: &str, params: Value) -> String {
        bridge_params(op, &params).unwrap_err().message
    }

    #[test]
    fn register_validates_client_id_and_worker_token() {
        assert_eq!(
            bridge_params(
                "desktop.capture.register",
                &json!({"client_id": "c", "worker_token": "a".repeat(64), "extra": 1})
            )
            .unwrap(),
            json!({"op": "desktop.capture.register", "params": {"client_id": "c", "worker_token": "a".repeat(64)}})
        );
        assert_eq!(
            message(
                "desktop.capture.register",
                json!({"client_id": "", "worker_token": "abc"})
            ),
            "client_id: Too small: expected string to have >=1 characters; worker_token: Invalid string: must match pattern /^[0-9a-f]{64}$/"
        );
    }

    #[test]
    fn targets_requires_an_object() {
        assert_eq!(
            bridge_params("desktop.capture.targets", &json!({"x": 1})).unwrap(),
            json!({"op": "desktop.capture.targets", "params": {}})
        );
        assert_eq!(
            message("desktop.capture.targets", json!(5)),
            "params: Invalid input: expected object, received number"
        );
        // An explicit `null` reads as `{}` (TypeScript's `params ?? {}`).
        assert_eq!(
            bridge_params("desktop.capture.targets", &Value::Null).unwrap(),
            json!({"op": "desktop.capture.targets", "params": {}})
        );
    }

    #[test]
    fn null_params_validates_as_empty_object_for_other_ops() {
        assert_eq!(
            message("desktop.capture.register", Value::Null),
            "client_id: Invalid input: expected string, received undefined; worker_token: Invalid input: expected string, received undefined"
        );
        assert_eq!(
            message("desktop.capture.request", Value::Null),
            "client_id: Invalid input: expected string, received undefined; window: Invalid option: expected one of \"main\"|\"tray\""
        );
    }

    #[test]
    fn worker_token_rejects_uppercase_hex() {
        assert_eq!(
            message(
                "desktop.capture.register",
                json!({"client_id": "c", "worker_token": "A".repeat(64)})
            ),
            "worker_token: Invalid string: must match pattern /^[0-9a-f]{64}$/"
        );
        assert!(hex64(&"a".repeat(64)));
        assert!(hex64(&format!("{}d", "a".repeat(63))));
        assert!(!hex64(&"A".repeat(64)));
        assert!(!hex64(&"g".repeat(64)));
    }

    #[test]
    fn request_applies_mode_default_and_window_id_regex() {
        let parsed = bridge_params(
            "desktop.capture.request",
            &json!({"client_id": "c", "window": "main", "window_id": "12"}),
        )
        .unwrap();
        assert_eq!(
            parsed,
            json!({"op": "desktop.capture.request", "params": {"client_id": "c", "window": "main", "mode": "window", "window_id": "12"}})
        );
        assert_eq!(
            message(
                "desktop.capture.request",
                json!({"client_id": "c", "window": "other", "mode": "x", "window_id": "abc"})
            ),
            "window: Invalid option: expected one of \"main\"|\"tray\"; mode: Invalid option: expected one of \"window\"|\"content\"; window_id: Invalid string: must match pattern /^[0-9]{1,20}$/"
        );
    }

    #[test]
    fn claim_validates_windows_max_and_fields() {
        let parsed = bridge_params(
            "desktop.capture.claim",
            &json!({"client_id": "c", "worker_token": "a".repeat(64), "windows": [
                {"label": "main", "window_id": "1", "pid": 2, "junk": 3}
            ]}),
        )
        .unwrap();
        assert_eq!(
            parsed,
            json!({"op": "desktop.capture.claim", "params": {"client_id": "c", "worker_token": "a".repeat(64), "windows": [{"label": "main", "window_id": "1", "pid": 2}]}})
        );
        assert_eq!(
            message(
                "desktop.capture.claim",
                json!({"client_id": "c", "worker_token": "a".repeat(64), "windows": [
                    {"label": "main", "window_id": "1", "pid": 1},
                    {"label": "t", "window_id": "2", "pid": 3},
                    {"label": "main", "window_id": "3", "pid": 4}
                ]})
            ),
            "windows.0.pid: Too small: expected number to be >=2; windows.1.label: Invalid option: expected one of \"main\"|\"tray\"; windows: Too big: expected array to have <=2 items"
        );
    }

    #[test]
    fn complete_and_result_validate() {
        assert_eq!(
            message(
                "desktop.capture.complete",
                json!({"request_id": "r", "worker_token": "z", "error": "nope"})
            ),
            "worker_token: Invalid string: must match pattern /^[0-9a-f]{64}$/; error: Invalid option: expected one of \"permission_denied\"|\"window_unavailable\"|\"unsupported_platform\"|\"capture_failed\"|\"capture_timeout\""
        );
        assert_eq!(
            message("desktop.capture.result", json!({})),
            "request_id: Invalid input: expected string, received undefined"
        );
        assert_eq!(
            bridge_params(
                "desktop.capture.result",
                &json!({"request_id": "r", "extra": 1})
            )
            .unwrap(),
            json!({"op": "desktop.capture.result", "params": {"request_id": "r"}})
        );
    }
}
