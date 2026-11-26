//! Native managed-work lifecycle ops (`src/core/work.ts`): `submitWork`,
//! `delegateChild`, `waitWork`, `stopWork` and `reviewWork`.
//!
//! Submit and child route through the native [`delegate`] admission (B3-6)
//! after resolving the request's gate. Wait, stop and review resolve their
//! work-grant scope here and then call the delegation modules that own the
//! effects (`wait::wait_task`, `stop::stop_work`, `review::review_work`).
#![allow(clippy::result_large_err)]

use std::time::{SystemTime, UNIX_EPOCH};

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_store::TaskStore;
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use crate::delegate::delegate;
use crate::runtime::Runtime;

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn not_allowed(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::NotAllowed, message)
}

fn internal(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Internal, message)
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

/// True when `parameter` is a value present but nullish (`null`), mirroring
/// TypeScript's `??` right-hand selection in `src/core/work.ts`.
fn is_null_value(v: &Value) -> bool {
    v.is_null()
}

/// Shallow object spread `{...base, ...over}` (`work.ts` `{...caller.options,
/// ...input.options}`): every key present in `over` replaces `base`'s.
fn spread_work_options(base: &Value, over: &Value) -> Value {
    let mut out = base.clone();
    if let (Some(base), Some(over)) = (out.as_object_mut(), over.as_object()) {
        for (key, value) in over {
            base.insert(key.clone(), value.clone());
        }
    }
    out
}

/// Resolve the `dispatch` (work options) object for `dispatch.submit`, port of
/// `submitWork` (`src/core/work.ts:54`):
/// `workOptionsSchema.parse({...input.options, kind: input.kind ?? input.options?.kind})`.
/// The top-level `kind` only wins when non-nullish (TS `??`).
fn submit_dispatch(input: &Value) -> Value {
    let mut dispatch = input.get("options").cloned().unwrap_or_else(|| json!({}));
    if let Some(kind) = input.get("kind")
        && !is_null_value(kind)
    {
        dispatch["kind"] = kind.clone();
    }
    dispatch
}

/// Resolve the `dispatch` (work options) object for `dispatch.child`, port of
/// `delegateChild` (`src/core/work.ts:66`), which computes
/// `{...caller.options, ...input.options}` then conditionally overrides
/// `difficulty`, `model`, `kind`, `requirements` and `preferences` as that
/// function does.
fn child_dispatch(caller_options: &Value, input: &Value) -> Value {
    let input_options = input.get("options").unwrap_or(&Value::Null);
    let mut dispatch = spread_work_options(caller_options, input_options);
    // Top-level `difficulty`/`model` only override when truthy (TS spreads them
    // conditionally); a nullish top-level value must not clobber the parsed one.
    for (key, source) in [("difficulty", input), ("model", input)] {
        if let Some(value) = source.get(key)
            && !value.is_null()
            && value != &json!("")
        {
            dispatch[key] = value.clone();
        }
    }
    // `kind`: top-level `kind` wins over the options kind when non-nullish.
    if let Some(kind) = input.get("kind")
        && !is_null_value(kind)
    {
        dispatch["kind"] = kind.clone();
    }
    // `requirements`/`preferences` fall back to the caller's when the child
    // request did not supply a non-null value.
    for key in ["requirements", "preferences"] {
        let provided = input_options.get(key);
        if provided.is_none_or(is_null_value) {
            if let Some(fallback) = caller_options.get(key) {
                dispatch[key] = fallback.clone();
            }
        }
    }
    dispatch
}

/// The parent's persisted work options. Port of `caller.options` read back
/// through TS's `authorizeWorkGrant` → `getWork`, which returns the **work node**
/// (`src/core/work.ts:36-38`), not the task record. Native parents keep their
/// options in the `work_nodes` table (written by `AdmissionState::register`), so
/// they are read from there, never from the parent's task record (which has no
/// `work` field).
fn caller_options(ctx: &Ctx, task_id: &str) -> Result<Value, CoreError> {
    let mut state = pacer_lifecycle::AdmissionState::open(&ctx.pacer_home)
        .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
    let work = state
        .work(task_id)
        .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
    Ok(work
        .and_then(|node| node.get("options").cloned())
        .unwrap_or_else(|| json!({})))
}

