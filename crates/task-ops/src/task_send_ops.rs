//! Selective native `task.send` (`send` in `src/session/send.ts`). Rust refuses enforcement
//! identities as `authorizeWorkOperation` does, validates the params as Zod does and answers the
//! refusals made before the task record is read: an executor caller, a malformed id and the text
//! check. Under the shared task lock it answers the record refusals: an unknown task, a stale
//! revision, a lane waiting on its question and a task that is not running. Core keeps what needs
//! its plugins and decides under the same lock: the live-worker check, the driving lease, delivery
//! into the worker, the lease rollback and the timeline entry.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    js_semantics::JsTrim,
};
use pacer_lifecycle::files_search::executor_session;
use pacer_store::{StoreError, TaskStore, is_task_id};
use serde_json::{Map, Value, json};

use super::files_search_ops::providers;
use super::lifecycle_ops::{invalid, object, project_api_task, type_name};
use super::session_context_ops::authorize;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Core's side of `task.send`: `{"kind":"send","id","text","force","expectRev","by"}` runs
/// TypeScript `send`, which rechecks every refusal under the task lock, and returns its record.
pub trait Bridge: Send {
    fn call(&mut self, request: Value) -> OpFuture<'_>;
}

pub fn needs_task_send_bridge(op: &str) -> bool {
    op == "task.send"
}

/// The registry entry; the front doors call [`task_send`] with their Core bridge instead.
pub fn task_send_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async {
        Err(CoreError::new(
            Code::Unavailable,
            "task send bridge unavailable",
        ))
    })
}

struct SendParams {
    id: String,
    text: String,
    force: bool,
    expect_rev: Option<f64>,
}

/// Zod `z.string().min(1).max(max)`, which counts code points.
fn string_field(
    params: &Map<String, Value>,
    name: &str,
    max: usize,
    issues: &mut Vec<String>,
) -> String {
    match params.get(name) {
        Some(Value::String(s)) => {
            let n = s.chars().count();
            if n < 1 {
                issues.push(format!(
                    "{name}: Too small: expected string to have >=1 characters"
                ));
            } else if n > max {
                issues.push(format!(
                    "{name}: Too big: expected string to have <={max} characters"
                ));
            }
            s.clone()
        }
        Some(other) => {
            issues.push(format!(
                "{name}: Invalid input: expected string, received {}",
                type_name(other)
            ));
            String::new()
        }
        None => {
            issues.push(format!(
                "{name}: Invalid input: expected string, received undefined"
            ));
            String::new()
        }
    }
}

/// Zod `z.number().int().positive().optional()`.
fn expect_rev(params: &Map<String, Value>, issues: &mut Vec<String>) -> Option<f64> {
    let value = params.get("expect_rev")?;
    let Some(n) = value.as_f64() else {
        issues.push(format!(
            "expect_rev: Invalid input: expected number, received {}",
            type_name(value)
        ));
        return None;
    };
    if n.fract() != 0.0 {
        issues.push("expect_rev: Invalid input: expected int, received number".into());
    } else if n > MAX_SAFE_INTEGER {
        issues.push("expect_rev: Too big: expected int to be <=9007199254740991".into());
    } else {
        if n < -MAX_SAFE_INTEGER {
            issues.push("expect_rev: Too small: expected int to be >=-9007199254740991".into());
        }
        if n <= 0.0 {
            issues.push("expect_rev: Too small: expected number to be >0".into());
        }
    }
    Some(n)
}

fn parse(params: &Value) -> Result<SendParams, CoreError> {
    let p = object(params)?;
    let mut issues = Vec::new();
    let id = string_field(p, "id", 128, &mut issues);
    let text = string_field(p, "text", 4000, &mut issues);
    let force = match p.get("force") {
        None => false,
        Some(Value::Bool(force)) => *force,
        Some(other) => {
            issues.push(format!(
                "force: Invalid input: expected boolean, received {}",
                type_name(other)
            ));
            false
        }
    };
    let expect_rev = expect_rev(p, &mut issues);
    if !issues.is_empty() {
        return Err(invalid(issues.join("; ")));
    }
    Ok(SendParams {
        id,
        text,
        force,
        expect_rev,
    })
}

fn valid_label(label: &str) -> bool {
    let Some((kind, version)) = label.split_once('/') else {
        return false;
    };
    let mut kind_bytes = kind.bytes();
    kind_bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        && kind.len() <= 32
        && kind_bytes.all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b':' | b'-'))
        && (1..=32).contains(&version.len())
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-'))
}

