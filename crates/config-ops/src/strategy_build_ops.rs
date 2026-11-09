//! Native `strategy.build` (`src/strategy/launcher.ts`). Rust validates the
//! request, owns request-ID idempotency, the intent and prompt files under
//! `link/sessions` and the prompt text, then asks Core for the rendered live
//! status and the terminal hand-off. Core builds the agent argv from the prompt
//! file Rust wrote, so the bridge never runs caller-supplied commands.
#![allow(clippy::result_large_err)]
use crate::executor_setup_ops::{enforcement, invalid, params_map, type_name};
use crate::setup_effects::{SetupEffects, unavailable};
use pacer_config::strategy::{load_strategy, show_strategy};
use pacer_foundation::{
    Ctx,
    api::CoreError,
    lock::{LockOptions, with_lock_async},
};
use serde_json::{Map, Value, json};
use std::{fs, path::Path};

const PLANNERS: &[&str] = &["claude-code", "codex", "cursor", "opencode"];
const HINT: &str =
    "Use strategy.list to choose a strategy and strategy.preview to validate a draft.";
const WEEK_S: f64 = 7.0 * 86400.0;

#[derive(Debug, Default, PartialEq)]
pub(crate) struct Params {
    pub agent: Option<String>,
    pub from: Option<String>,
    pub brief: Option<String>,
    pub worktree: Option<String>,
    pub request_id: Option<String>,
}

/// Zod string bounds count code points.
fn zod_len(text: &str) -> usize {
    text.chars().count()
}

/// Zod `uuid()`: RFC 9562 versions 1–8 and variant 8–b, or the nil and max UUIDs.
fn zod_uuid(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if lower == "00000000-0000-0000-0000-000000000000"
        || lower == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    let bytes = lower.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
        && (b'1'..=b'8').contains(&bytes[14])
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

/// Optional string field with Zod's issue text; `None` when absent.
fn optional(map: &Map<String, Value>, name: &str, issues: &mut Vec<String>) -> Option<String> {
    let value = map.get(name)?;
    match value.as_str() {
        Some(text) => Some(text.to_owned()),
        None => {
            issues.push(format!(
                "{name}: Invalid input: expected string, received {}",
                type_name(Some(value))
            ));
            None
        }
    }
}

pub(crate) fn parse(params: &Value) -> Result<Params, CoreError> {
    let map = params_map(params)?;
    let mut issues = Vec::new();
    let agent = match map.get("agent") {
        None => None,
        Some(value) => match value.as_str().filter(|a| PLANNERS.contains(a)) {
            Some(agent) => Some(agent.to_owned()),
            None => {
                issues.push("agent: Invalid option: expected one of \"claude-code\"|\"codex\"|\"cursor\"|\"opencode\"".into());
                None
            }
        },
    };
    let from = optional(&map, "from", &mut issues);
    match from.as_deref().map(zod_len) {
        Some(0) => issues.push("from: Too small: expected string to have >=1 characters".into()),
        Some(n) if n > 128 => {
            issues.push("from: Too big: expected string to have <=128 characters".into())
        }
        _ => {}
    }
    let brief = optional(&map, "brief", &mut issues);
    if brief.as_deref().is_some_and(|b| zod_len(b) > 2000) {
        issues.push("brief: Too big: expected string to have <=2000 characters".into());
    }
    let worktree = optional(&map, "worktree", &mut issues);
    match worktree.as_deref().map(zod_len) {
        Some(0) => {
            issues.push("worktree: Too small: expected string to have >=1 characters".into())
        }
        Some(n) if n > 4096 => {
            issues.push("worktree: Too big: expected string to have <=4096 characters".into())
        }
        _ => {}
    }
    let request_id = optional(&map, "request_id", &mut issues);
    if request_id.as_deref().is_some_and(|id| !zod_uuid(id)) {
        issues.push("request_id: Invalid UUID".into());
    }
    if !issues.is_empty() {
        return Err(invalid(issues.join("; ")));
    }
    Ok(Params {
        agent,
        from,
        brief,
        worktree,
        request_id,
    })
}

fn failed(message: impl Into<String>) -> CoreError {
    invalid(message).hint(HINT)
}

fn io_failed(error: std::io::Error) -> CoreError {
    failed(error.to_string())
}

/// `writeAtomic`: a 0600 exclusive temporary file renamed over `path`.
fn write_atomic(path: &Path, contents: &str) -> Result<(), CoreError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let temporary = std::path::PathBuf::from(format!(
        "{}.{}.tmp",
        path.display(),
        hex::encode(rand::random::<[u8; 4]>())
    ));
    let result = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .and_then(|mut file| file.write_all(contents.as_bytes()))
        .and_then(|()| fs::rename(&temporary, path));
    let _ = fs::remove_file(&temporary);
    result.map_err(io_failed)
}

/// Prompt files older than a week go, with their intent files.
fn clean_old(dir: &Path, now: f64) -> Result<(), CoreError> {
    for entry in fs::read_dir(dir).map_err(io_failed)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let old = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(f64::INFINITY, |d| d.as_secs_f64());
        if meta.is_file() && name.ends_with(".md") && modified < now - WEEK_S {
            fs::remove_file(&old).map_err(io_failed)?;
            let _ = fs::remove_file(old.with_extension("json"));
        }
    }
    Ok(())
}

