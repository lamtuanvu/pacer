//! Closed plugin document vocabulary. Text is data, never HTML or executable URLs.
use crate::settings::{clean_text, js_length};
use serde_json::Value;
pub const ROUTES: &[&str] = &[
    "start",
    "overview",
    "review",
    "sessions",
    "terminal",
    "settings",
    "hosts",
    "add-executor",
    "setup",
];
fn fail(path: &str, message: &str) -> String {
    format!(
        "{}: {message}",
        if path.trim_end_matches('.').is_empty() {
            "document"
        } else {
            path.trim_end_matches('.')
        }
    )
}
fn invalid(v: Option<&Value>, expected: &str) -> String {
    if let Some(n) = v.and_then(crate::json::number).filter(|n| !n.is_finite()) {
        return format!(
            "Invalid input: expected {expected}, received {}",
            crate::settings::js_number(n)
        );
    }
    let received = match v {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    };
    format!("Invalid input: expected {expected}, received {received}")
}
fn object(v: Option<&Value>, path: &str) -> Result<(), String> {
    if v.is_some_and(Value::is_object) {
        Ok(())
    } else {
        Err(fail(path, &invalid(v, "object")))
    }
}
fn text(
    v: &mut Value,
    key: &str,
    max: usize,
    min: usize,
    required: bool,
    path: &str,
) -> Result<(), String> {
    object(Some(v), path)?;
    let Some(value) = v.get_mut(key) else {
        return if required {
            Err(fail(
                &format!("{path}{key}"),
                "Invalid input: expected string, received undefined",
            ))
        } else {
            Ok(())
        };
    };
    let Some(s) = value.as_str().filter(|_| !crate::json::nonfinite(value)) else {
        return Err(fail(
            &format!("{path}{key}"),
            &invalid(Some(value), "string"),
        ));
    };
    let s = clean_text(s);
    let n = crate::js_semantics::codepoint_len(&s);
    if n < min {
        return Err(fail(
            &format!("{path}{key}"),
            &format!("Too small: expected string to have >={min} characters"),
        ));
    }
    if n > max {
        return Err(fail(
            &format!("{path}{key}"),
            &format!("Too big: expected string to have <={max} characters"),
        ));
    }
    *value = Value::String(s);
    Ok(())
}
fn enumeration(
    v: &Value,
    key: &str,
    items: &[&str],
    required: bool,
    path: &str,
) -> Result<(), String> {
    object(Some(v), path)?;
    if !required && v.get(key).is_none() {
        return Ok(());
    }
    if !v[key].as_str().is_some_and(|s| items.contains(&s)) {
        let message = if items.len() == 1 {
            format!("Invalid input: expected \"{}\"", items[0])
        } else {
            format!(
                "Invalid option: expected one of {}",
                items
                    .iter()
                    .map(|s| format!("\"{s}\""))
                    .collect::<Vec<_>>()
                    .join("|")
            )
        };
        return Err(fail(&format!("{path}{key}"), &message));
    }
    Ok(())
}
fn action(v: &Value, key: &str, path: &str) -> Result<(), String> {
    if !v[key].is_string() {
        return Err(fail(
            &format!("{path}{key}"),
            &invalid(v.get(key), "string"),
        ));
    }
    if !v[key].as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 64
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    }) {
        return Err(fail(
            &format!("{path}{key}"),
            "Invalid string: must match pattern /^[A-Za-z0-9._-]{1,64}$/",
        ));
    }
    Ok(())
}
fn closed(v: &Value, allowed: &[&str], path: &str) -> Result<(), String> {
    let Some(o) = v.as_object() else {
        return Err(fail(path, &invalid(Some(v), "object")));
    };
    let keys: Vec<_> = o
        .keys()
        .filter(|k| !allowed.contains(&k.as_str()))
        .collect();
    if !keys.is_empty() {
        return Err(fail(
            path,
            &format!(
                "Unrecognized key{}: {}",
                if keys.len() == 1 { "" } else { "s" },
                keys.iter()
                    .map(|k| format!("\"{k}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }
    Ok(())
}
fn node(
    v: &mut Value,
    path: &str,
    depth: usize,
    nodes: &mut usize,
    deepest: &mut usize,
) -> Result<(), String> {
    object(Some(v), path)?;
    *nodes += 1;
    *deepest = (*deepest).max(depth);
    // Bound recursive validation itself, before walking untrusted children.
    if depth > 512 {
        return Err("document is deeper than 8 levels".into());
    }
    let kind = v["type"].as_str().unwrap_or("").to_owned();
    let fields: &[&str] = match kind.as_str() {
        "section" => &["type", "title", "children"],
        "stack" => &["type", "gap", "children"],
        "heading" => &["type", "text", "level"],
        "text" => &["type", "text", "tone"],
        "keyValue" => &["type", "items"],
        "list" => &["type", "items", "empty"],
        "status" => &["type", "label", "tone"],
        "meter" => &["type", "label", "usedPct", "pacePct"],
        "code" => &["type", "text"],
        "link" => &["type", "label", "to"],
        "button" => &["type", "label", "action", "variant", "confirm"],
        "checkbox" => &["type", "label", "name", "checked", "action"],
        "empty" => &["type", "title", "body"],
        _ => {
            return Err(fail(
                &format!("{path}type"),
                "Invalid discriminator value. Expected 'section' | 'stack' | 'heading' | 'text' | 'keyValue' | 'list' | 'status' | 'meter' | 'code' | 'link' | 'button' | 'checkbox' | 'empty'",
            ));
        }
    };
    // Zod validates declared properties before reporting unknown keys.
    match kind.as_str() {
        "section" | "stack" => {
            if kind == "section" {
                text(v, "title", 80, 1, false, path)?;
            } else {
                enumeration(v, "gap", &["related", "content"], true, path)?;
            }
            if !v["children"].is_array() {
                return Err(fail(
                    &format!("{path}children"),
                    &invalid(v.get("children"), "array"),
                ));
            }
            let children = v["children"]
                .as_array_mut()
                .ok_or_else(|| fail(&format!("{path}children"), "Invalid input: expected array"))?;
            for (i, c) in children.iter_mut().enumerate() {
                node(
                    c,
                    &format!("{path}children.{i}."),
                    depth + 1,
                    nodes,
                    deepest,
                )?;
            }
        }
        "heading" => {
            text(v, "text", 80, 1, true, path)?;
            if !matches!(v["level"].as_f64(), Some(2.0 | 3.0)) {
                return Err(fail(&format!("{path}level"), "Invalid input"));
            }
        }
        "text" => {
            text(v, "text", 2000, 0, true, path)?;
            enumeration(v, "tone", &["muted"], false, path)?;
        }
        "code" => text(v, "text", 16384, 0, true, path)?,
        "empty" => {
            text(v, "title", 80, 1, true, path)?;
            text(v, "body", 2000, 0, false, path)?;
        }
        "keyValue" | "list" => {
            if kind == "list" {
                text(v, "empty", 80, 0, true, path)?;
            }
            if !v["items"].is_array() {
                return Err(fail(
                    &format!("{path}items"),
                    &invalid(v.get("items"), "array"),
                ));
            }
            let items = v["items"]
                .as_array_mut()
                .ok_or_else(|| fail(&format!("{path}items"), "Invalid input: expected array"))?;
            let max = if kind == "list" { 200 } else { 50 };
            for (i, item) in items.iter_mut().enumerate() {
                let p = format!("{path}items.{i}.");
                if kind == "keyValue" {
                    text(item, "label", 80, 1, true, &p)?;
                    text(item, "value", 80, 0, true, &p)?;
                    closed(item, &["label", "value"], &p)?;
                } else {
                    text(item, "title", 120, 1, true, &p)?;
                    text(item, "subtitle", 200, 0, false, &p)?;
                    if let Some(status) = item.get_mut("status") {
                        text(status, "label", 80, 1, true, &format!("{p}status."))?;
                        enumeration(
                            status,
                            "tone",
                            &["neutral", "info", "good", "warn", "bad"],
                            true,
                            &format!("{p}status."),
                        )?;
                        closed(status, &["label", "tone"], &format!("{p}status."))?;
                    }
                    if item.get("action").is_some() {
                        action(item, "action", &p)?;
                    }
                    closed(item, &["title", "subtitle", "status", "action"], &p)?;
                }
            }
            if items.len() > max {
                return Err(fail(
                    &format!("{path}items"),
                    &format!("Too big: expected array to have <={max} items"),
                ));
            }
        }
        _ => {
            text(v, "label", 80, 1, true, path)?;
            match kind.as_str() {
                "status" => enumeration(
                    v,
                    "tone",
                    &["neutral", "info", "good", "warn", "bad"],
                    true,
                    path,
                )?,
                "meter" => {
                    for key in ["usedPct", "pacePct"] {
                        if key == "pacePct" && v.get(key).is_none() {
                            continue;
                        }
                        let Some(n) = v[key].as_f64() else {
                            return Err(fail(
                                &format!("{path}{key}"),
                                &invalid(v.get(key), "number"),
                            ));
                        };
                        if !(0.0..=100.0).contains(&n) {
                            return Err(fail(
                                &format!("{path}{key}"),
                                if n < 0.0 {
                                    "Too small: expected number to be >=0"
                                } else {
                                    "Too big: expected number to be <=100"
                                },
                            ));
                        }
                    }
                }
                "link" => {
                    object(v.get("to"), &format!("{path}to."))?;
                    let to = &v["to"];
                    enumeration(to, "route", ROUTES, true, &format!("{path}to."))?;
                    if let Some(id) = to.get("taskId")
                        && !id.as_str().is_some_and(|s| {
                            !s.is_empty()
                                && s.len() <= 128
                                && s.bytes()
                                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
                        })
                    {
                        return Err(fail(
                            &format!("{path}to.taskId"),
                            &if id.is_string() {
                                "taskId uses letters, digits and . _ : -".into()
                            } else {
                                invalid(Some(id), "string")
                            },
                        ));
                    }
                    closed(to, &["route", "taskId"], &format!("{path}to."))?;
                }
                "button" | "checkbox" => {
                    if kind == "button" {
                        action(v, "action", path)?;
                        enumeration(v, "variant", &["secondary", "quiet", "danger"], true, path)?;
                        if let Some(confirm) = v.get_mut("confirm") {
                            text(confirm, "title", 80, 1, true, &format!("{path}confirm."))?;
                            text(confirm, "body", 2000, 1, true, &format!("{path}confirm."))?;
                            closed(confirm, &["title", "body"], &format!("{path}confirm."))?;
                        }
                    } else {
                        action(v, "name", path)?;
                        if !v["checked"].is_boolean() {
                            return Err(fail(
                                &format!("{path}checked"),
                                &invalid(v.get("checked"), "boolean"),
                            ));
                        }
                        action(v, "action", path)?;
                    }
                }
                _ => (),
            }
        }
    }
    closed(v, fields, path.trim_end_matches('.'))
}
pub fn parse(mut raw: Value, status: bool) -> Result<Value, String> {
    if crate::settings::js_json(&raw).len() > 65536 {
        return Err("document exceeds 65536 bytes".into());
    }
    let (mut nodes, mut deepest) = (0, 0);
    node(&mut raw, "", 1, &mut nodes, &mut deepest)?;
    if nodes > 500 {
        return Err("document has more than 500 nodes".into());
    }
    if deepest > 8 {
        return Err("document is deeper than 8 levels".into());
    }
    if status {
        let key = match raw["type"].as_str() {
            Some("status" | "button") => "label",
            Some("text") => "text",
            _ => return Err("a status item is one status, text or button node".into()),
        };
        if raw[key].as_str().is_some_and(|s| js_length(s) > 24) {
            return Err("status item text is longer than 24 characters".into());
        }
    }
    Ok(raw)
}

/// Validate an untrusted plugin veto response, stripping undeclared fields.
pub fn validate_result(raw: Value) -> Result<Vec<Value>, String> {
    if raw["ok"] == true {
        return Ok(vec![]);
    }
    if raw["ok"] != false {
        return Err("invalid validation result".into());
    }
    let errors = raw["errors"]
        .as_array()
        .ok_or("invalid validation result")?;
    if errors.len() > 50 {
        return Err("invalid validation result".into());
    }
    errors
        .iter()
        .map(|error| {
            let path = error["path"].as_str().ok_or("invalid validation path")?;
            let message = error["message"]
                .as_str()
                .ok_or("invalid validation message")?;
            let path = clean_text(path);
            let message = clean_text(message);
            if crate::js_semantics::codepoint_len(&path) > 200
                || crate::js_semantics::codepoint_len(&message) > 200
            {
                return Err("invalid validation result".into());
            }
            Ok(serde_json::json!({"path":path,"message":message}))
        })
        .collect()
}
