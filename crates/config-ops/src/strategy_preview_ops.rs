//! Native `strategy.preview` (`src/strategy/service.ts` `preview`). Rust applies,
//! serializes and validates the draft, then ranks both strategies over the
//! usage-broker rows TypeScript composed for the active strategy. Those rows are
//! valid for the draft only while it keeps every input of a provider row, so a
//! draft that changes one forwards, as does a base strategy with a YAML syntax or
//! I/O error. A missing or schema-invalid base strategy fails natively.
#![allow(clippy::result_large_err)]
use crate::config_writes::STRATEGY_HINT;
use pacer_config::{
    strategy::load_strategy,
    strategy_write::{DraftPreview, preview_draft},
};
use pacer_engine::usage_broker;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Value, json};

/// Strategy fields a provider row in `computeStatus` reads; ranking reads the rest.
const PROVIDER_INPUTS: &[&str] = &[
    "planner",
    "accounts",
    "hosts",
    "runners",
    "legacy",
    "runnerAliases",
    "providers",
];
const PACING_INPUTS: &[&str] = &["aheadThreshold", "behindThreshold", "plannerReserve"];

fn provider_inputs(strategy: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for key in PROVIDER_INPUTS {
        out.insert((*key).into(), strategy[*key].clone());
    }
    for key in PACING_INPUTS {
        out.insert(format!("pacing.{key}"), strategy["pacing"][*key].clone());
    }
    Value::Object(out)
}

fn enforcement(ctx: &Ctx) -> Result<(), CoreError> {
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

/// Inputs whose preview only TypeScript reproduces. Invalid params stay native.
pub fn strategy_preview_stays_forwarded(ctx: &Ctx, params: &Value) -> bool {
    let Ok(params) = crate::config_params::parse("strategy.preview", params.clone()) else {
        return false;
    };
    let current = match load_strategy(&ctx.pacer_home) {
        Ok(current) => current,
        Err(error) => return crate::strategy_load::needs_core(&error),
    };
    match preview_draft(&ctx.pacer_home, &params["draft"]) {
        DraftPreview::Unreadable => true,
        DraftPreview::Invalid { .. } => false,
        DraftPreview::Valid { strategy, .. } => {
            provider_inputs(&strategy) != provider_inputs(&current)
        }
    }
}

pub fn strategy_preview_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async {
        Err(CoreError::new(
            Code::Unavailable,
            "strategy.preview requires the usage broker bridge",
        ))
    })
}

fn ranked(ctx: &Ctx, strategy: &Value, parts: &Value) -> Vec<Value> {
    usage_broker::routing_status(ctx, strategy, parts)["executors"]["ranked"]
        .as_array()
        .map(|rows| rows.iter().map(|row| row["id"].clone()).collect())
        .unwrap_or_default()
}

/// Params are checked before the broker rows are requested.
pub async fn strategy_preview(
    ctx: &Ctx,
    params: Value,
    parts: OpFuture<'_>,
) -> Result<Value, CoreError> {
    enforcement(ctx)?;
    let params = crate::config_params::parse("strategy.preview", params)?;
    // `strategyAction` turns the plain `loadStrategy` error into `invalid_input` with its hint.
    let current = load_strategy(&ctx.pacer_home).map_err(|error| {
        CoreError::new(Code::InvalidInput, error.to_string()).hint(STRATEGY_HINT)
    })?;
    let preview = preview_draft(&ctx.pacer_home, &params["draft"]);
    let parts = parts.await?;
    let current_ranking = ranked(ctx, &current, &parts);
    Ok(match preview {
        DraftPreview::Valid {
            yaml,
            strategy,
            summary,
        } => json!({
            "ok": true,
            "errors": [],
            "yaml": yaml,
            "summary": summary,
            "ranking": {"current": current_ranking, "draft": ranked(ctx, &strategy, &parts)},
            "routing": {"current": current["routing"], "draft": strategy["routing"]},
        }),
        DraftPreview::Invalid { yaml, problems } => json!({
            "ok": false,
            "errors": problems,
            "yaml": yaml,
            "summary": "",
            "ranking": {"current": current_ranking, "draft": []},
            "routing": {"current": current["routing"], "draft": []},
        }),
        DraftPreview::Unreadable => {
            return Err(CoreError::new(
                Code::Unavailable,
                "strategy.preview: the base strategy needs the forwarded operation",
            ));
        }
    })
}

#[cfg(test)]
mod tests;