fn prompt(p: &Params, from: &str, base: &Value, status: &str, agent: &str) -> String {
    let brief = p
        .brief
        .as_deref()
        .unwrap_or("Ask what the user wants the strategy to do.");
    let summary = base["summary"].as_str().unwrap_or_default();
    let yaml = base["yaml"].as_str().unwrap_or_default();
    format!(
        "# Build a pacer strategy\n\n{brief}\n\nBase: {from}\n{summary}\n\n```yaml\n{yaml}\n```\n\nCurrent status:\n{status}\n\nUse the pacer MCP strategy tools. Preview first. Ask clarifying questions. Show the user the current and draft ranking change. Save only after explicit approval, with a reason and who: {agent}. Never switch strategies.\n"
    )
}

/// The stored prompt of a repeated request ID, after restoring its prompt file.
fn reuse(p: &Params, request: &str, path: &Path, intent: &Path) -> Result<bool, CoreError> {
    if p.request_id.is_none() {
        return Ok(false);
    }
    if !intent.exists() {
        // Recover an interrupted older write; no terminal was launched before the intent file.
        let _ = fs::remove_file(path);
        return Ok(false);
    }
    let stored: Value = fs::read_to_string(intent)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or_else(|| failed("strategy request prompt is unavailable"))?;
    if stored["request"].as_str() != Some(request) {
        return Err(failed(
            "strategy request ID was used with different details",
        ));
    }
    let prompt = stored["prompt"]
        .as_str()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| failed("strategy request prompt is unavailable"))?;
    if fs::read_to_string(path).ok().as_deref() != Some(prompt) {
        write_atomic(path, prompt)?;
    }
    Ok(true)
}

async fn build(
    ctx: &Ctx,
    p: &Params,
    app: bool,
    effects: &mut dyn SetupEffects,
) -> Result<Value, CoreError> {
    let home = &ctx.pacer_home;
    let strategy = load_strategy(home).map_err(|e| failed(e.to_string()))?;
    let agent = p
        .agent
        .clone()
        .unwrap_or_else(|| strategy["planner"]["agent"].as_str().unwrap_or("").into());
    if !PLANNERS.contains(&agent.as_str()) {
        return Err(failed(format!(
            "agent must be a configured planner: {}",
            PLANNERS.join(", ")
        )));
    }
    if p.brief
        .as_deref()
        .is_some_and(|b| b.encode_utf16().count() > 2000)
    {
        return Err(failed("brief must be at most 2000 characters"));
    }
    let from = p
        .from
        .clone()
        .unwrap_or_else(|| strategy["name"].as_str().unwrap_or("").into());
    let base = show_strategy(home, &from).map_err(|e| failed(e.to_string()))?;
    let id = p.request_id.clone().unwrap_or_else(|| {
        format!(
            "{}-{}",
            (ctx.now * 1000.0).floor() as i64,
            hex::encode(rand::random::<[u8; 2]>())
        )
    });
    let dir = home.join("link").join("sessions");
    let path = dir.join(format!("{id}.md"));
    let intent = dir.join(format!("{id}.json"));
    let request = json!({"agent": agent, "from": from, "brief": p.brief.clone().unwrap_or_default(), "worktree": p.worktree.clone().unwrap_or_default()}).to_string();
    fs::create_dir_all(&dir).map_err(io_failed)?;
    clean_old(&dir, ctx.now)?;
    if !reuse(p, &request, &path, &intent)? {
        let reply = effects.call(json!({"kind": "status_text"})).await?;
        let status = reply["text"]
            .as_str()
            .ok_or_else(|| unavailable("invalid setup effects response"))?;
        let prompt = prompt(p, &from, &base, status, &agent);
        if p.request_id.is_some() {
            write_atomic(
                &intent,
                &json!({"request": request, "prompt": prompt}).to_string(),
            )?;
        }
        write_atomic(&path, &prompt)?;
    }
    let mut open = json!({"kind": "strategy_terminal", "agent": agent, "id": id, "builtin": app});
    if let Some(worktree) = &p.worktree {
        open["worktree"] = json!(worktree);
    }
    if let Some(request_id) = &p.request_id {
        open["requestId"] = json!(request_id);
    }
    let result = effects.call(open).await?;
    let opened = result["opened"]
        .as_bool()
        .ok_or_else(|| unavailable("invalid setup effects response"))?;
    let command = result["command"].as_str().unwrap_or_default();
    let mut out = json!({"opened": opened, "target": result["target"], "command": command});
    if let Some(terminal) = result.get("terminalId").filter(|t| !t.is_null()) {
        out["terminalId"] = terminal.clone();
    }
    let message = if opened {
        "Session opened in a new terminal".to_owned()
    } else {
        format!("Run: {command}")
    };
    Ok(json!({"result": out, "message": message}))
}

pub(crate) async fn strategy_build(
    ctx: &Ctx,
    params: Value,
    app: bool,
    effects: &mut dyn SetupEffects,
) -> Result<Value, CoreError> {
    enforcement(ctx)?;
    let p = parse(&params)?;
    let built = match &p.request_id {
        Some(id) => with_lock_async(
            ctx,
            &format!("strategy-build-{id}"),
            LockOptions::default(),
            || build(ctx, &p, app, &mut *effects),
        )
        .await
        .map_err(|e| failed(e.to_string()))?,
        None => build(ctx, &p, app, effects).await,
    }
    .map_err(|mut error| {
        error.hint.get_or_insert_with(|| HINT.into());
        error
    })?;
    let opened = built["result"]["opened"] == true;
    let alert = json!({"type":"alert","data":{"key":"strategy-build","level":if opened {"info"} else {"error"},"title":if opened {"Strategy session opened"} else {"Strategy session failed"},"body":if opened {""} else {built["message"].as_str().unwrap_or_default()},"at":ctx.now}});
    for error in pacer_store::publish(ctx, &[alert]).errors {
        eprintln!("pacer: strategy alert publication failed: {error}");
    }
    Ok(built["result"].clone())
}

#[cfg(test)]
mod tests;
