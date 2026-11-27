//! Native `statusBrokerPartsFor` (`src/api/status-broker-bridge.ts`): the sealed
//! usage-broker parts each status op consumes, computed from `pacer-status` under
//! the same three modes — `{}` (full, read-write), `{cacheOnly:true}`
//! (read-only cache), and a `strategy.preview` `draft` which yields
//! `{current, draft}` or `{current, errors}`. Both statuses in the draft mode
//! share one readings map, so usage is read at most once per account.

use crate::compute::{Readings, StatusOptions, StatusRuntime, compute_status, status_broker_parts};
use pacer_config::{
    strategy::{StrategyError, load_strategy, parse_strategy, strategy_path},
    strategy_write::{DraftPreview, preview_draft},
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use serde_json::{Map, Value, json};
use std::{fs, path::Path, sync::Arc};

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

pub fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// The params of the sealed route, mirroring `src/api/status-broker-bridge.ts`:
/// a strict object with an optional `draft` and `cacheOnly`. Unknown keys and
/// values of the wrong type are refused with the text Zod produces at HEAD.
pub fn parse_params(params: &Value) -> Result<(Option<Value>, bool), CoreError> {
    let map = params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(params)
        ))
    })?;
    let mut cache_only = false;
    let mut draft: Option<Value> = None;
    let mut unknown: Vec<String> = Vec::new();
    for (key, value) in map {
        match key.as_str() {
            "draft" => {
                let obj = value.as_object().ok_or_else(|| {
                    invalid(format!(
                        "draft: Invalid input: expected object, received {}",
                        type_name(value)
                    ))
                })?;
                if let Some(from) = obj.get("from") {
                    let text = from.as_str().ok_or_else(|| {
                        invalid(format!(
                            "draft.from: Invalid input: expected string, received {}",
                            type_name(from)
                        ))
                    })?;
                    if text.is_empty() {
                        return Err(invalid(
                            "draft.from: Too small: expected string to have >=1 characters",
                        ));
                    }
                    if text.chars().count() > 128 {
                        return Err(invalid(
                            "draft.from: Too big: expected string to have <=128 characters",
                        ));
                    }
                }
                draft = Some(value.clone());
            }
            "cacheOnly" => {
                cache_only = value.as_bool().ok_or_else(|| {
                    invalid(format!(
                        "cacheOnly: Invalid input: expected boolean, received {}",
                        type_name(value)
                    ))
                })?;
            }
            other => unknown.push(format!("{other:?}")),
        }
    }
    if !unknown.is_empty() {
        return Err(invalid(if unknown.len() == 1 {
            format!("params: Unrecognized key: {}", unknown[0])
        } else {
            format!("params: Unrecognized keys: {}", unknown.join(", "))
        }));
    }
    Ok((draft, cache_only))
}

/// `computeStatus` for the full mode: `readOnly` follows `cacheOnly` (TypeScript
/// calls `computeStatus({...ctx, readOnly: true}, strategy, {cacheOnly: true})`).
async fn compute_full(
    ctx: &Ctx,
    strategy: &Value,
    cache_only: bool,
    rt: &StatusRuntime,
) -> Result<Value, CoreError> {
    let opts = StatusOptions {
        read_only: cache_only,
        cache_only,
        ..Default::default()
    };
    compute_status(ctx, strategy, &opts, rt).await
}

/// `computeStatus` for one of the two draft statuses: both are read-only and
/// share one readings map, so usage is read at most once per account.
async fn compute_draft_status(
    ctx: &Ctx,
    strategy: &Value,
    cache_only: bool,
    readings: &Arc<Readings>,
    rt: &StatusRuntime,
) -> Result<Value, CoreError> {
    let opts = StatusOptions {
        read_only: true,
        cache_only,
        readings: Some(readings.as_ref()),
        ..Default::default()
    };
    compute_status(ctx, strategy, &opts, rt).await
}

