//! Caller-scoped message reads and the `msg.policy` guardrail from `src/api/ops-msg.ts`.
#![allow(clippy::result_large_err)] // NativeOp and CoreError use this public API by value.
use crate::policy;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_store::{StoreError, TaskStore, is_task_id, messages};
use serde_json::{Map, Value, json};
use std::path::Path;

const MSG_KINDS: [&str; 6] = ["message", "question", "answer", "report", "nudge", "close"];
const TASK_ID: &str = r"/^t-\d{8}-\d{6}-[0-9a-f]{4}$/";
const PARTICIPANT: &str =
    r"/^(human|broker|external:[A-Za-z0-9._:-]{1,128}|task:t-\d{8}-\d{6}-[0-9a-f]{4})$/";

/// `participantSchema` in `src/messaging/types.ts`.
fn participant_id(p: &str) -> bool {
    matches!(p, "human" | "broker")
        || p.strip_prefix("task:").is_some_and(is_task_id)
        || p.strip_prefix("external:").is_some_and(|id| {
            (1..=128).contains(&id.len())
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        })
}

/// How the HTTP front door authenticated the request: `app` (cookie) or `session`
/// (bearer plus a valid `X-Pacer-Session`). Transports strip any inherited value.
pub const CALLER_AUTH_ENV: &str = "PACER_INTERNAL_MSG_CALLER_AUTH";

/// `appAuthenticated` (cookie) and the TUI's `participant: "human"` session for HTTP requests.
pub fn with_http_caller(mut ctx: Ctx, cookie: bool, human_session: bool) -> Ctx {
    ctx.env.remove(CALLER_AUTH_ENV);
    if cookie {
        ctx.env.insert(CALLER_AUTH_ENV.into(), "app".into());
    } else if human_session {
        ctx.env.insert(CALLER_AUTH_ENV.into(), "session".into());
    }
    ctx
}

pub fn is_msg_read_op(name: &str) -> bool {
    matches!(name, "msg.inbox" | "msg.log" | "msg.read")
}

/// TypeScript keeps work-grant and enforcement identities, Orca worktree detection
/// (strategy providers) and the human's read receipts (task/attention publication).
/// `msg.policy` also stays forwarded when `project-messaging.json` is unusable, because
/// its `projectError` carries Node and Zod details only the TypeScript reader produces.
pub fn msg_stays_forwarded(name: &str, ctx: &Ctx) -> bool {
    if name == "msg.policy" {
        return env(ctx, "PACER_WORK_GRANT").is_some()
            || env(ctx, "PACER_ENFORCEMENT_TOKEN").is_some()
            || pacer_config::project_messaging::read_projects(&ctx.pacer_home).is_err();
    }
    if !is_msg_read_op(name) {
        return false;
    }
    match caller(ctx, current_dir().as_deref()) {
        Ok(Caller::Forward) => true,
        Ok(Caller::Id(id)) => name == "msg.read" && id == "human",
        Err(_) => false,
    }
}

#[derive(Debug, PartialEq)]
enum Caller {
    Id(String),
    Forward,
}

pub fn current_dir() -> Option<String> {
    std::env::current_dir()
        .ok()
        .and_then(|p| p.to_str().map(str::to_owned))
}

fn env<'a>(ctx: &'a Ctx, name: &str) -> Option<&'a str> {
    ctx.env
        .get(name)
        .map(String::as_str)
        .filter(|v| !v.is_empty())
}

/// `callerParticipant` without a work grant (those requests stay forwarded).
fn caller(ctx: &Ctx, cwd: Option<&str>) -> Result<Caller, CoreError> {
    if env(ctx, "PACER_WORK_GRANT").is_some() || env(ctx, "PACER_ENFORCEMENT_TOKEN").is_some() {
        return Ok(Caller::Forward);
    }
    let role_executor = ctx.env.get("PACER_ROLE").map(String::as_str) == Some("executor");
    let executor = role_executor || cwd.is_some_and(|cwd| own_worktree(ctx, cwd));
    if !executor && cwd.is_some_and(orca_worktree) {
        return Ok(Caller::Forward);
    }
    if executor {
        return match env(ctx, "PACER_TASK_ID") {
            Some(id) => Ok(Caller::Id(format!("task:{id}"))),
            None => Err(forbidden("Executor identity is unknown", "identity")),
        };
    }
    let auth = ctx.env.get(CALLER_AUTH_ENV).map(String::as_str);
    if auth == Some("app") {
        return Ok(Caller::Id("human".into()));
    }
    if let Some(planner) = planner_participant(ctx) {
        return Ok(Caller::Id(planner));
    }
    if auth == Some("session") {
        return Ok(Caller::Id("human".into()));
    }
    Ok(Caller::Id("external:local".into()))
}

