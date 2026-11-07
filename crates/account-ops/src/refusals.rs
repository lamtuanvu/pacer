//! The refusals of `account.usage.check` (`src/core/account-usage-check.ts`),
//! `account.models` and `account.test` (`src/core/endpoints.ts`). The usage
//! job, model discovery and the endpoint test task stay forwarded.
use crate::{js::prototype_key, params, strategy_loads};
use pacer_config::strategy::load_strategy;
use pacer_engine::usage_refresh::refresh_capability;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use serde_json::Value;

const ENDPOINT_REQUIRED: &str = "a configured endpoint account is required";

fn strategy(ctx: &Ctx, name: Option<&str>) -> Option<Value> {
    if name.is_some_and(prototype_key) || !strategy_loads(ctx) {
        return None;
    }
    load_strategy(&ctx.pacer_home).ok()
}

/// `accountUsageCapability` for an account the check cannot start a job for.
fn usage_refusal(ctx: &Ctx, params: &Value) -> Option<CoreError> {
    let (name, consent) = params::usage_check(params)?;
    let s = strategy(ctx, Some(&name))?;
    let Some(account) = s["accounts"].get(&name) else {
        return Some(CoreError::new(
            Code::InvalidInput,
            format!("Unknown account {name}"),
        ));
    };
    let message = if account["usage"] == "unmetered" {
        "Unmetered. This account has no quota to check."
    } else if account["kind"] == "claude" && account["usage"] == "quota" {
        if consent {
            return None;
        }
        "This usage check consumes account quota. Confirm Run usage check to continue."
    } else if refresh_capability(account) != "unavailable" {
        return None;
    } else {
        "Only limit hits are observable for this account. A current quota balance is unavailable."
    };
    Some(CoreError::new(Code::NotAllowed, message))
}

/// `readKey` is empty for an unset environment variable or a missing or empty
/// key file; `None` leaves other sources to TypeScript.
fn key_missing(ctx: &Ctx, name: &str, source: &str) -> Option<bool> {
    if source == "none" {
        return Some(false);
    }
    if let Some(var) = source.strip_prefix("env:") {
        return Some(ctx.env.get(var).is_none_or(String::is_empty));
    }
    if source != "file" {
        return None;
    }
    match std::fs::metadata(ctx.pacer_home.join("secrets").join(format!("{name}.key"))) {
        Ok(meta) if meta.is_file() => Some(meta.len() == 0),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(true),
        _ => None,
    }
}

/// `listModels` before discovery.
fn models_refusal(ctx: &Ctx, params: &Value) -> Option<CoreError> {
    let (name, base_url) = params::models_params(params)?;
    let refuse = |message: &str| Some(CoreError::new(Code::InvalidInput, message));
    let connection = match &name {
        None => None,
        Some(name) => {
            let s = strategy(ctx, Some(name))?;
            match s["accounts"].get(name).filter(|a| a["kind"] == "endpoint") {
                None => return refuse(ENDPOINT_REQUIRED),
                Some(a) => a.get("connection").filter(|c| c.is_object()).cloned(),
            }
        }
    };
    let configured = connection.as_ref().and_then(|c| c["base_url"].as_str());
    if base_url.as_deref().or(configured).is_none_or(str::is_empty) {
        return refuse("endpoint base URL is required");
    }
    let c = connection?;
    let source = c["key"].as_str()?;
    key_missing(ctx, name.as_deref()?, source)?.then(|| {
        CoreError::new(
            Code::InvalidInput,
            "Key missing: configure the endpoint key before discovery",
        )
    })
}

/// `testEndpoint`'s account check.
fn test_refusal(ctx: &Ctx, params: &Value) -> Option<CoreError> {
    let name = params::test_params(params)?;
    let s = strategy(ctx, Some(&name))?;
    s["accounts"]
        .get(&name)
        .is_none_or(|a| a["kind"] != "endpoint")
        .then(|| CoreError::new(Code::InvalidInput, ENDPOINT_REQUIRED))
}

pub(crate) fn refusal(ctx: &Ctx, op: &str, params: &Value) -> Option<CoreError> {
    match op {
        "account.usage.check" => usage_refusal(ctx, params),
        "account.models" => models_refusal(ctx, params),
        "account.test" => test_refusal(ctx, params),
        _ => None,
    }
}
