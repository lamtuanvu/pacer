//! Selective native `task.delegate`, `task.retry`, `task.retry_all`, `task.answer`, `task.ask`
//! and `doctor.fix.delegate` (`src/api/ops.ts`).
//!
//! Each front door asks [`admit`] once per request. Rust answers what TypeScript decides before
//! any effect (the enforcement identity, Zod issues in schema key order, executor refusals and
//! task-record refusals) and now admits `task.delegate` to a native effect over
//! [`DelegationEffects`]. The other operations still reach Core unchanged.
//!
//! A task id that is well formed but missing stays with Core for `task.retry` and `task.answer`:
//! `retryTask` takes a desktop-update work lease first, and that lease can refuse with a conflict.
//! A store Rust cannot read also stays with Core, which owns that failure's reply.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    js_semantics::JsTrim,
};
use pacer_lifecycle::{files_search::executor_session, work_node_exists};
use pacer_store::{TaskStore, is_task_id};
use serde_json::{Map, Value, json};
use std::collections::HashSet;

use super::files_search_ops::providers;
use super::lifecycle_ops::{invalid, type_name};
use super::session_context_ops::authorize;

pub const DELEGATION_OPS: &[&str] = &[
    "task.delegate",
    "task.retry",
    "task.retry_all",
    "task.answer",
    "task.ask",
    "doctor.fix.delegate",
];

/// `EXECUTOR_DELEGATE_ERROR` in `src/tasks/api.ts`.
const EXECUTOR_DELEGATE_ERROR: &str = "PACER_ROLE=executor: pacer executors cannot delegate onward; complete the assigned task directly.";
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Native effects for `task.delegate`, supplied by the front door.
pub trait DelegationEffects: Send + Sync {
    /// Runs the whole native delegation and returns `summarizeTask`.
    fn delegate<'a>(&'a self, ctx: &'a Ctx, params: &'a Value) -> OpFuture<'a>;
}

/// What a front door does with a request [`admit`] did not refuse.
pub enum Admission<'a> {
    /// The reply, computed without Core.
    Native(Value),
    /// An asynchronous native effect, awaited by the front door.
    Effect(OpFuture<'a>),
    /// Core runs the original request.
    Core,
}

impl std::fmt::Debug for Admission<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Native(value) => f.debug_tuple("Native").field(value).finish(),
            Self::Effect(_) => f.write_str("Effect"),
            Self::Core => f.write_str("Core"),
        }
    }
}

impl PartialEq for Admission<'_> {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Native(a), Self::Native(b)) => a == b,
            (Self::Effect(_), Self::Effect(_)) => true,
            (Self::Core, Self::Core) => true,
            _ => false,
        }
    }
}

/// One published params field, checked as its Zod schema.
#[derive(Clone, Copy)]
enum Field {
    /// `z.string()` with optional `.min(n)` and `.max(n)`.
    Str(Option<usize>, Option<usize>),
    /// `z.string().trim().min(1).max(60)`.
    Title,
    /// `z.enum([...])`.
    Enum(&'static [&'static str]),
    /// The `group` regex in `delegateSchema`.
    Group,
    /// `z.number().int().min(min).max(max)`.
    Int(f64, f64),
    /// `z.number().int().positive()`.
    PositiveInt,
    /// `z.number().min(min).max(max)`.
    Num(f64, f64),
    /// `z.string().refine(validBase)`, which runs `git check-ref-format --branch`.
    Base,
    /// `messagingOverrideSchema`: a strict object with bounded rule/turn/liveness fields.
    Messaging,
    /// `z.boolean()`.
    Bool,
    /// `z.array(id).min(1).max(100)`.
    Ids,
}

/// `(key, schema, required)` in schema key order, which is Zod's issue order.
type Shape = &'static [(&'static str, Field, bool)];

