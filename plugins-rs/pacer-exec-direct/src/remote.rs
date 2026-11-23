//! The remote owned-executor attempt loop (M3 C10). Port of
//! `plugins/pacer-exec-direct/index.ts:40-82` (`runOwnedRemote`).
//!
//! A fresh remote run prepares a host placement, claims an owned run, and
//! starts it; resumed runs only poll. On exit the output is read and the
//! committed work is transferred back, naming the fetched branch and commit
//! count when a review worktree was produced.

use pacer_plugin::js::{self, slice_utf16};
use pacer_plugin::{Ctx, HandlerResult, PluginError};
use serde_json::{Value, json};

use crate::clock::Clock;
use crate::input::RemoteRun;

pub async fn run_owned_remote(input: RemoteRun, ctx: &Ctx, clock: &dyn Clock) -> HandlerResult {
    let task_id = input.task.id;
    let attempt = input.attempt;
    let remote = input.remote;

    let mut started_at: Option<f64> = remote.resume.as_ref().map(|r| r.started_at);
    let mut log_file: Option<String> = remote.resume.as_ref().map(|r| r.log_file.clone());
    if remote.resume.is_none() {
        ctx.host
            .call(
                "capability.hosts.prepareOwned",
                json!({ "taskId": task_id, "attempt": attempt }),
            )
            .await?;
        if ctx.cancel.is_cancelled() {
            return Err(PluginError::new(
                "plugin_unavailable",
                "remote placement was cancelled",
            ));
        }
        let claimed = ctx
            .host
            .call(
                "capability.hosts.claimOwned",
                json!({ "taskId": task_id, "attempt": attempt }),
            )
            .await?;
        started_at = claimed.get("startedAt").and_then(Value::as_f64);
        log_file = claimed.get("logFile").and_then(Value::as_str).map(String::from);
        if ctx.cancel.is_cancelled() {
            return Err(PluginError::new(
                "plugin_unavailable",
                "remote start was cancelled",
            ));
        }
        ctx.host
            .call(
                "capability.hosts.startOwned",
                json!({ "taskId": task_id, "attempt": attempt }),
            )
            .await?;
    }

    let deadline = started_at.unwrap_or(0.0) * 1000.0 + remote.timeout_ms as f64;
    let mut uncertain_since: Option<f64> = None;

    loop {
        if ctx.cancel.is_cancelled() {
            return Err(PluginError::new(
                "plugin_unavailable",
                "remote run was cancelled; inspect the persisted run",
            ));
        }
        let state = ctx
            .host
            .call(
                "capability.hosts.pollOwned",
                json!({ "taskId": task_id, "attempt": attempt }),
            )
            .await?;
        let state_name = state.get("state").and_then(Value::as_str);
        let exit_code = state.get("exitCode").and_then(Value::as_i64);

        if state_name == Some("exited") && exit_code.is_some() {
            let encoded = ctx
                .host
                .call(
                    "capability.hosts.readOwnedOutput",
                    json!({ "taskId": task_id, "attempt": attempt }),
                )
                .await?;
            let stdout = decode_str(encoded.get("stdoutBase64"));
            let stderr = decode_str(encoded.get("stderrBase64"));
            let trimmed_out = js::trim(&stdout);
            let trimmed_err = js::trim(&stderr);
            let body = if !trimmed_out.is_empty() { trimmed_out } else { trimmed_err };
            let report = slice_utf16(body, -4000, None);
            let transfer = ctx
                .host
                .call(
                    "capability.hosts.transferOwned",
                    json!({ "taskId": task_id, "attempt": attempt }),
                )
                .await?;
            if let Some(reason) = transfer.get("reason").and_then(Value::as_str) {
                return Err(PluginError::new(
                    "plugin_refused",
                    format!("remote transfer is unresolved: {reason}"),
                ));
            }
            let transferred = transfer
                .get("transferred")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let review_worktree = transfer.get("reviewWorktree").and_then(Value::as_str);
            let code = exit_code.unwrap_or(0);
            let started = started_at.unwrap_or(0.0);
            let log = log_file.unwrap_or_default();
            let mut result = json!({
                "backend": "direct",
                "report": report,
                "exec": { "code": code, "stdout": stdout, "stderr": stderr, "timedOut": false },
                "attempt": {
                    "executor": remote.executor,
                    "model": remote.model,
                    "startedAt": started,
                    "endedAt": clock.now_ms() / 1000.0,
                    "exitCode": code,
                    "timedOut": false,
                    "limitHit": false,
                    "log": log,
                }
            });
            if transferred
                && let Some(wt) = review_worktree
            {
                let branch = transfer.get("branch").and_then(Value::as_str);
                let commits = transfer.get("commits").and_then(Value::as_i64);
                result["worktree"] = json!(wt);
                result["report"] = json!(format!(
                    "ran on remote host; fetched {} ({} commits)\n\n{}",
                    branch.unwrap_or_default(),
                    commits.unwrap_or(0),
                    report
                ));
            }
            return Ok(result);
        }

        uncertain_since = if state_name == Some("uncertain") {
            Some(uncertain_since.unwrap_or(clock.now_ms()))
        } else {
            None
        };
        if let Some(u) = uncertain_since
            && clock.now_ms() - u >= 5000.0
        {
            return Err(PluginError::new(
                "plugin_unavailable",
                "remote run state is uncertain; replacement launch refused",
            ));
        }
        if clock.now_ms() >= deadline {
            return Err(PluginError::new(
                "plugin_timeout",
                "remote deadline reached; persisted run requires stop reconciliation",
            ));
        }
        clock.sleep(200).await;
    }
}

fn decode_str(v: Option<&Value>) -> String {
    let base64 = v.and_then(Value::as_str).unwrap_or_default();
    String::from_utf8_lossy(&js::base64::decode_lenient(base64)).into_owned()
}