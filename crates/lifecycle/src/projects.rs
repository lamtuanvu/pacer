use crate::{AdmissionError, semantics::js_numbers};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path};

/// Only ENOENT inherits global routing. Corrupt/unreadable policy never falls
/// back to the global strategy (src/config/project-strategies.ts).
pub fn read_project_strategies(home: &Path) -> Result<Value, AdmissionError> {
    let bytes = match std::fs::read(home.join("project-strategies.json")) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({"version":1,"projects":{}}));
        }
        Err(_) => return Err(AdmissionError("Cannot read project strategies".into())),
    };
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| AdmissionError("Invalid project strategies".into()))?;
    validate_project_strategies(&value)
}
pub fn validate_project_strategies(value: &Value) -> Result<Value, AdmissionError> {
    let invalid = || AdmissionError("Invalid project strategies".into());
    let Some(top) = value.as_object() else {
        return Err(invalid());
    };
    if top.len() != 2 || value["version"].as_f64() != Some(1.0) {
        return Err(invalid());
    }
    let entries = value["projects"].as_object().ok_or_else(invalid)?;
    for (key, entry) in entries {
        if !project_key(key) {
            return Err(invalid());
        }
        let fields = entry.as_object().ok_or_else(invalid)?;
        if fields.len() != 2
            || !entry["rev"]
                .as_f64()
                .is_some_and(|n| n.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(&n))
        {
            return Err(invalid());
        }
        let references = fields.get("executors").ok_or_else(invalid)?;
        if references.is_null() {
            continue;
        }
        let references = references.as_array().ok_or_else(invalid)?;
        let mut seen = HashSet::new();
        if references.is_empty() {
            return Err(invalid());
        }
        for reference in references {
            let reference = reference.as_str().ok_or_else(invalid)?;
            let Some((agent, rest)) = reference.split_once('#') else {
                return Err(invalid());
            };
            let Some((account, host)) = rest.split_once('@') else {
                return Err(invalid());
            };
            if !["claude-code", "codex", "cursor", "agy", "opencode"].contains(&agent)
                || !segment(account)
                || !segment(host)
                || !seen.insert(reference)
            {
                return Err(invalid());
            }
        }
    }
    Ok(js_numbers(value))
}
fn segment(s: &str) -> bool {
    s.as_bytes()
        .first()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn project_key(key: &str) -> bool {
    if let Some(suffix) = key.strip_prefix("local:") {
        return suffix.len() == 12
            && suffix
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    }
    let parts: Vec<_> = key.split('/').collect();
    parts.len() == 3
        && !key.ends_with(".git")
        && parts.iter().enumerate().all(|(i, s)| {
            !s.is_empty()
                && (i != 0
                    || s.as_bytes()[0].is_ascii_lowercase()
                    || s.as_bytes()[0].is_ascii_digit())
                && s.bytes().all(|b| {
                    b.is_ascii_lowercase()
                        || b.is_ascii_digit()
                        || b == b'.'
                        || b == b'-'
                        || i != 0 && b == b'_'
                })
        })
}
