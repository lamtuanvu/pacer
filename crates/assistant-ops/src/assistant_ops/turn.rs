//! Native `assistant.ask`, `assistant.cancel` and `assistant.tool`.
//!
//! Rust applies the caller policy and Zod params, then runs the turn itself. The
//! plugin call is injected by the front door as a [`ReplyRunner`]: only the
//! native plugin host (`ProcessRpc::Local`) can answer the turn's
//! `capability.assistant.tool` and `capability.secrets.resolve` calls itself.
//! Without that owner the door refuses before the turn starts.

use super::run_turn::{self, ReplyRunner};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::Value;
use std::sync::{Arc, OnceLock};

static RUNNER: OnceLock<Arc<dyn ReplyRunner>> = OnceLock::new();

/// The door installs its native-host-backed runner at start-up. Installing is
/// idempotent so a restarted door in the same process cannot replace a live one.
pub fn set_runner(runner: Arc<dyn ReplyRunner>) {
    let _ = RUNNER.set(runner);
}

#[cfg(test)]
pub fn clear_runner_for_tests() {
    // Tests that need a different runner run in their own process; this is a
    // best-effort reset for unit tests that only exercise refusals.
}

fn runner<'a>() -> Result<Arc<dyn ReplyRunner>, CoreError> {
    RUNNER.get().cloned().ok_or_else(|| {
        CoreError::new(
            Code::Unavailable,
            "The assistant needs the native plugin host.",
        )
    })
}

/// An op that reaches a turn. The policy runs before the runner is needed, so
/// executor sessions and work-grant callers keep their established refusals.
pub fn assistant_ask(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        super::refuse(ctx)?;
        run_turn::validate(&params)?;
        let reply = runner()?;
        run_turn::ask(ctx, params, reply).await
    })
}

pub fn assistant_cancel(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        super::refuse(ctx)?;
        let _ = super::params::parse("assistant.cancel", params.clone())?;
        let _ = runner()?;
        run_turn::cancel(ctx, params)
    })
}

/// `assistant.tool`: the live turn's tool context is the only authority. The
/// front door checks the `pag_` grant and binds it to this turn id.
pub fn assistant_tool<'a>(
    ctx: &'a Ctx,
    params: Value,
    reads: &'a mut dyn super::tools::ReadOps,
) -> OpFuture<'a> {
    Box::pin(async move {
        let _ = runner()?;
        run_turn::tool(ctx, params, reads).await
    })
}

/// Test-only seam: run a turn with an injected runner without installing a
/// process-wide one.
#[cfg(test)]
pub fn ask_with<'a>(
    ctx: &'a Ctx,
    params: Value,
    runner: Arc<dyn ReplyRunner>,
) -> OpFuture<'a> {
    run_turn::ask(ctx, params, runner)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use pacer_foundation::api::Code;

    #[tokio::test]
    async fn refusals_are_applied_before_the_runner_is_needed() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::with(dir.path().to_path_buf(), dir.path().to_path_buf(), Default::default(), 0.0);
        let executor = Ctx {
            env: [("PACER_ROLE".into(), "executor".into())].into_iter().collect(),
            ..ctx.clone()
        };
        let error = assistant_ask(&executor, serde_json::json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.code, Code::NotAllowed);
        let invalid = assistant_cancel(&ctx, serde_json::json!({}))
            .await
            .unwrap_err();
        assert_eq!(invalid.code, Code::InvalidInput);
    }
}
