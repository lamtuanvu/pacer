//! Native session lifecycle admission (`src/api/ops-session.ts`, `src/api/ops-agent-sessions.ts`).
//!
//! Rust refuses enforcement identities, validates the params as Zod does, answers the refusals
//! the task record alone decides and creates attachment drafts. Core keeps what needs its live
//! state: runner spawn, prepared admission, plugin agent IPC, session hosts and viewers. An
//! admitted request reaches Core over the private bridge on HTTP and unchanged on stdio.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_sessions::params::{
    MAX_ATTACHMENTS, MAX_EXECUTOR_LEN, MAX_SAFE_INTEGER, MAX_SESSION_REQUEST, valid_draft_uuid,
    valid_session_id,
};
use pacer_store::{TaskStore, attachments, is_task_id};
use serde_json::{Map, Value, json};

use super::session_context_ops::authorize;

const ID_PATTERN: &str = "/^[A-Za-z0-9_-]{1,128}$/";

const OPS: &[&str] = &[
    "session.create",
    "session.resume",
    "session.end",
    "session.prepare",
    "session.draft.create",
    "session.file.read",
    "session.attachment.prepare",
    "session.agent.create",
    "session.agent.list",
    "session.agent.get",
    "session.agent.end",
    "session.agent.retry",
    "session.agent.resume",
    "task.attach",
    "task.session",
    "task.takeover",
    "task.hand_back",
];

/// Operations whose number fields are `z.number().int().positive()`.
const NUMBER_FIELDS: &[(&str, &str)] = &[
    ("session.resume", "expect_rev"),
    ("session.end", "expect_rev"),
    ("session.file.read", "attempt"),
    ("session.agent.end", "expect_rev"),
    ("session.agent.retry", "expect_rev"),
    ("session.agent.resume", "expect_rev"),
];

/// How a front door answers a request Rust did not refuse.
#[derive(Debug, PartialEq)]
pub enum Admission {
    /// Rust owns the reply.
    Native(Value),
    /// Core runs the operation.
    Core,
}

pub fn uses_admission(op: &str) -> bool {
    OPS.contains(&op)
}

/// The registry entry; the front doors call [`admit`] instead.
pub fn session_lifecycle_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async {
        Err(CoreError::new(
            Code::Unavailable,
            "session lifecycle bridge unavailable",
        ))
    })
}

fn strict(op: &str) -> Option<&'static [&'static str]> {
    match op {
        "session.agent.list" => Some(&["task_id"]),
        "session.agent.get" => Some(&["task_id", "id"]),
        "session.agent.create" => Some(&["task_id", "request_id", "executor", "request"]),
        "session.agent.end" | "session.agent.retry" | "session.agent.resume" => {
            Some(&["task_id", "id", "expect_rev"])
        }
        _ => None,
    }
}

/// Inputs whose Zod reply depends on JavaScript details `serde_json` does not keep: number
/// literals outside the safe integers, `__proto__` keys, the order of several unknown keys and
/// oversized attachment lists, whose issues Zod interleaves. An assistant grant is answered by
/// Core's authorization.
pub fn session_lifecycle_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    if !uses_admission(op) {
        return false;
    }
    if ctx
        .env
        .get("PACER_ASSISTANT_GRANT")
        .is_some_and(|grant| !grant.is_empty())
    {
        return true;
    }
    let Value::Object(map) = params else {
        return false;
    };
    if map.contains_key("__proto__") {
        return true;
    }
    if let Some(known) = strict(op) {
        let unknown: Vec<&String> = map
            .keys()
            .filter(|key| !known.contains(&key.as_str()))
            .collect();
        let plain = |key: &str| {
            key.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                && key.parse::<f64>().is_err()
        };
        if unknown.len() > 1 || unknown.iter().any(|key| !plain(key)) {
            return true;
        }
    }
    let inexact = NUMBER_FIELDS
        .iter()
        .filter(|(name, _)| *name == op)
        .filter_map(|(_, field)| map.get(*field))
        .any(|value| matches!(value, Value::Number(_)) && safe_integer(value).is_none());
    inexact
        || (op == "session.create"
            && (map
                .get("attachments")
                .and_then(Value::as_array)
                .is_some_and(|list| list.len() > MAX_ATTACHMENTS)
                || map
                    .get("workspace")
                    .and_then(Value::as_object)
                    .is_some_and(|workspace| workspace.contains_key("__proto__"))))
}

fn safe_integer(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .filter(|n| n.unsigned_abs() <= MAX_SAFE_INTEGER)
}

fn type_name(value: Option<&Value>) -> &'static str {
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

fn expected(path: &str, kind: &str, value: Option<&Value>) -> String {
    format!(
        "{path}: Invalid input: expected {kind}, received {}",
        type_name(value)
    )
}

/// One object's fields, collected in schema order as Zod reports them.
struct Fields<'a> {
    map: &'a Map<String, Value>,
    prefix: &'static str,
    issues: Vec<String>,
}

impl<'a> Fields<'a> {
    fn path(&self, name: &str) -> String {
        format!("{}{name}", self.prefix)
    }

