//! Caller-scoped message reads from `src/api/ops-msg.ts` over the shared task database.
#![allow(clippy::result_large_err)] // NativeOp and CoreError use this public API by value.
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_store::{StoreError, TaskStore, is_task_id, messages};
use serde_json::{Map, Value, json};
use std::path::Path;

/// How the HTTP front door authenticated the request: `app` (cookie) or `session`
/// (bearer plus a valid `X-Pacer-Session`). Transports strip any inherited value.
pub(crate) const CALLER_AUTH_ENV: &str = "PACER_INTERNAL_MSG_CALLER_AUTH";

/// `appAuthenticated` (cookie) and the TUI's `participant: "human"` session for HTTP requests.
pub(crate) fn with_http_caller(mut ctx: Ctx, cookie: bool, human_session: bool) -> Ctx {
    ctx.env.remove(CALLER_AUTH_ENV);
    if cookie {
        ctx.env.insert(CALLER_AUTH_ENV.into(), "app".into());
    } else if human_session {
        ctx.env.insert(CALLER_AUTH_ENV.into(), "session".into());
    }
    ctx
}

pub(crate) fn is_msg_read_op(name: &str) -> bool {
    matches!(name, "msg.inbox" | "msg.log" | "msg.read")
}

/// TypeScript keeps work-grant and enforcement identities, Orca worktree detection
/// (strategy providers) and the human's read receipts (task/attention publication).
pub(crate) fn msg_stays_forwarded(name: &str, ctx: &Ctx) -> bool {
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

fn current_dir() -> Option<String> {
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
fn own_worktree(ctx: &Ctx, cwd: &str) -> bool {
    let own = format!(
        "{}/",
        Path::new(&ctx.pacer_home).join("worktrees").display()
    );
    cwd.strip_prefix(&own)
        .and_then(|rest| rest.split('/').nth(1))
        .is_some_and(is_task_id)
}

/// `/orca/workspaces/<ws>/pacer-<taskId>-<provider>`; TypeScript confirms the provider.
fn orca_worktree(cwd: &str) -> bool {
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
        let Some(value) = self.map.get(key) else {
            self.issues.push(format!(
                "{key}: Invalid input: expected string, received undefined"
            ));
            return None;
        };
        let text = self.string(key, value, None)?;
        if !is_task_id(text) {
            self.issues.push(format!(
                "{key}: Invalid string: must match pattern /^t-\\d{{8}}-\\d{{6}}-[0-9a-f]{{4}}$/"
            ));
            return None;
        }
        Some(text)
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
        let unknown: Vec<String> = self
            .map
            .keys()
            .filter(|key| !known.contains(&key.as_str()))
            .map(|key| format!("\"{key}\""))
            .collect();
        match unknown.len() {
            0 => {}
            1 => self
                .issues
                .push(format!("params: Unrecognized key: {}", unknown[0])),
            _ => self
                .issues
                .push(format!("params: Unrecognized keys: {}", unknown.join(", "))),
        }
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

pub(super) fn msg_inbox(ctx: &Ctx, params: Value) -> OpFuture<'_> {
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

pub(super) fn msg_log(ctx: &Ctx, params: Value) -> OpFuture<'_> {
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

pub(super) fn msg_read(ctx: &Ctx, params: Value) -> OpFuture<'_> {
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::collections::HashMap;

    fn ctx(env: &[(&str, &str)]) -> Ctx {
        Ctx::with(
            "/home/u".into(),
            "/home/u/.pacer".into(),
            env.iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect::<HashMap<_, _>>(),
            1.0,
        )
    }

    fn id(env: &[(&str, &str)], cwd: &str) -> Caller {
        caller(&ctx(env), Some(cwd)).unwrap()
    }

    #[test]
    fn caller_follows_typescript_precedence() {
        let local = Caller::Id("external:local".into());
        let human = Caller::Id("human".into());
        assert_eq!(id(&[], "/tmp"), local);
        assert_eq!(
            id(&[("PACER_WORK_GRANT", "pwg_x")], "/tmp"),
            Caller::Forward
        );
        assert_eq!(
            id(&[("PACER_ENFORCEMENT_TOKEN", "pet_x")], "/tmp"),
            Caller::Forward
        );
        assert_eq!(
            id(
                &[("PACER_ROLE", "executor"), ("PACER_TASK_ID", "t-1")],
                "/tmp"
            ),
            Caller::Id("task:t-1".into())
        );
        let error = caller(&ctx(&[("PACER_ROLE", "executor")]), Some("/tmp")).unwrap_err();
        assert_eq!(error.code, Code::NotAllowed);
        assert_eq!(error.message, "Executor identity is unknown");
        assert_eq!(error.data.unwrap()["layer"], "identity");
        assert_eq!(id(&[(CALLER_AUTH_ENV, "app")], "/tmp"), human);
        assert_eq!(
            id(&[(CALLER_AUTH_ENV, "app"), ("CLAUDECODE", "1")], "/tmp"),
            human
        );
        assert_eq!(
            id(&[(CALLER_AUTH_ENV, "session"), ("CLAUDECODE", "1")], "/tmp"),
            Caller::Id("external:claude-code".into())
        );
        assert_eq!(id(&[(CALLER_AUTH_ENV, "session")], "/tmp"), human);
        assert_eq!(
            id(
                &[
                    (CALLER_AUTH_ENV, "app"),
                    ("PACER_ROLE", "executor"),
                    ("PACER_TASK_ID", "t")
                ],
                "/tmp"
            ),
            Caller::Id("task:t".into())
        );
    }

    #[test]
    fn executor_and_orca_worktrees_follow_cwd_rules() {
        let task = "t-20260101-000000-abcd";
        assert_eq!(
            id(
                &[("PACER_TASK_ID", task)],
                &format!("/home/u/.pacer/worktrees/repo/{task}/src")
            ),
            Caller::Id(format!("task:{task}"))
        );
        assert_eq!(
            id(&[], &format!("/home/u/.pacer/worktrees/{task}")),
            Caller::Id("external:local".into())
        );
        assert_eq!(
            id(&[], &format!("/x/orca/workspaces/ws/pacer-{task}-codex/a")),
            Caller::Forward
        );
        assert_eq!(
            id(&[], &format!("/x/orca/workspaces/ws/pacer-{task}-")),
            Caller::Id("external:local".into())
        );
        assert_eq!(
            id(&[], "/x/orca/workspaces/pacer/pinfish"),
            Caller::Id("external:local".into())
        );
    }

    #[test]
    fn planner_identity_matches_typescript_cleaning() {
        let planner = |env: &[(&str, &str)]| planner_participant(&ctx(env));
        assert_eq!(
            planner(&[("PACER_PLANNER_SESSION", "codex:a b/😀")]),
            Some("external:codex:a-b---".into())
        );
        assert_eq!(
            planner(&[("PACER_PLANNER_SESSION", "claude-code:")]),
            Some("external:claude-code".into())
        );
        assert_eq!(
            planner(&[("PACER_PLANNER_SESSION", "codex:a\nb")]),
            Some("external:codex:a-b".into())
        );
        assert_eq!(
            planner(&[("PACER_PLANNER_SESSION", "x y")]),
            Some("external:x-y".into())
        );
        let long = "a".repeat(200);
        assert_eq!(
            planner(&[("PACER_PLANNER_SESSION", &format!("codex:{long}"))]),
            Some(format!("external:codex:{}", &long[..96]))
        );
        assert_eq!(
            planner(&[("CLAUDECODE", "1")]),
            Some("external:claude-code".into())
        );
        assert_eq!(
            planner(&[("CODEX_SANDBOX", "seatbelt")]),
            Some("external:codex".into())
        );
        assert_eq!(
            planner(&[("CODEX_THREAD_ID", "abc")]),
            Some("external:codex:abc".into())
        );
        assert_eq!(planner(&[("CODEX_HOME", "/x")]), None);
    }

    #[test]
    fn params_match_zod_issue_order() {
        let issues =
            |op: fn(&Value) -> Result<(), CoreError>, v: Value| op(&v).unwrap_err().message;
        fn inbox(v: &Value) -> Result<(), CoreError> {
            let mut p = Params::new(v)?;
            p.optional_bool("unread_only");
            p.optional_limit("limit");
            p.finish(&["unread_only", "limit"])
        }
        fn read(v: &Value) -> Result<(), CoreError> {
            let mut p = Params::new(v)?;
            p.ids("ids");
            p.finish(&["ids"])
        }
        assert!(inbox(&Value::Null).is_ok());
        assert_eq!(
            issues(inbox, json!({"limit": -0.5, "unread_only": 1})),
            "unread_only: Invalid input: expected boolean, received number; limit: Invalid input: expected int, received number"
        );
        assert_eq!(
            issues(inbox, json!({"limit": 1e300})),
            "limit: Too big: expected int to be <=9007199254740991; limit: Too big: expected number to be <=1000"
        );
        assert_eq!(
            issues(inbox, json!({"bogus": 1, "other": 2, "limit": 0})),
            "limit: Too small: expected number to be >=1; params: Unrecognized keys: \"bogus\", \"other\""
        );
        assert_eq!(
            issues(inbox, json!([])),
            "params: Invalid input: expected object, received array"
        );
        assert_eq!(
            issues(read, json!({"ids": [1, "x".repeat(65)]})),
            "ids.0: Invalid input: expected string, received number; ids.1: Too big: expected string to have <=64 characters"
        );
        assert_eq!(
            issues(read, json!({"ids": [], "z": 1})),
            "ids: Too small: expected array to have >=1 items; params: Unrecognized key: \"z\""
        );
        assert!(read(&json!({"ids": ["😀".repeat(64)]})).is_ok());
    }

    #[test]
    fn human_receipts_and_grants_stay_forwarded() {
        assert!(msg_stays_forwarded(
            "msg.read",
            &ctx(&[(CALLER_AUTH_ENV, "app")])
        ));
        assert!(!msg_stays_forwarded(
            "msg.inbox",
            &ctx(&[(CALLER_AUTH_ENV, "app")])
        ));
        assert!(msg_stays_forwarded(
            "msg.log",
            &ctx(&[("PACER_WORK_GRANT", "pwg_x")])
        ));
        assert!(!msg_stays_forwarded(
            "msg.send",
            &ctx(&[(CALLER_AUTH_ENV, "app")])
        ));
    }
}
