//! Native `task.answer`.
//!
//! Port of `answer`, `answerLiveTask` and `continueWithMessage`
//! (`src/core/tasks.ts:202-215,516-623`). A live built-in PTY answer is typed
//! into the session; an openable session resumes with an answer message; every
//! other task falls back to an answer retry through [`crate::retry`].
#![allow(clippy::result_large_err)]

use std::path::Path;

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_lifecycle::work_node_exists;
use pacer_read_model::{ActiveCounts, tasks as read_tasks};
use pacer_store::{TaskStore, messages, publish};
use serde_json::{Value, json};

use crate::retry::{self, RetryInput};
use crate::runtime::Runtime;

#[cfg(test)]
mod tests;

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn conflict(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Conflict, message)
}

fn not_allowed(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::NotAllowed, message)
}

fn unknown(id: &str) -> CoreError {
    CoreError::new(Code::UnknownTask, format!("unknown task {id}"))
}

fn internal(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Internal, message)
}

fn check_rev(task: &Value, expect: Option<i64>) -> Result<(), CoreError> {
    if let Some(expect) = expect
        && task.get("rev").and_then(Value::as_i64) != Some(expect)
    {
        return Err(conflict("task changed"));
    }
    Ok(())
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The public `apiTask` view clients read (`src/api/read-model/tasks.ts:21`),
/// built by the same read-model projection as `task.list` and `task.get`.
fn view(ctx: &Ctx, task: &Value) -> Result<Value, CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let rows = read_tasks::api_tasks(
        ctx,
        &ActiveCounts::default(),
        std::slice::from_ref(task),
        &mut store,
        &|_| false,
    )
    .map_err(|e| internal(e.to_string()))?;
    rows.into_iter()
        .next()
        .ok_or_else(|| internal("answer projection produced no task"))
}

fn managed(ctx: &Ctx, id: &str) -> bool {
    TaskStore::open(&ctx.pacer_home)
        .ok()
        .and_then(|mut store| work_node_exists(&mut store, id))
        .unwrap_or(false)
}

/// `canContinue` (`src/core/tasks.ts:38-40`).
fn can_continue(task: &Value) -> bool {
    task.get("interactionMode").and_then(Value::as_str) != Some("conversation")
        && task.get("run").is_some()
        && (task.pointer("/run/agentSession").is_some()
            || task
                .pointer("/run/executor")
                .and_then(Value::as_str)
                .is_some_and(|executor| executor.contains("opencode")))
}

fn read_pid(dir: &Path) -> Option<i64> {
    std::fs::read_to_string(dir.join("pid"))
        .ok()
        .and_then(|text| text.trim().parse::<i64>().ok())
}

fn process_alive(pid: i64, dir: &Path) -> bool {
    let output = match std::process::Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
    {
        Ok(output) => output,
        Err(_) => return false,
    };
    if !output.status.success() {
        return false;
    }
    let command = String::from_utf8_lossy(&output.stdout);
    let command = command.trim();
    command.contains(&dir.join("run.sh").to_string_lossy().into_owned())
        || command.ends_with(&format!("_session {}", dir.display()))
}

/// `directInputAvailable` (`src/session/send.ts:94-99`) for a built-in PTY.
pub fn direct_input_available(task: &Value) -> bool {
    if task.get("state").and_then(Value::as_str) != Some("running") {
        return false;
    }
    let Some(run) = task.get("run") else {
        return false;
    };
    if run.get("host").is_some() || run.get("takeover").is_some() {
        return false;
    }
    let Some(dir) = run.get("dir").and_then(Value::as_str) else {
        return false;
    };
    let dir = Path::new(dir);
    if !dir.join("interactive.json").exists() || dir.join("exit").exists() {
        return false;
    }
    match read_pid(dir) {
        Some(pid) => process_alive(pid, dir),
        None => false,
    }
}

pub fn session_socket(dir: &Path) -> std::path::PathBuf {
    std::fs::read_to_string(dir.join("session.sock.path"))
        .ok()
        .map(|text| std::path::PathBuf::from(text.trim()))
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| dir.join("session.sock"))
}

