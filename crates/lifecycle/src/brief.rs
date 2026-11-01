use serde_json::{Map, Value};
use std::{path::Path, process::Command};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("{0}")]
pub struct AdmissionError(pub String);

fn string_field<'a>(
    raw: &'a Value,
    name: &str,
    min: usize,
    max: Option<usize>,
) -> Result<Option<&'a str>, AdmissionError> {
    let Some(value) = raw.get(name) else {
        return Ok(None);
    };
    let text = value
        .as_str()
        .ok_or_else(|| AdmissionError(format!("{name}: Expected string")))?;
    if text.chars().count() < min || max.is_some_and(|n| text.chars().count() > n) {
        return Err(AdmissionError(format!("{name}: invalid length")));
    }
    Ok(Some(text))
}

fn boolean_field(raw: &Value, name: &str) -> Result<(), AdmissionError> {
    if raw.get(name).is_some_and(|value| !value.is_boolean()) {
        return Err(AdmissionError(format!("{name}: Expected boolean")));
    }
    Ok(())
}

fn number_field(
    raw: &Value,
    name: &str,
    min: f64,
    max: f64,
    integer: bool,
) -> Result<(), AdmissionError> {
    let Some(value) = raw.get(name) else {
        return Ok(());
    };
    let n = value
        .as_f64()
        .ok_or_else(|| AdmissionError(format!("{name}: Expected number")))?;
    if !n.is_finite() || n < min || n > max || (integer && n.fract() != 0.0) {
        return Err(AdmissionError(format!("{name}: invalid number")));
    }
    Ok(())
}

fn enum_field(
    raw: &Value,
    name: &str,
    values: &[&str],
    message: &str,
) -> Result<(), AdmissionError> {
    if let Some(value) = raw.get(name)
        && !value.as_str().is_some_and(|s| values.contains(&s))
    {
        return Err(AdmissionError(message.into()));
    }
    Ok(())
}

pub fn valid_base(base: &str) -> bool {
    if (7..=40).contains(&base.len()) && base.bytes().all(|c| c.is_ascii_hexdigit()) {
        return true;
    }
    if base.is_empty() || base.contains('\0') || base.starts_with('-') || base.contains("@{") {
        return false;
    }
    Command::new("git")
        .args(["check-ref-format", "--branch", base])
        .output()
        .is_ok_and(|result| result.status.success())
}

fn copy_if_present(from: &Value, to: &mut Map<String, Value>, source: &str, target: &str) {
    if let Some(value) = from.get(source) {
        to.insert(target.into(), value.clone());
    }
}