/// `dispatch.submit`: a planner or human submits managed work. Port of
/// `submitWork` (`src/core/work.ts:48-57`). A live scoped work grant turns the
/// submit into child delegation; otherwise the caller must identify a repository
/// and may not be an executor without a grant.
pub async fn submit_work(
    ctx: &Ctx,
    runtime: &Runtime,
    input: &Value,
) -> Result<Value, CoreError> {
    if ctx.env.get("PACER_WORK_GRANT").is_some() {
        return delegate_child(ctx, runtime, input).await;
    }
    if ctx.env.get("PACER_ROLE").map(String::as_str) == Some("executor") {
        return Err(not_allowed("A scoped work grant is required"));
    }
    if input
        .get("repo")
        .and_then(Value::as_str)
        .map(str::is_empty)
        .unwrap_or(true)
    {
        return Err(invalid("Repository is required"));
    }
    let mut call = input.clone();
    call["dispatch"] = submit_dispatch(input);
    delegate(ctx, runtime, &call, Some("planner")).await
}

/// `dispatch.child`: an executor holding a live `pwg_` work grant requests an
/// isolated child. Port of `delegateChild` (`src/core/work.ts:58-110`): the
/// child inherits its parent's repository and is delegated with `workParent`,
/// `worktree: "new"` and an idempotency `request_id` so admission can build the
/// child's subtree and deduplicate replays.
pub async fn delegate_child(
    ctx: &Ctx,
    runtime: &Runtime,
    input: &Value,
) -> Result<Value, CoreError> {
    let token = ctx
        .env
        .get("PACER_WORK_GRANT")
        .ok_or_else(|| not_allowed("A scoped work grant is required"))?;
    let caller = pacer_work::authorize_work_grant(ctx, token)?;
    if input.get("requestId").map(Value::is_null).unwrap_or(true) {
        return Err(invalid("Child delegation requires an idempotency requestId"));
    }

    // The child inherits its parent's repository. Disallow overriding it.
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
    let parent = store
        .read(&caller.task_id)
        .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?
        .ok_or_else(|| not_allowed("Parent work no longer exists"))?;
    let repo = parent
        .pointer("/brief/repo")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_default();
    let override_repo = input.get("repo").and_then(Value::as_str);
    if let Some(override_repo) = override_repo
        && !override_repo.is_empty()
        && override_repo != repo
    {
        return Err(not_allowed("Child work must use its parent's repository"));
    }

    let mut call = input.clone();
    call["repo"] = Value::String(repo);
    call["dispatch"] = child_dispatch(&caller_options(ctx, &caller.task_id)?, &call);
    call["workParent"] = Value::String(caller.task_id);
    call["worktree"] = json!("new");
    call["worktree_reason"] = json!("Isolated delegated child work");
    call["source"] = json!("planner");
    delegate(ctx, runtime, &call, Some("planner")).await
}

/// Record the start of a `child` wait for `id` (`setWorkWait`/`beginChildWait`
/// in `src/dispatch/work.ts:148-159`). A nested wait increments the refcount;
/// an idle slot starts a fresh measurement.
fn begin_child_wait(ctx: &Ctx, id: &str) -> Result<(), CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let db = store.connection().map_err(|e| internal(e.to_string()))?;
    let row: Option<(Option<f64>, i64)> = db
        .query_row(
            "SELECT started_at,refs FROM work_waits WHERE task_id=?1 AND kind='child'",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| internal(e.to_string()))?;
    match row {
        None => {
            db.execute(
                "INSERT INTO work_waits(task_id,kind,started_at,total_seconds,refs) VALUES(?1,'child',?2,0,1)",
                rusqlite::params![id, ctx.now],
            )
            .map_err(|e| internal(e.to_string()))?;
        }
        Some((None, _)) => {
            db.execute(
                "UPDATE work_waits SET started_at=?1,refs=1 WHERE task_id=?2 AND kind='child'",
                rusqlite::params![ctx.now, id],
            )
            .map_err(|e| internal(e.to_string()))?;
        }
        Some((Some(_), refs)) => {
            db.execute(
                "UPDATE work_waits SET refs=?1 WHERE task_id=?2 AND kind='child'",
                rusqlite::params![refs + 1, id],
            )
            .map_err(|e| internal(e.to_string()))?;
        }
    }
    Ok(())
}

