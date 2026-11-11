use super::Mode;
use serde_json::{Map, Value};
use std::process::{Command, Stdio};

pub(super) fn validate(
    mode: Mode,
    name: &str,
    schema: &Value,
    mut value: Value,
) -> Result<Value, String> {
    // These transforms are intentionally not expressed by JSON Schema. String bounds
    // use Zod 4's code-point counting, not JS String.length's UTF-16 unit counting.
    let trim_field = match (mode, name) {
        (Mode::Planner, "delegate") => Some("title"),
        (Mode::Planner, "task_request_review") => Some("note"),
        _ => None,
    };
    if let Some(field) = trim_field
        && let Some(text) = value[field].as_str()
    {
        value[field] = text.trim_matches(js_whitespace).into();
    }
    let mut errors = Vec::new();
    let mut root = schema.clone();
    if mode == Mode::Planner && name == "delegate" {
        root["properties"]["base"]["pacerBase"] = true.into();
    }
    let parsed = parse(&root, &root, Some(&value), "", &mut errors);
    if errors.is_empty() {
        Ok(parsed)
    } else {
        Err(errors.join("\n"))
    }
}

fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn valid_base(base: &str) -> bool {
    if (7..=40).contains(&base.len()) && base.bytes().all(|b| b.is_ascii_hexdigit()) {
        return true;
    }
    if base.is_empty() || base.contains('\0') || base.starts_with('-') || base.contains("@{") {
        return false;
    }
    Command::new("git")
        .args(["check-ref-format", "--branch", base])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn issue(errors: &mut Vec<String>, path: &str, message: String) {
    errors.push(if path.is_empty() {
        message
    } else {
        format!("{message} at {path}")
    });
}

fn received(v: Option<&Value>) -> &'static str {
    if let Some(label) = v.and_then(super::json::nonfinite) {
        return label;
    }
    match v {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(n)) if n.as_f64().is_none_or(|n| !n.is_finite()) => {
            if n.to_string().starts_with('-') {
                "-Infinity"
            } else {
                "Infinity"
            }
        }
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn child_path(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.into()
    } else {
        format!("{path}.{key}")
    }
}