    fn id(&mut self, name: &str) {
        self.pattern(name, self.map.get(name));
    }

    fn optional_id(&mut self, name: &str) {
        if self.map.contains_key(name) {
            self.id(name);
        }
    }

    fn pattern(&mut self, name: &str, value: Option<&Value>) {
        match value {
            Some(Value::String(id)) if valid_session_id(id) => {}
            Some(Value::String(_)) => self.issues.push(format!(
                "{}: Invalid string: must match pattern {ID_PATTERN}",
                self.path(name)
            )),
            other => self
                .issues
                .push(expected(&self.path(name), "string", other)),
        }
    }

    /// `z.string().min(1).max(max)`, which counts code points.
    fn text(&mut self, name: &str, max: Option<usize>) {
        match self.map.get(name) {
            Some(Value::String(text)) => {
                let length = text.chars().count();
                if length < 1 {
                    self.issues.push(format!(
                        "{}: Too small: expected string to have >=1 characters",
                        self.path(name)
                    ));
                } else if let Some(max) = max.filter(|max| length > *max) {
                    self.issues.push(format!(
                        "{}: Too big: expected string to have <={max} characters",
                        self.path(name)
                    ));
                }
            }
            other => self
                .issues
                .push(expected(&self.path(name), "string", other)),
        }
    }

    fn optional_string(&mut self, name: &str) {
        match self.map.get(name) {
            None | Some(Value::String(_)) => {}
            other => self
                .issues
                .push(expected(&self.path(name), "string", other)),
        }
    }

    fn uuid(&mut self, name: &str) {
        match self.map.get(name) {
            Some(Value::String(text)) if valid_draft_uuid(text) => {}
            Some(Value::String(_)) => self
                .issues
                .push(format!("{}: Invalid UUID", self.path(name))),
            other => self
                .issues
                .push(expected(&self.path(name), "string", other)),
        }
    }

    /// `z.number().int().positive()`; inexact literals were forwarded before this runs.
    fn positive(&mut self, name: &str) {
        match self.map.get(name) {
            Some(value @ Value::Number(_)) => {
                if safe_integer(value).is_some_and(|n| n <= 0) {
                    self.issues.push(format!(
                        "{}: Too small: expected number to be >0",
                        self.path(name)
                    ));
                }
            }
            other => self
                .issues
                .push(expected(&self.path(name), "number", other)),
        }
    }

    fn workspace(&mut self) {
        let value = self.map.get("workspace");
        let Some(Value::Object(workspace)) = value else {
            self.issues.push(expected("workspace", "object", value));
            return;
        };
        let mut inner = Fields {
            map: workspace,
            prefix: "workspace.",
            issues: Vec::new(),
        };
        match workspace.get("mode").and_then(Value::as_str) {
            Some("new") => inner.text("base", None),
            Some("current") => inner.text("path", None),
            _ => inner.issues.push(
                "workspace.mode: Invalid discriminator value. Expected 'new' | 'current'".into(),
            ),
        }
        self.issues.append(&mut inner.issues);
    }

    fn attachments(&mut self) {
        let value = self.map.get("attachments");
        let Some(Value::Array(list)) = value else {
            self.issues.push(expected("attachments", "array", value));
            return;
        };
        for (index, item) in list.iter().enumerate() {
            match item {
                Value::String(text) if valid_draft_uuid(text) => {}
                Value::String(_) => self
                    .issues
                    .push(format!("attachments.{index}: Invalid UUID")),
                other => self.issues.push(expected(
                    &format!("attachments.{index}"),
                    "string",
                    Some(other),
                )),
            }
        }
    }

    fn target(&mut self) {
        let valid = self
            .map
            .get("target")
            .and_then(Value::as_str)
            .is_some_and(|target| ["app", "orca", "here", "terminal", "tmux"].contains(&target));
        if !valid {
            self.issues.push(
                r#"target: Invalid option: expected one of "app"|"orca"|"here"|"terminal"|"tmux""#
                    .into(),
            );
        }
    }

    /// `.strict()` reports unknown keys after the fields.
    fn unknown_key(&mut self, known: &[&str]) {
        if let Some(key) = self.map.keys().find(|key| !known.contains(&key.as_str())) {
            self.issues
                .push(format!("params: Unrecognized key: \"{key}\""));
        }
    }
}

