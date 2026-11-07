//! The two Zod passes over issue params: the published operation schema (`issueImportParams`,
//! `issueSearchParams`, reported by `parseOpParams`) and the bounded core schema (`issueImportSchema`,
//! `issueSearchSchema`, reported as "Invalid issue … input" with the issues in the hint).
use pacer_foundation::api::{Code, CoreError};
use serde_json::{Map, Value};

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

pub(crate) struct ImportInput {
    pub repo: String,
    pub issue: String,
}

pub(crate) struct SearchInput {
    pub repo: String,
    pub query: String,
    pub state: Option<String>,
    pub limit: Option<u64>,
}

fn received(value: Option<&Value>) -> &'static str {
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

fn object(params: &Value) -> Result<Map<String, Value>, CoreError> {
    match params {
        Value::Null => Ok(Map::new()),
        Value::Object(map) => Ok(map.clone()),
        other => Err(CoreError::new(
            Code::InvalidInput,
            format!(
                "params: Invalid input: expected object, received {}",
                received(Some(other))
            ),
        )),
    }
}

fn string(map: &Map<String, Value>, name: &str, optional: bool, issues: &mut Vec<String>) {
    let value = map.get(name);
    if value.is_some_and(Value::is_string) || (optional && value.is_none()) {
        return;
    }
    issues.push(format!(
        "{name}: Invalid input: expected string, received {}",
        received(value)
    ));
}

fn strict(map: &Map<String, Value>, known: &[&str], issues: &mut Vec<String>) {
    let unknown: Vec<String> = map
        .keys()
        .filter(|key| !known.contains(&key.as_str()))
        .map(|key| format!("\"{key}\""))
        .collect();
    match unknown.len() {
        0 => {}
        1 => issues.push(format!("params: Unrecognized key: {}", unknown[0])),
        _ => issues.push(format!("params: Unrecognized keys: {}", unknown.join(", "))),
    }
}

fn published(issues: Vec<String>) -> Result<(), CoreError> {
    if issues.is_empty() {
        Ok(())
    } else {
        Err(CoreError::new(Code::InvalidInput, issues.join("; ")))
    }
}

fn text(map: &Map<String, Value>, name: &str) -> String {
    map.get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// `issueImportParams`: `{repo: string, issue: string}`, strict.
pub(crate) fn import(params: &Value) -> Result<ImportInput, CoreError> {
    let map = object(params)?;
    let mut issues = Vec::new();
    string(&map, "repo", false, &mut issues);
    string(&map, "issue", false, &mut issues);
    strict(&map, &["repo", "issue"], &mut issues);
    published(issues)?;
    Ok(ImportInput {
        repo: text(&map, "repo"),
        issue: text(&map, "issue"),
    })
}

/// `issueSearchParams`: `{repo: string, query: string, state?: string, limit?: int}`, strict.
pub(crate) fn search(params: &Value) -> Result<SearchInput, CoreError> {
    let map = object(params)?;
    let mut issues = Vec::new();
    string(&map, "repo", false, &mut issues);
    string(&map, "query", false, &mut issues);
    string(&map, "state", true, &mut issues);
    if let Some(limit) = map.get("limit") {
        match limit.as_f64() {
            None => issues.push(format!(
                "limit: Invalid input: expected number, received {}",
                received(Some(limit))
            )),
            Some(n) if n.fract() != 0.0 => {
                issues.push("limit: Invalid input: expected int, received number".into());
            }
            Some(n) if n > MAX_SAFE => {
                issues.push(format!("limit: Too big: expected int to be <={MAX_SAFE}"));
            }
            Some(n) if n < -MAX_SAFE => {
                issues.push(format!(
                    "limit: Too small: expected int to be >=-{MAX_SAFE}"
                ));
            }
            Some(_) => {}
        }
    }
    strict(&map, &["repo", "query", "state", "limit"], &mut issues);
    published(issues)?;
    Ok(SearchInput {
        repo: text(&map, "repo"),
        query: text(&map, "query"),
        state: map.get("state").and_then(Value::as_str).map(str::to_owned),
        // Negative integers saturate to 0 and report "Too small" in the core pass, as in Zod.
        limit: map.get("limit").and_then(Value::as_f64).map(|n| n as u64),
    })
}

/// Zod `min`/`max` on a string's UTF-16 length.
fn length(name: &str, value: &str, max: usize, issues: &mut Vec<String>) {
    let units = value.encode_utf16().count();
    if units < 1 {
        issues.push(format!(
            "{name}: Too small: expected string to have >=1 characters"
        ));
    } else if units > max {
        issues.push(format!(
            "{name}: Too big: expected string to have <={max} characters"
        ));
    }
}

fn core(message: &str, issues: Vec<String>) -> Result<(), CoreError> {
    if issues.is_empty() {
        Ok(())
    } else {
        Err(CoreError::new(Code::InvalidInput, message).hint(issues.join("; ")))
    }
}

/// `issueImportSchema` over input that already passed the published schema.
pub(crate) fn import_bounds(input: &ImportInput) -> Result<(), CoreError> {
    let mut issues = Vec::new();
    length("repo", &input.repo, 512, &mut issues);
    length("issue", &input.issue, 2048, &mut issues);
    core("Invalid issue import input", issues)
}

/// `issueSearchSchema` over input that already passed the published schema.
pub(crate) fn search_bounds(input: &SearchInput) -> Result<(), CoreError> {
    let mut issues = Vec::new();
    length("repo", &input.repo, 512, &mut issues);
    length("query", &input.query, 256, &mut issues);
    if input
        .state
        .as_deref()
        .is_some_and(|s| !matches!(s, "open" | "closed" | "all"))
    {
        issues.push(r#"state: Invalid option: expected one of "open"|"closed"|"all""#.into());
    }
    match input.limit {
        Some(0) => issues.push("limit: Too small: expected number to be >=1".into()),
        Some(limit) if limit > 50 => {
            issues.push("limit: Too big: expected number to be <=50".into());
        }
        _ => {}
    }
    core("Invalid issue search input", issues)
}