const ID: Field = Field::Str(Some(1), Some(128));
const TEXT: Field = Field::Str(None, None);
const NAME: Field = Field::Str(Some(1), None);
const KINDS: &[&str] = &[
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

/// `delegateSchema` with `repo` required. `dispatch` is `z.unknown()`; `base` and
/// `messaging` are validated natively (see [`Field::Base`] and [`Field::Messaging`]).
const DELEGATE: Shape = &[
    (
        "difficulty",
        Field::Enum(&["simple", "standard", "complex"]),
        false,
    ),
    ("model", Field::Str(Some(1), Some(256)), false),
    ("title", Field::Title, false),
    ("request_id", ID, false),
    ("base", Field::Base, false),
    ("source", Field::Enum(&["planner", "ui", "cli"]), false),
    ("goal", NAME, true),
    ("repo", NAME, true),
    ("scope", TEXT, false),
    ("acceptance", TEXT, false),
    ("acceptance_pipefail", Field::Bool, false),
    ("acceptance_timeout_min", Field::Int(1.0, 120.0), false),
    ("constraints", TEXT, false),
    ("context", TEXT, false),
    ("kind", Field::Enum(KINDS), false),
    ("executor", TEXT, false),
    ("worktree_base", Field::Enum(&["default", "head"]), false),
    ("worktree", Field::Enum(&["current", "new", "auto"]), false),
    ("worktree_reason", Field::Str(None, Some(200)), false),
    ("timeout_min", Field::Num(1.0, 240.0), false),
    ("interactive", Field::Bool, false),
    ("group", Field::Group, false),
    ("messaging", Field::Messaging, false),
    ("grant", Field::Bool, false),
];
const RETRY: Shape = &[
    ("id", ID, true),
    ("expect_rev", Field::PositiveInt, false),
    ("executor", ID, false),
    ("from_panel", Field::Bool, false),
];
const RETRY_ALL: Shape = &[
    ("ids", Field::Ids, true),
    ("executor", ID, false),
    ("from_panel", Field::Bool, false),
];
const ANSWER: Shape = &[
    ("id", ID, true),
    ("text", Field::Str(Some(1), Some(2000)), true),
    ("expect_rev", Field::PositiveInt, false),
];
const ASK: Shape = &[
    ("id", ID, true),
    ("text", Field::Str(Some(1), Some(1000)), true),
];
const DOCTOR_FIX: Shape = &[
    ("check", Field::Str(Some(1), Some(256)), true),
    ("scope", Field::Enum(&["fix", "investigate"]), true),
];

fn shape(op: &str) -> Option<Shape> {
    Some(match op {
        "task.delegate" => DELEGATE,
        "task.retry" => RETRY,
        "task.retry_all" => RETRY_ALL,
        "task.answer" => ANSWER,
        "task.ask" => ASK,
        "doctor.fix.delegate" => DOCTOR_FIX,
        _ => return None,
    })
}

/// Zod counts code points.
fn string_issues(
    name: &str,
    value: &Value,
    min: Option<usize>,
    max: Option<usize>,
    issues: &mut Vec<String>,
) {
    let Value::String(text) = value else {
        return issues.push(expected(name, "string", value));
    };
    length_issues(name, text, min, max, issues);
}

fn length_issues(
    name: &str,
    text: &str,
    min: Option<usize>,
    max: Option<usize>,
    issues: &mut Vec<String>,
) {
    let units = text.chars().count();
    if let Some(min) = min.filter(|min| units < *min) {
        issues.push(format!(
            "{name}: Too small: expected string to have >={min} characters"
        ));
    }
    if let Some(max) = max.filter(|max| units > *max) {
        issues.push(format!(
            "{name}: Too big: expected string to have <={max} characters"
        ));
    }
}

fn expected(name: &str, kind: &str, value: &Value) -> String {
    format!(
        "{name}: Invalid input: expected {kind}, received {}",
        type_name(value)
    )
}

fn number_issues(name: &str, n: f64, min: f64, max: f64, issues: &mut Vec<String>) {
    if n < min {
        issues.push(format!("{name}: Too small: expected number to be >={min}"));
    }
    if n > max {
        issues.push(format!("{name}: Too big: expected number to be <={max}"));
    }
}

fn valid_group(group: &str) -> bool {
    let bytes = group.as_bytes();
    (1..=40).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn ids_issues(name: &str, value: &Value, issues: &mut Vec<String>) {
    let Value::Array(ids) = value else {
        return issues.push(expected(name, "array", value));
    };
    for (index, id) in ids.iter().enumerate() {
        string_issues(&format!("{name}.{index}"), id, Some(1), Some(128), issues);
    }
    if ids.is_empty() {
        issues.push(format!(
            "{name}: Too small: expected array to have >=1 items"
        ));
    } else if ids.len() > 100 {
        issues.push(format!(
            "{name}: Too big: expected array to have <=100 items"
        ));
    }
}

/// `messagingOverrideSchema` (`src/messaging/types.ts`) issue text in Zod order.
fn messaging_issues(name: &str, value: &Value, issues: &mut Vec<String>) {
    let Some(fields) = value.as_object() else {
        return issues.push(expected(name, "object", value));
    };
    for key in fields.keys() {
        if !matches!(key.as_str(), "rules" | "max_turns" | "liveness") {
            issues.push(format!("{name}: Unrecognized key: \"{key}\""));
        }
    }
    if let Some(rules) = fields.get("rules") {
        match rules.as_array() {
            Some(items) if items.len() <= 50 => {
                for (index, rule) in items.iter().enumerate() {
                    let path = format!("{name}.rules.{index}");
                    let Some(rule) = rule.as_object() else {
                        issues.push(expected(&path, "object", rule));
                        continue;
                    };
                    for key in rule.keys() {
                        if !matches!(
                            key.as_str(),
                            "effect" | "from_kind" | "to_kind" | "from_position" | "relation"
                                | "kinds" | "repo" | "executor" | "grant" | "limits"
                        ) {
                            issues.push(format!("{path}: Unrecognized key: \"{key}\""));
                        }
                    }
                    if !rule
                        .get("effect")
                        .and_then(Value::as_str)
                        .is_some_and(|effect| matches!(effect, "allow" | "deny"))
                    {
                        issues.push(format!(
                            "{path}.effect: Invalid option: expected one of \"allow\"|\"deny\""
                        ));
                    }
                    if let Some(kinds) = rule.get("kinds")
                        && kinds.as_array().is_some_and(Vec::is_empty)
                    {
                        issues.push(format!(
                            "{path}.kinds: Too small: expected array to have >=1 items"
                        ));
                    }
                }
            }
            Some(_) => issues.push(format!(
                "{name}.rules: Too big: expected array to have <=50 items"
            )),
            None => issues.push(expected(&format!("{name}.rules"), "array", rules)),
        }
    }
    if let Some(turns) = fields.get("max_turns") {
        match turns.as_f64() {
            Some(n) if n.fract() != 0.0 => issues.push(format!(
                "{name}.max_turns: Invalid input: expected int, received number"
            )),
            Some(n) if n <= 0.0 => issues.push(format!(
                "{name}.max_turns: Too small: expected number to be >0"
            )),
            Some(n) if n > 10_000.0 => issues.push(format!(
                "{name}.max_turns: Too big: expected number to be <=10000"
            )),
            Some(_) => {}
            None => issues.push(expected(&format!("{name}.max_turns"), "number", turns)),
        }
    }
    if let Some(liveness) = fields.get("liveness") {
        match liveness.as_object() {
            Some(liveness) => {
                for key in liveness.keys() {
                    if !matches!(key.as_str(), "interval_s" | "max_nudges" | "escalate_after_s") {
                        issues.push(format!("{name}.liveness: Unrecognized key: \"{key}\""));
                    }
                }
                for (key, min) in [
                    ("interval_s", 10.0),
                    ("max_nudges", 0.0),
                    ("escalate_after_s", 10.0),
                ] {
                    if let Some(value) = liveness.get(key) {
                        match value.as_f64() {
                            Some(n) if n.fract() != 0.0 => issues.push(format!(
                                "{name}.liveness.{key}: Invalid input: expected int, received number"
                            )),
                            Some(n) if n < min => issues.push(format!(
                                "{name}.liveness.{key}: Too small: expected number to be >={:.0}",
                                min
                            )),
                            Some(_) => {}
                            None => issues.push(expected(
                                &format!("{name}.liveness.{key}"),
                                "number",
                                value,
                            )),
                        }
                    }
                }
            }
            None => issues.push(expected(&format!("{name}.liveness"), "object", liveness)),
        }
    }
}

fn field_issues(name: &str, field: Field, value: &Value, issues: &mut Vec<String>) {
    match field {
        Field::Str(min, max) => string_issues(name, value, min, max, issues),
        Field::Title => match value {
            Value::String(title) => {
                length_issues(name, title.js_trim(), Some(1), Some(60), issues);
            }
            other => issues.push(expected(name, "string", other)),
        },
        Field::Enum(options) => {
            if !value.as_str().is_some_and(|text| options.contains(&text)) {
                let options = options
                    .iter()
                    .map(|option| format!("\"{option}\""))
                    .collect::<Vec<_>>()
                    .join("|");
                issues.push(format!(
                    "{name}: Invalid option: expected one of {options}"
                ));
            }
        }
        Field::Group => match value {
            Value::String(group) if valid_group(group) => {}
            Value::String(_) => issues.push(format!(
                "{name}: group must be 1–40 characters, starting alphanumeric, of letters, digits, - and _"
            )),
            other => issues.push(expected(name, "string", other)),
        },
        Field::Int(min, max) => match value.as_f64() {
            Some(n) if n.fract() != 0.0 => issues.push(format!(
                "{name}: Invalid input: expected int, received number"
            )),
            Some(n) => number_issues(name, n, min, max, issues),
            None => issues.push(expected(name, "number", value)),
        },
        Field::Num(min, max) => match value.as_f64() {
            Some(n) => number_issues(name, n, min, max, issues),
            None => issues.push(expected(name, "number", value)),
        },
        Field::PositiveInt => match value.as_f64() {
            Some(n) if n <= 0.0 => {
                issues.push(format!("{name}: Too small: expected number to be >0"));
            }
            Some(_) => {}
            None => issues.push(expected(name, "number", value)),
        },
        Field::Base => match value {
            Value::String(base) => {
                length_issues(name, base, Some(1), Some(4096), issues);
                if !pacer_lifecycle::valid_base(base) {
                    issues.push(format!(
                        "{name}: base must be a branch name or a 7–40 hex SHA"
                    ));
                }
            }
            other => issues.push(expected(name, "string", other)),
        },
        Field::Messaging => messaging_issues(name, value, issues),
        Field::Bool if value.is_boolean() => {}
        Field::Bool => issues.push(expected(name, "boolean", value)),
        Field::Ids => ids_issues(name, value, issues),
    }
}

/// Requests whose number validation only Core can answer exactly: a fractional,
/// exponent or unsafe number may read differently in serde_json and `JSON.parse`.
/// `task.delegate` now validates `base`, `messaging` and numbers natively in
/// `pacer_delegation`, so it is excluded here.
fn core_validates(op: &str, shape: Shape, p: &Map<String, Value>) -> bool {
    op != "task.delegate"
        && shape.iter().any(|(name, field, _)| {
            matches!(field, Field::Int(..) | Field::Num(..) | Field::PositiveInt)
                && matches!(p.get(*name), Some(Value::Number(n))
                    if n.is_f64() || n.as_f64().is_none_or(|n| n.abs() > MAX_SAFE_INTEGER))
        })
}

fn params_issues(shape: Shape, p: &Map<String, Value>) -> Vec<String> {
    let mut issues = Vec::new();
    for &(name, field, required) in shape {
        match p.get(name) {
            Some(value) => field_issues(name, field, value, &mut issues),
            None if required => issues.push(missing(name, field)),
            None => {}
        }
    }
    issues
}

fn missing(name: &str, field: Field) -> String {
    match field {
        Field::Enum(options) => format!(
            "{name}: Invalid option: expected one of {}",
            options
                .iter()
                .map(|option| format!("\"{option}\""))
                .collect::<Vec<_>>()
                .join("|")
        ),
        Field::Ids => format!("{name}: Invalid input: expected array, received undefined"),
        Field::Int(..) | Field::Num(..) | Field::PositiveInt => {
            format!("{name}: Invalid input: expected number, received undefined")
        }
        Field::Bool => format!("{name}: Invalid input: expected boolean, received undefined"),
        // Remaining fields are string-typed in every schema today (Str, Title, Group).
        _ => format!("{name}: Invalid input: expected string, received undefined"),
    }
}

fn is_executor(ctx: &Ctx) -> bool {
    let cwd = std::env::current_dir().unwrap_or_default();
    executor_session(ctx, &cwd, || providers(ctx))
}

fn not_allowed(message: &str) -> CoreError {
    CoreError::new(Code::NotAllowed, message)
}

fn unknown(id: &str) -> CoreError {
    CoreError::new(Code::UnknownTask, format!("unknown task {id}"))
}

fn env_set(ctx: &Ctx, name: &str) -> bool {
    ctx.env.get(name).is_some_and(|value| !value.is_empty())
}

/// `Some(true)` only when the store proves `id` is not managed work.
fn unmanaged(ctx: &Ctx, id: &str) -> Option<bool> {
    let mut store = TaskStore::open(&ctx.pacer_home).ok()?;
    work_node_exists(&mut store, id).map(|managed| !managed)
}

fn retry(ctx: &Ctx, p: &Map<String, Value>) -> Result<Admission<'static>, CoreError> {
    if is_executor(ctx) {
        return Err(not_allowed(EXECUTOR_DELEGATE_ERROR));
    }
    let id = p["id"].as_str().unwrap_or_default();
    if !is_task_id(id) && unmanaged(ctx, id) == Some(true) {
        return Err(unknown(id));
    }
    Ok(Admission::Core)
}

/// The reply when no id can name a task; each id is skipped as `task.retry_all` skips it.
fn retry_all(ctx: &Ctx, p: &Map<String, Value>) -> Result<Admission<'static>, CoreError> {
    if is_executor(ctx) {
        return Err(not_allowed(EXECUTOR_DELEGATE_ERROR));
    }
    let mut seen = HashSet::new();
    let mut skipped = Vec::new();
    for id in p["ids"].as_array().into_iter().flatten() {
        let id = id.as_str().unwrap_or_default();
        if !seen.insert(id) {
            continue;
        }
        if is_task_id(id) || unmanaged(ctx, id) != Some(true) {
            return Ok(Admission::Core);
        }
        skipped.push(json!({"id": id, "reason": format!("unknown task {id}")}));
    }
    Ok(Admission::Native(
        json!({"retried": [], "skipped": skipped}),
    ))
}