/// `loadStrategySnapshot` (`src/config/strategy.ts`): the active strategy's
/// path, name and exact source text, parsed once into the strategy every status
/// op in this request uses.
fn load_strategy_snapshot(home: &Path) -> Result<(Value, String, String, String), CoreError> {
    let (path, name) = strategy_path(home).map_err(|error| strategy_error("path", error))?;
    let text = fs::read_to_string(&path)
        .map_err(|error| invalid(format!("strategy read failed: {error}")))?;
    let strategy =
        parse_strategy(&text, &path, &name).map_err(|error| strategy_error("strategy", error))?;
    Ok((strategy, name, text, path.to_string_lossy().into_owned()))
}

fn strategy_error(kind: &str, error: StrategyError) -> CoreError {
    invalid(format!("strategy {kind} {error}"))
}

async fn full_parts(ctx: &Ctx, cache_only: bool, rt: &StatusRuntime) -> Result<Value, CoreError> {
    let (strategy, name, text, path) = load_strategy_snapshot(&ctx.pacer_home)?;
    let status = compute_full(ctx, &strategy, cache_only, rt).await?;
    let mut parts = status_broker_parts(&status);
    parts["strategy"] = json!({"name": name, "path": path, "text": text});
    Ok(parts)
}

async fn draft_parts(
    ctx: &Ctx,
    draft: Value,
    cache_only: bool,
    rt: &StatusRuntime,
) -> Result<Value, CoreError> {
    let current =
        load_strategy(&ctx.pacer_home).map_err(|error| strategy_error("strategy", error))?;
    let readings: Arc<Readings> = Arc::new(Readings::default());
    let current_status = compute_draft_status(ctx, &current, cache_only, &readings, rt).await?;
    let current_parts = status_broker_parts(&current_status);
    let reply = |draft: Option<Value>, errors: Option<Vec<Value>>| {
        let mut out = Map::new();
        out.insert("current".into(), current_parts.clone());
        if let Some(draft) = draft {
            out.insert("draft".into(), draft);
        }
        if let Some(errors) = errors {
            out.insert("errors".into(), Value::Array(errors));
        }
        Value::Object(out)
    };
    match preview_draft(&ctx.pacer_home, &draft) {
        DraftPreview::Valid { strategy, .. } => {
            let draft_status =
                compute_draft_status(ctx, &strategy, cache_only, &readings, rt).await?;
            Ok(reply(Some(status_broker_parts(&draft_status)), None))
        }
        DraftPreview::Invalid { problems, .. } => Ok(reply(
            None,
            Some(problems.into_iter().map(Value::String).collect()),
        )),
        // A base strategy only Bun reads is forwarded before this route is used;
        // keep the same `{current, errors}` shape if a caller reaches it anyway.
        DraftPreview::Unreadable => Ok(reply(
            None,
            Some(vec![Value::String(
                "the base strategy needs the forwarded operation".into(),
            )]),
        )),
    }
}

/// The reply `statusBrokerPartsFor` gives (`src/api/status-broker-bridge.ts`),
/// computed natively: `{}` is the active strategy's parts plus its snapshot,
/// `{cacheOnly:true}` is the read-only cache-only parts, and `{draft}` is
/// preview's `{current, draft}` (or `{current, errors}`) pair.
pub async fn broker_parts(
    ctx: &Ctx,
    params: Value,
    rt: &StatusRuntime,
) -> Result<Value, CoreError> {
    let (draft, cache_only) = parse_params(&params)?;
    match draft {
        Some(draft) => draft_parts(ctx, draft, cache_only, rt).await,
        None => full_parts(ctx, cache_only, rt).await,
    }
}

/// Re-exports for `crates/status/tests/parts.rs` (the same `pub(crate)` under
/// `testing` pattern as `compute::testing`).
pub mod testing {
    pub use super::{broker_parts, parse_params, type_name};
}
