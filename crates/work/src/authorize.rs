//! The operation gate `authorizeWorkOperation` (`src/core/work.ts`:318), ported line by
//! line. Every transport must pass this gate before an operation is admitted.
//!
//! Gate order (brief §3): assistant grant → enforcement → `dispatch.enforcement.denied`
//! without an identity → `task.review` executor check → no grant (executor plus
//! `dispatch.*`) → msg allow-list (grant validity only) → dispatch/task allow-list →
//! `dispatch.child` returns → id required → `require_work_scope` with `review` for
//! `dispatch.review|retry|answer` and `task.review`.
//!
//! The run-grant (`prg_`) and orchestrator lanes are a separate slice and are omitted here,
//! matching the brief's referenced source range.

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use rusqlite::Connection;
use serde_json::Value;

use crate::grants::{authorize_assistant_grant, authorize_work_grant_db, require_work_scope_db};

/// `TASK_REVIEW_REFUSAL` (`src/core/work.ts:43`).
pub const TASK_REVIEW_REFUSAL: &str = "PACER_ROLE=executor: executors cannot review their own task; only a child they dispatched this run (use pacer dispatch review).";
/// `TASK_REVIEW_VARIANTS_REFUSAL` (`src/core/work.ts:44`).
pub const TASK_REVIEW_VARIANTS_REFUSAL: &str = "PACER_ROLE=executor: send_back and retry verdicts are for the planner or a person; retry or answer a child with pacer dispatch retry / pacer dispatch answer.";

/// The union of the two allow-lists (`src/core/work.ts:333-335`, §3).
pub const WORK_GRANT_OPS: &[&str] = &[
    // msg allow-list: grant validity only, no subtree scope
    "msg.send",
    "msg.inbox",
    "msg.wait",
    "msg.log",
    "msg.read",
    "msg.close",
    "msg.policy",
    "tree.status",
    "liveness.status",
    // dispatch allow-list
    "dispatch.child",
    "dispatch.tree",
    "dispatch.events",
    "dispatch.wait",
    "dispatch.review",
    "dispatch.retry",
    "dispatch.answer",
    "dispatch.stop",
    // task allow-list
    "task.get",
    "task.wait",
    "task.log",
    "task.diff",
    "task.review",
];

const MSG_OPS: &[&str] = &[
    "msg.send",
    "msg.inbox",
    "msg.wait",
    "msg.log",
    "msg.read",
    "msg.close",
    "msg.policy",
    "tree.status",
    "liveness.status",
];

const DISPATCH_TASK_OPS: &[&str] = &[
    "dispatch.child",
    "dispatch.tree",
    "dispatch.events",
    "dispatch.wait",
    "dispatch.review",
    "dispatch.retry",
    "dispatch.answer",
    "dispatch.stop",
    "task.get",
    "task.wait",
    "task.log",
    "task.diff",
    "task.review",
];

const REVIEW_OPS: &[&str] = &[
    "dispatch.review",
    "dispatch.retry",
    "dispatch.answer",
    "task.review",
];