fn answer(ctx: &Ctx, p: &Map<String, Value>) -> Result<Admission<'static>, CoreError> {
    let id = p["id"].as_str().unwrap_or_default();
    // The handler's managed-work refusal comes before every refusal below.
    if unmanaged(ctx, id) != Some(true) {
        return Ok(Admission::Core);
    }
    if is_executor(ctx) {
        return Err(not_allowed("executors cannot delegate onward"));
    }
    let text = p["text"].as_str().unwrap_or_default();
    if text.encode_utf16().count() > 2000 {
        return Err(invalid("answer must contain 1–2000 characters"));
    }
    if !is_task_id(id) {
        return Err(unknown(id));
    }
    Ok(Admission::Core)
}

/// `requireAskingExecutor`, then `ask` up to its first write.
fn ask(ctx: &Ctx, p: &Map<String, Value>) -> Result<Admission<'static>, CoreError> {
    let id = p["id"].as_str().unwrap_or_default();
    let own = ctx.env.get("PACER_TASK_ID").map(String::as_str);
    if !is_executor(ctx) || own.is_none_or(str::is_empty) || own != Some(id) {
        return Err(not_allowed("pacer ask works only inside a delegated task"));
    }
    if !is_task_id(id) {
        return Err(unknown(id));
    }
    let text = p["text"].as_str().unwrap_or_default();
    if text.encode_utf16().count() > 1000 {
        return Err(invalid("question must contain 1–1000 characters"));
    }
    let Ok(mut store) = TaskStore::open(&ctx.pacer_home) else {
        return Ok(Admission::Core);
    };
    let task = match store.read(id) {
        Ok(Some(task)) => task,
        Ok(None) => return Err(unknown(id)),
        Err(_) => return Ok(Admission::Core),
    };
    if task
        .get("question")
        .is_some_and(|q| q.is_object() && q.get("answer").is_none())
    {
        return Err(CoreError::new(
            Code::Conflict,
            "already asked; stop and wait for the answer",
        ));
    }
    if task.get("state").and_then(Value::as_str) != Some("running") {
        return Err(CoreError::new(Code::Conflict, "task is not running"));
    }
    Ok(Admission::Core)
}

