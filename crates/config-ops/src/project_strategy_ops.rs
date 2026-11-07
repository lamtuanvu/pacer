//! Native repository executor overrides (`src/core/project-strategies.ts`,
//! `src/config/project-strategies.ts`). Absolute checkout paths need git identity from the
//! Core repository probe. An unusual registry, an unloadable strategy or an unusable policy
//! file keep TypeScript's reading and error text. Those inputs stay forwarded.
#![allow(clippy::result_large_err)]
use crate::repo_registry_ops::{params_object, received};
use pacer_config::{project_messaging::project_key, strategy::load_strategy};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use pacer_lifecycle::{
    AdmissionError, read_project_strategies, repo_registry, resolve_runner,
    validate_project_strategies,
};
use serde_json::{Map, Value, json};
use std::path::Path;

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const FILE: &str = "project-strategies.json";

pub fn project_strategy_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    if !op.starts_with("project.strategy.") {
        return false;
    }
    let absolute = params
        .get("repo")
        .and_then(Value::as_str)
        .is_some_and(|repo| Path::new(repo).is_absolute());
    absolute
        || repo_registry::registry_needs_core(&ctx.pacer_home)
        || load_strategy(&ctx.pacer_home).is_err()
        || read_project_strategies(&ctx.pacer_home).is_err()
}

struct Params {
    repo: String,
    executors: Vec<String>,
    expect_rev: i64,
}

/// Zod `string().min(1).max(max)` issues at `path`.
fn text(path: &str, value: Option<&Value>, max: usize, issues: &mut Vec<String>) -> String {
    let Some(Value::String(s)) = value else {
        issues.push(format!(
            "{path}: Invalid input: expected string, received {}",
            received(value)
        ));
        return String::new();
    };
    let length = s.chars().count();
    if length < 1 {
        issues.push(format!(
            "{path}: Too small: expected string to have >=1 characters"
        ));
    }
    if length > max {
        issues.push(format!(
            "{path}: Too big: expected string to have <={max} characters"
        ));
    }
    s.clone()
}

/// Zod `number().int().nonnegative().safe()` issues.
fn revision(value: Option<&Value>, issues: &mut Vec<String>) -> i64 {
    let Some(n) = value.and_then(Value::as_f64) else {
        issues.push(format!(
            "expect_rev: Invalid input: expected number, received {}",
            received(value)
        ));
        return -1;
    };
    if n.fract() != 0.0 {
        issues.push("expect_rev: Invalid input: expected int, received number".into());
        return -1;
    }
    for (failed, issue) in [
        (
            n > MAX_SAFE,
            "Too big: expected int to be <=9007199254740991",
        ),
        (
            n < -MAX_SAFE,
            "Too small: expected int to be >=-9007199254740991",
        ),
        (n < 0.0, "Too small: expected number to be >=0"),
        (
            n > MAX_SAFE,
            "Too big: expected int to be <=9007199254740991",
        ),
        (
            n < -MAX_SAFE,
            "Too small: expected int to be >=-9007199254740991",
        ),
    ] {
        if failed {
            issues.push(format!("expect_rev: {issue}"));
        }
    }
    n as i64
}

