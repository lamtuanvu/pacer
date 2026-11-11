//! Native `runner.check` refusals (`checkRunner` in `src/core/runner-check.ts`).
//!
//! The public schema is `z.object({id})`: unknown keys such as `test` are
//! stripped, so every accepted input starts the check job. Rust answers what
//! TypeScript refuses before `startJob` (the enforcement identity, params and
//! unknown runners). A configured runner forwards, because its check steps
//! (CLI detection, sign-in, usage and the scratch test task) run in the
//! TypeScript job registry. An unloadable strategy and prototype-key ids
//! forward too, so TypeScript reports them in its own words.
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.
use crate::limits_refresh_ops::PROTOTYPE_KEYS;
use crate::runner_ops::{authorize, invalid, params_object, type_name};
use pacer_config::strategy::load_strategy;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::resolve_runner;
use serde_json::Value;

enum Plan {
    Refuse(CoreError),
    Forward,
}

/// Inputs that start the check job, or that only TypeScript reports.
pub fn runner_check_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    op == "runner.check" && matches!(plan(ctx, params), Plan::Forward)
}

pub fn runner_check(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        match plan(ctx, &params) {
            Plan::Refuse(error) => Err(error),
            Plan::Forward => Err(CoreError::new(
                Code::Unavailable,
                "runner.check runs its check job in the forwarded operation",
            )
            .hint("Retry runner.check.")),
        }
    })
}

fn plan(ctx: &Ctx, params: &Value) -> Plan {
    match check_id(ctx, params) {
        Err(error) => Plan::Refuse(error),
        Ok(id) if PROTOTYPE_KEYS.contains(&id.as_str()) => Plan::Forward,
        Ok(id) => match load_strategy(&ctx.pacer_home) {
            Err(_) => Plan::Forward,
            Ok(strategy) if resolve_runner(&strategy, &id).is_some() => Plan::Forward,
            Ok(_) => Plan::Refuse(CoreError::new(
                Code::UnknownExecutor,
                format!("unknown runner {id}"),
            )),
        },
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

    fn refusal(ctx: &Ctx, params: Value) -> CoreError {
        match plan(ctx, &params) {
            Plan::Refuse(error) => error,
            Plan::Forward => panic!("{params} forwarded"),
        }
    }

    #[test]
    fn validates_id_like_the_public_schema() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_with(dir.path(), &[]);
        assert_eq!(
            refusal(&ctx, json!({})).message,
            "id: Invalid input: expected string, received undefined"
        );
        assert_eq!(
            refusal(&ctx, json!({"id": 1})).message,
            "id: Invalid input: expected string, received number"
        );
        assert_eq!(
            refusal(&ctx, json!({"id": ""})).message,
            "id: Too small: expected string to have >=1 characters"
        );
        assert_eq!(
            refusal(&ctx, json!({"id": "😀".repeat(129)})).message,
            "id: Too big: expected string to have <=128 characters"
        );
        assert_eq!(
            check_id(&ctx, &json!({"id": "😀".repeat(128)})).unwrap(),
            "😀".repeat(128)
        );
        assert_eq!(
            refusal(&ctx, json!([])).message,
            "params: Invalid input: expected object, received array"
        );
        let token = ctx_with(dir.path(), &[("PACER_ENFORCEMENT_TOKEN", "t")]);
        assert_eq!(
            refusal(&token, json!({"id": "codex"})).code,
            Code::NotAllowed
        );
    }

    #[test]
    fn refuses_unknown_runners_and_forwards_the_check_job() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("strategy.yaml"), STRATEGY).unwrap();
        let ctx = ctx_with(dir.path(), &[]);
        let unknown = refusal(&ctx, json!({"id": "cursor", "test": false}));
        assert_eq!(unknown.code, Code::UnknownExecutor);
        assert_eq!(unknown.message, "unknown runner cursor");
        assert!(unknown.hint.is_none());
        for params in [
            json!({"id": "codex"}),
            json!({"id": "codex", "test": false}),
            json!({"id": "codex#codex@local"}),
            json!({"id": "constructor"}),
        ] {
            assert!(runner_check_stays_forwarded(&ctx, "runner.check", &params));
        }
        assert!(!runner_check_stays_forwarded(
            &ctx,
            "runner.add",
            &json!({"id": "codex"})
        ));
        std::fs::write(dir.path().join("strategy.yaml"), "planner: [\n").unwrap();
        assert!(runner_check_stays_forwarded(
            &ctx,
            "runner.check",
            &json!({"id": "nope"})
        ));
    }
}
