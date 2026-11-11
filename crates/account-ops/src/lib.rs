//! Native account operations (`src/core/accounts.ts`, `src/core/endpoints.ts`
//! and `src/core/account-usage-check.ts`).
//!
//! `account.remove` and the managed endpoint `account.add`, `account.edit` and
//! `account.adopt` own their strategy, endpoint state and evidence writes.
//! Inputs that write a key, run the endpoint test task, start a usage job or
//! discover models stay forwarded; so do the subscription account kinds,
//! whose replies carry plugin usage readings. `account.usage.check`,
//! `account.models`, `account.test` and `account.signin` refuse natively.
//! `account.list` composes its rows over the account-list Core bridge. No
//! handler reads or reports an endpoint key.
#![allow(clippy::result_large_err)]

pub mod account_list_ops;
mod endpoint;
mod evidence;
mod js;
mod model;
mod params;
mod refusals;
mod remove;
#[cfg(test)]
mod tests;

use pacer_config::{
    doc::parse_value,
    strategy::{load_strategy, strategy_path},
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::Value;

pub(crate) const SETTINGS_CONFLICT: &str =
    "Your settings changed while they were being updated. Try again.";

/// TypeScript reports an unreadable or invalid strategy in its parser's words.
pub(crate) fn strategy_loads(ctx: &Ctx) -> bool {
    strategy_path(&ctx.pacer_home)
        .ok()
        .and_then(|(path, _)| std::fs::read_to_string(path).ok())
        .is_some_and(|text| parse_value(&text).is_ok())
        && load_strategy(&ctx.pacer_home).is_ok()
}

pub(crate) fn forwarded() -> CoreError {
    CoreError::new(
        Code::Unavailable,
        "this account input requires the forwarded operation",
    )
}

fn enforcement(ctx: &Ctx) -> bool {
    ctx.env
        .get("PACER_ENFORCEMENT_TOKEN")
        .is_some_and(|token| !token.is_empty())
}

fn authorize(ctx: &Ctx) -> Result<(), CoreError> {
    if enforcement(ctx) {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial",
        ));
    }
    Ok(())
}

/// Account inputs whose effects only the TypeScript core owns.
pub fn account_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    if enforcement(ctx) {
        return false;
    }
    match op {
        "account.remove" => remove::stays_forwarded(ctx, params),
        "account.add" | "account.edit" | "account.adopt" => {
            endpoint::stays_forwarded(ctx, op, params)
        }
        "account.usage.check" | "account.models" | "account.test" => {
            refusals::refusal(ctx, op, params).is_none()
        }
        "account.list" => account_list_ops::list_stays_forwarded(ctx, params),
        "account.signin" => account_list_ops::signin_refusal(ctx, params).is_none(),
        _ => false,
    }
}

/// The caller synchronizes endpoints and publishes `accounts`.
pub fn account_remove(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        remove::remove(ctx, &params)
    })
}

fn save<'a>(ctx: &'a Ctx, op: &'static str, params: Value) -> OpFuture<'a> {
    Box::pin(async move {
        authorize(ctx)?;
        endpoint::save(ctx, op, &params).await
    })
}

/// The caller synchronizes endpoints and publishes `accounts`.
pub fn account_add(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    save(ctx, "account.add", params)
}

/// The caller synchronizes endpoints and publishes `accounts`.
pub fn account_edit(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    save(ctx, "account.edit", params)
}

/// The caller synchronizes endpoints and publishes `accounts`.
pub fn account_adopt(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    save(ctx, "account.adopt", params)
}

fn refuse<'a>(ctx: &'a Ctx, op: &'static str, params: Value) -> OpFuture<'a> {
    Box::pin(async move {
        authorize(ctx)?;
        Err(refusals::refusal(ctx, op, &params).unwrap_or_else(forwarded))
    })
}

pub fn account_usage_check(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    refuse(ctx, "account.usage.check", params)
}

pub fn account_models(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    refuse(ctx, "account.models", params)
}

pub fn account_test(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    refuse(ctx, "account.test", params)
}
