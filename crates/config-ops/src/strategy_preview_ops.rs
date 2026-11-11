//! Native `strategy.preview` (`src/strategy/service.ts` `preview`). Rust applies,
//! serializes and validates the draft, then ranks both strategies over the
//! usage-broker rows TypeScript composed for the active strategy. Those rows are
//! valid for the draft only while it keeps every input of a provider row, so a
//! draft that changes one forwards, as does a base strategy with a YAML syntax or
//! I/O error. A missing or schema-invalid base strategy fails natively.
#![allow(clippy::result_large_err)]
use crate::config_writes::STRATEGY_HINT;
use pacer_config::{
    strategy::{list_strategies, load_strategy},
    strategy_write::{DraftPreview, preview_draft},
};
use pacer_engine::usage_broker;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Value, json};

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
    if listed && crate::strategy_load::text_may_differ(&path) {
        return true;
    }
    matches!(
        preview_draft(&ctx.pacer_home, &params["draft"]),
        DraftPreview::Unreadable
    )
}

/// The usage-broker params `strategy.preview` sends: its draft, for `preview`'s statuses.
pub fn broker_params(params: &Value) -> Value {
    match params.get("draft") {
        Some(draft) if draft.is_object() => json!({"draft": draft}),
        _ => json!({}),
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

fn invalid_response() -> CoreError {
    CoreError::new(Code::Unavailable, "invalid usage broker response")
}

fn failed(yaml: String, errors: Value, current_ranking: Vec<Value>, current: &Value) -> Value {
    json!({
        "ok": false,
        "errors": errors,
        "yaml": yaml,
        "summary": "",
        "ranking": {"current": current_ranking, "draft": []},
        "routing": {"current": current["routing"], "draft": []},
    })
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
    let current_ranking = ranked(
        ctx,
        &current,
        parts.get("current").ok_or_else(invalid_response)?,
    );
    Ok(match preview {
        DraftPreview::Valid {
            yaml,
            strategy,
            summary,
        } => match (parts.get("draft"), parts.get("errors")) {
            (Some(draft), _) => json!({
                "ok": true,
                "errors": [],
                "yaml": yaml,
                "summary": summary,
                "ranking": {"current": current_ranking, "draft": ranked(ctx, &strategy, draft)},
                "routing": {"current": current["routing"], "draft": strategy["routing"]},
            }),
            // `preview` reports a draft status that fails after validation with its message.
            (None, Some(errors)) if errors.is_array() => {
                failed(yaml, errors.clone(), current_ranking, &current)
            }
            (None, _) => return Err(invalid_response()),
        },
        DraftPreview::Invalid { yaml, problems } => {
            failed(yaml, json!(problems), current_ranking, &current)
        }
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
