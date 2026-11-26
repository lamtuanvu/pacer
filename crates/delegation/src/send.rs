//! Native `task.send` (`src/session/send.ts:47-122`).
//!
//! Port of `send`, `directInputAvailable` and `sendDirectInput`. Under the task lock it
//! rechecks every refusal, claims the 60 s driving lease, types the message into the live
//! built-in PTY (or drives the live worker), rolls the lease back on a definite failure and
//! records the timeline `message` entry. The caller (`pacer-task-ops`) has already refused
//! executor callers, malformed ids and empty text, and answered the pre-record refusals.
#![allow(clippy::result_large_err)]

use std::path::Path;

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_sessions::client::{SessionError, TypeResult, type_into_session};
use pacer_store::{StoreError, TaskStore, append_activity};
use serde_json::{Value, json};

use crate::answer::{direct_input_available, session_socket};
use crate::runtime::Runtime;

/// `DRIVING_LEASE_S` (`src/session/send.ts:22`).
const DRIVING_LEASE_S: f64 = 60.0;

fn unknown(id: &str) -> CoreError {
    CoreError::new(Code::UnknownTask, format!("unknown task {id}"))
}
fn conflict(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Conflict, message)
}
fn unavailable(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Unavailable, message)
}
fn internal(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Internal, message)
}

fn check_rev(task: &Value, expect: Option<f64>) -> Result<(), CoreError> {
    if let Some(expect) = expect
        && task.get("rev").and_then(Value::as_f64) != Some(expect)
    {
        return Err(conflict("task changed"));
    }
    Ok(())
}

/// The result a successful `with_task_lock` closure returns: the previous driving holder,
/// whether someone contended, and where to deliver.
struct Claim {
    /// The previous `driving` object (or `None`), to hand the lease back on rollback.
    previous: Option<Value>,
    contended: bool,
    /// The claimant's previous holder when contended, for the timeline text.
    taken_from: Option<String>,
    /// The built-in run directory, when delivery is into a local PTY.
    dir: Option<String>,
    /// The live backend name, when delivery is into a live (Orca) worker.
    backend: Option<String>,
    /// The live terminal handle, when delivery is into a live (Orca) worker.
    terminal: Option<String>,
    /// The lease epoch we claimed, used as a guard that no one took it over.
    claimed_at: f64,
}