fn last_question(store: &mut TaskStore, id: &str, text: &str, at: Option<f64>) -> Option<Value> {
    messages::thread(store, id, None, None)
        .ok()?
        .into_iter()
        .filter(|m| {
            m.get("kind").and_then(Value::as_str) == Some("question")
                && m.get("from").and_then(Value::as_str) == Some(&format!("task:{id}"))
        })
        .filter(|m| {
            at.is_none()
                || (m.get("body").and_then(Value::as_str) == Some(text)
                    && m.get("createdAt").and_then(Value::as_f64) == at)
        })
        .last()
}

/// `answerLiveTask` (`src/core/tasks.ts:595-623`). Reserves the answer under the
/// task lock, types it into the session, and rolls a definite failure back.
pub async fn answer_live_task(
    ctx: &Ctx,
    id: &str,
    text: &str,
    expect_rev: Option<i64>,
) -> Result<Value, CoreError> {
    let (reserved, dir) = {
        let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
        store
            .with_task_lock(id, |locked| {
                let task = locked.read()?;
                check_rev(&task, expect_rev).map_err(StoreWrap)?;
                if !direct_input_available(&task)
                    || task.get("question").is_none()
                    || task.pointer("/question/answer").is_some()
                {
                    return Err(StoreWrap(conflict("task is not waiting for a live answer")));
                }
                let rev = task.get("rev").and_then(Value::as_i64).unwrap_or(0);
                let updated = locked.update(rev, ctx.now, |t| {
                    t["question"]["answer"] = json!(text);
                    t["question"]["answeredAt"] = json!(ctx.now);
                })?;
                Ok((updated, task.pointer("/run/dir").and_then(Value::as_str).map(str::to_owned)))
            })
            .map_err(|e: StoreWrap| e.0)?
    };
    let question_message = {
        let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
        last_question(
            &mut store,
            id,
            reserved.pointer("/question/text").and_then(Value::as_str).unwrap_or_default(),
            reserved.pointer("/question/at").and_then(Value::as_f64),
        )
    };
    let reserved_text = text.to_owned();
    let same = |task: &Value| -> bool {
        direct_input_available(task)
            && task.pointer("/run/dir").and_then(Value::as_str)
            == dir.as_deref()
            && task.pointer("/question/at").and_then(Value::as_f64)
                == reserved.pointer("/question/at").and_then(Value::as_f64)
            && task.pointer("/question/text").and_then(Value::as_str)
                == reserved.pointer("/question/text").and_then(Value::as_str)
            && task.pointer("/question/answer").and_then(Value::as_str) == Some(reserved_text.as_str())
            && task.pointer("/question/answeredAt").and_then(Value::as_f64)
                == reserved.pointer("/question/answeredAt").and_then(Value::as_f64)
    };

    let delivered = match dir.as_deref() {
        None => Err(pacer_sessions::client::SessionError {
            message: "No interactive run".into(),
            input_attempted: false,
        }),
        Some(dir) => {
            pacer_sessions::client::type_into_session(&session_socket(Path::new(dir)), text, || {
                TaskStore::open(&ctx.pacer_home)
                    .ok()
                    .and_then(|mut store| store.read(id).ok().flatten())
                    .is_some_and(|task| same(&task))
            })
            .await
        }
    };

    match delivered {
        Ok(pacer_sessions::client::TypeResult::Typed) => {
            if let Some(message) = question_message
                && let Some(to) = message.get("to").and_then(Value::as_str)
                && let Some(mid) = message.get("id").and_then(Value::as_str)
            {
                let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
                let _ = messages::mark_read(&mut store, to, &[mid], ctx.now);
            }
            let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
            let task = store
                .read(id)
                .map_err(|e| internal(e.to_string()))?
                .ok_or_else(|| unknown(id))?;
            view(ctx, &task)
        }
        Ok(other) => {
            let reason = match other {
                pacer_sessions::client::TypeResult::Refused { controller } => {
                    // `viewerName` renders `client:label`; TS `clean` shows the label.
                    let label = controller
                        .and_then(|name| name.rsplit(':').next().map(str::to_owned))
                        .filter(|name| !name.is_empty())
                        .unwrap_or_else(|| "another viewer".into());
                    format!("The terminal is controlled from {label}; nothing was typed")
                }
                pacer_sessions::client::TypeResult::Pending { reason } => {
                    format!("Not delivered: {reason}. Nothing was typed; try again")
                }
                pacer_sessions::client::TypeResult::Busy => {
                    "The task's run or question changed before delivery; nothing was typed".into()
                }
                pacer_sessions::client::TypeResult::Typed => unreachable!(),
            };
            rollback_answer(ctx, id, &same);
            Err(conflict(reason))
        }
        Err(error) => {
            if error.input_attempted {
                // A socket error after a write is ambiguous: keep the reservation.
            } else {
                rollback_answer(ctx, id, &same);
            }
            Err(CoreError::new(
                Code::Unavailable,
                format!("Interactive input failed: {error}"),
            ))
        }
    }
}

