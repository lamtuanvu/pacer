//! `executor.models.available` (`src/api/ops.ts`): the models an executor can
//! use, from the listing cache, the account's connection or `opencode models`.
#![allow(clippy::result_large_err)]
use crate::config_params::parse;
use pacer_config::strategy::load_strategy;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_models::{PROTOTYPE_KEYS, available_needs_core, available_reply};
use serde_json::Value;

const FORWARDED: &str = "executor.models.available requires the forwarded operation";
const OP: &str = "executor.models.available";

pub fn executor_models_available(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        crate::runner_ops::authorize(ctx)?;
        let p = parse(OP, params)?;
        let runner = p["runner"].as_str().unwrap_or("");
        let strategy = load_strategy(&ctx.pacer_home)
            .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
        if strategy["runners"].get(runner).is_none() {
            return Err(CoreError::new(
                Code::InvalidInput,
                format!("unknown runner {runner}"),
            ));
        }
        let refresh = p["refresh"] == true;
        available_reply(&ctx.pacer_home, ctx.now, &strategy, runner, refresh)
            .await
            .ok_or_else(|| CoreError::new(Code::Unavailable, FORWARDED))
    })
}

/// Forwards a runner only TypeScript resolves (an inherited object key), a
/// listing the front door cannot reproduce or run as Core does, and a
/// strategy only TypeScript loads. Invalid params and unknown runners stay
/// native.
pub fn executor_models_available_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    if op != OP {
        return false;
    }
    let Ok(p) = parse(OP, params.clone()) else {
        return false;
    };
    let Ok(strategy) = load_strategy(&ctx.pacer_home) else {
        return false;
    };
    let runner = p["runner"].as_str().unwrap_or("");
    if strategy["runners"].get(runner).is_none() {
        return PROTOTYPE_KEYS.contains(&runner);
    }
    available_needs_core(
        &ctx.pacer_home,
        ctx.now,
        &strategy,
        runner,
        p["refresh"] == true,
    )
}
