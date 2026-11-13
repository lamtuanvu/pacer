//! P5 engine ops: pause/resume, mode hold/release and `limits.report`. `mode.hold`
//! without `until` reads the planner account's reset from the usage-broker parts.
//! P5c/P5d broker-backed status ops live in `status_ops`.
#![allow(clippy::result_large_err)]
use crate::strategy_load;
use pacer_config::{config_writes, strategy::load_strategy};
use pacer_engine::{exhausted, mode_hold, pause, status};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Value, json};

const MODES: [&str; 4] = ["strict", "normal", "relaxed", "emergency"];

/// `mode.hold` without `until` loads the strategy; one Rust does not load the way
/// TypeScript does keeps `loadStrategy`'s error text. An `until` Rust cannot write as
/// `JSON.stringify` does also forwards.
pub fn mode_hold_stays_forwarded(ctx: &Ctx, params: &Value) -> bool {
    match params.get("until") {
        None => !matches!(strategy_load::native_load(&ctx.pacer_home), Some(Ok(_))),
        Some(until) => until
            .as_f64()
            .is_some_and(|until| until >= mode_hold::UNTIL_WRITTEN_IN_FULL),
    }
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn object(params: &Value) -> Result<&serde_json::Map<String, Value>, CoreError> {
    params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(params)
        ))
    })
}

fn optional_string<'a>(
    params: &'a serde_json::Map<String, Value>,
    name: &str,
) -> Result<Option<&'a str>, CoreError> {
    match params.get(name) {
        None => Ok(None),
        Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(other) => Err(invalid(format!(
            "{name}: Invalid input: expected string, received {}",
            type_name(other)
        ))),
    }
}

fn require_string<'a>(
    params: &'a serde_json::Map<String, Value>,
    name: &str,
) -> Result<&'a str, CoreError> {
    match params.get(name) {
        Some(Value::String(s)) if !s.is_empty() => Ok(s.as_str()),
        Some(Value::String(_)) => Err(invalid(format!(
            "{name}: Too small: expected string to have >=1 characters"
        ))),
        Some(other) => Err(invalid(format!(
            "{name}: Invalid input: expected string, received {}",
            type_name(other)
        ))),
        None => Err(invalid(format!(
            "{name}: Invalid input: expected string, received undefined"
        ))),
    }
}

fn publish_report(report: pacer_store::PublishReport) {
    for error in report.errors {
        eprintln!("pacer: engine op publication failed: {error}");
    }
}

fn map_io(error: String) -> CoreError {
    invalid(error)
}

pub fn delegation_pause(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let p = object(&params)?;
        let duration = require_string(p, "for")?;
        let reason = optional_string(p, "reason")?;
        let result = pause::pause(ctx, duration, reason, None).map_err(map_io)?;
        publish_report(pacer_store::publish(
            ctx,
            &[json!({"type":"pause","data": result.clone()})],
        ));
        if let Err(error) = pacer_store::append_activity(
            ctx,
            json!({"kind":"config","level":"info","text": format!("Delegation paused for {duration}")}),
        ) {
            return Err(invalid(error.to_string()));
        }
        Ok(result)
    })
}

pub fn delegation_resume(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let _ = object(&params)?;
        let result = pause::resume(ctx).map_err(map_io)?;
        publish_report(pacer_store::publish(
            ctx,
            &[json!({"type":"pause","data":{"removed":true}})],
        ));
        if let Err(error) = pacer_store::append_activity(
            ctx,
            json!({"kind":"config","level":"info","text":"Delegation resumed"}),
        ) {
            return Err(invalid(error.to_string()));
        }
        Ok(result)
    })
}

/// The `mode.hold` Zod schema: issues in key order, `null` params read as `{}`.
fn parse_hold(params: &Value) -> Result<(&'static str, Option<f64>), CoreError> {
    let empty = serde_json::Map::new();
    let p = if params.is_null() {
        &empty
    } else {
        object(params)?
    };
    let mut issues = Vec::new();
    let given = p.get("mode").and_then(Value::as_str);
    let mode = match MODES.into_iter().find(|mode| given == Some(*mode)) {
        Some(mode) => mode,
        None => {
            issues.push(format!(
                "mode: Invalid option: expected one of {}",
                MODES.map(|m| format!("\"{m}\"")).join("|")
            ));
            ""
        }
    };
    let until = match p.get("until") {
        None => None,
        Some(Value::Number(n)) => n.as_f64(),
        Some(other) => {
            issues.push(format!(
                "until: Invalid input: expected number, received {}",
                type_name(other)
            ));
            None
        }
    };
    if !issues.is_empty() {
        return Err(invalid(issues.join("; ")));
    }
    Ok((mode, until))
}

