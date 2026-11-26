//! Native repository messaging policy ops (`src/api/ops-msg.ts`). Absolute
//! checkout paths resolve read-only through `pacer-repos`; Node read errors and
//! Zod issues for nested rules, liveness and an unusable policy file are
//! reproduced here, so every input is answered natively.
#![allow(clippy::result_large_err)]
use pacer_config::project_messaging::{self, liveness, project_key, rules};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Map, Value, json};
use std::path::Path;

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

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

/// Zod `number().int()` issues; returns the value when it is an integer.
fn integer(name: &str, value: Option<&Value>, issues: &mut Vec<String>) -> Option<f64> {
    let Some(n) = value.and_then(Value::as_f64) else {
        issues.push(format!(
            "{name}: Invalid input: expected number, received {}",
            received(value)
        ));
        return None;
    };
    if n.fract() != 0.0 {
        issues.push(format!(
            "{name}: Invalid input: expected int, received number"
        ));
        return None;
    }
    if n > MAX_SAFE {
        issues.push(format!(
            "{name}: Too big: expected int to be <=9007199254740991"
        ));
    }
    if n < -MAX_SAFE {
        issues.push(format!(
            "{name}: Too small: expected int to be >=-9007199254740991"
        ));
    }
    Some(n)
}

/// The operation schemas, with Zod issue text and order.
fn parse(op: &str, params: Value) -> Result<Map<String, Value>, CoreError> {
    let params = if params.is_null() { json!({}) } else { params };
    let Some(map) = params.as_object() else {
        return Err(CoreError::new(
            Code::InvalidInput,
            format!(
                "params: Invalid input: expected object, received {}",
                received(Some(&params))
            ),
        ));
    };
    let fields: &[&str] = match op {
        "project.messaging.get" => &["repo"],
        "project.messaging.remove" => &["repo", "expect_rev"],
        _ => &["repo", "expect_rev", "rules", "max_turns", "liveness"],
    };
    let mut issues = Vec::new();
    let mut out = Map::new();
    match map.get("repo") {
        Some(Value::String(repo)) => {
            let length = repo.chars().count();
            if length < 1 {
                issues.push("repo: Too small: expected string to have >=1 characters".into());
            }
            if length > 4096 {
                issues.push("repo: Too big: expected string to have <=4096 characters".into());
            }
            out.insert("repo".into(), json!(repo));
        }
        other => issues.push(format!(
            "repo: Invalid input: expected string, received {}",
            received(other)
        )),
    }
    if fields.contains(&"expect_rev")
        && let Some(n) = integer("expect_rev", map.get("expect_rev"), &mut issues)
    {
        if n < 0.0 {
            issues.push("expect_rev: Too small: expected number to be >=0".into());
        }
        if n > MAX_SAFE {
            issues.push("expect_rev: Too big: expected int to be <=9007199254740991".into());
        }
        if n < -MAX_SAFE {
            issues.push("expect_rev: Too small: expected int to be >=-9007199254740991".into());
        }
        out.insert("expect_rev".into(), json!(n as i64));
    }
    if fields.contains(&"rules") {
        match map.get("rules") {
            Some(value) => {
                if let Some(normalized) = rules(value, "rules", &mut issues) {
                    out.insert("rules".into(), normalized);
                }
            }
            None => issues.push(format!(
                "rules: Invalid input: expected array, received {}",
                received(None)
            )),
        }
    }
    if fields.contains(&"max_turns")
        && let Some(value) = map.get("max_turns")
        && let Some(n) = integer("max_turns", Some(value), &mut issues)
    {
        if n <= 0.0 {
            issues.push("max_turns: Too small: expected number to be >0".into());
        }
        if n > 10000.0 {
            issues.push("max_turns: Too big: expected number to be <=10000".into());
        }
        out.insert("max_turns".into(), json!(n as i64));
    }
    if fields.contains(&"liveness")
        && let Some(value) = map.get("liveness")
        && let Some(normalized) = liveness(value, "liveness", &mut issues)
    {
        out.insert("liveness".into(), normalized);
    }
    let unknown: Vec<String> = map
        .keys()
        .filter(|key| !fields.contains(&key.as_str()))
        .map(|key| format!("\"{key}\""))
        .collect();
    match unknown.len() {
        0 => {}
        1 => issues.push(format!("params: Unrecognized key: {}", unknown[0])),
        _ => issues.push(format!("params: Unrecognized keys: {}", unknown.join(", "))),
    }
    if issues.is_empty() {
        Ok(out)
    } else {
        Err(CoreError::new(Code::InvalidInput, issues.join("; ")))
    }
}

/// `repoKey` in `src/api/ops-msg.ts`: a key is used as-is; an absolute checkout is
/// resolved read-only through `pacer-repos` and its registry key is used.
fn repo_key<'a>(ctx: &Ctx, params: &'a Map<String, Value>) -> Result<String, CoreError> {
    let repo = params["repo"].as_str().unwrap_or("");
    if project_key(repo) {
        return Ok(repo.to_owned());
    }
    if Path::new(repo).is_absolute() {
        let resolved = pacer_repos::resolve_repo_read_only(ctx, repo, false)?;
        return Ok(resolved["key"]
            .as_str()
            .unwrap_or(repo)
            .to_owned());
    }
    Err(CoreError::new(
        Code::InvalidInput,
        "repo must be an absolute path or a repository key",
    ))
}

fn authorize(ctx: &Ctx, op: &str, params: &Value) -> Result<(), CoreError> {
    let is_executor = ctx.env.get("PACER_ROLE").map(String::as_str) == Some("executor");
    pacer_work::authorize_work_operation(ctx, op, params, is_executor)
}

pub fn project_messaging_get(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx, "project.messaging.get", &params)?;
        let p = parse("project.messaging.get", params)?;
        let repo = repo_key(ctx, &p)?;
        project_messaging::get(&ctx.pacer_home, &repo)
    })
}

pub fn project_messaging_set(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx, "project.messaging.set", &params)?;
        let mut p = parse("project.messaging.set", params)?;
        let repo = repo_key(ctx, &p)?;
        let expect_rev = p["expect_rev"].as_i64().unwrap_or(-1);
        let mut policy = Map::new();
        for key in ["rules", "max_turns", "liveness"] {
            if let Some(value) = p.remove(key) {
                policy.insert(key.into(), value);
            }
        }
        project_messaging::write(ctx, &repo, expect_rev, Some(policy))
    })
}

pub fn project_messaging_remove(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx, "project.messaging.remove", &params)?;
        let p = parse("project.messaging.remove", params)?;
        let repo = repo_key(ctx, &p)?;
        let expect_rev = p["expect_rev"].as_i64().unwrap_or(-1);
        project_messaging::write(ctx, &repo, expect_rev, None)
    })
}

#[cfg(test)]
mod tests;