/// Parse the public task delegate fields. Unknown caller fields are discarded, as in Zod's object schema.
pub fn parse_delegate_brief(raw: &Value, default_repo: &str) -> Result<Value, AdmissionError> {
    if !raw.is_object() {
        return Err(AdmissionError("delegate input must be an object".into()));
    }
    string_field(raw, "goal", 1, None)?.ok_or_else(|| AdmissionError("goal: Required".into()))?;
    string_field(raw, "repo", 1, None)?;
    for name in ["scope", "acceptance", "constraints", "context", "executor"] {
        string_field(raw, name, 0, None)?;
    }
    for (name, min, max) in [
        ("request_id", 1, 128),
        ("base", 1, 4096),
        ("worktree_reason", 0, 200),
    ] {
        string_field(raw, name, min, Some(max))?;
    }
    if let Some(title) = string_field(raw, "title", 0, None)?
        && (title.trim().is_empty() || title.trim().chars().count() > 60)
    {
        return Err(AdmissionError("title: invalid length".into()));
    }
    for name in ["acceptance_pipefail", "interactive", "grant"] {
        boolean_field(raw, name)?;
    }
    number_field(raw, "acceptance_timeout_min", 1.0, 120.0, true)?;
    number_field(raw, "timeout_min", 1.0, 240.0, false)?;
    enum_field(
        raw,
        "worktree",
        &["current", "new", "auto"],
        "worktree must be one of current, new, auto",
    )?;
    enum_field(
        raw,
        "worktree_base",
        &["default", "head"],
        "worktree_base must be default or head",
    )?;
    enum_field(raw, "source", &["planner", "ui", "cli"], "invalid source")?;
    enum_field(
        raw,
        "kind",
        &[
            "boilerplate",
            "tests",
            "docs",
            "rename",
            "migration",
            "feature",
            "debug",
            "refactor",
            "performance",
            "unfamiliar-code",
            "research",
        ],
        "invalid kind",
    )?;
    if let Some(base) = raw.get("base").and_then(Value::as_str)
        && !valid_base(base)
    {
        return Err(AdmissionError(
            "base must be a branch name or a 7–40 hex SHA".into(),
        ));
    }
    if let Some(group) = string_field(raw, "group", 0, None)? {
        let bytes = group.as_bytes();
        if bytes.is_empty()
            || bytes.len() > 40
            || !bytes[0].is_ascii_alphanumeric()
            || !bytes
                .iter()
                .all(|c| c.is_ascii_alphanumeric() || *c == b'-' || *c == b'_')
        {
            return Err(AdmissionError(
                "group must be 1–40 characters, starting alphanumeric, of letters, digits, - and _"
                    .into(),
            ));
        }
    }
    let mut brief = Map::new();
    brief.insert("goal".into(), raw["goal"].clone());
    brief.insert(
        "repo".into(),
        raw.get("repo")
            .cloned()
            .unwrap_or_else(|| Value::String(default_repo.into())),
    );
    for (source, target) in [
        ("scope", "scope"),
        ("acceptance", "acceptance"),
        ("acceptance_pipefail", "pipefail"),
        ("acceptance_timeout_min", "acceptanceTimeoutMin"),
        ("constraints", "constraints"),
        ("context", "context"),
        ("base", "base"),
        ("worktree_base", "worktreeBase"),
    ] {
        copy_if_present(raw, &mut brief, source, target);
    }
    let mut input = Map::new();
    for (source, target) in [
        ("request_id", "requestId"),
        ("source", "source"),
        ("kind", "kind"),
        ("executor", "executor"),
        ("timeout_min", "timeoutMin"),
        ("worktree", "worktree"),
        ("worktree_reason", "worktree_reason"),
        ("interactive", "interactive"),
        ("group", "group"),
        ("messaging", "messaging"),
        ("grant", "grant"),
    ] {
        copy_if_present(raw, &mut input, source, target);
    }
    if let Some(title) = raw.get("title").and_then(Value::as_str) {
        input.insert("title".into(), Value::String(title.trim().into()));
    }
    Ok(serde_json::json!({"brief":brief,"input":input}))
}

/// Synchronous checks shared by initial admission and policy revalidation.
pub fn validate_input(input: &Value, repo_validated: bool) -> Vec<String> {
    let mut problems = Vec::new();
    let brief = &input["brief"];
    if input.get("title").is_some_and(|v| {
        !v.as_str()
            .is_some_and(|s| (1..=60).contains(&s.trim().chars().count()))
    }) {
        problems.push("title must be 1–60 characters after trimming".into());
    }
    if !brief["goal"].as_str().is_some_and(|s| !s.trim().is_empty()) {
        problems.push("goal is required".into());
    }
    match brief["repo"].as_str() {
        Some(repo) if Path::new(repo).is_absolute() => {
            if !repo_validated && !Path::new(repo).is_dir() {
                problems.push(format!("repo does not exist: {repo}"));
            }
        }
        _ => problems.push("repo must be an absolute path".into()),
    }
    if brief.get("acceptanceTimeoutMin").is_some_and(|v| {
        !v.as_f64()
            .is_some_and(|n| n.fract() == 0.0 && (1.0..=120.0).contains(&n))
    }) {
        problems.push("acceptance_timeout_min must be an integer between 1 and 120".into());
    }
    if brief
        .get("base")
        .and_then(Value::as_str)
        .is_some_and(|s| !valid_base(s))
    {
        problems.push("base must be a branch name or a 7–40 hex SHA".into());
    }
    if input.get("requestId").is_some_and(|v| {
        !v.as_str()
            .is_some_and(|s| (1..=128).contains(&s.chars().count()))
    }) {
        problems.push("request_id must be 1–128 characters".into());
    }
    if input.get("source").is_some_and(|v| {
        !v.as_str()
            .is_some_and(|s| ["planner", "ui", "cli", "onboarding"].contains(&s))
    }) {
        problems.push("invalid source".into());
    }
    if input
        .get("timeoutMin")
        .is_some_and(|v| !v.as_f64().is_some_and(|n| (1.0..=240.0).contains(&n)))
    {
        problems.push("timeout_min must be between 1 and 240".into());
    }
    if brief
        .get("worktreeBase")
        .is_some_and(|v| !v.as_str().is_some_and(|s| ["default", "head"].contains(&s)))
    {
        problems.push("worktree_base must be default or head".into());
    }
    if input.get("worktree").is_some_and(|v| {
        !v.as_str()
            .is_some_and(|s| ["current", "new", "auto"].contains(&s))
    }) {
        problems.push("worktree must be one of current, new, auto".into());
    }
    problems
}