/// `holdMode`: without `until`, hold until the planner account's `resetsAt` in the broker
/// parts, or for a week.
pub async fn mode_hold(
    ctx: &Ctx,
    params: Value,
    parts: Option<OpFuture<'_>>,
) -> Result<Value, CoreError> {
    let (mode, until) = parse_hold(&params)?;
    let until = match until {
        Some(until) => until,
        None => {
            let strategy = load_strategy(&ctx.pacer_home)
                .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
            let parts = parts
                .ok_or_else(|| {
                    CoreError::new(Code::Unavailable, "usage broker bridge unavailable")
                })?
                .await?;
            let planner = strategy["planner"]["account"].as_str().unwrap_or_default();
            status::default_mode_hold_until(&parts, planner, ctx.now)
        }
    };
    mode_hold::hold(ctx, mode, until).map_err(map_io)
}

pub fn mode_hold_op(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(mode_hold(ctx, params, None))
}

pub fn mode_release(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let _ = object(&params)?;
        mode_hold::release(ctx).map_err(map_io)
    })
}

pub fn limits_report(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let p = object(&params)?;
        let provider = require_string(p, "provider")?;
        if provider.chars().count() > 128 {
            return Err(invalid(
                "provider: Too big: expected string to have <=128 characters",
            ));
        }
        let until = match p.get("until") {
            None => None,
            Some(Value::Number(n)) => Some(n.as_f64().ok_or_else(|| {
                invalid("until: Invalid input: expected number, received number")
            })?),
            Some(other) => {
                return Err(invalid(format!(
                    "until: Invalid input: expected number, received {}",
                    type_name(other)
                )));
            }
        };
        let strategy = load_strategy(&ctx.pacer_home).map_err(|e| invalid(e.to_string()))?;
        let runner = config_writes::resolve(&strategy, provider);
        let runner_id = runner
            .and_then(|r| r.get("id").and_then(Value::as_str))
            .unwrap_or(provider);
        let cfg = strategy.get("providers").and_then(|p| p.get(runner_id));
        let Some(cfg) = cfg else {
            return Err(CoreError::new(
                Code::UnknownExecutor,
                format!("unknown provider \"{provider}\""),
            ));
        };
        let exhausted_until = match until {
            Some(value) => {
                if !value.is_finite() {
                    return Err(invalid("until must be unix seconds"));
                }
                value
            }
            None => {
                let cooldown = cfg
                    .get("cooldownS")
                    .and_then(Value::as_f64)
                    .unwrap_or(21600.0);
                ctx.now + cooldown
            }
        };
        let account = runner
            .and_then(|r| r.get("account").and_then(Value::as_str))
            .unwrap_or(provider);
        exhausted::mark_exhausted(ctx, account, exhausted_until, true).map_err(map_io)?;
        Ok(json!({
            "provider": provider,
            "account": account,
            "exhaustedUntil": exhausted_until,
        }))
    })
}

