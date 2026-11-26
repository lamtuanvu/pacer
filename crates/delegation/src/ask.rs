//! Native `task.ask`: record one question from the current executor.
//!
//! Port of `requireAskingExecutor` (`src/core/tasks.ts:88-93`) and `ask`
//! (`src/core/tasks.ts:96-114`). The write, the parent message and the question
//! check all happen under the `ask-{id}` lock so a second ask sees the first.
#![allow(clippy::result_large_err)]

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
    lock::{LockOptions, with_lock},
};
use pacer_store::{
    TaskStore, is_task_id,
    messages::{self, NewMessage},
    publish,
};
use serde_json::{Value, json};

#[cfg(test)]
mod tests;

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn conflict(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Conflict, message)
}

fn unknown(id: &str) -> CoreError {
    CoreError::new(Code::UnknownTask, format!("unknown task {id}"))
}

fn internal(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Internal, message)
}

/// `requireAskingExecutor` (`src/core/tasks.ts:88-93`). Only the task's own
/// executor session may ask a question; the operation front door enforces the
/// same identity before this effect runs.
pub fn require_asking_executor(ctx: &Ctx, id: &str) -> Result<(), CoreError> {
    let is_executor = ctx.env.get("PACER_ROLE").is_some_and(|role| role == "executor");
    let own = ctx.env.get("PACER_TASK_ID").map(String::as_str);
    if !is_executor || own.is_none_or(str::is_empty) || own != Some(id) {
        return Err(CoreError::new(
            Code::NotAllowed,
            "pacer ask works only inside a delegated task",
        ));
    }
    Ok(())
}

/// `ask` (`src/core/tasks.ts:96-114`). Records `question` on the task, inserts
/// the parent message and publishes it; returns the updated task record.
pub fn ask_task(ctx: &Ctx, id: &str, text: &str) -> Result<Value, CoreError> {
    require_asking_executor(ctx, id)?;
    if !is_task_id(id) {
        return Err(unknown(id));
    }
    if text.is_empty() || text.encode_utf16().count() > 1000 {
        return Err(invalid("question must contain 1–1000 characters"));
    }
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let id_owned = id.to_owned();
    let text_owned = text.to_owned();
    with_lock(ctx, &format!("ask-{id}"), LockOptions::default(), || {
        let task = store
            .read(&id_owned)
            .map_err(|e| internal(e.to_string()))?
            .ok_or_else(|| unknown(&id_owned))?;
        if task
            .get("question")
            .is_some_and(|q| q.is_object() && q.get("answer").is_none())
        {
            return Err(conflict("already asked; stop and wait for the answer"));
        }
        if task.get("state").and_then(Value::as_str) != Some("running") {
            return Err(conflict("task is not running"));
        }
        store
            .update_current(&id_owned, ctx.now, |t| {
                t["question"] = json!({"text": text_owned, "at": ctx.now});
                Ok(())
            })
            .map_err(|e| internal(e.to_string()))?;

        let to = format!("task:{id_owned}");
        let parent = messages::parent_of(&mut store, &to).map_err(|e| internal(e.to_string()))?;
        if let Some(parent) = parent {
            let root = messages::root_of(&mut store, &to).map_err(|e| internal(e.to_string()))?;
            let request_id = format!("ask:{id_owned}:{}", ctx.now);
            let (message, duplicate) = messages::insert(
                &mut store,
                &NewMessage {
                    task_id: Some(&id_owned),
                    root_id: &root,
                    from: &to,
                    to: &parent,
                    kind: "question",
                    body: &text_owned,
                    reply_to: None,
                    request_id: Some(&request_id),
                    held: false,
                },
                ctx.now,
            )
            .map_err(|e| internal(e.to_string()))?;
            if !duplicate {
                let event = json!({"type":"entity","data":{"kind":"message","id":message["id"],"value":message}});
                publish(ctx, &[event]);
            }
        }
        store
            .read(&id_owned)
            .map_err(|e| internal(e.to_string()))?
            .ok_or_else(|| unknown(&id_owned))
    })
    .map_err(|e| internal(e.to_string()))?
}
