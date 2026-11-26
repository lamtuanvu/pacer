//! Native `runner.check` validation and the `JobStarter` seam.
//!
//! `checkRunner` (`src/core/runner-check.ts`) starts a job for every accepted
//! runner. The decision steps themselves live in
//! `pacer_lifecycle::runner_check::check`; the server implements [`JobStarter`]
//! over the delegation runtime, which gathers the case and starts the job.
//! This crate owns only the public schema, caller policy and the errors
//! TypeScript reports before a job starts.
#![allow(clippy::result_large_err)]
use crate::runner_ops::{authorize, invalid, params_object, type_name};
use pacer_config::strategy::load_strategy;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::resolve_runner;
use serde_json::Value;

/// Starts a runner-check job. Implemented in `pacer-server` over the
/// `pacer-delegation` runtime; the parity driver supplies a case-backed double.
pub trait JobStarter: Send + Sync {
    fn start<'a>(&'a self, ctx: &'a Ctx, params: &'a Value) -> OpFuture<'a>;
}

/// The registry handler. Both doors answer `runner.check` through the
/// [`JobStarter`] branch in `call_native`; this entry keeps the op discoverable
/// and gives a direct caller a clear error instead of a silent forward.
pub fn runner_check(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        validate(ctx, &params)?;
        Err(CoreError::new(
            Code::Unavailable,
            "runner.check requires a job starter",
        ))
    })
}

/// Validate the public input and start the job through `starter`.
pub fn runner_check_native<'a>(
    ctx: &'a Ctx,
    params: Value,
    starter: &'a (dyn JobStarter + 'a),
) -> OpFuture<'a> {
    Box::pin(async move {
        check_id(ctx, &params)?;
        match load_strategy(&ctx.pacer_home) {
            Err(error) => Err(CoreError::new(Code::Internal, error.to_string())),
            Ok(strategy) => {
                let id = params["id"].as_str().unwrap_or_default();
                if resolve_runner(&strategy, id).is_none() {
                    return Err(CoreError::new(
                        Code::UnknownExecutor,
                        format!("unknown runner {id}"),
                    ));
                }
                starter.start(ctx, &params).await
            }
        }
    })
}

fn validate(ctx: &Ctx, params: &Value) -> Result<(), CoreError> {
    check_id(ctx, params)?;
    match load_strategy(&ctx.pacer_home) {
        Err(error) => Err(CoreError::new(Code::Internal, error.to_string())),
        Ok(strategy) => {
            let id = params["id"].as_str().unwrap_or_default();
            if resolve_runner(&strategy, id).is_none() {
                Err(CoreError::new(
                    Code::UnknownExecutor,
                    format!("unknown runner {id}"),
                ))
            } else {
                Ok(())
            }
        }
    }
}

/// The caller policy, then `z.object({id: z.string().min(1).max(128)})`.
/// Zod measures string length in code points, not UTF-16 units.
fn check_id(ctx: &Ctx, params: &Value) -> Result<String, CoreError> {
    authorize(ctx)?;
    match params_object(params)?.get("id") {
        Some(Value::String(id)) => match id.chars().count() {
            0 => Err(invalid(
                "id: Too small: expected string to have >=1 characters",
            )),
            n if n > 128 => Err(invalid(
                "id: Too big: expected string to have <=128 characters",
            )),
            _ => Ok(id.clone()),
        },
        other => Err(invalid(format!(
            "id: Invalid input: expected string, received {}",
            other.map_or("undefined", type_name)
        ))),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    const STRATEGY: &str = "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nrunners:\n  claude-code: {}\n  codex: {}\n";

    fn ctx_with(dir: &std::path::Path, env: &[(&str, &str)]) -> Ctx {
        let env: HashMap<String, String> = env
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect();
        Ctx::with(dir.into(), dir.into(), env, 1.0)
    }

    struct Starter(bool);
    impl JobStarter for Starter {
        fn start<'a>(&'a self, _: &'a Ctx, _: &'a Value) -> OpFuture<'a> {
            let started = self.0;
            Box::pin(async move {
                if started {
                    Ok(json!({"kind":"runner.check","state":"passed"}))
                } else {
                    Err(CoreError::new(Code::Unavailable, "not started"))
                }
            })
        }
    }

    #[tokio::test]
    async fn validates_id_like_the_public_schema() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_with(dir.path(), &[]);
        let starter = Starter(true);
        for (params, message) in [
            (json!({}), "id: Invalid input: expected string, received undefined"),
            (json!({"id": 1}), "id: Invalid input: expected string, received number"),
            (json!({"id": ""}), "id: Too small: expected string to have >=1 characters"),
        ] {
            let error = runner_check_native(&ctx, params, &starter).await.unwrap_err();
            assert_eq!(error.message, message);
        }
        let token = ctx_with(dir.path(), &[("PACER_ENFORCEMENT_TOKEN", "t")]);
        assert_eq!(
            runner_check_native(&token, json!({"id":"codex"}), &starter)
                .await
                .unwrap_err()
                .code,
            Code::NotAllowed
        );
    }

    #[tokio::test]
    async fn starts_a_configured_runner_and_refuses_unknown_ones() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("strategy.yaml"), STRATEGY).unwrap();
        let ctx = ctx_with(dir.path(), &[]);
        let started = Starter(true);
        let job = runner_check_native(&ctx, json!({"id":"codex"}), &started)
            .await
            .unwrap();
        assert_eq!(job["kind"], "runner.check");
        let error = runner_check_native(&ctx, json!({"id":"cursor"}), &started)
            .await
            .unwrap_err();
        assert_eq!(error.code, Code::UnknownExecutor);
        assert_eq!(error.message, "unknown runner cursor");
    }
}