/// Native engine operations provided to the server registry.
pub const fn ops() -> &'static [pacer_foundation::api::NativeOp] {
    use pacer_foundation::api::NativeOp;
    &[
        NativeOp {
            name: "delegation.pause",
            call: delegation_pause,
        },
        NativeOp {
            name: "delegation.resume",
            call: delegation_resume,
        },
        NativeOp {
            name: "mode.hold",
            call: mode_hold_op,
        },
        NativeOp {
            name: "mode.release",
            call: mode_release,
        },
        NativeOp {
            name: "limits.report",
            call: limits_report,
        },
    ]
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use pacer_foundation::Ctx;
    use std::collections::HashMap;
    use tempfile::tempdir;

    fn ctx(now: f64) -> (tempfile::TempDir, Ctx) {
        let dir = tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let pacer_home = home.join(".pacer");
        std::fs::create_dir_all(pacer_home.join("state")).unwrap();
        std::fs::write(
            pacer_home.join("strategy.yaml"),
            "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n  cursor: {cooldown: 6h}\n",
        )
        .unwrap();
        let ctx = Ctx::with(home, pacer_home, HashMap::new(), now);
        (dir, ctx)
    }

    #[tokio::test]
    async fn pause_resume_publish_and_clear() {
        let (_dir, ctx) = ctx(1_000.0);
        let paused = delegation_pause(&ctx, json!({"for":"1h","reason":"break"}))
            .await
            .unwrap();
        assert_eq!(paused["until"], 4600.0);
        assert!(pause::read_pause(&ctx).is_some());
        let resumed = delegation_resume(&ctx, json!({})).await.unwrap();
        assert_eq!(resumed, json!({"resumed": true}));
        assert!(pause::read_pause(&ctx).is_none());
    }

    #[tokio::test]
    async fn mode_hold_with_until_and_release_clears() {
        let (_dir, ctx) = ctx(100.0);
        assert!(!mode_hold_stays_forwarded(&ctx, &json!({"mode":"normal"})));
        for (until, forwarded) in [(18_446_744_073_709_549_568.0, false), (2f64.powi(64), true)] {
            let params = json!({"mode":"normal","until":until});
            assert_eq!(mode_hold_stays_forwarded(&ctx, &params), forwarded);
        }
        let held = mode_hold_op(&ctx, json!({"mode":"emergency","until":160.0}))
            .await
            .unwrap();
        assert_eq!(held.to_string(), r#"{"mode":"emergency","until":160}"#);
        assert_eq!(
            mode_release(&ctx, json!({})).await.unwrap(),
            json!({"released": true})
        );
    }

    #[tokio::test]
    async fn mode_hold_without_until_reads_the_planner_reset() {
        let (_dir, ctx) = ctx(100.0);
        let parts = |reset: Value| -> Option<OpFuture<'static>> {
            Some(Box::pin(async move {
                Ok(
                    json!({"accounts": [{"name": "codex", "resetsAt": 900}, {"name": "claude-code", "resetsAt": reset}]}),
                )
            }))
        };
        let hold = |p| mode_hold(&ctx, json!({"mode": "strict"}), p);
        assert_eq!(
            hold(parts(json!(500))).await.unwrap().to_string(),
            r#"{"mode":"strict","until":500}"#
        );
        assert_eq!(
            hold(parts(Value::Null)).await.unwrap()["until"],
            json!(604_900)
        );
        let past = hold(parts(json!(50))).await.unwrap_err();
        assert_eq!(
            past.message,
            "mode hold until must be a future unix timestamp"
        );
        let missing = hold(None).await.unwrap_err();
        assert_eq!(missing.code, Code::Unavailable);
        let bad = mode_hold(&ctx, json!({"mode": "x", "until": "y"}), None)
            .await
            .unwrap_err();
        assert_eq!(
            bad.message,
            "mode: Invalid option: expected one of \"strict\"|\"normal\"|\"relaxed\"|\"emergency\"; until: Invalid input: expected number, received string"
        );
        std::fs::write(ctx.pacer_home.join("strategy.yaml"), "planner: [\n").unwrap();
        assert!(mode_hold_stays_forwarded(&ctx, &json!({"mode":"normal"})));
        assert!(!mode_hold_stays_forwarded(
            &ctx,
            &json!({"mode":"normal","until":200.0})
        ));
    }

    #[tokio::test]
    async fn limits_report_marks_account_with_cooldown_default() {
        let (_dir, ctx) = ctx(1_000.0);
        let reported = limits_report(&ctx, json!({"provider":"cursor"}))
            .await
            .unwrap();
        assert_eq!(reported["account"], "cursor");
        assert_eq!(reported["exhaustedUntil"], 1_000.0 + 21600.0);
        assert_eq!(exhausted::read_marks(&ctx)["cursor"], 1_000.0 + 21600.0);
        let explicit = limits_report(&ctx, json!({"provider":"codex","until":1_060.0}))
            .await
            .unwrap();
        assert_eq!(explicit["exhaustedUntil"], 1_060.0);
        assert_eq!(exhausted::read_marks(&ctx)["codex"], 1_060.0);
    }
}