fn forbidden(message: &str, layer: &str) -> CoreError {
    let mut data = Map::new();
    data.insert("reason".into(), json!("msg_forbidden"));
    data.insert("layer".into(), json!(layer));
    CoreError::new(Code::NotAllowed, message).data(data)
}

/// `<pacerHome>/worktrees/<repo>/<taskId>` from `isExecutorSession`.
pub fn own_worktree(ctx: &Ctx, cwd: &str) -> bool {
    let own = format!(
        "{}/",
        Path::new(&ctx.pacer_home).join("worktrees").display()
    );
    cwd.strip_prefix(&own)
        .and_then(|rest| rest.split('/').nth(1))
        .is_some_and(is_task_id)
}

/// `/orca/workspaces/<ws>/pacer-<taskId>-<provider>`; TypeScript confirms the provider.
pub fn orca_worktree(cwd: &str) -> bool {
    const MARK: &str = "/orca/workspaces/";
    cwd.match_indices(MARK).any(|(at, _)| {
        let rest = &cwd[at + MARK.len()..];
        let Some((workspace, rest)) = rest.split_once('/') else {
            return false;
        };
        let Some(rest) = rest.strip_prefix("pacer-") else {
            return false;
        };
        !workspace.is_empty()
            && rest.get(..22).is_some_and(is_task_id)
            && rest
                .get(22..)
                .and_then(|r| r.strip_prefix('-'))
                .is_some_and(|provider| !provider.is_empty() && !provider.starts_with('/'))
    })
}

/// `String.replace(/[^allowed]/g, "-")` over UTF-16 code units.
fn clean(value: &str, extra: &[char]) -> String {
    let mut out = String::new();
    for c in value.chars() {
        if c.is_ascii_alphanumeric() || extra.contains(&c) {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('-', c.len_utf16()));
        }
    }
    out
}

fn planner_session_id(kind: &str, session: Option<&str>) -> String {
    let clean: String = session
        .map(|s| clean(s, &['.', '_', '-']).chars().take(96).collect())
        .unwrap_or_default();
    if clean.is_empty() {
        format!("external:{kind}")
    } else {
        format!("external:{kind}:{clean}")
    }
}

/// `plannerParticipant`: the planner session this process runs in, from its environment.
fn planner_participant(ctx: &Ctx) -> Option<String> {
    if let Some(value) = env(ctx, "PACER_PLANNER_SESSION") {
        // `(.*)$` stops at ECMAScript line terminators.
        let line = |s: &str| !s.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
        for kind in ["claude-code", "codex"] {
            if let Some(rest) = value
                .strip_prefix(kind)
                .and_then(|r| r.strip_prefix(':'))
                .filter(|r| line(r))
            {
                return Some(planner_session_id(kind, Some(rest)));
            }
        }
        let clean: String = clean(value, &['.', '_', ':', '-'])
            .chars()
            .take(128)
            .collect();
        if !clean.is_empty() {
            return Some(format!("external:{clean}"));
        }
    }
    if ctx.env.get("CLAUDECODE").map(String::as_str) == Some("1") {
        return Some("external:claude-code".into());
    }
    if env(ctx, "CODEX_THREAD_ID").is_some() || env(ctx, "CODEX_SANDBOX").is_some() {
        return Some(planner_session_id(
            "codex",
            ctx.env.get("CODEX_THREAD_ID").map(String::as_str),
        ));
    }
    None
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Zod issue collection for one strict object schema, in schema field order.
struct Params<'a> {
    map: &'a Map<String, Value>,
    issues: Vec<String>,
}

