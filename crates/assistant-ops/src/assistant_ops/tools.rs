//! Native read tools and the one tool-call pipeline.
//!
//! Port of `src/assistant/tools.ts` (`READ_TOOLS`, `runReadTool`,
//! `toolDefinitions`) and `runAssistantTool` from `src/assistant/service.ts`.
//! Every tool is read-only by name, projects data (never free text), redacts it,
//! escapes `<` so data cannot close its `<data>` delimiter, and caps it at 32 KiB.
//! `ReadOps` is injected; B4-4 implements it over the native registry.

use crate::assistant_ops::{cards, redact::Redactor};
use pacer_foundation::{
    Ctx,
    api::{CoreError, OpFuture},
};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::{collections::BTreeSet, sync::OnceLock};

pub const RESULT_CAP_BYTES: usize = 32 * 1024;
/// `assistantLimitsSchema.maxToolRounds` default; one counter per turn.
const MAX_TOOL_ROUNDS: u32 = 6;

/// Calls one existing read op in-process. Implemented over the native registry
/// by B4-4; injected here so the port can be tested against the TS goldens.
pub trait ReadOps: Send {
    fn read<'a>(&'a mut self, ctx: &'a Ctx, op: &'a str, params: Value) -> OpFuture<'a>;
}

/// What one turn remembers across its tool calls.
#[derive(Default)]
pub struct ToolState {
    pub seen_tasks: BTreeSet<String>,
    pub tool_log: Vec<Value>,
    pub rounds: u32,
}

#[derive(Debug)]
pub struct ToolRunResult {
    pub name: String,
    pub content: String,
    pub ok: bool,
}

const STRING_KEYS: [&str; 38] = [
    "id", "task_id", "taskId", "title", "state", "kind", "executor", "requested_executor",
    "backend", "runner", "account", "name", "verdict", "mode", "severity", "window", "status",
    "phase", "label", "version", "strategy", "planner", "agent", "model", "step", "rule",
    "ladder_rule", "next", "before", "host", "source", "tone", "acceptanceState", "protocol",
    "previous", "level", "outcome", "relation",
];
const EXPLAIN_KEYS: [&str; 5] = ["code", "subject", "of", "value", "revision"];
const ENUM_KEYS: [&str; 3] = ["reason", "note", "resolved"];

fn safe_key(key: &str) -> bool {
    let len = key.len();
    len >= 1
        && len <= 64
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() > max {
        let mut out: String = text.chars().take(max - 1).collect();
        out.push('…');
        out
    } else {
        text.to_owned()
    }
}

fn enum_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^[a-z][a-z0-9_]{0,31}$").unwrap_or_else(|e| panic!("invalid enum pattern: {e}"))
    })
}

/// `project` in `tools.ts`: keep numbers, booleans, null and a small allow-list
/// of short pacer-owned string values; drop every other free-text field.
pub fn project(value: &Value, text: bool, keys: &[&str], depth: usize) -> Option<Value> {
    if depth > 10 {
        return None;
    }
    match value {
        Value::Array(items) => Some(Value::Array(
            items
                .iter()
                .take(200)
                .filter_map(|v| project(v, text, keys, depth + 1))
                .collect(),
        )),
        Value::Number(_) | Value::Bool(_) => Some(value.clone()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, v) in map {
                if !safe_key(key) {
                    continue;
                }
                match v {
                    Value::String(s) => {
                        if STRING_KEYS.contains(&key.as_str()) || keys.contains(&key.as_str()) {
                            out.insert(key.clone(), Value::String(clip(s, if key == "title" { 80 } else { 160 })));
                        } else if ENUM_KEYS.contains(&key.as_str()) && enum_pattern().is_match(s) {
                            out.insert(key.clone(), Value::String(s.clone()));
                        } else if text && key == "text" {
                            out.insert(key.clone(), Value::String(clip(s, 240)));
                        }
                    }
                    Value::Null | Value::Number(_) | Value::Bool(_) => {
                        out.insert(key.clone(), v.clone());
                    }
                    Value::Array(_) | Value::Object(_) => {
                        if let Some(nested) = project(v, text, keys, depth + 1) {
                            out.insert(key.clone(), nested);
                        }
                    }
                }
            }
            Some(Value::Object(out))
        }
        // null and undefined are dropped by `Object.entries` projection.
        _ => None,
    }
}