/// `authorizeWorkOperation` — the full gate.
///
/// The work store is opened only when a granted identity actually needs it (a running
/// executor's `task.review`, or a live `PACER_WORK_GRANT`). An operator request with
/// no grant is admitted without touching `state/tasks.db`, matching `src/core/work.ts`,
/// so a native `dispatch.preview`/`dispatch.explain` leaves the store untouched.
pub fn authorize_work_operation(
    ctx: &Ctx,
    name: &str,
    params: &Value,
    is_executor: bool,
) -> Result<(), CoreError> {
    // The assistant-turn identity comes first and answers for nothing else (`spec §2`).
    if let Some(assistant_token) = ctx
        .env
        .get("PACER_ASSISTANT_GRANT")
        .filter(|token| !token.is_empty())
    {
        let grant = authorize_assistant_grant(ctx, assistant_token)?;
        if name != "assistant.tool" {
            return Err(CoreError::new(
                Code::NotAllowed,
                "An assistant grant runs assistant.tool only.",
            ));
        }
        let turn_id = params.get("turnId").and_then(Value::as_str);
        let turn_id = match turn_id {
            Some(id) if !id.is_empty() => id,
            _ => return Err(CoreError::new(Code::InvalidInput, "turnId is required")),
        };
        if turn_id != grant.turn_id {
            return Err(CoreError::new(
                Code::NotAllowed,
                "This assistant grant belongs to another turn.",
            ));
        }
        return Ok(());
    }
    if ctx
        .env
        .get("PACER_ENFORCEMENT_TOKEN")
        .is_some_and(|token| !token.is_empty())
    {
        if name != "dispatch.enforcement.denied" {
            return Err(CoreError::new(
                Code::NotAllowed,
                "Enforcement identity only reports a native child denial",
            ));
        }
        return Ok(());
    }
    if name == "dispatch.enforcement.denied" {
        return Err(CoreError::new(
            Code::NotAllowed,
            "An enforcement identity is required",
        ));
    }
    if name == "task.review" && is_executor {
        let mut store = crate::grants::open(ctx)?;
        let db = store.connection().map_err(crate::grants::store_err)?;
        assert_executor_task_review(ctx, params, &db)?;
    }
    let Some(token) = ctx
        .env
        .get("PACER_WORK_GRANT")
        .map(String::as_str)
        .filter(|token| !token.is_empty())
    else {
        if ctx.env.get("PACER_ROLE").map(String::as_str) == Some("executor")
            && name.starts_with("dispatch.")
        {
            return Err(CoreError::new(
                Code::NotAllowed,
                "A scoped work grant is required",
            ));
        }
        return Ok(());
    };
    // Validate the token shape before opening the grant store: `authorizeWorkGrant`
    // refuses a malformed `pwg_` first and never touches the home filesystem, so a
    // refused grant must not open (and checkpoint) `state/tasks.db`.
    if !crate::grants::is_pwg(token) {
        return Err(CoreError::new(Code::NotAllowed, "Invalid work grant"));
    }
    let mut store = crate::grants::open(ctx)?;
    let db = store.connection().map_err(crate::grants::store_err)?;
    // msg allow-list: the grant's validity is enough; no subtree scope is required.
    if MSG_OPS.contains(&name) {
        authorize_work_grant_db(db, ctx, token)?;
        return Ok(());
    }
    let _caller = authorize_work_grant_db(db, ctx, token)?;
    if !DISPATCH_TASK_OPS.contains(&name) {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Operation is not allowed by this work grant",
        ));
    }
    if name == "dispatch.child" {
        return Ok(());
    }
    let id = params.get("id").and_then(Value::as_str);
    let id = match id {
        Some(id) if !id.is_empty() => id,
        _ => return Err(CoreError::new(Code::InvalidInput, "Task id is required")),
    };
    let review = REVIEW_OPS.contains(&name);
    require_work_scope_db(db, ctx, token, id, review)?;
    Ok(())
}

/// `assertExecutorTaskReview` (`src/core/work.ts`:358): an executor may act on only a
/// child within its own grant; never on its own task, and never with the planner variants.
fn assert_executor_task_review(
    ctx: &Ctx,
    params: &Value,
    db: &Connection,
) -> Result<(), CoreError> {
    let verdict = params.get("verdict").and_then(Value::as_str);
    if verdict == Some("send_back") || verdict == Some("retry") {
        return Err(CoreError::new(
            Code::NotAllowed,
            TASK_REVIEW_VARIANTS_REFUSAL,
        ));
    }
    let token = ctx.env.get("PACER_WORK_GRANT");
    let id = params.get("id").and_then(Value::as_str);
    let (Some(token), Some(id)) = (token, id) else {
        return Err(CoreError::new(Code::NotAllowed, TASK_REVIEW_REFUSAL));
    };
    if token.is_empty() || id.is_empty() {
        return Err(CoreError::new(Code::NotAllowed, TASK_REVIEW_REFUSAL));
    }
    if require_work_scope_db(db, ctx, token, id, true).is_err() {
        return Err(CoreError::new(Code::NotAllowed, TASK_REVIEW_REFUSAL));
    }
    Ok(())
}