impl<'a> Params<'a> {
    fn new(params: &'a Value) -> Result<Self, CoreError> {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        let map = match params {
            Value::Null => EMPTY.get_or_init(Map::new),
            Value::Object(map) => map,
            other => {
                return Err(CoreError::new(
                    Code::InvalidInput,
                    format!(
                        "params: Invalid input: expected object, received {}",
                        kind(other)
                    ),
                ));
            }
        };
        Ok(Self {
            map,
            issues: Vec::new(),
        })
    }

    fn mismatch(&mut self, path: &str, expected: &str, value: &Value) {
        self.issues.push(format!(
            "{path}: Invalid input: expected {expected}, received {}",
            kind(value)
        ));
    }

    fn string(&mut self, path: &str, value: &'a Value, max: Option<usize>) -> Option<&'a str> {
        let Some(text) = value.as_str() else {
            self.mismatch(path, "string", value);
            return None;
        };
        if let Some(max) = max
            && text.chars().count() > max
        {
            self.issues.push(format!(
                "{path}: Too big: expected string to have <={max} characters"
            ));
            return None;
        }
        Some(text)
    }

    fn task_id(&mut self, key: &str) -> Option<&'a str> {
        self.pattern(key, self.map.get(key), is_task_id, TASK_ID)
    }

    /// A required `z.string().regex(..)` at `path`.
    fn pattern(
        &mut self,
        path: &str,
        value: Option<&'a Value>,
        ok: fn(&str) -> bool,
        pattern: &str,
    ) -> Option<&'a str> {
        let Some(value) = value else {
            self.issues.push(format!(
                "{path}: Invalid input: expected string, received undefined"
            ));
            return None;
        };
        let text = self.string(path, value, None)?;
        if !ok(text) {
            self.issues.push(format!(
                "{path}: Invalid string: must match pattern {pattern}"
            ));
            return None;
        }
        Some(text)
    }

    /// The `msg.policy` `check` object.
    fn send(&mut self, value: &'a Value) -> Option<policy::Send<'a>> {
        let Some(map) = value.as_object() else {
            self.mismatch("check", "object", value);
            return None;
        };
        let from = self.pattern("check.from", map.get("from"), participant_id, PARTICIPANT);
        let to = self.pattern("check.to", map.get("to"), participant_id, PARTICIPANT);
        let kind = map
            .get("kind")
            .and_then(Value::as_str)
            .filter(|k| MSG_KINDS.contains(k));
        if kind.is_none() {
            let options: Vec<String> = MSG_KINDS.iter().map(|k| format!("\"{k}\"")).collect();
            self.issues.push(format!(
                "check.kind: Invalid option: expected one of {}",
                options.join("|")
            ));
        }
        let grant = match map.get("grant") {
            Some(value) => {
                let flag = value.as_bool();
                if flag.is_none() {
                    self.mismatch("check.grant", "boolean", value);
                }
                flag
            }
            None => Some(false),
        };
        self.unrecognized("check", map, &["from", "to", "kind", "grant"]);
        Some(policy::Send {
            from: from?,
            to: to?,
            kind: kind?,
            grant: grant?,
        })
    }

    fn unrecognized(&mut self, path: &str, map: &Map<String, Value>, known: &[&str]) {
        let unknown: Vec<String> = map
            .keys()
            .filter(|key| !known.contains(&key.as_str()))
            .map(|key| format!("\"{key}\""))
            .collect();
        match unknown.len() {
            0 => {}
            1 => self
                .issues
                .push(format!("{path}: Unrecognized key: {}", unknown[0])),
            _ => self
                .issues
                .push(format!("{path}: Unrecognized keys: {}", unknown.join(", "))),
        }
    }

    fn optional_string(&mut self, key: &str, max: usize) -> Option<&'a str> {
        let value = self.map.get(key)?;
        self.string(key, value, Some(max))
    }

    fn optional_bool(&mut self, key: &str) -> Option<bool> {
        let value = self.map.get(key)?;
        let flag = value.as_bool();
        if flag.is_none() {
            self.mismatch(key, "boolean", value);
        }
        flag
    }

    /// `z.number().int().min(1).max(1000)`.
    fn optional_limit(&mut self, key: &str) -> Option<u32> {
        let value = self.map.get(key)?;
        let Some(n) = value.as_f64().filter(|_| value.is_number()) else {
            self.mismatch(key, "number", value);
            return None;
        };
        if n.fract() != 0.0 {
            self.issues.push(format!(
                "{key}: Invalid input: expected int, received number"
            ));
            return None;
        }
        let before = self.issues.len();
        if n < -9_007_199_254_740_991.0 {
            self.issues.push(format!(
                "{key}: Too small: expected int to be >=-9007199254740991"
            ));
        } else if n > 9_007_199_254_740_991.0 {
            self.issues.push(format!(
                "{key}: Too big: expected int to be <=9007199254740991"
            ));
        }
        if n < 1.0 {
            self.issues
                .push(format!("{key}: Too small: expected number to be >=1"));
        } else if n > 1000.0 {
            self.issues
                .push(format!("{key}: Too big: expected number to be <=1000"));
        }
        (self.issues.len() == before).then_some(n as u32)
    }

    /// `z.array(z.string().max(64)).min(1).max(500)`.
    fn ids(&mut self, key: &str) -> Option<Vec<&'a str>> {
        let Some(value) = self.map.get(key) else {
            self.issues.push(format!(
                "{key}: Invalid input: expected array, received undefined"
            ));
            return None;
        };
        let Some(items) = value.as_array() else {
            self.mismatch(key, "array", value);
            return None;
        };
        let before = self.issues.len();
        let ids: Vec<&str> = items
            .iter()
            .enumerate()
            .filter_map(|(i, item)| self.string(&format!("{key}.{i}"), item, Some(64)))
            .collect();
        if items.is_empty() {
            self.issues.push(format!(
                "{key}: Too small: expected array to have >=1 items"
            ));
        } else if items.len() > 500 {
            self.issues.push(format!(
                "{key}: Too big: expected array to have <=500 items"
            ));
        }
        (self.issues.len() == before).then_some(ids)
    }

    fn finish(mut self, known: &[&str]) -> Result<(), CoreError> {
        self.unrecognized("params", self.map, known);
        if self.issues.is_empty() {
            Ok(())
        } else {
            Err(CoreError::new(Code::InvalidInput, self.issues.join("; ")))
        }
    }
}

