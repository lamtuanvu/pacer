#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::files_search::executor_session;
use pacer_lifecycle::TASK_KINDS;
use pacer_store::TaskStore;
use serde_json::{Map, Value};

use super::files_search_ops::providers;
use super::lifecycle_ops::{
    invalid, object, optional_expect_rev, project_api_task, require_string, type_name,
};

/// Executor sessions may review only a child they dispatched through a valid work grant (F4); the
/// native front door only ever handles plain non-work reviews, which an executor may never make.
const TASK_REVIEW_REFUSAL: &str = "PACER_ROLE=executor: executors cannot review their own task; only a child they dispatched this run (use pacer dispatch review).";

/// Native effects for `task.review`, supplied by `pacer-server` from its
/// delegation runtime. Validation and the executor refusal stay in this crate;
/// every accepted verdict is carried out by the implementation.
pub trait ReviewEffects: Send + Sync {
    fn review<'a>(&'a self, ctx: &'a Ctx, params: &'a Value) -> OpFuture<'a>;
}

/// TypeScript `isExecutorSession`: PACER_ROLE=executor, a cwd inside a pacer task worktree, or an
/// Orca workspace lane. `cwd` is the serving process's working directory.
fn is_executor_session(ctx: &Ctx, cwd: &std::path::Path) -> bool {
    executor_session(ctx, cwd, || providers(ctx))
}

pub fn task_review_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "task review effects bridge unavailable",
        ))
    })
}

fn require_task_id(params: &Map<String, Value>, name: &str) -> Result<String, CoreError> {
    let id = require_string(params, name)?;
    let id_units = id.encode_utf16().count();
    if id.is_empty() {
        return Err(invalid(
            "id: Too small: expected string to have >=1 characters",
        ));
    }
    if id_units > 128 {
        return Err(invalid(
            "id: Too big: expected string to have <=128 characters",
        ));
    }
    Ok(id.to_owned())
}

fn optional_kind(params: &Map<String, Value>) -> Result<Option<String>, CoreError> {
    match params.get("kind") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            if TASK_KINDS.contains(&s.as_str()) {
                Ok(Some(s.clone()))
            } else {
                Err(invalid(format!("unknown kind \"{s}\"")))
            }
        }
        Some(other) => Err(invalid(format!(
            "kind: Invalid input: expected string, received {}",
            type_name(other)
        ))),
    }
}

fn optional_note(params: &Map<String, Value>) -> Result<Option<String>, CoreError> {
    match params.get("note") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            if s.encode_utf16().count() > 2000 {
                Err(invalid("note: Too big: expected string to have <=2000 characters"))
            } else {
                Ok(Some(s.clone()))
            }
        }
        Some(other) => Err(invalid(format!(
            "note: Invalid input: expected string, received {}",
            type_name(other)
        ))),
    }
}

fn optional_executor(params: &Map<String, Value>) -> Result<Option<String>, CoreError> {
    match params.get("executor") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(other) => Err(invalid(format!(
            "executor: Invalid input: expected string, received {}",
            type_name(other)
        ))),
    }
}

fn optional_expect_state(params: &Map<String, Value>) -> Result<Option<String>, CoreError> {
    match params.get("expect_state") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(other) => Err(invalid(format!(
            "expect_state: Invalid input: expected string, received {}",
            type_name(other)
        ))),
    }
}

fn parse_verdict(params: &Map<String, Value>) -> Result<&'static str, CoreError> {
    match require_string(params, "verdict")? {
        "accept" => Ok("accept"),
        "reject" => Ok("reject"),
        "send_back" => Ok("send_back"),
        "retry" => Ok("retry"),
        other => Err(invalid(format!(
            "verdict: Invalid option: expected one of \"accept\"|\"reject\"|\"send_back\"|\"retry\", received \"{other}\""
        ))),
    }
}

