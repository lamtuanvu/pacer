//! Native `runner.check`: gather the readiness case, run the shared decision
//! helper and persist the result under the `runner-checks` lock.
//!
//! `pacer_lifecycle::runner_check::check` owns every decision (CLI found,
//! sign-in, usage, model offered, scratch test task). This module owns the
//! effects around it: collecting the case snapshot, writing
//! `state/runner-checks.json` and shaping the job reply. Tests pass the case
//! snapshot directly through [`run_case`]; production gathers it through the
//! injected [`Runtime`](crate::runtime::Runtime).
#![allow(clippy::result_large_err)]

use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use serde_json::{Value, json};

fn checks_file(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("state").join("runner-checks.json")
}

/// `JSON.stringify` spelling for a finite integral `ctx.now`.
fn js_number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

static JOB_SEQ: AtomicU64 = AtomicU64::new(0);
fn job_id(ctx: &Ctx) -> String {
    let n = JOB_SEQ.fetch_add(1, Ordering::Relaxed);
    let micros = (ctx.now * 1_000_000.0) as u64;
    format!("rc-{micros}-{n}")
}

/// Publish the job entity the way `startJob` publishes each step change.
fn publish_job(ctx: &Ctx, job: &Value) {
    let env = Value::Object(
        ctx.env
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect(),
    );
    if let Some(value) = pacer_lifecycle::jobs::published(job, &env) {
        let event = json!({"type":"entity","data":{"kind":"job","id":job["id"],"value":value}});
        for error in pacer_store::publish(ctx, &[event]).errors {
            eprintln!("pacer: runner check publication failed: {error}");
        }
    }
}

fn read_raw(ctx: &Ctx) -> Value {
    fs::read(checks_file(ctx))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

/// Run the decision helper over a fully gathered case, persist its `stored`
/// map under `runner-checks` and return the job reply.
pub fn run_case(ctx: &Ctx, case: &Value) -> Result<Value, CoreError> {
    let out = pacer_lifecycle::runner_check::check(case);
    if out["error"]["code"] == "unknown_executor" {
        return Err(CoreError::new(
            Code::UnknownExecutor,
            out["error"]["message"].as_str().unwrap_or_default().to_string(),
        ));
    }
    let stored = out["stored"].clone();
    with_lock(ctx, "runner-checks", LockOptions::default(), || {
        fs::create_dir_all(ctx.pacer_home.join("state"))?;
        let bytes = serde_json::to_vec(&stored)?;
        write_private(&checks_file(ctx), &bytes)
    })
    .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?
    .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;

    let id = out["target"].as_str().unwrap_or_default().to_string();
    let failed = out.get("error").is_some();
    let pending: Vec<Value> = out["names"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|name| json!({"name": name, "state": "pending"}))
        .collect();
    let mut job = json!({
        "id": job_id(ctx),
        "kind": "runner.check",
        "target": id,
        "state": "running",
        "steps": pending,
        "startedAt": js_number(ctx.now),
        "pid": std::process::id(),
        "cancellable": false,
    });
    publish_job(ctx, &job);
    for event in out["steps"].as_array().into_iter().flatten() {
        let name = event["name"].clone();
        let state = match event["type"].as_str().unwrap_or_default() {
            "start" => "running",
            "pass" => "passed",
            "fail" => "failed",
            "skip" => "skipped",
            _ => continue,
        };
        if let Some(row) = job["steps"]
            .as_array_mut()
            .into_iter()
            .flatten()
            .find(|row| row["name"] == name)
        {
            row["state"] = state.into();
            if let Some(detail) = event.get("detail") {
                row["detail"] = detail.clone();
            }
        }
        publish_job(ctx, &job);
    }
    for row in job["steps"].as_array_mut().into_iter().flatten() {
        if row["state"] == "pending" {
            row["state"] = json!("skipped");
        }
    }
    job["state"] = json!(if failed { "failed" } else { "passed" });
    job["endedAt"] = js_number(ctx.now);
    if let Some(error) = out.get("error") {
        job["error"] = json!({
            "code": error["code"].as_str().unwrap_or("failed"),
            "message": error["message"].as_str().unwrap_or_default(),
        });
    }
    publish_job(ctx, &job);
    let jobs_dir = ctx.pacer_home.join("state").join("jobs");
    let bytes = serde_json::to_vec(&job)
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    with_lock(ctx, "jobs", LockOptions::default(), || {
        fs::create_dir_all(&jobs_dir)?;
        write_private(&jobs_dir.join(format!("{}.json", job["id"].as_str().unwrap_or_default())), &bytes)
    })
    .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?
    .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    Ok(job)
}

/// Build the decision case from the runtime effects. A test may supply the
/// entire case through `PACER_TEST_RUNNER_CHECK_CASE` so both doors decide on
/// byte-identical inputs.
pub fn start<'a>(ctx: &'a Ctx, runtime: &'a crate::Runtime, params: &'a Value) -> OpFuture<'a> {
    Box::pin(async move {
        let id = params["id"].as_str().unwrap_or_default().to_string();
        if let Ok(raw) = std::env::var("PACER_TEST_RUNNER_CHECK_CASE")
            && let Ok(mut case) = serde_json::from_str::<Value>(&raw)
        {
            case["now"] = js_number(ctx.now);
            case["id"] = json!(id);
            case["env"] = json!(ctx.env);
            case["raw"] = read_raw(ctx);
            return run_case(ctx, &case);
        }
        let strategy = pacer_config::strategy::load_strategy(&ctx.pacer_home)
            .map_err(|error| CoreError::new(Code::Unavailable, error.to_string()))?;
        let Some(runner) = pacer_lifecycle::resolve_runner(&strategy, &id) else {
            return Err(CoreError::new(
                Code::UnknownExecutor,
                format!("unknown runner {id}"),
            ));
        };
        let runner = runner.clone();
        let account = strategy["accounts"][runner["account"].as_str().unwrap_or_default()].clone();
        let found = detect(&ctx, runtime, &runner).await;
        let status = accounts_status(&ctx, runtime, &account).await;
        let row = limits_row(&ctx, runtime, &account, &id).await;
        let models = model_listing(&ctx, &strategy, &runner, &account);
        let test_error = test_task(&ctx, &runner, &account).await.err();
        let test_error = match test_error {
            Some(error) => json!(error),
            None => Value::Bool(false),
        };
        let case = json!({
            "id": id,
            "now": js_number(ctx.now),
            "runner": runner,
            "account": account,
            "found": found,
            "status": status,
            "signInReason": Value::Null,
            "row": row,
            "models": models,
            "testError": test_error,
            "refreshed": Value::Null,
            "env": json!(ctx.env),
            "raw": read_raw(ctx),
        });
        run_case(ctx, &case)
    })
}