/// Decides one request, once. `Err` is the reply TypeScript would give.
pub fn admit<'a>(
    ctx: &'a Ctx,
    op: &str,
    params: &'a Value,
    effects: &'a dyn DelegationEffects,
) -> Result<Admission<'a>, CoreError> {
    let Some(shape) = shape(op) else {
        return Ok(Admission::Core);
    };
    // `authorizeWorkOperation` answers these identities before reading the params.
    if env_set(ctx, "PACER_ASSISTANT_GRANT") {
        return Ok(Admission::Core);
    }
    authorize(ctx)?;
    if env_set(ctx, "PACER_WORK_GRANT") {
        return Ok(Admission::Core);
    }
    let empty = Map::new();
    let p = match params {
        Value::Null => &empty,
        Value::Object(p) => p,
        other => {
            return Err(invalid(format!(
                "params: Invalid input: expected object, received {}",
                type_name(other)
            )));
        }
    };
    if core_validates(op, shape, p) {
        return Ok(Admission::Core);
    }
    let issues = params_issues(shape, p);
    if !issues.is_empty() {
        return Err(invalid(issues.join("; ")));
    }
    match op {
        "task.delegate" if is_executor(ctx) => Err(not_allowed(EXECUTOR_DELEGATE_ERROR)),
        "task.delegate" => Ok(Admission::Effect(effects.delegate(ctx, params))),
        "task.retry" => retry(ctx, p),
        "task.retry_all" => retry_all(ctx, p),
        "task.answer" => answer(ctx, p),
        "task.ask" => ask(ctx, p),
        _ if is_executor(ctx) => Err(not_allowed(EXECUTOR_DELEGATE_ERROR)),
        _ => Ok(Admission::Core),
    }
}

/// A test double that reports an empty reply when a native delegate is admitted.
pub struct NoDelegationEffects;
impl DelegationEffects for NoDelegationEffects {
    fn delegate<'a>(&'a self, _: &'a Ctx, _: &'a Value) -> OpFuture<'a> {
        Box::pin(async { Ok(json!({})) })
    }
}

pub fn is_delegation_op(op: &str) -> bool {
    DELEGATION_OPS.contains(&op)
}

/// The registry entry; both front doors call [`admit`] and forward what it admits.
pub fn task_delegation_stub<'a>(_: &'a Ctx, _: Value) -> OpFuture<'a> {
    Box::pin(async {
        Err(CoreError::new(
            Code::Unavailable,
            "task delegation requires a front door",
        ))
    })
}

#[cfg(test)]
#[path = "task_delegation_ops/tests.rs"]
mod tests;