enum SendErr {
    Store(StoreError),
    Core(CoreError),
}
impl From<StoreError> for SendErr {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl From<CoreError> for SendErr {
    fn from(error: CoreError) -> Self {
        Self::Core(error)
    }
}

/// A live backend, matched against `backendById(task.live.backend, backends)?.live`.
fn is_live_backend(backend: &str) -> bool {
    matches!(backend, "orca")
}

/// The reader of a delivery result: `true` keeps the lease (returned to the caller as a
/// success) and `false` rolls it back. The message and `input_attempted` mirror the shape
/// `send` turns into a `CoreError` (`src/session/send.ts:66-90`).
type Delivery = Result<(), (String, bool)>;

fn session_error(error: SessionError) -> (String, bool) {
    (error.message, error.input_attempted)
}

fn typed_result(result: TypeResult, attempted: bool) -> Delivery {
    match result {
        TypeResult::Typed => Ok(()),
        TypeResult::Busy => Err((
            "session is busy delivering to another viewer; try again".to_owned(),
            attempted,
        )),
        TypeResult::Refused { controller } => Err((
            format!("delivery refused; {controller:?} is controlling the session"),
            attempted,
        )),
        TypeResult::Pending { reason } => Err((format!("delivery pending: {reason}"), attempted)),
    }
}

/// `send_to_task(ctx, runtime, id, text, by, force, expect_rev)` — the native `send`.
pub async fn send_to_task(
    ctx: &Ctx,
    _runtime: &Runtime,
    id: &str,
    text: &str,
    by: &str,
    force: bool,
    expect_rev: Option<f64>,
) -> Result<Value, CoreError> {
    let claim = {
        let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
        store
            .with_task_lock(id, |locked| {
                let task = locked.read()?;
                check_rev(&task, expect_rev).map_err(SendErr::Core)?;
                let state = task.get("state").and_then(Value::as_str);
                let awaiting_answer = task
                    .get("question")
                    .is_some_and(|q| !q.is_null() && q.get("answer").is_none());
                if state == Some("needs_input") || awaiting_answer {
                    return Err(SendErr::Core(conflict(format!(
                        "task is waiting for an answer; use pacer answer"
                    ))));
                }
                if state != Some("running") {
                    return Err(SendErr::Core(conflict(format!(
                        "task is {}, not running",
                        state.unwrap_or("undefined")
                    ))));
                }
                let direct = direct_input_available(&task);
                let live = task.get("live").filter(|l| !l.is_null());
                if live.is_none() && !direct {
                    return Err(SendErr::Core(
                        unavailable(
                            "this task has no live terminal to send into",
                        )
                        .hint("only an interactive lane (delegate --interactive) on a backend that keeps its worker live accepts messages"),
                    ));
                }
                let backend = live
                    .and_then(|l| l.get("backend"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if let Some(backend) = backend.as_deref()
                    && !is_live_backend(backend)
                {
                    return Err(SendErr::Core(unavailable(format!(
                        "the {backend} backend cannot deliver live input"
                    ))));
                }
                let terminal = live
                    .and_then(|l| l.get("terminal"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let previous = task.get("driving").filter(|d| !d.is_null()).cloned();
                let contained = previous.as_ref().is_some_and(|holder| {
                    holder.get("by").and_then(Value::as_str).is_some_and(|who| who != by)
                        && holder
                            .get("at")
                            .and_then(Value::as_f64)
                            .is_some_and(|at| ctx.now - at < DRIVING_LEASE_S)
                });
                if contained && !force {
                    let holder = previous
                        .as_ref()
                        .and_then(|p| p.get("by"))
                        .and_then(Value::as_str)
                        .unwrap_or("?");
                    let ago = previous
                        .as_ref()
                        .and_then(|p| p.get("at"))
                        .and_then(Value::as_f64)
                        .map(|at| ctx.now - at)
                        .unwrap_or(0.0);
                    return Err(SendErr::Core(conflict(format!(
                        "{holder} sent a message {ago:.0}s ago; use --force to send anyway"
                    ))));
                }
                let taken_from = if contained {
                    previous
                        .as_ref()
                        .and_then(|p| p.get("by"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                } else {
                    None
                };
                let claimed_at = ctx.now;
                let dir = task
                    .pointer("/run/dir")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let rev = task.get("rev").and_then(Value::as_i64).unwrap_or(0);
                locked.update(rev, ctx.now, |t| {
                    t["driving"] = json!({ "by": by, "at": claimed_at });
                })?;
                Ok(Claim {
                    previous,
                    contended: contained,
                    taken_from,
                    dir,
                    backend,
                    terminal,
                    claimed_at,
                })
            })
            .map_err(|error: SendErr| match error {
                SendErr::Store(StoreError::UnknownTask(_)) => unknown(id),
                SendErr::Store(other) => internal(other.to_string()),
                SendErr::Core(error) => error,
            })?
    };

    let delivery: Delivery = match (claim.backend.as_deref(), claim.dir.as_deref()) {
        (Some(backend), _) => match claim.terminal.as_deref() {
            Some(terminal) => live_send(backend, terminal, text).await,
            None => Err((
                "the live worker has no terminal to send into".to_owned(),
                false,
            )),
        },
        (None, Some(dir)) => {
            match type_into_session(
                &session_socket(Path::new(dir)),
                text,
                || still_owned(ctx, id, dir, by, claim.claimed_at),
            )
            .await
            {
                Ok(result) => typed_result(result, true),
                Err(error) => Err(session_error(error)),
            }
        }
        (None, None) => Err(("No interactive run".to_owned(), false)),
    };

    match delivery {
        Ok(()) => {
            record_message(ctx, id, text, &claim);
            let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
            store
                .read(id)
                .map_err(|e| internal(e.to_string()))?
                .ok_or_else(|| unknown(id))
        }
        Err((message, input_attempted)) => {
            rollback_lease(ctx, id, by, claim.claimed_at, claim.previous.as_ref());
            let error = if input_attempted {
                unavailable(format!("Interactive input failed: {message}"))
            } else {
                conflict(message)
            };
            Err(error)
        }
    }
}

/// Deliver into a live (Orca) worker by running `orca terminal send`, as
/// `src/exec/orca/client.ts:149` does. The Orca lane is unverified unless Orca is
/// installed in the sandbox, but the front door owns the same subprocess here.
async fn live_send(backend: &str, terminal: &str, text: &str) -> Delivery {
    let output = match tokio::process::Command::new("orca")
        .args([
            "terminal",
            "send",
            "--terminal",
            terminal,
            "--text",
            text,
            "--enter",
            "--json",
        ])
        .output()
        .await
    {
        Ok(output) => output,
        Err(error) => {
            return Err((format!("{backend} terminal send failed: {error}"), false));
        }
    };
    if !output.status.success() {
        return Err((
            format!(
                "{backend} terminal send failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            false,
        ));
    }
    let body: Value = match serde_json::from_slice(&output.stdout) {
        Ok(body) => body,
        Err(_) => return Ok(()),
    };
    if let Some(error) = body.get("error") {
        Err((format!("{backend} refused the send: {error}"), false))
    } else {
        Ok(())
    }
}

/// `ready()` in `sendDirectInput` (`src/session/send.ts:104-107`): the run is unchanged and
/// our lease still holds, so no competing sender received the paste.
fn still_owned(ctx: &Ctx, id: &str, dir: &str, by: &str, claimed_at: f64) -> bool {
    TaskStore::open(&ctx.pacer_home)
        .ok()
        .and_then(|mut store| store.read(id).ok().flatten())
        .is_some_and(|task| {
            direct_input_available(&task)
                && task.pointer("/run/dir").and_then(Value::as_str) == Some(dir)
                && task.get("driving").is_some_and(|d| {
                    d.get("by").and_then(Value::as_str) == Some(by)
                        && d.get("at").and_then(Value::as_f64) == Some(claimed_at)
                })
        })
}

/// Give the lease back unless someone claimed it since (`src/session/send.ts:80-88`).
fn rollback_lease(ctx: &Ctx, id: &str, by: &str, claimed_at: f64, previous: Option<&Value>) {
    let Ok(mut store) = TaskStore::open(&ctx.pacer_home) else {
        return;
    };
    let _ = store.with_task_lock(id, |locked| {
        let task = locked.read()?;
        let still_held = task.get("driving").is_some_and(|d| {
            d.get("by").and_then(Value::as_str) == Some(by)
                && d.get("at").and_then(Value::as_f64) == Some(claimed_at)
        });
        if still_held {
            let rev = task.get("rev").and_then(Value::as_i64).unwrap_or(0);
            locked.update(rev, ctx.now, |t| {
                if let Some(previous) = previous {
                    t["driving"] = previous.clone();
                } else {
                    t.as_object_mut().and_then(|o| o.remove("driving"));
                }
            })?;
        }
        Ok::<(), StoreError>(())
    });
}

/// `taskActivity(ctx, updated, "message", ...)` (`src/core/tasks.ts` re-export).
fn record_message(ctx: &Ctx, id: &str, text: &str, claim: &Claim) {
    let took_over = if claim.contended {
        let from = claim.taken_from.as_deref().unwrap_or("another caller");
        format!(" (took over from {from})")
    } else {
        String::new()
    };
    let clipped: String = text.chars().take(200).collect();
    let mut activity = json!({
        "kind": "message",
        "level": "info",
        "text": format!("Sent{took_over}: {clipped}"),
        "taskId": id,
    });
    if let Ok(mut store) = TaskStore::open(&ctx.pacer_home) {
        if let Ok(Some(task)) = store.read(id) {
            if let Some(repo) = str_field(&task, "/repo").or_else(|| str_field(&task, "/brief/repo")) {
                activity["repo"] = json!(repo);
            }
            if let Some(executor) = str_field(&task, "/result/executor")
                .or_else(|| str_field(&task, "/executor"))
                .or_else(|| {
                    task.get("attempts")
                        .and_then(Value::as_array)
                        .and_then(|a| a.last())
                        .and_then(|v| str_field(v, "/executor"))
                })
                .or_else(|| str_field(&task, "/requestedExecutor"))
            {
                activity["executor"] = json!(executor);
            }
            if let Some(host) = str_field(&task, "/run/host") {
                activity["host"] = json!(host);
            }
        }
    }
    let _ = append_activity(ctx, activity);
}

fn str_field(value: &Value, path: &str) -> Option<String> {
    value
        .pointer(path)
        .and_then(Value::as_str)
        .map(str::to_owned)
}