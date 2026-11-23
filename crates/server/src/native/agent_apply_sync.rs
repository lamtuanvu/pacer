//! Front-door dispatch for native `agent.preview`, `agent.connect`, `agent.undo` and
//! `agent.disconnect`.
//!
//! Rust refuses callers and validates params. Core runs the reference agent operation, because
//! the planner-plugin file plan and undo (ARCH-12) live only in the TypeScript plugin host.
//! Over HTTP an admitted request crosses the private effects bridge with no deadline, as a
//! forwarded request has none. Over stdio it is forwarded unchanged: the bridge would hold the
//! request loop for the whole connect/undo, while the core child answers forwarded requests
//! concurrently.
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_install::agent_ops::{self, AgentEffects};
use pacer_messaging_ops::msg_ops::{current_dir, orca_worktree, own_worktree};
use serde_json::{Value, json};

/// Ops a front door dispatches natively through [`admit`], then Core.
pub(crate) fn uses_effects(op: &str) -> bool {
    agent_ops::uses_effects(op)
}

/// Work-grant callers, and a task worktree as the process directory, whose executor
/// check needs Core (`isExecutorSession` confirms the Orca provider from the strategy).
pub(crate) fn stays_forwarded(ctx: &Ctx, op: &str) -> bool {
    if !agent_ops::uses_effects(op) {
        return false;
    }
    agent_ops::stays_forwarded(ctx)
        || current_dir().is_some_and(|cwd| own_worktree(ctx, &cwd) || orca_worktree(&cwd))
}

/// The caller refusals and schema, without any Core effect.
#[allow(clippy::result_large_err)]
pub(crate) fn admit(ctx: &Ctx, op: &str, params: &Value) -> Result<(), CoreError> {
    if agent_ops::uses_effects(op) {
        agent_ops::admit(ctx, op, params)
    } else {
        Err(CoreError::new(Code::UnknownOp, "unknown operation"))
    }
}

#[allow(clippy::result_large_err)]
pub(crate) async fn call(
    ctx: &Ctx,
    op: &str,
    params: Value,
    effects: &mut dyn AgentEffects,
) -> Result<Value, CoreError> {
    if agent_ops::uses_effects(op) {
        agent_ops::agent_call(ctx, op, params, effects).await
    } else {
        Err(CoreError::new(Code::UnknownOp, "unknown operation"))
    }
}

pub(crate) struct HttpEffects {
    pub(crate) target: Option<(u16, String)>,
}

impl AgentEffects for HttpEffects {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            crate::native::core_bridge_sync::http(
                self.target.clone(),
                "agent.effects",
                json!({ "request": request }),
            )
            .await
        })
    }
}