fn rollback_answer(ctx: &Ctx, id: &str, same: &impl Fn(&Value) -> bool) {
    let Ok(mut store) = TaskStore::open(&ctx.pacer_home) else {
        return;
    };
    let _ = store.with_task_lock(id, |locked| {
        let task = locked.read()?;
        if same(&task) {
            let rev = task.get("rev").and_then(Value::as_i64).unwrap_or(0);
            locked.update(rev, ctx.now, |t| {
                if let Some(question) = t.get_mut("question") {
                    question.as_object_mut().and_then(|q| q.remove("answer"));
                    question.as_object_mut().and_then(|q| q.remove("answeredAt"));
                }
            })?;
        }
        Ok::<(), pacer_store::StoreError>(())
    });
}

/// `continueWithMessage` (`src/core/tasks.ts:202-215`). Inserts the answer
/// message, reserves the answer and asks the supervisor to start a turn.
async fn continue_with_message(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    text: &str,
    expect_rev: Option<i64>,
) -> Result<Option<Value>, CoreError> {
    let (rev, reply_to, message_id) = {
        let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
        let task = store
            .with_task_lock(id, |locked| {
                let task = locked.read()?;
                check_rev(&task, expect_rev).map_err(StoreWrap)?;
                if task.get("state").and_then(Value::as_str) != Some("needs_input")
                    || task.get("question").is_none()
                    || task.pointer("/question/answer").is_some()
                    || task.get("retriedBy").is_some()
                {
                    return Err(StoreWrap(conflict("task is not waiting for an answer")));
                }
                Ok(task)
            })
            .map_err(|e: StoreWrap| e.0)?;
        let rev = task.get("rev").and_then(Value::as_i64).unwrap_or(0);
        let reply_to = messages::thread(&mut store, id, None, None)
            .ok()
            .and_then(|thread| {
                thread
                    .into_iter()
                    .filter(|m| {
                        m.get("kind").and_then(Value::as_str) == Some("question")
                            && m.get("from").and_then(Value::as_str) == Some(&format!("task:{id}"))
                    })
                    .last()
            })
            .and_then(|m| m.get("id").and_then(Value::as_str).map(str::to_owned));
        let root = messages::root_of(&mut store, &format!("task:{id}"))
            .map_err(|e| internal(e.to_string()))?;
        let request_id = format!("answer:{id}:{rev}");
        let (message, duplicate) = messages::insert(
            &mut store,
            &messages::NewMessage {
                task_id: Some(id),
                root_id: &root,
                from: "human",
                to: &format!("task:{id}"),
                kind: "answer",
                body: text,
                reply_to: reply_to.as_deref(),
                request_id: Some(&request_id),
                held: false,
            },
            ctx.now,
        )
        .map_err(|e| internal(e.to_string()))?;
        if duplicate {
            drop(store);
            return Ok(None);
        }
        let event = json!({"type":"entity","data":{"kind":"message","id":message["id"],"value":message}});
        publish(ctx, &[event]);
        store
            .update_current(id, ctx.now, |t| {
                t["question"]["answer"] = json!(text);
                t["question"]["answeredAt"] = json!(ctx.now);
                Ok(())
            })
            .map_err(|e| internal(e.to_string()))?;
        (rev, reply_to, message.get("id").and_then(Value::as_str).map(str::to_owned))
    };

    match runtime.supervisor.tick(ctx, id).await {
        Ok(_) => {
            let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
            let task = store
                .read(id)
                .map_err(|e| internal(e.to_string()))?
                .ok_or_else(|| unknown(id))?;
            Ok(Some(view(ctx, &task)?))
        }
        Err(_) => {
            let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
            store
                .update_current(id, ctx.now, |t| {
                    if let Some(question) = t.get_mut("question") {
                        question.as_object_mut().and_then(|q| q.remove("answer"));
                        question.as_object_mut().and_then(|q| q.remove("answeredAt"));
                    }
                    Ok(())
                })
                .map_err(|e| internal(e.to_string()))?;
            if let Some(mid) = message_id.as_deref() {
                let _ = messages::mark_read(&mut store, &format!("task:{id}"), &[mid], ctx.now);
            }
            let _ = (rev, reply_to);
            Ok(None)
        }
    }
}