pub fn task_review<'a>(
    ctx: &'a Ctx,
    params: Value,
    effects: &'a dyn ReviewEffects,
) -> OpFuture<'a> {
    Box::pin(async move {
        if params.get("accepted").is_some() {
            return Err(invalid(
                "task.review requires verdict; accepted was removed in protocol 3",
            ));
        }
        if is_executor_session(ctx, &std::env::current_dir().unwrap_or_default()) {
            return Err(CoreError::new(Code::NotAllowed, TASK_REVIEW_REFUSAL));
        }
        let p = object(&params)?;
        let id = require_task_id(p, "id")?;
        let verdict = parse_verdict(p)?;
        let _kind = optional_kind(p)?;
        let note = optional_note(p)?;
        let executor = optional_executor(p)?;
        let expect_rev = optional_expect_rev(p)?;
        let expect_state = optional_expect_state(p)?;
        if verdict == "send_back" && note.as_deref().is_none_or(|note| note.trim().is_empty()) {
            return Err(invalid("send_back requires a note"));
        }
        if verdict == "retry" && executor.as_deref().is_none_or(|executor| executor.trim().is_empty())
        {
            return Err(invalid("retry requires an executor"));
        }
        let mut store = TaskStore::open(&ctx.pacer_home)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        let current = store
            .read(&id)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?
            .ok_or_else(|| CoreError::new(Code::UnknownTask, format!("unknown task {id}")))?;
        if let Some(expected) = expect_rev
            && current.get("rev").and_then(Value::as_f64) != Some(expected)
        {
            let projected = project_api_task(ctx, &mut store, &current).ok();
            let mut err = CoreError::new(Code::Conflict, "task changed");
            if let Some(task) = projected {
                let mut data = Map::new();
                data.insert("task".into(), task);
                err = err.data(data);
            }
            return Err(err);
        }
        if let Some(expected) = &expect_state {
            let state = current.get("state").and_then(Value::as_str).unwrap_or("");
            if state != expected.as_str() {
                let projected = project_api_task(ctx, &mut store, &current).ok();
                let mut err = CoreError::new(Code::Conflict, "task state changed");
                if let Some(task) = projected {
                    let mut data = Map::new();
                    data.insert("task".into(), task);
                    err = err.data(data);
                }
                return Err(err);
            }
        }
        drop(store);
        effects.review(ctx, &params).await
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use pacer_foundation::api::OpFuture;
    use serde_json::json;
    use std::collections::HashMap;

    struct Effects;
    impl ReviewEffects for Effects {
        fn review<'a>(&'a self, _: &'a Ctx, params: &'a Value) -> OpFuture<'a> {
            let value = params.clone();
            Box::pin(async move { Ok(value) })
        }
    }

    fn ctx(env: &[(&str, &str)]) -> Ctx {
        let home = tempfile::tempdir().unwrap();
        let pacer_home = home.path().join(".pacer");
        let env = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect::<HashMap<_, _>>();
        Ctx::with(home.path().into(), pacer_home, env, 1.0)
    }

    #[tokio::test]
    async fn executor_session_is_refused_before_any_effects() {
        let ctx = ctx(&[("PACER_ROLE", "executor")]);
        let result = task_review(
            &ctx,
            json!({ "id": "t-20261106-000000-abcd", "verdict": "accept" }),
            &Effects,
        )
        .await;
        let error = result.unwrap_err();
        assert_eq!(error.code, Code::NotAllowed);
        assert_eq!(error.message, TASK_REVIEW_REFUSAL);
    }

    #[tokio::test]
    async fn non_executor_session_proceeds_past_the_refusal() {
        let ctx = ctx(&[]);
        // Without a stored task the handler fails after the refusal with unknown_task; the
        // point here is that an empty env is NOT refused with the executor message.
        let result = task_review(
            &ctx,
            json!({ "id": "t-20261106-000000-abcd", "verdict": "accept" }),
            &Effects,
        )
        .await;
        let error = result.unwrap_err();
        assert_ne!(error.code, Code::NotAllowed);
    }

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn all_four_verdicts_parse() {
        assert_eq!(parse_verdict(&map(json!({"verdict":"accept"}))).unwrap(), "accept");
        assert_eq!(parse_verdict(&map(json!({"verdict":"reject"}))).unwrap(), "reject");
        assert_eq!(parse_verdict(&map(json!({"verdict":"send_back"}))).unwrap(), "send_back");
        assert_eq!(parse_verdict(&map(json!({"verdict":"retry"}))).unwrap(), "retry");
        assert!(parse_verdict(&map(json!({"verdict":"nope"}))).is_err());
    }

    /// Parity with TypeScript `isExecutorSession`: an executor is detected by PACER_ROLE **or** by a
    /// cwd inside a pacer task worktree under `<pacerHome>/worktrees` (no env var required).
    #[test]
    fn executor_detection_matches_type_script_for_env_and_cwd() {
        use std::path::Path;
        // Env mode: PACER_ROLE alone marks an executor, whatever the cwd.
        let env_ctx = ctx(&[("PACER_ROLE", "executor")]);
        assert!(is_executor_session(&env_ctx, Path::new("/tmp/unrelated")));
        // Plain sessions are not executors.
        let plain = ctx(&[]);
        assert!(!is_executor_session(&plain, Path::new("/tmp/unrelated")));

        // cwd mode: no env var, but the cwd resolves under <pacerHome>/worktrees/<repo>/<taskId>.
        let dir = tempfile::tempdir().unwrap();
        let pacer_home = dir.path().join(".pacer");
        let cwd = pacer_home
            .join("worktrees")
            .join("repo")
            .join("t-20261106-000000-abcd")
            .join("src");
        let cwd_ctx = Ctx::with(dir.path().into(), pacer_home.clone(), HashMap::new(), 1.0);
        assert!(
            is_executor_session(&cwd_ctx, &cwd),
            "cwd inside a pacer task worktree must classify as an executor"
        );
        // A sibling path under the same pacer home but outside a task worktree is not.
        assert!(!is_executor_session(
            &cwd_ctx,
            &pacer_home.join("worktrees").join("repo")
        ));
    }
}