fn strip_free_text(value: &Value) -> Value {
    project(value, false, &[], 0).unwrap_or(Value::Null)
}

fn project_opts(value: &Value, text: bool, keys: &[&str]) -> Value {
    project(value, text, keys, 0).unwrap_or(Value::Null)
}

fn scope_kind(scope: &Value) -> &str {
    scope.get("kind").and_then(Value::as_str).unwrap_or("")
}

fn out(note: &str) -> Value {
    json!({"empty": true, "note": note})
}

fn get<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    map.get(key).filter(|v| !v.is_null())
}

fn object<'a>(value: &'a Value) -> &'a Map<String, Value> {
    value.as_object().unwrap_or(&EMPTY_MAP)
}

static EMPTY_MAP: std::sync::LazyLock<Map<String, Value>> =
    std::sync::LazyLock::new(Map::new);

fn id_param(params: &Map<String, Value>) -> Option<String> {
    get(params, "id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .map(str::to_owned)
}

fn int_param(params: &Map<String, Value>, key: &str, min: i64, max: i64) -> Option<i64> {
    match get(params, key) {
        None => None,
        Some(Value::Number(n)) => {
            let value = n.as_i64()?;
            (value >= min && value <= max).then_some(value)
        }
        Some(_) => None,
    }
}

fn string_param(
    params: &Map<String, Value>,
    key: &str,
    min: usize,
    max: usize,
) -> Option<String> {
    match get(params, key) {
        None => None,
        Some(Value::String(s)) => {
            let len = s.chars().count();
            (len >= min && len <= max).then(|| s.clone())
        }
        Some(_) => None,
    }
}

/// Validate a tool's arguments the way each zod schema does (unknown keys are
/// stripped, not refused).
fn valid_args(name: &str, args: &Value) -> bool {
    let map = match args {
        Value::Object(map) => map,
        Value::Null => return matches!(name, "snapshot" | "budget" | "strategies"),
        _ => return false,
    };
    match name {
        "snapshot" | "budget" | "strategies" => true,
        "task_get" => id_param(map).is_some(),
        "task_events" => {
            id_param(map).is_some()
                && get(map, "after").is_none_or(|_| int_param(map, "after", 0, i64::MAX).is_some())
        }
        "tasks_list" => {
            let state_ok = get(map, "state")
                .and_then(Value::as_str)
                .is_none_or(|s| matches!(s, "queued" | "running" | "done" | "partial" | "failed" | "limit" | "stopped" | "needs_input"));
            let repo_ok = get(map, "repo").is_none_or(|_| string_param(map, "repo", 1, usize::MAX).is_some());
            let before_ok = get(map, "before").is_none_or(|_| string_param(map, "before", 1, 128).is_some());
            let limit_ok = get(map, "limit").is_none_or(|_| int_param(map, "limit", 1, 100).is_some());
            state_ok && repo_ok && before_ok && limit_ok
        }
        "analytics" => {
            let repo_ok = get(map, "repo").is_none_or(|v| v.is_string());
            repo_ok && string_param(map, "kind", 1, 128).is_some()
        }
        "activity" => get(map, "limit").is_none_or(|_| int_param(map, "limit", 1, 100).is_some()),
        "route_explain" => {
            string_param(map, "repo", 1, 4096).is_some()
                && get(map, "kind").is_none_or(|_| string_param(map, "kind", 1, 64).is_some())
                && get(map, "executor").is_none_or(|_| string_param(map, "executor", 1, 128).is_some())
        }
        _ => false,
    }
}

async fn in_chosen_scope(
    reads: &mut dyn ReadOps,
    ctx: &Ctx,
    scope: &Value,
    task_id: &str,
) -> bool {
    match scope_kind(scope) {
        "task" => scope.get("id").and_then(Value::as_str) == Some(task_id),
        "repo" => {
            let repo = scope.get("repo").and_then(Value::as_str).unwrap_or_default();
            match reads
                .read(ctx, "task.list", json!({"repo": repo, "limit": 200}))
                .await
            {
                Ok(page) => page["tasks"]
                    .as_array()
                    .is_some_and(|tasks| tasks.iter().any(|t| t["id"].as_str() == Some(task_id))),
                Err(_) => false,
            }
        }
        _ => true,
    }
}

fn recent(value: Value, since: f64) -> Value {
    let Some(tasks) = value.get("tasks").and_then(Value::as_array) else {
        return value;
    };
    let filtered: Vec<Value> = tasks
        .iter()
        .filter(|task| {
            let at = get(object(task), "updatedAt")
                .or_else(|| get(object(task), "createdAt"))
                .and_then(Value::as_f64);
            at.is_none_or(|at| at >= since)
        })
        .cloned()
        .collect();
    let mut out = object(&value).clone();
    out.insert("tasks".into(), Value::Array(filtered));
    Value::Object(out)
}

struct ToolDef {
    name: &'static str,
    description: &'static str,
    parameters: Value,
}

fn tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef { name: "snapshot", description: "Counts, attention items, mode and pause state.", parameters: json!({"type":"object","additionalProperties":false}) },
        ToolDef { name: "tasks_list", description: "Titles, states, executors and times of work items. At most 100.", parameters: json!({"type":"object","properties":{"state":{"type":"string","enum":["queued","running","done","partial","failed","limit","stopped","needs_input"]},"repo":{"type":"string","minLength":1},"before":{"type":"string","minLength":1,"maxLength":128},"limit":{"type":"integer","minimum":1,"maximum":100}},"additionalProperties":false}) },
        ToolDef { name: "task_get", description: "Summary fields, decisions, attempts and review state of one work item. No goal or task text.", parameters: json!({"type":"object","required":["id"],"properties":{"id":{"type":"string","minLength":1,"maxLength":128}},"additionalProperties":false}) },
        ToolDef { name: "task_events", description: "The timeline of a work item after a cursor.", parameters: json!({"type":"object","required":["id"],"properties":{"id":{"type":"string","minLength":1,"maxLength":128},"after":{"type":"integer","minimum":0}},"additionalProperties":false}) },
        ToolDef { name: "budget", description: "Cached usage, pace and resets per account. Never triggers a live usage read.", parameters: json!({"type":"object","additionalProperties":false}) },
        ToolDef { name: "analytics", description: "Reviewed outcomes with sample sizes.", parameters: json!({"type":"object","properties":{"repo":{"type":"string"},"kind":{"type":"string","minLength":1,"maxLength":128}},"additionalProperties":false}) },
        ToolDef { name: "activity", description: "Recent activity log entries.", parameters: json!({"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100}},"additionalProperties":false}) },
        ToolDef { name: "route_explain", description: "Which executor work like this would go to, and why: the ladder step, the reasons, the fallbacks. Read-only; starts and reserves nothing.", parameters: json!({"type":"object","required":["repo"],"properties":{"repo":{"type":"string","minLength":1,"maxLength":4096},"kind":{"type":"string","minLength":1,"maxLength":64},"executor":{"type":"string","minLength":1,"maxLength":128}},"additionalProperties":false}) },
        ToolDef { name: "strategies", description: "Strategy names and summaries.", parameters: json!({"type":"object","additionalProperties":false}) },
    ]
}

fn tool_names() -> Vec<&'static str> {
    tool_defs().into_iter().map(|t| t.name).collect()
}

/// Definitions handed to the backend. The host runs the tools; the backend only asks.
pub fn tool_definitions() -> Value {
    let mut definitions: Vec<Value> = tool_defs()
        .into_iter()
        .map(|t| json!({"name": t.name, "description": t.description, "parameters": t.parameters}))
        .collect();
    definitions.push(json!({
        "name": "propose_action",
        "description": "Suggest one action for the user to confirm. It never runs on its own.",
        "parameters": {"type":"object","additionalProperties":false,"required":["op","params","why"],
            "properties":{"op":{"type":"string"},"params":{"type":"object"},"why":{"type":"string","maxLength":600}}}
    }));
    Value::Array(definitions)
}

fn error_content(message: &str) -> String {
    serde_json::to_string(&json!({"error": message})).unwrap_or_else(|_| "{}".to_owned())
}

/// Run one read tool: validate, scope, redact and cap. The result is data, never
/// instructions.
pub async fn run_read_tool(
    ctx: &Ctx,
    name: &str,
    args: &Value,
    scope: &Value,
    redactor: &Redactor,
    reads: &mut dyn ReadOps,
) -> ToolRunResult {
    if !tool_names().contains(&name) {
        return ToolRunResult {
            name: name.to_owned(),
            ok: false,
            content: error_content(&format!("Unknown tool {name}.")),
        };
    }
    if !valid_args(name, args) {
        return ToolRunResult {
            name: name.to_owned(),
            ok: false,
            content: error_content("Invalid tool arguments."),
        };
    }
    let params = object(args).clone();
    let result = match run_tool(ctx, name, &params, scope, reads).await {
        Ok(value) => value,
        Err(error) => {
            let message = redactor.text(&error.message).replace('<', "\\u003c");
            return ToolRunResult {
                name: name.to_owned(),
                ok: false,
                content: error_content(&message),
            };
        }
    };
    let redacted = redactor.json(&result);
    let mut text = serde_json::to_string(&redacted)
        .unwrap_or_else(|_| "null".to_owned())
        .replace('<', "\\u003c");
    if text.len() > RESULT_CAP_BYTES {
        let mut keep = RESULT_CAP_BYTES.saturating_sub(300);
        loop {
            let partial = {
                let bytes = text.as_bytes();
                let mut end = keep.min(bytes.len());
                while end > 0 && !text.is_char_boundary(end) {
                    end -= 1;
                }
                String::from_utf8_lossy(&bytes[..end])
                    .trim_end_matches('\u{fffd}')
                    .to_owned()
            };
            text = serde_json::to_string(&json!({
                "truncated": true,
                "note": "The result was larger than 32 KiB and was cut.",
                "partial": partial,
            }))
            .unwrap_or_else(|_| "{}".to_owned())
            .replace('<', "\\u003c");
            if text.len() <= RESULT_CAP_BYTES {
                break;
            }
            keep = (keep as f64 * 0.8) as usize;
        }
    }
    ToolRunResult {
        name: name.to_owned(),
        content: text,
        ok: true,
    }
}

fn core_error(message: impl Into<String>) -> CoreError {
    CoreError::new(pacer_foundation::api::Code::Internal, message)
}

#[allow(clippy::too_many_lines)]
async fn run_tool(
    ctx: &Ctx,
    name: &str,
    params: &Map<String, Value>,
    scope: &Value,
    reads: &mut dyn ReadOps,
) -> Result<Value, CoreError> {
    let kind = scope_kind(scope);
    match name {
        "snapshot" => {
            if kind == "task" {
                return Ok(out("The snapshot is outside a single-task scope."));
            }
            let raw = reads.read(ctx, "snapshot.get", json!({})).await?;
            let s = object(&raw["snapshot"]);
            let mut picked = Map::new();
            for key in ["counts", "attention", "mode", "pause", "planner"] {
                if let Some(value) = s.get(key) {
                    picked.insert(key.to_owned(), value.clone());
                }
            }
            Ok(strip_free_text(&Value::Object(picked)))
        }
        "tasks_list" => {
            if kind == "task" {
                return Ok(out("The scope is a single task; use task_get."));
            }
            let mut filter = Map::new();
            if let Some(state) = get(params, "state") {
                filter.insert("state".into(), state.clone());
            }
            if kind == "repo" {
                filter.insert(
                    "repo".into(),
                    Value::String(scope.get("repo").and_then(Value::as_str).unwrap_or_default().into()),
                );
            } else if let Some(repo) = get(params, "repo") {
                filter.insert("repo".into(), repo.clone());
            }
            if let Some(before) = get(params, "before") {
                filter.insert("before".into(), before.clone());
            }
            let limit = int_param(params, "limit", 1, 100).unwrap_or(50).min(100);
            let mut dispatch_params = filter.clone();
            dispatch_params.insert("relation".into(), Value::String("all".into()));
            dispatch_params.insert("limit".into(), json!(limit));
            let work = reads.read(ctx, "dispatch.list", Value::Object(dispatch_params)).await?;

            let mut task_params = Map::new();
            task_params.insert("limit".into(), json!(limit));
            if let Some(state) = filter.get("state") {
                task_params.insert("states".into(), json!([state]));
            }
            if let Some(repo) = filter.get("repo") {
                task_params.insert("repo".into(), repo.clone());
            }
            let tasks = reads.read(ctx, "task.list", Value::Object(task_params)).await?;

            let since = if kind == "dispatch" {
                ctx.now - scope.get("days").and_then(Value::as_f64).unwrap_or(0.0) * 86_400.0
            } else {
                0.0
            };
            Ok(strip_free_text(&json!({
                "work": recent(work, since),
                "tasks": recent(tasks, since),
            })))
        }
        "task_get" => {
            let task_id = id_param(params).unwrap_or_default();
            if !in_chosen_scope(reads, ctx, scope, &task_id).await {
                return Ok(out("That task is outside the chosen scope."));
            }
            match reads
                .read(ctx, "dispatch.tree", json!({"id": task_id}))
                .await
            {
                Ok(tree) => Ok(strip_free_text(&tree)),
                Err(_) => {
                    let detail = reads.read(ctx, "task.get", json!({"id": task_id})).await?;
                    Ok(strip_free_text(&detail))
                }
            }
        }
        "task_events" => {
            let task_id = id_param(params).unwrap_or_default();
            if !in_chosen_scope(reads, ctx, scope, &task_id).await {
                return Ok(out("That task is outside the chosen scope."));
            }
            let mut read_params = Map::new();
            read_params.insert("id".into(), Value::String(task_id));
            if let Some(after) = int_param(params, "after", 0, i64::MAX) {
                read_params.insert("after".into(), json!(after));
            }
            let events = reads.read(ctx, "dispatch.events", Value::Object(read_params)).await?;
            Ok(strip_free_text(&events))
        }
        "budget" => {
            if kind == "task" {
                return Ok(out("Budget is outside a single-task scope."));
            }
            let budget = reads.read(ctx, "assistant.budget", json!({})).await?;
            Ok(strip_free_text(&budget))
        }
        "analytics" => {
            if kind == "task" {
                return Ok(out("Analytics are outside a single-task scope."));
            }
            let mut read_params = params.clone();
            if kind == "repo" {
                read_params.insert(
                    "repo".into(),
                    Value::String(scope.get("repo").and_then(Value::as_str).unwrap_or_default().into()),
                );
            }
            let analytics = reads.read(ctx, "dispatch.analytics", Value::Object(read_params)).await?;
            Ok(strip_free_text(&analytics))
        }
        "activity" => {
            let mut read_params = Map::new();
            read_params.insert("limit".into(), json!(int_param(params, "limit", 1, 100).unwrap_or(50)));
            if kind == "task" {
                read_params.insert(
                    "taskId".into(),
                    Value::String(scope.get("id").and_then(Value::as_str).unwrap_or_default().into()),
                );
            }
            if kind == "repo" {
                read_params.insert(
                    "repo".into(),
                    Value::String(scope.get("repo").and_then(Value::as_str).unwrap_or_default().into()),
                );
            }
            let activity = reads.read(ctx, "activity.list", Value::Object(read_params)).await?;
            Ok(project_opts(&activity, true, &[]))
        }
        "route_explain" => {
            if kind == "task" {
                return Ok(out(
                    "Route explanations are outside a single-task scope; task_get shows where this task went.",
                ));
            }
            let repo = if kind == "repo" {
                scope.get("repo").and_then(Value::as_str).unwrap_or_default().to_owned()
            } else {
                string_param(params, "repo", 1, 4096).unwrap_or_default()
            };
            let mut read_params = Map::new();
            read_params.insert("repo".into(), Value::String(repo));
            read_params.insert(
                "goal".into(),
                Value::String("Explain how work like this would be routed.".into()),
            );
            if let Some(kind) = get(params, "kind") {
                read_params.insert("kind".into(), kind.clone());
            }
            if let Some(executor) = get(params, "executor") {
                read_params.insert("executor".into(), executor.clone());
            }
            let explained = reads.read(ctx, "dispatch.explain", Value::Object(read_params)).await?;
            Ok(project_opts(&explained, true, &EXPLAIN_KEYS))
        }
        "strategies" => {
            if kind == "task" {
                return Ok(out("Strategies are outside a single-task scope."));
            }
            let list = reads.read(ctx, "strategy.list", json!({})).await?;
            let rows = list.as_array().map_or(&[][..], Vec::as_slice);
            let summaries = rows
                .iter()
                .map(|s| {
                    json!({
                        "name": s.get("name").cloned().unwrap_or(Value::Null),
                        "active": s.get("active").cloned().unwrap_or(Value::Null),
                        "summary": s.get("summary").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect();
            Ok(Value::Array(summaries))
        }
        _ => Err(core_error(format!("Unknown tool {name}."))),
    }
}

fn task_id_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\bt-\d{8}-\d{6}-[0-9a-f]{4}\b")
            .unwrap_or_else(|e| panic!("invalid task id pattern: {e}"))
    })
}

/// Run one call of a turn: charge the round budget, build a card for
/// `propose_action`, or run a read tool and return its delimited data.
pub async fn run_assistant_tool(
    ctx: &Ctx,
    call: &Value,
    scope: &Value,
    redactor: &Redactor,
    state: &mut ToolState,
    reads: &mut dyn ReadOps,
) -> (String, bool) {
    if state.rounds >= MAX_TOOL_ROUNDS {
        return (
            error_content("That turn has used its tool-call budget."),
            false,
        );
    }
    state.rounds += 1;
    let name = call.get("name").and_then(Value::as_str).unwrap_or_default();
    let args = call.get("arguments").cloned().unwrap_or(Value::Null);
    if name == "propose_action" {
        let op = args.get("op").and_then(Value::as_str).unwrap_or_default();
        let result = cards::build_card(ctx, &args, &NoCards, redactor);
        let logged_op = if result.ok() {
            Value::String(op.to_owned())
        } else {
            Value::Null
        };
        state.tool_log.push(json!({"name": name, "op": logged_op}));
        return match result {
            cards::CardResult::Ok(_) => (
                "The proposal is shown to the user as a card. It has not run.".to_owned(),
                true,
            ),
            cards::CardResult::Note(note) => (note, false),
        };
    }
    let out = run_read_tool(ctx, name, &args, scope, redactor, reads).await;
    for mat in task_id_pattern().find_iter(&out.content) {
        state.seen_tasks.insert(mat.as_str().to_owned());
    }
    state.tool_log.push(json!({
        "name": name,
        "ok": out.ok,
        "args": redactor.json(&args),
    }));
    (
        format!("<data tool=\"{name}\">\n{}\n</data>", out.content),
        out.ok,
    )
}

/// The library slice does not persist cards: B4-4 owns the live turn's card
/// list. `propose_action` is still fully validated through `build_card`.
struct NoCards;

impl cards::CardDeps for NoCards {
    fn task(&self, _ctx: &Ctx, _id: &str) -> Option<cards::CardTask> {
        None
    }
}

#[cfg(test)]
mod tests;
