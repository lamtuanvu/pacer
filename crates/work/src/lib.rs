//! Native work-operation authorization (`authorize_work_operation`, `src/core/work.ts`)
//! and the shared grant identities it resolves (`src/dispatch/work.ts`). B2-1.
//!
//! Executors reach dispatch and msg operations through `pwg_` work grants. This crate
//! is the native gate: it resolves a grant against `state/tasks.db` (the `work_grants`
//! and `work_nodes` tables, schema `crates/lifecycle/src/work.sql`) and, when no grant
//! is present, enforces the remaining caller refusals (`PACER_ASSISTANT_GRANT`, the
//! enforcement identity, and the `PACER_ROLE=executor` dispatch refusal).
#![allow(clippy::result_large_err)]

mod authorize;
mod grants;
#[cfg(test)]
mod tests;

pub use authorize::{
    TASK_REVIEW_REFUSAL, TASK_REVIEW_VARIANTS_REFUSAL, WORK_GRANT_OPS, authorize_work_operation,
};
pub use grants::{
    AssistantGrant, WorkNode, authorize_assistant_grant, authorize_work_grant, require_work_scope,
    token_hash,
};
