use crate::json::{AdmissionString as JsString, Map, Value, js_numbers};
use std::{path::Path, process::Command};

fn utf16_len(s: &JsString) -> usize {
    s.utf16_len()
}
fn codepoint_len(s: &JsString) -> usize {
    s.codepoint_len()
}

fn js_trim(s: &JsString) -> JsString {
    s.trim()
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("{0}")]
pub struct AdmissionError(pub String);
impl AdmissionError {
    pub fn conflict(message: impl AsRef<str>) -> Self {
        Self(format!("conflict: {}", message.as_ref()))
    }
    pub fn is_conflict(&self) -> bool {
        self.0.starts_with("conflict:")
    }
}

fn string_field<'a>(
    raw: &'a Value,
    name: &str,
    min: usize,
    max: Option<usize>,
) -> Result<Option<&'a JsString>, AdmissionError> {
    let Some(value) = raw.get(name) else {
        return Ok(None);
    };
    let text = value
        .as_js_string()
        .ok_or_else(|| AdmissionError(format!("{name}: Expected string")))?;
    if codepoint_len(text) < min || max.is_some_and(|n| codepoint_len(text) > n) {
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
    if !n.is_finite()
        || n < min
        || n > max
        || (integer && (n.fract() != 0.0 || n.abs() > 9_007_199_254_740_991.0))
    {
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
    if (7..=40).contains(&base.chars().count()) && base.bytes().all(|c| c.is_ascii_hexdigit()) {
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

fn copy_if_present(from: &Value, to: &mut Map, source: &str, target: &str) {
    if let Some(value) = from.get(source) {
        to.insert(target.into(), value.clone());
    }
}

/// Parse the public task delegate fields. Unknown caller fields are discarded, as in Zod's object schema.
pub(crate) fn parse_delegate_value(
    raw: &Value,
    default_repo: &str,
) -> Result<Value, AdmissionError> {
    let normalized = js_numbers(raw);
    let raw = &normalized;
    if !raw.is_object() {
        return Err(AdmissionError("delegate input must be an object".into()));
    }
    string_field(raw, "goal", 1, None)?.ok_or_else(|| AdmissionError("goal: Required".into()))?;
    if string_field(raw, "repo", 1, None)?.is_none() && default_repo.is_empty() {
        return Err(AdmissionError("repo: invalid length".into()));
    }
    for name in ["scope", "acceptance", "constraints", "context", "executor"] {
        string_field(raw, name, 0, None)?;
    }
    for (name, min, max) in [
        ("model", 1, 256),
        ("request_id", 1, 128),
        ("base", 1, 4096),
        ("worktree_reason", 0, 200),
    ] {
        string_field(raw, name, min, Some(max))?;
    }
    if let Some(title) = string_field(raw, "title", 0, None)?
        && (js_trim(title).is_empty() || codepoint_len(&js_trim(title)) > 60)
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
        "difficulty",
        &["simple", "standard", "complex"],
        "invalid difficulty",
    )?;
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
    if let Some(base) = raw.get("base").and_then(Value::as_js_string)
        && !valid_base(&base.to_string())
    {
        return Err(AdmissionError(
            "base must be a branch name or a 7–40 hex SHA".into(),
        ));
    }
    if let Some(group) = string_field(raw, "group", 0, None)? {
        let text = group.as_str().unwrap_or("");
        let bytes = text.as_bytes();
        if bytes.is_empty()
            || codepoint_len(group) > 40
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
    if let Some(dispatch) = raw.get("dispatch")
        && !matches!(dispatch, Value::Null | Value::Bool(false))
        && !dispatch.as_f64().is_some_and(|n| n == 0.0)
        && dispatch != ""
    {
        input.insert("dispatch".into(), crate::schema::dispatch(dispatch)?);
    }
    let alias = raw
        .get("dispatch")
        .and_then(|value| value.get("difficulty"));
    if let (Some(difficulty), Some(alias)) = (raw.get("difficulty"), alias)
        && difficulty != alias
    {
        return Err(AdmissionError(
            "Give difficulty once: top-level difficulty and dispatch.difficulty differ".into(),
        ));
    }
    let nested_model = input.get("dispatch").and_then(|value| value.get("model"));
    if let (Some(model), Some(alias)) = (raw.get("model"), nested_model)
        && model != alias
    {
        return Err(AdmissionError(
            "Give model once: top-level model and dispatch.model differ".into(),
        ));
    }
    let difficulty = raw.get("difficulty").or(alias).cloned();
    let model = raw.get("model").or(nested_model).cloned();
    input.insert(
        "difficultySource".into(),
        Value::String(
            if difficulty.is_some() {
                "brief"
            } else {
                "unspecified"
            }
            .into(),
        ),
    );
    if let Some(difficulty) = difficulty {
        input.insert("difficulty".into(), difficulty.clone());
        input.entry("dispatch").and_modify(|value| {
            if let Value::Object(dispatch) = value {
                dispatch.insert("difficulty".into(), difficulty);
            }
        });
    }
    if let Some(model) = model {
        input.insert("model".into(), model.clone());
        input.entry("dispatch").and_modify(|value| {
            if let Value::Object(dispatch) = value {
                dispatch.insert("model".into(), model);
            }
        });
    }
    if let Some(messaging) = raw.get("messaging") {
        input.insert("messaging".into(), crate::schema::messaging(messaging)?);
    }
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
        ("grant", "grant"),
    ] {
        copy_if_present(raw, &mut input, source, target);
    }
    if let Some(title) = raw.get("title").and_then(Value::as_js_string) {
        input.insert("title".into(), Value::String(js_trim(title)));
    }
    let mut result = Map::new();
    result.insert("brief".into(), Value::Object(brief));
    result.insert("input".into(), Value::Object(input));
    Ok(Value::Object(result))
}

/// Strategy resolution supplied by the caller for the requested executor.
pub struct ValidationContext<'a> {
    pub configured_providers: &'a [&'a str],
    pub executor: ExecutorResolution,
}