/// `detectAgents` (`src/install/detection.ts`) for one runner. A plugin that
/// implements `agent.detect` is authoritative; otherwise the local PATH is
/// searched for the agent's binary.
async fn detect(ctx: &Ctx, runtime: &crate::Runtime, runner: &Value) -> Value {
    let agent = runner["agent"].as_str().unwrap_or_default();
    for plugin in runtime.plugins.providers(ctx, "agent.detect") {
        let params = json!({"host": runner["host"], "agent": agent});
        if let Ok(value) = runtime
            .plugins
            .call(ctx, &plugin, "agent.detect", params, std::time::Duration::from_secs(20))
            .await
            && let Some(row) = value.as_array().and_then(|rows| {
                rows.iter().find(|row| row["agent"] == agent)
            })
        {
            return row.clone();
        }
    }
    let binary = match agent {
        "agy" => "antigravity",
        "claude-code" => "claude",
        agent => agent,
    };
    let found = ctx
        .env
        .get("PATH")
        .map(|path| {
            std::env::split_paths(path).any(|dir| {
                let candidate = dir.join(binary);
                candidate.is_file()
            })
        })
        .unwrap_or(false);
    json!({
        "agent": agent,
        "found": found,
        "version": Value::Null,
        "path": Value::Null,
        "install_hint": format!("Install {binary} to use this executor"),
    })
}

async fn accounts_status(ctx: &Ctx, runtime: &crate::Runtime, account: &Value) -> Value {
    let name = account["name"].as_str().unwrap_or_default();
    for plugin in runtime.plugins.providers(ctx, "account.list") {
        if let Ok(value) = runtime
            .plugins
            .call(ctx, &plugin, "account.list", json!({}), std::time::Duration::from_secs(20))
            .await
            && let Some(row) = value
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row["name"] == name))
        {
            return row.clone();
        }
    }
    // A login indicator is host-owned state; without a plugin reading it the
    // check cannot claim the account is signed in.
    Value::Null
}

async fn limits_row(ctx: &Ctx, runtime: &crate::Runtime, account: &Value, id: &str) -> Value {
    let name = account["name"].as_str().unwrap_or_default();
    for plugin in runtime.plugins.providers(ctx, "limits.check") {
        if let Ok(value) = runtime
            .plugins
            .call(
                ctx,
                &plugin,
                "limits.check",
                json!({"runners": [id]}),
                std::time::Duration::from_secs(20),
            )
            .await
            && let Some(row) = value
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row["account"] == name))
        {
            return row.clone();
        }
    }
    Value::Null
}

