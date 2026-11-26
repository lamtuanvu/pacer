//! Native `dispatch.submit` and `dispatch.child` (`submitWork` and `delegateChild`
//! in `src/core/work.ts`).
//!
//! Both route through the native [`delegate`] admission (B3-6) after resolving
//! the request's gate: `submit_work` is the planner/human door (requires an
//! explicit repository, or a live scoped work grant), and `delegate_child` is
//! the scoped work-grant door an executor uses to run an isolated child under
//! its parent's root. `delegate` already handles brief parsing, request-id
//! idempotency, repository validation, work-option setup and create-and-launch.
#![allow(clippy::result_large_err)]

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_store::TaskStore;
use serde_json::{Value, json};

use crate::delegate::delegate;
use crate::runtime::Runtime;

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn not_allowed(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::NotAllowed, message)
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

#[cfg(test)]
#[path = "work_tests.rs"]
mod tests;