pub enum ExecutorResolution {
    Unknown,
    Planner,
    Other,
}

/// Synchronous checks shared by initial admission and policy revalidation.
pub(crate) fn validate_value(
    input: &Value,
    repo_validated: bool,
    context: &ValidationContext<'_>,
) -> Vec<JsString> {
    let mut problems = Vec::new();
    let brief = &input["brief"];
    if input.get("title").is_some_and(|v| {
        !v.as_js_string()
            .is_some_and(|s| (1..=60).contains(&utf16_len(&js_trim(s))))
    }) {
        problems.push("title must be 1–60 characters after trimming".into());
    }
    if !brief["goal"]
        .as_js_string()
        .is_some_and(|s| !js_trim(s).is_empty())
    {
        problems.push("goal is required".into());
    }
    let repo = brief["repo"].as_js_string().map(ToString::to_string);
    match repo.as_deref() {
        Some(repo) if Path::new(repo).is_absolute() => {
            if !repo_validated
                && !Path::new(repo).is_dir()
                && let Some(original) = brief["repo"].as_js_string()
            {
                problems.push(JsString::surround("repo does not exist: ", original, ""));
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
        .and_then(Value::as_js_string)
        .is_some_and(|s| !valid_base(&s.to_string()))
    {
        problems.push("base must be a branch name or a 7–40 hex SHA".into());
    }
    if input.get("requestId").is_some_and(|v| {
        !v.as_js_string()
            .is_some_and(|s| (1..=128).contains(&utf16_len(s)))
    }) {
        problems.push("request_id must be 1–128 characters".into());
    }
    if input.get("source").is_some_and(|v| {
        !v.as_str()
            .is_some_and(|s| ["planner", "ui", "cli", "onboarding"].contains(&s))
    }) {
        problems.push("invalid source".into());
    }
    if let Some(kind) = input
        .get("kind")
        .and_then(Value::as_js_string)
        .filter(|s| !s.is_empty())
    {
        let kinds = [
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
        ];
        if !kind.as_str().is_some_and(|s| kinds.contains(&s)) {
            problems.push(JsString::surround(
                "unknown kind \"",
                kind,
                &format!("\" (allowed: {})", kinds.join(", ")),
            ));
        }
    }
    if let Some(executor) = input
        .get("executor")
        .and_then(Value::as_js_string)
        .filter(|s| !s.is_empty())
    {
        match context.executor {
            ExecutorResolution::Unknown => problems.push(JsString::surround(
                "unknown executor \"",
                executor,
                &format!(
                    "\" (configured: {})",
                    context.configured_providers.join(", ")
                ),
            )),
            ExecutorResolution::Planner
                if input.pointer("/dispatch/allowDelegation") != Some(&Value::Bool(true)) =>
            {
                problems.push(JsString::surround(
                    "\"",
                    executor,
                    "\" is the planner; pick an executor",
                ))
            }
            _ => {}
        }
    }
    if input
        .get("timeoutMin")
        .is_some_and(|v| !js_relational_number(v).is_some_and(|n| (1.0..=240.0).contains(&n)))
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
    if input
        .get("worktree_reason")
        .is_some_and(|v| !v.as_js_string().is_some_and(|s| utf16_len(s) <= 200))
    {
        problems.push("worktree_reason must be a string of at most 200 characters".into());
    }
    if input.get("group").is_some_and(|v| {
        !v.as_str().is_some_and(|s| {
            let bytes = s.as_bytes();
            (1..=40).contains(&bytes.len())
                && bytes[0].is_ascii_alphanumeric()
                && bytes
                    .iter()
                    .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
        })
    }) {
        problems.push(
            "group must be 1–40 characters, starting alphanumeric, of letters, digits, - and _"
                .into(),
        );
    }
    problems
}

// JS relational comparison applies ToNumber, unlike Number.isInteger above.
fn js_relational_number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(v) => Some(if *v { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let text = s.as_str()?;
            let s = crate::semantics::js_trim(text);
            if s.is_empty() {
                return Some(0.0);
            }
            for (prefix, base) in [
                ("0x", 16),
                ("0X", 16),
                ("0b", 2),
                ("0B", 2),
                ("0o", 8),
                ("0O", 8),
            ] {
                if let Some(digits) = s.strip_prefix(prefix) {
                    if digits.is_empty() {
                        return None;
                    }
                    return digits.chars().try_fold(0.0, |n, c| {
                        c.to_digit(base)
                            .map(|digit| n * f64::from(base) + f64::from(digit))
                    });
                }
            }
            if matches!(s, "Infinity" | "+Infinity") {
                return Some(f64::INFINITY);
            }
            if s == "-Infinity" {
                return Some(f64::NEG_INFINITY);
            }
            if !s
                .bytes()
                .all(|b| b.is_ascii_digit() || b"+-.eE".contains(&b))
            {
                return None;
            }
            s.parse().ok()
        }
        Value::Array(items) => {
            if items.is_empty() {
                Some(0.0)
            } else if items.len() == 1 {
                if matches!(items[0], Value::Null) {
                    Some(0.0)
                } else if matches!(
                    items[0],
                    Value::Array(_) | Value::String(_) | Value::Number(_)
                ) {
                    js_relational_number(&items[0])
                } else {
                    None
                }
            } else {
                None
            }
        }
        _ => None,
    }
}
