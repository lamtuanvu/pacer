//! The P2-C subset of the TS operation schemas, including Zod issue order.
use pacer_foundation::api::{Code, CoreError};
use serde_json::{Value, json};

#[derive(Clone)]
enum Schema {
    String(usize, Option<usize>),
    Bool,
    Integer(f64),
    /// Inclusive min/max with Zod `.min(n).max(m)` messages (`>=` / `<=`).
    IntegerBounds(f64, f64),
    Level,
    HostSession,
    Json,
    Array(Box<Schema>),
    Object(Vec<(&'static str, Schema, bool)>),
    Nullable(Box<Schema>),
    RunnerId,
}
fn id() -> Schema {
    Schema::String(1, Some(128))
}
fn draft() -> Schema {
    object(vec![
        ("from", id(), false),
        ("set", Schema::Json, true),
        ("unset", array(Schema::String(0, None)), true),
        ("description", Schema::String(0, None), true),
    ])
}
fn array(s: Schema) -> Schema {
    Schema::Array(Box::new(s))
}
fn object(fields: Vec<(&'static str, Schema, bool)>) -> Schema {
    Schema::Object(fields)
}
fn kind(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}
fn runner_id(s: &str) -> bool {
    let mut parts = s.split('@');
    let body = parts.next().unwrap_or("");
    let host = parts.next();
    if parts.next().is_some() {
        return false;
    }
    let mut parts = body.split('#');
    let agent = parts.next().unwrap_or("");
    let account = parts.next();
    let component = |s: &str| {
        !s.is_empty()
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    parts.next().is_none()
        && ["claude-code", "codex", "cursor", "agy", "opencode"].contains(&agent)
        && account.is_none_or(component)
        && host.is_none_or(component)
}
fn validate(schema: &Schema, value: Option<&Value>, path: &str, issues: &mut Vec<String>) -> Value {
    let label = if path.is_empty() { "params" } else { path };
    let mut issue = |message: String| issues.push(format!("{label}: {message}"));
    let expected = match schema {
        Schema::String(_, _) | Schema::RunnerId => "string",
        Schema::Bool => "boolean",
        Schema::Integer(_) | Schema::IntegerBounds(_, _) => "number",
        Schema::Array(_) => "array",
        Schema::Object(_) => "object",
        _ => "",
    };
    let valid = match schema {
        Schema::Nullable(inner) => {
            return if value == Some(&Value::Null) {
                Value::Null
            } else {
                validate(inner, value, path, issues)
            };
        }
        Schema::Level => {
            if !value
                .and_then(Value::as_str)
                .is_some_and(|v| ["off", "important", "all"].contains(&v))
            {
                issue("Invalid option: expected one of \"off\"|\"important\"|\"all\"".into());
            }
            return value.cloned().unwrap_or(Value::Null);
        }
        Schema::HostSession => {
            if !value
                .and_then(Value::as_str)
                .is_some_and(|v| matches!(v, "recording" | "full"))
            {
                issue("Invalid option: expected one of \"recording\"|\"full\"".into());
            }
            return value.cloned().unwrap_or(Value::Null);
        }
        Schema::Json => return value.cloned().unwrap_or(Value::Null),
        Schema::String(_, _) | Schema::RunnerId => value.is_some_and(Value::is_string),
        Schema::Bool => value.is_some_and(Value::is_boolean),
        Schema::Integer(_) | Schema::IntegerBounds(_, _) => value.is_some_and(Value::is_number),
        Schema::Array(_) => value.is_some_and(Value::is_array),
        Schema::Object(_) => value.is_some_and(Value::is_object),
    };
    if !valid {
        issue(format!(
            "Invalid input: expected {expected}, received {}",
            kind(value)
        ));
        return Value::Null;
    }
    let value = value.unwrap_or(&Value::Null);
    match schema {
        Schema::String(min, max) => {
            let len = value.as_str().unwrap_or("").chars().count();
            if len < *min {
                issue(format!(
                    "Too small: expected string to have >={min} characters"
                ));
            }
            if let Some(max) = max
                && len > *max
            {
                issue(format!(
                    "Too big: expected string to have <={max} characters"
                ));
            }
        }
        Schema::RunnerId => {
            let s = value.as_str().unwrap_or("");
            if s.is_empty() {
                issue("Too small: expected string to have >=1 characters".into());
            }
            if s.chars().count() > 128 {
                issue("Too big: expected string to have <=128 characters".into());
            }
            if !runner_id(s) {
                issue("invalid runner id".into());
            }
        }
        Schema::Integer(min) => {
            let n = value.as_f64().unwrap_or(f64::NAN);
            if !n.is_finite() || n.fract() != 0.0 {
                issue("Invalid input: expected int, received number".into());
            } else {
                if n < -9_007_199_254_740_991.0 {
                    issue("Too small: expected int to be >=-9007199254740991".into());
                }
                if n > 9_007_199_254_740_991.0 {
                    issue("Too big: expected int to be <=9007199254740991".into());
                }
                if n < *min {
                    issue(if *min == 0.0 {
                        "Too small: expected number to be >=0".into()
                    } else {
                        "Too small: expected number to be >0".into()
                    });
                }
            }
        }
        Schema::IntegerBounds(min, max) => {
            let n = value.as_f64().unwrap_or(f64::NAN);
            if !n.is_finite() || n.fract() != 0.0 {
                issue("Invalid input: expected int, received number".into());
            } else {
                if n < -9_007_199_254_740_991.0 {
                    issue("Too small: expected int to be >=-9007199254740991".into());
                }
                if n > 9_007_199_254_740_991.0 {
                    issue("Too big: expected int to be <=9007199254740991".into());
                }
                if n < *min {
                    issue(format!("Too small: expected number to be >={min}"));
                }
                if n > *max {
                    issue(format!("Too big: expected number to be <={max}"));
                }
            }
        }
        Schema::Array(inner) => {
            return Value::Array(
                value
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                    .map(|(i, v)| validate(inner, Some(v), &format!("{path}.{i}"), issues))
                    .collect(),
            );
        }
        Schema::Object(fields) => {
            let mut result = serde_json::Map::new();
            for (key, inner, optional) in fields {
                let v = value.get(key);
                if *optional && v.is_none() {
                    continue;
                }
                let child = if path.is_empty() {
                    key.to_string()
                } else {
                    format!("{path}.{key}")
                };
                result.insert((*key).into(), validate(inner, v, &child, issues));
            }
            return Value::Object(result);
        }
        _ => {}
    }
    value.clone()
}
#[allow(clippy::result_large_err)]
pub fn parse(op: &str, mut params: Value) -> Result<Value, CoreError> {
    pacer_config::normalize_json(&mut params);
    use Schema::*;
    let schema = match op {
        "strategy.list" => object(vec![]),
        "strategy.show" => object(vec![("name", id(), false)]),
        "strategy.use" => object(vec![("name", String(1, None), false)]),
        "strategy.remove" => object(vec![("name", id(), false)]),
        "strategy.save" => object(vec![
            ("name", id(), false),
            ("draft", draft(), false),
            ("reason", String(1, None), false),
            ("overwrite", Bool, true),
        ]),
        "strategy.preview" => object(vec![("draft", draft(), false)]),
        "routing.get" => object(vec![]),
        "routing.set" => object(vec![(
            "rules",
            array(object(vec![
                ("kinds", array(String(0, None)), true),
                ("executors", array(id()), false),
            ])),
            false,
        )]),
        "runner.set" => object(vec![
            ("id", id(), false),
            ("enabled", Bool, true),
            ("model", Nullable(Box::new(String(1, None))), true),
            ("max_tasks", Integer(1.0), true),
            ("rank", Integer(0.0), true),
        ]),
        "runner.reorder" => object(vec![("ids", array(id()), false)]),
        "runner.remove" => object(vec![("id", RunnerId, false)]),
        "runner.settings.get" => object(vec![]),
        "runner.settings.save" => object(vec![
            ("expectedRevision", String(1, None), false),
            ("order", array(id()), false),
            (
                "runners",
                array(object(vec![
                    ("id", id(), false),
                    ("enabled", Bool, false),
                    ("maxTasks", IntegerBounds(1.0, 16.0), false),
                ])),
                false,
            ),
        ]),
        "notifications.set" => object(vec![("level", Level, false)]),
        "host.add" => object(vec![
            ("alias", id(), false),
            ("ssh", String(1, None), false),
        ]),
        "host.remove" => object(vec![("alias", id(), false)]),
        "host.repo.map" => object(vec![
            ("alias", id(), false),
            ("key", id(), false),
            ("path", String(1, None), false),
        ]),
        "host.account.add" => object(vec![
            ("alias", id(), false),
            ("account", id(), false),
            ("home", String(1, None), false),
        ]),
        "host.set" => object(vec![
            ("alias", id(), false),
            ("max_tasks", IntegerBounds(1.0, 16.0), true),
            ("paused", Bool, true),
            ("session", HostSession, true),
        ]),
        "config.set" => {
            return parse_config_set(params);
        }
        _ => object(vec![]),
    };
    let params = if params.is_null() { json!({}) } else { params };
    let mut issues = Vec::new();
    let result = validate(&schema, Some(&params), "", &mut issues);
    // z.record(z.string(), z.json()) has an object boundary, but arbitrary keys.
    if matches!(op, "strategy.save" | "strategy.preview")
        && let Some(set) = params.pointer("/draft/set")
        && !set.is_object()
    {
        // Keep this issue in schema order, before unset/description/reason.
        let at = issues
            .iter()
            .position(|s| {
                s.starts_with("draft.unset")
                    || s.starts_with("draft.description")
                    || s.starts_with("reason:")
                    || s.starts_with("overwrite:")
            })
            .unwrap_or(issues.len());
        issues.insert(
            at,
            format!(
                "draft.set: Invalid input: expected record, received {}",
                kind(Some(set))
            ),
        );
    }
    if issues.is_empty() {
        Ok(result)
    } else {
        Err(CoreError::new(Code::InvalidInput, issues.join("; ")))
    }
}

fn config_key_options() -> String {
    pacer_config::settings::CONFIG_KEYS
        .iter()
        .map(|k| format!("\"{k}\""))
        .collect::<Vec<_>>()
        .join("|")
}

#[allow(clippy::result_large_err)]
fn parse_config_set(mut params: Value) -> Result<Value, CoreError> {
    pacer_config::normalize_json(&mut params);
    // Zod's object schema treats null like a missing object body for these fields.
    let params = if params.is_null() { json!({}) } else { params };
    let mut issues = Vec::new();
    if !params.is_object() {
        issues.push(format!(
            "params: Invalid input: expected object, received {}",
            kind(Some(&params))
        ));
        return Err(CoreError::new(Code::InvalidInput, issues.join("; ")));
    }
    let key = params.get("key").and_then(Value::as_str);
    if !key.is_some_and(|k| pacer_config::settings::CONFIG_KEYS.contains(&k)) {
        // z.enum reports Invalid option for missing, wrong-type and unknown keys.
        issues.push(format!(
            "key: Invalid option: expected one of {}",
            config_key_options()
        ));
    }
    let value = params.get("value");
    let value_ok = value.is_some_and(|v| {
        v.is_string()
            || v.is_number()
            || v.is_boolean()
            || v.as_array().is_some_and(|a| a.iter().all(Value::is_string))
    });
    if !value_ok {
        // z.union collapses to a bare Invalid input for this field.
        issues.push("value: Invalid input".into());
    }
    if let Some(integrations) = params.get("integrations")
        && !integrations
            .as_str()
            .is_some_and(|v| matches!(v, "install" | "skip"))
    {
        issues.push("integrations: Invalid option: expected one of \"install\"|\"skip\"".into());
    }
    if !issues.is_empty() {
        return Err(CoreError::new(Code::InvalidInput, issues.join("; ")));
    }
    let mut result = serde_json::Map::new();
    result.insert(
        "key".into(),
        params.get("key").cloned().unwrap_or(Value::Null),
    );
    result.insert(
        "value".into(),
        params.get("value").cloned().unwrap_or(Value::Null),
    );
    if let Some(integrations) = params.get("integrations") {
        result.insert("integrations".into(), integrations.clone());
    }
    Ok(Value::Object(result))
}
