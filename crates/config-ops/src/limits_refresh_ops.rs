//! `limits.refresh` for accounts without a refresh source (`refreshAccountUsage` and
//! `refreshAllUsage` in `src/usage/refresh.ts`). Such accounts answer `unsupported` before any
//! usage read; an account whose usage a provider command or passive log must read forwards,
//! because the read runs the usage plugin and the per-process refresh coordinator.
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.
use pacer_config::strategy::load_strategy;
use pacer_engine::usage_refresh::refresh_capability;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Map, Value, json};

/// Names `strategy.accounts[name]` resolves through `Object.prototype` in TypeScript.
const PROTOTYPE_KEYS: [&str; 12] = [
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];

enum Plan {
    Native(Value),
    Forward,
}

pub fn limits_refresh_stays_forwarded(ctx: &Ctx, params: &Value) -> bool {
    matches!(plan(ctx, params), Ok(Plan::Forward))
}

pub fn limits_refresh(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        match plan(ctx, &params)? {
            Plan::Native(result) => Ok(result),
            Plan::Forward => Err(CoreError::new(
                Code::Unavailable,
                "account configuration changed during the request",
            )
            .hint("Retry limits.refresh.")),
        }
    })
}

fn plan(ctx: &Ctx, params: &Value) -> Result<Plan, CoreError> {
    crate::runner_ops::authorize(ctx)?;
    let account = account_param(&crate::runner_ops::params_object(params)?)?;
    let Ok(strategy) = load_strategy(&ctx.pacer_home) else {
        return Ok(Plan::Forward);
    };
    let empty = Map::new();
    let accounts = strategy["accounts"].as_object().unwrap_or(&empty);
    let names: Vec<&String> = match &account {
        Some(name) if PROTOTYPE_KEYS.contains(&name.as_str()) => return Ok(Plan::Forward),
        Some(name) => match accounts.get_key_value(name) {
            Some((key, _)) => vec![key],
            None => {
                return Err(
                    crate::runner_ops::invalid(format!("Unknown account {name}"))
                        .hint("Run pacer account list to see configured accounts."),
                );
            }
        },
        None if accounts.contains_key("__proto__") => return Ok(Plan::Forward),
        None => object_keys(accounts),
    };
    let mut rows = Vec::new();
    for name in names {
        let capability = refresh_capability(&accounts[name.as_str()]);
        if capability != "unavailable" {
            return Ok(Plan::Forward);
        }
        rows.push(
            json!({"account": name, "capability": capability, "outcome": "unsupported",
            "capturedAt": null, "source": null, "error": null}),
        );
    }
    Ok(Plan::Native(json!({"accounts": rows})))
}

/// `account: id.optional()`, where `id` is a string of 1 to 128 UTF-16 units.
fn account_param(map: &Map<String, Value>) -> Result<Option<String>, CoreError> {
    match map.get("account") {
        None => Ok(None),
        Some(Value::String(name)) => match name.encode_utf16().count() {
            0 => Err(crate::runner_ops::invalid(
                "account: Too small: expected string to have >=1 characters",
            )),
            n if n > 128 => Err(crate::runner_ops::invalid(
                "account: Too big: expected string to have <=128 characters",
            )),
            _ => Ok(Some(name.clone())),
        },
        Some(other) => Err(crate::runner_ops::invalid(format!(
            "account: Invalid input: expected string, received {}",
            crate::runner_ops::type_name(other)
        ))),
    }
}

/// `Object.keys`: array-index keys in ascending order, then the rest in insertion order.
fn object_keys(map: &Map<String, Value>) -> Vec<&String> {
    let index = |key: &str| {
        key.parse::<u32>()
            .ok()
            .filter(|n| *n < u32::MAX && n.to_string() == key)
    };
    let mut keys: Vec<&String> = map.keys().filter(|k| index(k).is_some()).collect();
    keys.sort_by_key(|k| index(k));
    keys.extend(map.keys().filter(|k| index(k).is_none()));
    keys
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::collections::HashMap;

    fn ctx(strategy: &str) -> (tempfile::TempDir, Ctx) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("strategy.yaml"), strategy).unwrap();
        let ctx = Ctx::with(dir.path().into(), dir.path().into(), HashMap::new(), 1.0);
        (dir, ctx)
    }

    fn call(ctx: &Ctx, params: Value) -> Result<Value, CoreError> {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(limits_refresh(ctx, params))
    }

    const CURSOR_ONLY: &str =
        "planner: cursor\naccounts:\n  cursor: {kind: cursor}\nrunners:\n  cursor: {}\n";

    #[test]
    fn accounts_without_a_refresh_source_answer_unsupported() {
        let (_dir, ctx) = ctx(CURSOR_ONLY);
        assert!(!limits_refresh_stays_forwarded(&ctx, &json!({})));
        let rows = call(&ctx, json!({})).unwrap()["accounts"].clone();
        assert_eq!(rows[0]["account"], "cursor");
        assert_eq!(rows[0]["outcome"], "unsupported");
        assert_eq!(
            call(&ctx, json!({"account": "cursor"})).unwrap()["accounts"],
            rows
        );
        let unknown = call(&ctx, json!({"account": "nope"})).unwrap_err();
        assert_eq!(unknown.message, "Unknown account nope");
        assert!(limits_refresh_stays_forwarded(
            &ctx,
            &json!({"account": "constructor"})
        ));
    }

    #[test]
    fn invalid_params_use_the_published_schema() {
        let (_dir, ctx) = ctx(CURSOR_ONLY);
        let message = |params| call(&ctx, params).unwrap_err().message;
        assert_eq!(
            message(json!({"account": 1})),
            "account: Invalid input: expected string, received number"
        );
        assert_eq!(
            message(json!({"account": ""})),
            "account: Too small: expected string to have >=1 characters"
        );
        assert_eq!(
            message(json!("x")),
            "params: Invalid input: expected object, received string"
        );
    }

    #[test]
    fn readable_accounts_and_broken_strategies_forward() {
        for strategy in ["planner:\n  agent: claude-code\n", "planner: [\n"] {
            let (_dir, ctx) = ctx(strategy);
            assert!(limits_refresh_stays_forwarded(&ctx, &json!({})));
        }
    }
}