struct StoreWrap(CoreError);
impl From<pacer_store::StoreError> for StoreWrap {
    fn from(e: pacer_store::StoreError) -> Self {
        StoreWrap(internal(e.to_string()))
    }
}

/// `answer` (`src/core/tasks.ts:516-590`). Returns `{task, retry}` as TypeScript does.
pub async fn answer_task(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    text: &str,
    expect_rev: Option<i64>,
) -> Result<Value, CoreError> {
    if ctx.env.get("PACER_ROLE").is_some_and(|role| role == "executor") {
        return Err(not_allowed("executors cannot delegate onward"));
    }
    if text.is_empty() || utf16_len(text) > 2000 {
        return Err(invalid("answer must contain 1–2000 characters"));
    }
    let current = {
        let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
        store.read(id).map_err(|e| internal(e.to_string()))?
    };
    let Some(current) = current else {
        return Err(unknown(id));
    };
    // The op refuses managed work that cannot continue before any other check
    // (`src/api/ops.ts:510-512`); `work::answer_work` lands with B2-11.
    if managed(ctx, id) && !can_continue(&current) {
        return Err(not_allowed(
            "Use dispatch.answer with a requestId and revision for managed work",
        ));
    }
    if direct_input_available(&current) && current.get("question").is_some() {
        let live = answer_live_task(ctx, id, text, expect_rev).await?;
        let view = view(ctx, &live)?;
        return Ok(json!({"task": view, "retry": view}));
    }
    let mut retry_rev = expect_rev;
    if can_continue(&current) {
        if let Some(task) = continue_with_message(ctx, runtime, id, text, expect_rev).await? {
            let view = view(ctx, &task)?;
            return Ok(json!({"task": view, "retry": view}));
        }
        // A held turn falls back to a retry against the revision it committed.
        retry_rev = {
            let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
            store
                .read(id)
                .map_err(|e| internal(e.to_string()))?
                .and_then(|t| t.get("rev").and_then(Value::as_i64))
        };
    }
    let reply = retry::retry_task(
        ctx,
        runtime,
        id,
        RetryInput {
            answer_text: Some(text.to_owned()),
            expect_rev: retry_rev,
            ..RetryInput::default()
        },
    )
    .await?;
    // `retry_task` summarizes for `task.retry`; `answer` projects the raw
    // parent/child records through `apiTask`, as the TypeScript handler does.
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let mut read_view = |summary: &Value| -> Result<Value, CoreError> {
        let id = summary.get("task_id").and_then(Value::as_str).unwrap_or_default();
        let task = store
            .read(id)
            .map_err(|e| internal(e.to_string()))?
            .ok_or_else(|| unknown(id))?;
        view(ctx, &task)
    };
    let of = read_view(&reply["of"])?;
    let retry = read_view(&reply["retry"])?;
    Ok(json!({"task": of, "retry": retry}))
}
