//! `modelDeclarationSchema` from `src/dispatch/types.ts` with Zod 4's issue
//! texts, for operation params that carry runner model declarations
//! (`runner.models.set`, `runner.models.set_many`). Issues read
//! `<path>: <message>` in Zod's order; the root path is `params`.
use serde_json::{Map, Value};

/// `modelDeclarationSchema.array().max(256)`.
pub const MAX_MODELS: usize = 256;
/// `strengths: z.array(name).max(64)`.
pub const MAX_STRENGTHS: usize = 64;
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const TIERS: [&str; 4] = ["small", "medium", "frontier", "unknown"];
const FIELDS: [&str; 5] = ["id", "tier", "strengths", "tools", "context"];

/// Zod's name for a received value; `None` is a missing key.
pub fn received(value: Option<&Value>) -> &'static str {
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

/// The issue path of `key` under `path`.
pub fn at(path: &str, key: impl std::fmt::Display) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

/// Record `message` at `path`.
pub fn issue(issues: &mut Vec<String>, path: &str, message: impl std::fmt::Display) {
    let label = if path.is_empty() { "params" } else { path };
    issues.push(format!("{label}: {message}"));
}

/// `z.string().min(min).max(max)`; Zod counts code points.
pub fn string(
    value: Option<&Value>,
    path: &str,
    min: usize,
    max: Option<usize>,
    issues: &mut Vec<String>,
) -> Option<String> {
    let Some(Value::String(text)) = value else {
        let got = received(value);
        issue(
            issues,
            path,
            format!("Invalid input: expected string, received {got}"),
        );
        return None;
    };
    let length = text.chars().count();
    if length < min {
        issue(
            issues,
            path,
            format!("Too small: expected string to have >={min} characters"),
        );
        return None;
    }
    if let Some(max) = max.filter(|max| length > *max) {
        issue(
            issues,
            path,
            format!("Too big: expected string to have <={max} characters"),
        );
        return None;
    }
    Some(text.clone())
}

/// Array length bounds, reported after the element issues.
pub fn array_bounds(items: &[Value], path: &str, min: usize, max: usize, issues: &mut Vec<String>) {
    if items.len() < min {
        issue(
            issues,
            path,
            format!("Too small: expected array to have >={min} items"),
        );
    }
    if items.len() > max {
        issue(
            issues,
            path,
            format!("Too big: expected array to have <={max} items"),
        );
    }
}

/// A strict object's keys outside `known`, in object order.
pub fn unrecognized(
    map: &Map<String, Value>,
    known: &[&str],
    path: &str,
    issues: &mut Vec<String>,
) {
    let extra: Vec<String> = map
        .keys()
        .filter(|key| !known.contains(&key.as_str()))
        .map(|key| format!("\"{key}\""))
        .collect();
    match extra.len() {
        0 => {}
        1 => issue(issues, path, format!("Unrecognized key: {}", extra[0])),
        _ => issue(
            issues,
            path,
            format!("Unrecognized keys: {}", extra.join(", ")),
        ),
    }
}

/// `z.number().int().positive()`.
fn positive_int(value: &Value, path: &str, issues: &mut Vec<String>) {
    let Some(n) = value.as_f64() else {
        let got = received(Some(value));
        issue(
            issues,
            path,
            format!("Invalid input: expected number, received {got}"),
        );
        return;
    };
    if n.fract() != 0.0 {
        issue(issues, path, "Invalid input: expected int, received number");
        return;
    }
    if n < -MAX_SAFE {
        issue(
            issues,
            path,
            "Too small: expected int to be >=-9007199254740991",
        );
    }
    if n > MAX_SAFE {
        issue(
            issues,
            path,
            "Too big: expected int to be <=9007199254740991",
        );
    }
    if n <= 0.0 {
        issue(issues, path, "Too small: expected number to be >0");
    }
}

/// One declaration in Zod's output shape: `id`, `tier` (default `unknown`),
/// `strengths` (default `[]`), then `tools` and `context` when given.
fn declaration(value: &Value, path: &str, issues: &mut Vec<String>) -> Option<Value> {
    let Value::Object(map) = value else {
        let got = received(Some(value));
        issue(
            issues,
            path,
            format!("Invalid input: expected object, received {got}"),
        );
        return None;
    };
    let before = issues.len();
    let id = string(map.get("id"), &at(path, "id"), 1, Some(256), issues);
    let tier = match map.get("tier") {
        None => Some("unknown"),
        Some(tier) => tier
            .as_str()
            .filter(|tier| TIERS.contains(tier))
            .or_else(|| {
                let options = TIERS.map(|t| format!("\"{t}\"")).join("|");
                let message = format!("Invalid option: expected one of {options}");
                issue(issues, &at(path, "tier"), message);
                None
            }),
    };
    let strengths = match map.get("strengths") {
        None => Some(Vec::new()),
        Some(Value::Array(items)) => {
            let path = at(path, "strengths");
            let names: Vec<Option<String>> = items
                .iter()
                .enumerate()
                .map(|(i, item)| string(Some(item), &at(&path, i), 1, Some(256), issues))
                .collect();
            array_bounds(items, &path, 0, MAX_STRENGTHS, issues);
            names.into_iter().collect::<Option<Vec<_>>>()
        }
        Some(other) => {
            let got = received(Some(other));
            let message = format!("Invalid input: expected array, received {got}");
            issue(issues, &at(path, "strengths"), message);
            None
        }
    };
    if let Some(tools) = map.get("tools").filter(|tools| !tools.is_boolean()) {
        let got = received(Some(tools));
        let message = format!("Invalid input: expected boolean, received {got}");
        issue(issues, &at(path, "tools"), message);
    }
    if let Some(context) = map.get("context") {
        positive_int(context, &at(path, "context"), issues);
    }
    unrecognized(map, &FIELDS, path, issues);
    let (Some(id), Some(tier), Some(strengths)) = (id, tier, strengths) else {
        return None;
    };
    if issues.len() != before {
        return None;
    }
    let mut out = Map::new();
    out.insert("id".into(), Value::String(id));
    out.insert("tier".into(), Value::String(tier.into()));
    out.insert("strengths".into(), strengths.into());
    for key in ["tools", "context"] {
        if let Some(value) = map.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    Some(Value::Object(out))
}

/// `modelDeclarationSchema.array().max(256)` at `path`. The parsed
/// declarations are complete only when no issue was added.
pub fn model_declarations(
    value: Option<&Value>,
    path: &str,
    issues: &mut Vec<String>,
) -> Vec<Value> {
    let Some(Value::Array(items)) = value else {
        let got = received(value);
        issue(
            issues,
            path,
            format!("Invalid input: expected array, received {got}"),
        );
        return Vec::new();
    };
    let parsed = items
        .iter()
        .enumerate()
        .filter_map(|(i, item)| declaration(item, &at(path, i), issues))
        .collect();
    array_bounds(items, path, 0, MAX_MODELS, issues);
    parsed
}
