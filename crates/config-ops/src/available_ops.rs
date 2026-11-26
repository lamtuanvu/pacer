//! `executor.models.available` (`src/api/ops.ts`): the models an executor can
//! use, from the listing cache, the account's connection or `opencode models`.
#![allow(clippy::result_large_err)]
use crate::config_params::parse;
use pacer_config::strategy::load_strategy;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_models::{PROTOTYPE_KEYS, available_reply};
use serde_json::Value;

const OP: &str = "executor.models.available";

pub fn executor_models_available(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        crate::runner_ops::authorize(ctx)?;
        let p = parse(OP, params)?;
        let runner = p["runner"].as_str().unwrap_or("");
        let strategy = load_strategy(&ctx.pacer_home)
            .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
        // A prototype key resolves through `Object.prototype` in JavaScript,
        // so TypeScript lists it as a runner with no account rather than
        // refusing it as unknown.
        if strategy["runners"].get(runner).is_none()
            && !PROTOTYPE_KEYS.contains(&runner)
        {
            return Err(CoreError::new(
                Code::InvalidInput,
                format!("unknown runner {runner}"),
            ));
        }
        let refresh = p["refresh"] == true;
        match available_reply(&ctx.pacer_home, ctx.now, &strategy, runner, refresh).await {
            Ok(reply) => Ok(reply),
            Err(message) => Err(CoreError::new(Code::Internal, message)),
        }
    })
}