fn validate(op: &str, params: &Value) -> Result<(), CoreError> {
    let empty = Map::new();
    let map = match params {
        Value::Null => &empty,
        Value::Object(map) => map,
        other => {
            return Err(CoreError::new(
                Code::InvalidInput,
                expected("params", "object", Some(other)),
            ));
        }
    };
    let mut f = Fields {
        map,
        prefix: "",
        issues: Vec::new(),
    };
    match op {
        "session.create" => {
            f.id("request_id");
            f.uuid("draftId");
            f.text("request", Some(MAX_SESSION_REQUEST));
            f.text("repo", None);
            f.text("executor", Some(MAX_EXECUTOR_LEN));
            f.workspace();
            f.attachments();
        }
        "session.resume" | "session.end" => {
            f.id("id");
            f.positive("expect_rev");
        }
        "session.prepare" => {
            f.text("repo", None);
            f.optional_string("executor");
        }
        "session.file.read" => {
            f.id("id");
            f.positive("attempt");
            f.text("reference", Some(4096));
        }
        "session.attachment.prepare" => {
            f.id("id");
            f.uuid("attachmentId");
        }
        "session.agent.create" => {
            f.id("task_id");
            f.id("request_id");
            f.text("executor", Some(MAX_EXECUTOR_LEN));
            f.text("request", Some(MAX_SESSION_REQUEST));
        }
        "session.agent.list" => f.optional_id("task_id"),
        "session.agent.get" => {
            f.id("task_id");
            f.uuid("id");
        }
        "session.agent.end" | "session.agent.retry" | "session.agent.resume" => {
            f.id("task_id");
            f.uuid("id");
            f.positive("expect_rev");
        }
        "task.attach" => {
            f.id("id");
            f.target();
        }
        "task.session" | "task.takeover" | "task.hand_back" => f.id("id"),
        _ => {}
    }
    if let Some(known) = strict(op) {
        f.unknown_key(known);
    }
    if f.issues.is_empty() {
        Ok(())
    } else {
        Err(CoreError::new(Code::InvalidInput, f.issues.join("; ")))
    }
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `readTask`. `None` leaves a store Rust cannot read to Core, which reports its own failure.
fn read_task(ctx: &Ctx, id: &str) -> Option<Option<Value>> {
    if !is_task_id(id) {
        return Some(None);
    }
    let mut store = TaskStore::open(&ctx.pacer_home).ok()?;
    store.read(id).ok()
}

fn conversation(task: Option<Value>, id: &str) -> Result<Value, CoreError> {
    let task =
        task.ok_or_else(|| CoreError::new(Code::UnknownTask, format!("unknown task {id}")))?;
    if task.get("interactionMode").and_then(Value::as_str) != Some("conversation") {
        return Err(CoreError::new(
            Code::NotAllowed,
            "This task is not an interactive conversation",
        ));
    }
    Ok(task)
}

/// The refusals the handlers make from the task record before any effect.
fn check_record(ctx: &Ctx, op: &str, params: &Value) -> Result<(), CoreError> {
    if !matches!(
        op,
        "session.end" | "session.attachment.prepare" | "session.file.read"
    ) {
        return Ok(());
    }
    let id = params.get("id").and_then(Value::as_str).unwrap_or_default();
    let Some(task) = read_task(ctx, id) else {
        return Ok(());
    };
    match op {
        "session.end" => {
            let task = conversation(task, id)?;
            if task.get("rev").and_then(Value::as_f64)
                != params.get("expect_rev").and_then(Value::as_f64)
            {
                return Err(CoreError::new(
                    Code::Conflict,
                    "Session changed; refresh and try again",
                ));
            }
        }
        "session.attachment.prepare" => {
            let task = conversation(task, id)?;
            if !js_truthy(task.get("sessionDraftId"))
                || task.get("state").and_then(Value::as_str) != Some("running")
            {
                return Err(CoreError::new(Code::Conflict, "Session is not running"));
            }
        }
        _ => {
            let task =
                task.ok_or_else(|| CoreError::new(Code::UnknownTask, "Session not found"))?;
            let run = task.get("run").filter(|run| js_truthy(Some(run)));
            let attempt = run
                .and_then(|run| run.get("attempt"))
                .and_then(Value::as_f64);
            if run.is_none() || attempt != params.get("attempt").and_then(Value::as_f64) {
                return Err(CoreError::new(
                    Code::Conflict,
                    "This session attempt has changed; refresh it",
                ));
            }
            if js_truthy(run.and_then(|run| run.get("host")))
                || task.get("backend").and_then(Value::as_str) == Some("orca")
            {
                return Err(CoreError::new(
                    Code::NotAllowed,
                    "This session's files are not available here",
                ));
            }
        }
    }
    Ok(())
}

/// Refuses or answers `op`; [`Admission::Core`] leaves the operation to Core.
pub fn admit(ctx: &Ctx, op: &str, params: &Value) -> Result<Admission, CoreError> {
    authorize(ctx)?;
    validate(op, params)?;
    if op == "session.draft.create" {
        // A store Rust cannot open or write stays with Core; no draft exists yet.
        let created = TaskStore::open(&ctx.pacer_home)
            .ok()
            .and_then(|mut store| attachments::create_draft(&mut store, ctx.now).ok());
        return Ok(created.map_or(Admission::Core, |id| Admission::Native(json!({ "id": id }))));
    }
    check_record(ctx, op, params)?;
    Ok(Admission::Core)
}

/// The private bridge request, with the caller's raw client headers for Core to validate.
pub fn bridge_request(
    op: &str,
    params: Value,
    client: Option<&str>,
    client_instance: Option<&str>,
) -> Value {
    json!({ "op": op, "params": params, "client": client, "clientInstance": client_instance })
}

#[cfg(test)]
mod tests;
