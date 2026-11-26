//! Live answers into a running built-in PTY, ported from `deliverLiveAnswer`
//! (`src/messaging/send.ts`) and `answerLiveTask` (`src/core/tasks.ts`).
#![allow(clippy::result_large_err)]
use crate::send::{direct_input_available, send_direct_input};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_store::{TaskStore, messages};
use serde_json::Value;

fn store_error(error: pacer_store::StoreError) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// The question from task `to` that the caller's reply answers.
fn answered_question(
    store: &mut TaskStore,
    caller: &str,
    to: &str,
    reply_to: &str,
) -> Result<Option<Value>, CoreError> {
    let Some(question) = messages::get(store, reply_to).map_err(store_error)? else {
        return Ok(None);
    };
    let ok = text(&question, "kind") == "question"
        && messages::task_of(to).is_some()
        && text(&question, "from") == to
        && (text(&question, "to") == caller || caller == "human");
    Ok(ok.then_some(question))
}

fn is_task_question(task: &Value, question: &Value) -> bool {
    task.get("question").is_some_and(|q| {
        q.get("text") == question.get("body")
            && q.get("at").and_then(Value::as_f64) == question.get("createdAt").and_then(Value::as_f64)
    })
}

/// The task that currently waits for this answer in its own live interactive run.
fn direct_answer_target(
    _ctx: &Ctx,
    store: &mut TaskStore,
    m: &Value,
) -> Result<Option<String>, CoreError> {
    let Some(reply_to) = m.get("replyTo").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(id) = messages::task_of(text(m, "to")) else {
        return Ok(None);
    };
    let Some(question) = answered_question(store, text(m, "from"), text(m, "to"), reply_to)? else {
        return Ok(None);
    };
    let Some(task) = store.read(&id).map_err(store_error)? else {
        return Ok(None);
    };
    let waiting = direct_input_available(&task)
        && task.get("question").is_some_and(|q| q.get("answer").is_none())
        && is_task_question(&task, &question);
    Ok(waiting.then(|| id.to_owned()))
}

fn unmark_read(store: &mut TaskStore, to: &str, ids: &[&str]) {
    let Ok(db) = store.connection() else {
        return;
    };
    let Ok(mut stmt) = db.prepare("UPDATE messages SET status='pending', read_at=NULL WHERE id=? AND recipient=? AND status='read'") else {
        return;
    };
    for id in ids {
        let _ = stmt.execute(rusqlite::params![id, to]);
    }
}

/// Reserve the answer on the task's question, type it into the live session, and
/// mark the question message read. A definite failure rolls the reservation back.
async fn answer_live_task(
    ctx: &Ctx,
    store: &mut TaskStore,
    id: &str,
    body: &str,
) -> Result<(), CoreError> {
    let task = store
        .read(id)
        .map_err(store_error)?
        .ok_or_else(|| CoreError::new(Code::NotFound, format!("Unknown task {id}")))?;
    let waiting = direct_input_available(&task)
        && task.get("question").is_some_and(|q| q.get("answer").is_none());
    if !waiting {
        return Err(CoreError::new(
            Code::Conflict,
            "task is not waiting for a live answer",
        ));
    }
    let question = task.get("question").cloned().unwrap_or_default();
    let question_message = messages::thread(store, id, None, None)
        .map_err(store_error)?
        .into_iter()
        .rev()
        .find(|m| {
            text(m, "kind") == "question"
                && text(m, "from") == format!("task:{id}")
                && text(m, "body") == text(&question, "text")
                && m.get("createdAt").and_then(Value::as_f64)
                    == question.get("at").and_then(Value::as_f64)
        });
    let reserved = store
        .update_current(id, ctx.now, |t| {
            if let Some(q) = t.get_mut("question").and_then(Value::as_object_mut) {
                q.insert("answer".into(), Value::String(body.to_owned()));
                q.insert("answeredAt".into(), Value::from(ctx.now));
            }
            Ok(())
        })
        .map_err(store_error)?;
    let same = |t: &Value| {
        t.get("run").and_then(|r| r.get("dir")) == reserved.get("run").and_then(|r| r.get("dir"))
            && t.get("question").and_then(|q| q.get("at"))
                == reserved.get("question").and_then(|q| q.get("at"))
            && t.get("question").and_then(|q| q.get("text"))
                == reserved.get("question").and_then(|q| q.get("text"))
            && t.get("question").and_then(|q| q.get("answer")).and_then(Value::as_str) == Some(body)
            && t.get("question").and_then(|q| q.get("answeredAt")).and_then(Value::as_f64)
                == Some(ctx.now)
    };
    send_direct_input(ctx, &reserved, body, same).await?;
    if let Some(question) = question_message {
        let _ = messages::mark_read(store, text(&question, "to"), &[text(&question, "id")], ctx.now);
    }
    Ok(())
}

/// `deliverLiveAnswer`: returns `true` when the answer reached the live session.
/// A refused answer to the open question stays read; anything else returns to pending.
pub async fn deliver_live_answer(ctx: &Ctx, id: &str) -> Result<bool, CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(store_error)?;
    let Some(m) = messages::get(&mut store, id).map_err(store_error)? else {
        return Ok(false);
    };
    let Some(target) = direct_answer_target(ctx, &mut store, &m)? else {
        return Ok(false);
    };
    let body = text(&m, "body").to_owned();
    let to = text(&m, "to").to_owned();
    let _ = messages::mark_read(&mut store, &to, &[id], ctx.now);
    match answer_live_task(ctx, &mut store, &target, &body).await {
        Ok(()) => Ok(true),
        Err(error) => {
            let reserved = store
                .read(&target)
                .map_err(store_error)?
                .is_some_and(|t| {
                    t.get("question").and_then(|q| q.get("answer")).and_then(Value::as_str) == Some(body.as_str())
                });
            if reserved || direct_answer_target(ctx, &mut store, &m)?.is_some() {
                return Err(error);
            }
            unmark_read(&mut store, &to, &[id]);
            Ok(false)
        }
    }
}