/// Close a `child` wait for `id` (`endChildWait` in `src/dispatch/work.ts:161`).
/// A nested wait only drops the refcount; the last waiter accumulates the
/// elapsed time and clears the slot.
fn end_child_wait(ctx: &Ctx, id: &str) -> Result<(), CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let db = store.connection().map_err(|e| internal(e.to_string()))?;
    let row: Option<(Option<f64>, i64)> = db
        .query_row(
            "SELECT started_at,refs FROM work_waits WHERE task_id=?1 AND kind='child'",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| internal(e.to_string()))?;
    let Some((started, refs)) = row else { return Ok(()) };
    if refs <= 0 {
        return Ok(());
    }
    if refs > 1 {
        db.execute(
            "UPDATE work_waits SET refs=?1 WHERE task_id=?2 AND kind='child'",
            rusqlite::params![refs - 1, id],
        )
        .map_err(|e| internal(e.to_string()))?;
        return Ok(());
    }
    let elapsed = started.map(|start| (ctx.now - start).max(0.0)).unwrap_or(0.0);
    db.execute(
        "UPDATE work_waits SET total_seconds=total_seconds+?1,started_at=NULL,refs=0 WHERE task_id=?2 AND kind='child'",
        rusqlite::params![elapsed, id],
    )
    .map_err(|e| internal(e.to_string()))?;
    Ok(())
}

/// `dispatch.wait`: wait for managed work to settle (`waitWork`,
/// `src/core/work.ts:309-315`). A grant holder measures the wait against its
/// own work item, but may never wait on itself; the wait itself belongs to
/// `wait::wait_task`.
pub async fn wait_work(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    timeout_s: u32,
) -> Result<Value, CoreError> {
    let parent = if let Some(token) = ctx.env.get("PACER_WORK_GRANT") {
        let caller = pacer_work::authorize_work_grant(ctx, token)?;
        if caller.task_id == id {
            return Err(not_allowed("A work item cannot wait for itself"));
        }
        pacer_work::require_work_scope(ctx, token, id, false)?;
        begin_child_wait(ctx, &caller.task_id)?;
        Some(caller.task_id)
    } else {
        None
    };
    let result = crate::wait::wait_task(ctx, runtime, id, timeout_s).await;
    if let Some(parent) = parent {
        let mut end_ctx = ctx.clone();
        end_ctx.now = now_secs();
        end_child_wait(&end_ctx, &parent)?;
    }
    result
}

/// `dispatch.stop`: stop every non-terminal node in a work tree (`stopWork`,
/// `src/core/work.ts:317-326`). The tree walk and signals belong to
/// `stop::stop_work`; a grant holder must first prove the root is in scope.
pub async fn stop_work(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    expect_rev: Option<i64>,
) -> Result<Value, CoreError> {
    if let Some(token) = ctx.env.get("PACER_WORK_GRANT") {
        pacer_work::require_work_scope(ctx, token, id, false)?;
    }
    crate::stop::stop_work(ctx, runtime, id, expect_rev).await
}

/// `dispatch.review`: record a verdict on managed work (`reviewWork`,
/// `src/core/work.ts:117-135`). `review::review_work` owns the lock, CAS and
/// evidence; a grant holder may only review a child in its subtree.
pub async fn review_work(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    accepted: bool,
    note: Option<&str>,
    expect_rev: Option<i64>,
) -> Result<Value, CoreError> {
    if let Some(token) = ctx.env.get("PACER_WORK_GRANT") {
        pacer_work::require_work_scope(ctx, token, id, true)?;
    }
    crate::review::review_work(ctx, runtime, id, accepted, note, expect_rev).await
}

#[cfg(test)]
#[path = "work_tests.rs"]
mod tests;