fn store_error(error: StoreError) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

fn open(ctx: &Ctx) -> Result<TaskStore, CoreError> {
    TaskStore::open(&ctx.pacer_home).map_err(store_error)
}

fn participant(ctx: &Ctx) -> Result<String, CoreError> {
    match caller(ctx, current_dir().as_deref())? {
        Caller::Id(id) => Ok(id),
        Caller::Forward => Err(CoreError::new(
            Code::Unavailable,
            "message caller requires the TypeScript core",
        )),
    }
}

pub fn msg_inbox(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let mut p = Params::new(&params)?;
        let unread_only = p.optional_bool("unread_only");
        let limit = p.optional_limit("limit");
        p.finish(&["unread_only", "limit"])?;
        let me = participant(ctx)?;
        let mut store = open(ctx)?;
        let messages = messages::inbox(&mut store, &me, unread_only.unwrap_or(true), limit)
            .map_err(store_error)?;
        Ok(json!({"participant": me, "messages": messages}))
    })
}

pub fn msg_log(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let mut p = Params::new(&params)?;
        let task = p.task_id("task");
        let after = p.optional_string("after", 64);
        let limit = p.optional_limit("limit");
        p.finish(&["task", "after", "limit"])?;
        let task = task.unwrap_or_default();
        let me = participant(ctx)?;
        let mut store = open(ctx)?;
        if messages::task_of(&me).is_some() {
            let mine = messages::root_of(&mut store, &me).map_err(store_error)?;
            let theirs =
                messages::root_of(&mut store, &format!("task:{task}")).map_err(store_error)?;
            if mine != theirs {
                return Err(forbidden("That task is outside your tree", "protocol"));
            }
        }
        let messages = messages::thread(&mut store, task, after, limit).map_err(store_error)?;
        Ok(json!({"messages": messages}))
    })
}

pub fn msg_read(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let mut p = Params::new(&params)?;
        let ids = p.ids("ids");
        p.finish(&["ids"])?;
        let ids = ids.unwrap_or_default();
        let me = participant(ctx)?;
        if me == "human" {
            return Err(CoreError::new(
                Code::Unavailable,
                "human read receipts require the TypeScript core",
            ));
        }
        let mut store = open(ctx)?;
        // TypeScript stamps receipts with `Date.now() / 1000`.
        let at = (ctx.now * 1000.0).floor() / 1000.0;
        let read = messages::mark_read(&mut store, &me, &ids, at).map_err(store_error)?;
        Ok(json!({"read": read}))
    })
}

/// `msg.policy` reads no caller identity: the guardrail and a hypothetical send are public.
pub fn msg_policy(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let mut p = Params::new(&params)?;
        let task = p
            .map
            .get("task")
            .and_then(|v| p.pattern("task", Some(v), is_task_id, TASK_ID));
        let send = p.map.get("check").and_then(|v| p.send(v));
        p.finish(&["task", "check"])?;
        let mut store = policy::Store::new(&ctx.pacer_home);
        let anchor = match (task, &send) {
            (Some(task), _) => Some(format!("task:{task}")),
            (None, Some(s)) if messages::task_of(s.to).is_some() => Some(s.to.to_owned()),
            (None, Some(s)) => Some(s.from.to_owned()),
            (None, None) => None,
        };
        let root = anchor
            .map(|a| policy::root(&mut store, &a))
            .transpose()
            .map_err(store_error)?;
        let mut out = policy::effective(&mut store, root.as_deref()).map_err(store_error)?;
        if let Some(send) = send {
            out["check"] = policy::check(&mut store, ctx.now, &send).map_err(store_error)?;
        }
        Ok(out)
    })
}

#[cfg(test)]
mod tests;