fn model_listing(ctx: &Ctx, strategy: &Value, runner: &Value, account: &Value) -> Value {
    let id = runner["id"].as_str().unwrap_or_default();
    let listing = pacer_models::available_models(&ctx.pacer_home, ctx.now, strategy, id);
    let base = match listing {
        pacer_models::Listing::Known(list) => list,
        pacer_models::Listing::Unsupported
        | pacer_models::Listing::NeedsDiscovery(_)
        | pacer_models::Listing::Failed(_) => {
            return json!({
                "source": "none",
                "offered": Value::Null,
                "closest": [],
                "note": account["provider"].as_str().unwrap_or_default(),
            });
        }
    };
    let model = runner["model"].as_str().unwrap_or_default();
    let offered = pacer_models::is_offered(&base, model);
    let closest = pacer_models::closest_models(&base, model, 3);
    let source = match base.source {
        pacer_models::ModelSource::Opencode => "opencode",
        pacer_models::ModelSource::Connection => "connection",
        pacer_models::ModelSource::Discovery => "discovery",
        pacer_models::ModelSource::None => "none",
    };
    json!({
        "source": source,
        "offered": offered.map(Value::Bool).unwrap_or(Value::Null),
        "closest": closest,
        "note": base.note.unwrap_or_default(),
    })
}

/// A scratch test task (`src/endpoints/test-task.ts`): `git init` in
/// `$PACER_HOME/scratch/test-*`, the agent's one-line prompt, 180 s and a
/// `hello.txt == "ok"` check. The repository is always removed afterwards.
async fn test_task(ctx: &Ctx, runner: &Value, account: &Value) -> Result<(), String> {
    if !runner["host"].is_null() {
        return Err("remote runner test tasks are not supported yet".into());
    }
    let agent = runner["agent"].as_str().unwrap_or_default();
    let binary = match agent {
        "claude-code" => "claude",
        agent => agent,
    };
    let root = ctx.pacer_home.join("scratch");
    fs::create_dir_all(&root).map_err(|error| format!("test task failed: {error}"))?;
    let repo = root.join(format!("test-{}-{}", ctx.now as i64, std::process::id()));
    fs::create_dir_all(&repo).map_err(|error| format!("test task failed: {error}"))?;
    let result = async {
        let git = tokio::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&repo)
            .output()
            .await
            .map_err(|error| format!("could not create test git repo: {error}"))?;
        if !git.status.success() {
            return Err("could not create test git repo".to_string());
        }
        let argv = if agent == "claude-code" {
            vec![
                binary.to_string(),
                "-p".into(),
                "Create a file named hello.txt containing exactly: ok".into(),
            ]
        } else {
            vec![
                binary.to_string(),
                "run".into(),
                "Create a file named hello.txt containing exactly: ok".into(),
            ]
        };
        let mut command = tokio::process::Command::new(&argv[0]);
        command.args(&argv[1..]).current_dir(&repo);
        if let Some(home) = account["home"].as_str() {
            command.env("CLAUDE_CONFIG_DIR", home);
        }
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(180),
            command.output(),
        )
        .await
        .map_err(|_| "test task timed out".to_string())?
        .map_err(|error| format!("test task failed: {error}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        match fs::read_to_string(repo.join("hello.txt")) {
            Ok(text) if text == "ok" => Ok(()),
            _ => Err("test task did not create hello.txt containing exactly: ok".into()),
        }
    }
    .await;
    let _ = fs::remove_dir_all(&repo);
    result
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use pacer_foundation::Ctx;
    use std::collections::HashMap;

    fn ctx(dir: &std::path::Path) -> Ctx {
        Ctx::with(dir.into(), dir.into(), HashMap::new(), 1_700_000_000.0)
    }

    fn case() -> Value {
        json!({
            "id": "codex", "now": 1_700_000_000.0,
            "runner": {"id":"codex","agent":"codex","account":"codex","model":"gpt-5","host":null},
            "account": {"name":"codex","kind":"codex","usage":"quota","provider":"openai","source":"opencode"},
            "found": {"found":true,"install_hint":"install codex"},
            "status": {"signedIn":true}, "signInReason": null,
            "row": {"usedPct":3,"window":"weekly","error":null,"hint":null,"capturedAt":1,"stale":false},
            "models": {"source":"opencode","offered":true,"closest":[],"note":null},
            "testError": false, "refreshed": null, "env": {}, "raw": {},
        })
    }

    #[test]
    fn run_case_persists_the_check_and_returns_a_job() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(dir.path());
        let job = run_case(&ctx, &case()).unwrap();
        assert_eq!(job["kind"], "runner.check");
        assert_eq!(job["target"], "codex");
        assert_eq!(job["state"], "passed");
        assert_eq!(job["steps"].as_array().unwrap().len(), 5);
        let stored: Value =
            serde_json::from_slice(&fs::read(checks_file(&ctx)).unwrap()).unwrap();
        assert_eq!(stored["codex"]["passed"], true);
        assert_eq!(stored["codex"]["detail"], "Executor is ready");
    }

    #[test]
    fn a_failed_step_fails_the_job_and_is_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(dir.path());
        let mut c = case();
        c["found"]["found"] = json!(false);
        let job = run_case(&ctx, &c).unwrap();
        assert_eq!(job["state"], "failed");
        assert_eq!(job["error"]["code"], "failed");
        let stored: Value =
            serde_json::from_slice(&fs::read(checks_file(&ctx)).unwrap()).unwrap();
        assert_eq!(stored["codex"]["passed"], false);
    }
}