fn parse(op: &str, params: &Value) -> Result<Params, CoreError> {
    let map = params_object(params)?;
    let fields: &[&str] = match op {
        "project.strategy.list" => &[],
        "project.strategy.get" => &["repo"],
        "project.strategy.set" => &["repo", "executors", "expect_rev"],
        _ => &["repo", "expect_rev"],
    };
    let mut issues = Vec::new();
    let mut out = Params {
        repo: String::new(),
        executors: Vec::new(),
        expect_rev: 0,
    };
    if fields.contains(&"repo") {
        out.repo = text("repo", map.get("repo"), 4096, &mut issues);
    }
    if fields.contains(&"executors") {
        match map.get("executors") {
            Some(Value::Array(items)) => {
                for (i, item) in items.iter().enumerate() {
                    let id = text(&format!("executors.{i}"), Some(item), 128, &mut issues);
                    out.executors.push(id);
                }
                if items.is_empty() {
                    issues.push("executors: Too small: expected array to have >=1 items".into());
                }
            }
            other => issues.push(format!(
                "executors: Invalid input: expected array, received {}",
                received(other)
            )),
        }
    }
    if fields.contains(&"expect_rev") {
        out.expect_rev = revision(map.get("expect_rev"), &mut issues);
    }
    if !issues.is_empty() {
        return Err(invalid(issues.join("; ")));
    }
    Ok(out)
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn policies(ctx: &Ctx) -> Result<Value, CoreError> {
    read_project_strategies(&ctx.pacer_home).map_err(|AdmissionError(message)| {
        let hint = if message.starts_with("Cannot read") {
            "Check project-strategies.json permissions before delegating."
        } else {
            "Repair project-strategies.json before delegating; no global fallback was used."
        };
        invalid(message).hint(hint)
    })
}

fn strategy(ctx: &Ctx) -> Result<Value, CoreError> {
    load_strategy(&ctx.pacer_home).map_err(|error| invalid(error.to_string()))
}

/// `String(value)` for the scalars a runner holds.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

fn reference(runner: &Value) -> String {
    format!(
        "{}#{}@{}",
        js_string(runner.get("agent")),
        js_string(runner.get("account")),
        runner["host"].as_str().unwrap_or("local")
    )
}

/// `executorLabel(agent)` for a bare agent id.
fn agent_label(agent: &str) -> &str {
    match agent {
        "claude-code" | "claude" => "Claude Code",
        "codex" => "Codex",
        "cursor" => "Cursor",
        "agy" | "antigravity" => "Antigravity",
        "byteplus" => "BytePlus",
        "local" => "Local model",
        "opencode" => "OpenCode",
        "gemini" => "Gemini",
        other => other,
    }
}

fn is_planner(strategy: &Value, runner: &Value) -> bool {
    let planner = &strategy["planner"];
    runner.get("agent") == planner.get("agent") && runner.get("account") == planner.get("account")
}

fn view(strategy: &Value, repo: Value, entry: Option<&Value>) -> Value {
    let available: Vec<Value> = strategy["runners"]
        .as_object()
        .into_iter()
        .flat_map(Map::values)
        .filter(|runner| !is_planner(strategy, runner))
        .map(|runner| {
            let label = format!(
                "{} · {} · {}",
                agent_label(runner["agent"].as_str().unwrap_or("")),
                js_string(runner.get("account")),
                runner["host"].as_str().unwrap_or("This machine")
            );
            json!({"id": runner["id"], "reference": reference(runner), "label": label})
        })
        .collect();
    json!({
        "repo": repo,
        "rev": entry.map_or(json!(0), |e| e["rev"].clone()),
        "executors": entry.map_or(Value::Null, |e| e["executors"].clone()),
        "available": available,
    })
}

/// `resolve` in `src/core/project-strategies.ts` for a repository key.
fn resolve(ctx: &Ctx, value: &str) -> Result<Value, CoreError> {
    let data = policies(ctx)?;
    let found = |read_only: bool| -> Result<Option<Value>, CoreError> {
        Ok(repo_registry::list_repos(ctx, read_only)?
            .into_iter()
            .find(|repo| repo.key == value)
            .map(|repo| repo.to_json()))
    };
    if Path::new(value).is_absolute() {
        return Err(CoreError::new(
            Code::Unavailable,
            "absolute repository paths require the forwarded project.strategy operation",
        ));
    }
    if data["projects"].get(value).is_some() {
        return Ok(found(true)?.unwrap_or_else(|| json!({"key": value, "label": value})));
    }
    found(false)?.ok_or_else(|| invalid("repo must be an absolute path or a registered repo key"))
}

/// `projectReferences`: aliases resolve once, when saving.
fn references(strategy: &Value, ids: &[String]) -> Result<Vec<String>, CoreError> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let runner = resolve_runner(strategy, id)
            .ok_or_else(|| invalid(format!("Unknown executor {id}")))?;
        if is_planner(strategy, runner) {
            return Err(invalid(format!("{id} is the planner")));
        }
        out.push(reference(runner));
    }
    let distinct: std::collections::HashSet<&String> = out.iter().collect();
    if distinct.len() != out.len() {
        return Err(invalid("Duplicate project executor"));
    }
    Ok(out)
}