fn valid_instance(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

/// `callerIdentity` over the HTTP headers `X-Pacer-Client` (`label`) and
/// `X-Pacer-Client-Instance` (`instance`), as `src/api/http.ts` validates them. A caller without
/// either, such as stdio, is the terminal it runs in.
pub fn caller_identity(ctx: &Ctx, label: Option<&str>, instance: Option<&str>) -> String {
    let label = label.unwrap_or("");
    let client = valid_label(label).then_some(label);
    if let Some(id) = instance.filter(|id| valid_instance(id)) {
        let name = client.unwrap_or(if label == "app" { "app" } else { "http" });
        return format!("client:{name}#{id}");
    }
    if let Some(client) = client {
        return format!("client:{client}");
    }
    let env = |name: &str| {
        ctx.env
            .get(name)
            .map(|value| value.js_trim())
            .filter(|value| !value.is_empty())
    };
    let user = env("USER").unwrap_or("planner");
    match env("ORCA_TERMINAL_HANDLE")
        .or_else(|| env("TMUX_PANE"))
        .or_else(|| env("TERM_SESSION_ID"))
    {
        Some(session) => format!("{user}@{session}"),
        None => user.to_owned(),
    }
}

fn unknown(id: &str) -> CoreError {
    CoreError::new(Code::UnknownTask, format!("unknown task {id}"))
}

fn internal(error: impl ToString) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

/// A refusal decided from the task record under the shared task lock.
enum Refusal {
    Core(CoreError),
    StaleRev(Value),
    Store(StoreError),
}

impl From<StoreError> for Refusal {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

/// The refusals `send` makes from the task record under its lock, in its order, up to the
/// live-worker check. Core makes the live-worker and lease checks under the same lock.
fn check_record(task: &Value, p: &SendParams) -> Result<(), Refusal> {
    if let Some(expected) = p.expect_rev
        && task.get("rev").and_then(Value::as_f64) != Some(expected)
    {
        return Err(Refusal::StaleRev(task.clone()));
    }
    let state = task.get("state").and_then(Value::as_str);
    let unanswered = task
        .get("question")
        .is_some_and(|q| !q.is_null() && q.get("answer").is_none());
    if state == Some("needs_input") || unanswered {
        return Err(Refusal::Core(CoreError::new(
            Code::Conflict,
            format!("task is waiting for an answer; use pacer answer {}", p.id),
        )));
    }
    if state != Some("running") {
        return Err(Refusal::Core(CoreError::new(
            Code::Conflict,
            format!("task is {}, not running", state.unwrap_or("undefined")),
        )));
    }
    Ok(())
}

fn stale_rev(ctx: &Ctx, store: &mut TaskStore, task: &Value) -> CoreError {
    let mut error = CoreError::new(Code::Conflict, "task changed");
    if let Ok(projected) = project_api_task(ctx, store, task) {
        let mut data = Map::new();
        data.insert("task".into(), projected);
        error = error.data(data);
    }
    error
}

/// `task.send` for the caller `by` (see [`caller_identity`]).
pub fn task_send<'a>(
    ctx: &'a Ctx,
    params: Value,
    by: String,
    bridge: &'a mut dyn Bridge,
) -> OpFuture<'a> {
    Box::pin(async move {
        authorize(ctx)?;
        let p = parse(&params)?;
        let cwd = std::env::current_dir().unwrap_or_default();
        if executor_session(ctx, &cwd, || providers(ctx)) {
            return Err(CoreError::new(
                Code::NotAllowed,
                "executors cannot use pacer send; use pacer ask",
            ));
        }
        if !is_task_id(&p.id) {
            return Err(unknown(&p.id));
        }
        if p.text.js_trim().is_empty() || p.text.encode_utf16().count() > 4000 {
            return Err(invalid("message must contain 1–4000 characters"));
        }
        {
            let mut store = TaskStore::open(&ctx.pacer_home).map_err(internal)?;
            let checked = store.with_task_lock(&p.id, |locked| check_record(&locked.read()?, &p));
            match checked {
                Ok(()) => {}
                Err(Refusal::Core(error)) => return Err(error),
                Err(Refusal::StaleRev(task)) => return Err(stale_rev(ctx, &mut store, &task)),
                Err(Refusal::Store(StoreError::UnknownTask(_))) => return Err(unknown(&p.id)),
                Err(Refusal::Store(error)) => return Err(internal(error)),
            }
        }
        let mut request = json!({
            "kind": "send",
            "id": p.id,
            "text": p.text,
            "force": p.force,
            "by": by,
        });
        if let Some(expect_rev) = p.expect_rev {
            request["expectRev"] = json!(expect_rev as u64);
        }
        bridge.call(request).await
    })
}

#[cfg(test)]
mod tests;