fn parse(
    root: &Value,
    schema: &Value,
    value: Option<&Value>,
    path: &str,
    errors: &mut Vec<String>,
) -> Value {
    if let Some(reference) = schema["$ref"].as_str().and_then(|r| r.strip_prefix('#')) {
        return parse(
            root,
            &root.pointer(reference).cloned().unwrap_or_default(),
            value,
            path,
            errors,
        );
    }
    if value.is_none()
        && let Some(default) = schema.get("default")
    {
        return default.clone();
    }
    if let Some(choices) = schema["anyOf"].as_array() {
        let mut continuable = Vec::new();
        for choice in choices {
            let mut local = Vec::new();
            let parsed = parse(root, choice, value, path, &mut local);
            if local.is_empty() {
                return parsed;
            }
            if local
                .iter()
                .all(|e| !e.starts_with("Invalid") && !e.starts_with("Unrecognized"))
            {
                continuable.push(local);
            }
        }
        if continuable.len() == 1 {
            if let Some(local) = continuable.pop() {
                errors.extend(local);
            }
        } else {
            issue(errors, path, "Invalid input".into());
        }
        return Value::Null;
    }
    if let Some(choices) = schema["enum"].as_array()
        && !value.is_some_and(|v| choices.contains(v))
    {
        let options = choices
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("|");
        let msg = if choices.len() == 1 {
            format!("Invalid input: expected {options}")
        } else {
            format!("Invalid option: expected one of {options}")
        };
        issue(errors, path, msg);
        return Value::Null;
    }
    if let Some(constant) = schema.get("const")
        && value != Some(constant)
    {
        issue(errors, path, format!("Invalid input: expected {constant}"));
        return Value::Null;
    }
    let kind = schema["type"].as_str().unwrap_or_default();
    let valid_type = match kind {
        "string" => value.is_some_and(|v| v.is_string() && super::json::nonfinite(v).is_none()),
        "boolean" => value.is_some_and(Value::is_boolean),
        "object" => value.is_some_and(Value::is_object),
        "array" => value.is_some_and(Value::is_array),
        "number" | "integer" => value.and_then(Value::as_f64).is_some_and(f64::is_finite),
        "null" => value.is_some_and(Value::is_null),
        _ => true,
    };
    if !valid_type {
        let expected = if kind == "integer" { "number" } else { kind };
        issue(
            errors,
            path,
            format!(
                "Invalid input: expected {expected}, received {}",
                received(value)
            ),
        );
        return Value::Null;
    }
    let value = value.cloned().unwrap_or_default();
    match kind {
        "object" => {
            let Some(object) = value.as_object() else {
                return value;
            };
            let mut out = Map::new();
            let props = schema["properties"].as_object();
            if let Some(props) = props {
                for (key, child) in props {
                    let required = schema["required"]
                        .as_array()
                        .is_some_and(|keys| keys.iter().any(|k| k == key));
                    if object.contains_key(key) || required || child.get("default").is_some() {
                        out.insert(
                            key.clone(),
                            parse(root, child, object.get(key), &child_path(path, key), errors),
                        );
                    }
                }
            }
            let unknown: Vec<_> = super::json::object_keys(object)
                .into_iter()
                .filter(|k| props.is_none_or(|p| !p.contains_key(*k)))
                .collect();
            if schema["additionalProperties"] == false && !unknown.is_empty() {
                let keys = unknown
                    .iter()
                    .map(|k| format!("\"{k}\""))
                    .collect::<Vec<_>>()
                    .join(", ");
                issue(
                    errors,
                    path,
                    format!(
                        "Unrecognized key{}: {keys}",
                        if unknown.len() == 1 { "" } else { "s" }
                    ),
                );
            } else if schema["additionalProperties"].is_object() {
                for key in unknown {
                    let parsed = parse(
                        root,
                        &schema["additionalProperties"],
                        object.get(key),
                        &child_path(path, key),
                        errors,
                    );
                    if key != "__proto__" {
                        out.insert(key.clone(), parsed);
                    }
                }
            }
            Value::Object(out)
        }
        "array" => {
            let Some(items) = value.as_array() else {
                return value;
            };
            bounds(schema, items.len(), "array", path, errors);
            Value::Array(
                items
                    .iter()
                    .enumerate()
                    .map(|(i, item)| {
                        parse(
                            root,
                            &schema["items"],
                            Some(item),
                            &format!("{path}[{i}]"),
                            errors,
                        )
                    })
                    .collect(),
            )
        }
        "string" => {
            let Some(text) = value.as_str() else {
                return value;
            };
            bounds(
                schema,
                super::json::code_points(text),
                "string",
                path,
                errors,
            );
            if let Some(pattern) = schema["pattern"].as_str() {
                let lower = pattern.starts_with("^[a-z");
                let allowed = |b: u8| {
                    b.is_ascii_lowercase()
                        || b.is_ascii_digit()
                        || (!lower && b.is_ascii_uppercase())
                };
                let valid = (1..=40).contains(&text.len())
                    && text.bytes().next().is_some_and(allowed)
                    && text
                        .bytes()
                        .all(|b| allowed(b) || b == b'-' || (!lower && b == b'_'));
                if !valid {
                    let message = if lower {
                        format!("Invalid string: must match pattern /{pattern}/")
                    } else {
                        "group must be 1–40 characters, starting alphanumeric, of letters, digits, - and _".into()
                    };
                    issue(errors, path, message);
                }
            }
            if schema["pacerBase"] == true && !valid_base(text) {
                issue(
                    errors,
                    path,
                    "base must be a branch name or a 7–40 hex SHA".into(),
                );
            }
            value
        }
        "integer" | "number" => {
            let Some(number) = value.as_f64() else {
                return value;
            };
            if kind == "integer" {
                if number.fract() != 0.0 {
                    issue(
                        errors,
                        path,
                        "Invalid input: expected int, received number".into(),
                    );
                    return value;
                }
                if number.abs() > 9_007_199_254_740_991.0 {
                    let message = if number > 0.0 {
                        "Too big: expected int to be <=9007199254740991"
                    } else {
                        "Too small: expected int to be >=-9007199254740991"
                    };
                    issue(errors, path, message.into());
                }
            }
            for (field, too, comparator, exclusive) in [
                ("minimum", "small", ">=", false),
                ("exclusiveMinimum", "small", ">", true),
                ("maximum", "big", "<=", false),
                ("exclusiveMaximum", "big", "<", true),
            ] {
                if let Some(bound) = schema[field].as_f64() {
                    if kind == "integer" && field == "maximum" && bound == 9_007_199_254_740_991.0 {
                        continue;
                    }
                    let bad = if too == "small" {
                        number < bound || (exclusive && number == bound)
                    } else {
                        number > bound || (exclusive && number == bound)
                    };
                    if bad {
                        issue(
                            errors,
                            path,
                            format!(
                                "Too {too}: expected number to be {comparator}{}",
                                schema[field]
                            ),
                        );
                    }
                }
            }
            // JSON.parse uses IEEE doubles even for integer tokens; normalize before
            // passing to a backend so large integers and -0 have JS semantics too.
            super::wire::number_value(number)
        }
        _ => value,
    }
}

fn bounds(schema: &Value, count: usize, kind: &str, path: &str, errors: &mut Vec<String>) {
    let (min, max, unit) = if kind == "string" {
        ("minLength", "maxLength", "characters")
    } else {
        ("minItems", "maxItems", "items")
    };
    for (key, too, cmp) in [(min, "small", ">="), (max, "big", "<=")] {
        if let Some(bound) = schema[key].as_u64()
            && ((too == "small" && (count as u64) < bound)
                || (too == "big" && count as u64 > bound))
        {
            issue(
                errors,
                path,
                format!("Too {too}: expected {kind} to have {cmp}{bound} {unit}"),
            );
        }
    }
}
