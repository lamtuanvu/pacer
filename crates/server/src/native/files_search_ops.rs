//! Native `files.search`. Callers holding a work grant never reach this handler: the front
//! doors forward every operation while `PACER_WORK_GRANT` is set.
#![allow(clippy::result_large_err)]
use pacer_config::strategy::load_strategy;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::files_search::{executor_session, files_search};
use serde_json::Value;

fn providers(ctx: &Ctx) -> Vec<String> {
    load_strategy(&ctx.pacer_home)
        .ok()
        .and_then(|s| {
            s.get("providers")?
                .as_object()
                .map(|m| m.keys().cloned().collect())
        })
        .unwrap_or_default()
}

pub(super) fn files_search_op(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    let ctx = ctx.clone();
    Box::pin(async move {
        tokio::task::spawn_blocking(move || {
            files_search(&ctx, &params, || {
                let cwd = std::env::current_dir().unwrap_or_default();
                executor_session(&ctx, &cwd, || providers(&ctx))
            })
        })
        .await
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?
    })
}