/// `writeProjectStrategy`: compare-and-set under the `project-strategies` lock.
fn write(
    ctx: &Ctx,
    key: &str,
    executors: Option<Vec<String>>,
    expect_rev: i64,
) -> Result<Value, CoreError> {
    let candidate = json!({"version": 1, "projects": {key: {"rev": 1, "executors": executors.clone().unwrap_or_default()}}});
    let executors_valid = executors.is_none() || validate_project_strategies(&candidate).is_ok();
    if !project_key(key) || !(0..MAX_SAFE as i64).contains(&expect_rev) || !executors_valid {
        return Err(invalid("Invalid project strategy")
            .hint("Choose a repository and at least one distinct configured executor."));
    }
    std::fs::create_dir_all(&ctx.pacer_home).map_err(|e| invalid(e.to_string()))?;
    with_lock(ctx, "project-strategies", LockOptions::default(), || {
        let data = policies(ctx)?;
        let current = data["projects"][key]["rev"].as_i64().unwrap_or(0);
        if current != expect_rev {
            let mut details = Map::new();
            details.insert("expected".into(), json!(expect_rev));
            details.insert("actual".into(), json!(current));
            return Err(CoreError::new(
                Code::Conflict,
                "Project strategy changed in another client",
            )
            .hint("Reload the project strategy and review your changes.")
            .data(details));
        }
        let entry = json!({"rev": current + 1, "executors": executors});
        let mut projects: Map<String, Value> = data["projects"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(k, e)| {
                (
                    k.clone(),
                    json!({"rev": e["rev"], "executors": e["executors"]}),
                )
            })
            .collect();
        projects.insert(key.into(), entry.clone());
        let mut bytes = serde_json::to_vec_pretty(&json!({"version": 1, "projects": projects}))
            .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
        bytes.push(b'\n');
        write_private(&ctx.pacer_home.join(FILE), &bytes)
            .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
        Ok(entry)
    })
    .map_err(|error| CoreError::new(Code::Unavailable, error.to_string()))?
}

pub fn project_strategy_list(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        parse("project.strategy.list", &params)?;
        let data = policies(ctx)?;
        let strategy = strategy(ctx)?;
        let repos = repo_registry::list_repos(ctx, true)?;
        let views = data["projects"]
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(_, entry)| !entry["executors"].is_null())
            .map(|(key, entry)| {
                let repo = repos
                    .iter()
                    .find(|repo| repo.key == *key)
                    .map_or_else(|| json!({"key": key, "label": key}), |r| r.to_json());
                view(&strategy, repo, Some(entry))
            })
            .collect();
        Ok(Value::Array(views))
    })
}

pub fn project_strategy_get(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let p = parse("project.strategy.get", &params)?;
        let repo = resolve(ctx, &p.repo)?;
        let data = policies(ctx)?;
        let key = repo["key"].as_str().unwrap_or("");
        Ok(view(
            &strategy(ctx)?,
            repo.clone(),
            data["projects"].get(key),
        ))
    })
}

pub fn project_strategy_set(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let p = parse("project.strategy.set", &params)?;
        let repo = resolve(ctx, &p.repo)?;
        let strategy = strategy(ctx)?;
        let refs = references(&strategy, &p.executors)?;
        let entry = write(
            ctx,
            repo["key"].as_str().unwrap_or(""),
            Some(refs),
            p.expect_rev,
        )?;
        Ok(view(&strategy, repo, Some(&entry)))
    })
}

pub fn project_strategy_remove(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let p = parse("project.strategy.remove", &params)?;
        let repo = resolve(ctx, &p.repo)?;
        let strategy = strategy(ctx)?;
        let entry = write(ctx, repo["key"].as_str().unwrap_or(""), None, p.expect_rev)?;
        Ok(view(&strategy, repo, Some(&entry)))
    })
}

#[cfg(test)]
mod tests;
