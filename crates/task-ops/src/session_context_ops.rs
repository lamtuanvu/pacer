//! Native `session.context`: a conversation's revision and private attachment draft
//! metadata, read from the task store (`ctxWithId` in `src/api/ops-session.ts`).
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_sessions::params::valid_session_id;
use pacer_store::{TaskStore, attachments, is_task_id};
use serde_json::{Map, Value};

const ID_PATTERN: &str = "/^[A-Za-z0-9_-]{1,128}$/";

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn internal(error: impl ToString) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
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

/// `z.object({ id })` over `params ?? {}`.
fn parse_id(params: &Value) -> Result<&str, CoreError> {
    let id = match params {
        Value::Null => None,
        Value::Object(map) => map.get("id"),
        other => {
            return Err(invalid(format!(
                "params: Invalid input: expected object, received {}",
                type_name(Some(other))
            )));
        }
    };
    match id {
        Some(Value::String(id)) if valid_session_id(id) => Ok(id),
        Some(Value::String(_)) => Err(invalid(format!(
            "id: Invalid string: must match pattern {ID_PATTERN}"
        ))),
        other => Err(invalid(format!(
            "id: Invalid input: expected string, received {}",
            type_name(other)
        ))),
    }
}

/// `authorizeWorkOperation` refuses enforcement identities before the schema runs.
/// Work-grant callers never reach native handlers: both front doors forward them.
pub(crate) fn authorize(ctx: &Ctx) -> Result<(), CoreError> {
    if ctx
        .env
        .get("PACER_ENFORCEMENT_TOKEN")
        .is_some_and(|token| !token.is_empty())
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial",
        ));
    }
    Ok(())
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn draft_missing() -> CoreError {
    CoreError::new(Code::NotFound, "Attachment draft expired or does not exist")
}

pub fn session_context(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move { context(ctx, &params) })
}

fn context(ctx: &Ctx, params: &Value) -> Result<Value, CoreError> {
    authorize(ctx)?;
    let id = parse_id(params)?;
    let unknown = || CoreError::new(Code::UnknownTask, format!("unknown task {id}"));
    // `readTask` answers other ids without opening (or creating) the database.
    if !is_task_id(id) {
        return Err(unknown());
    }
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(internal)?;
    let task = store.read(id).map_err(internal)?.ok_or_else(unknown)?;
    if task.get("interactionMode").and_then(Value::as_str) != Some("conversation") {
        return Err(CoreError::new(
            Code::NotAllowed,
            "This task is not an interactive conversation",
        ));
    }
    let draft = task.get("sessionDraftId");
    let listed = match draft {
        Some(Value::String(draft_id)) if !draft_id.is_empty() => {
            attachments::draft_attachments(&mut store, draft_id, ctx.now)
                .map_err(internal)?
                .ok_or_else(draft_missing)?
        }
        // TypeScript stores only UUID strings, so no draft it creates can match another value.
        Some(other) if js_truthy(other) => {
            attachments::ensure_schema(&mut store).map_err(internal)?;
            return Err(draft_missing());
        }
        _ => Vec::new(),
    };
    let mut out = Map::new();
    if let Some(draft) = draft {
        out.insert("draftId".into(), draft.clone());
    }
    out.insert("attachments".into(), Value::Array(listed));
    out.insert(
        "rev".into(),
        task.get("rev").cloned().unwrap_or(Value::Null),
    );
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests;
