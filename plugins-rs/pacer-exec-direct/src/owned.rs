//! The owned-executor attempt loop (M3 C10). Port of
//! `plugins/pacer-exec-direct/index.ts:84-157` (`runOwned`).
//!
//! A fresh owned run claims a wrapper, starts it, and poll-observes it;
//! resumed runs only poll. Placement `new` resolves and creates a worktree
//! before any claim. Interactive runs require a host-reaped completion report
//! and must skip the wall deadline, settling only on `completeReportedRun`.

use pacer_plugin::js::{self, slice_utf16};
use pacer_plugin::{Ctx, HandlerResult, PluginError};
use serde_json::{Value, json};

use crate::clock::Clock;
use crate::input::OwnedRun;

/// A host-reaped interactive completion (`completeReportedRun`).
struct Completed {
    status: String,
    summary: String,
    exit_code: i64,
}

pub async fn run_owned(input: OwnedRun, ctx: &Ctx, clock: &dyn Clock) -> HandlerResult {
    let task_id = input.task.id;
    let attempt = input.attempt;
    let owned = input.owned;
    let interactive = owned.session.as_deref() == Some("interactive");

    let mut worktree: Option<String> = owned
        .resume
        .as_ref()
        .and_then(|r| r.worktree.clone());

    // Fresh placement `new`: resolve a stable base then create or reuse a worktree.
    if owned.resume.is_none() && owned.placement == "new" {
        let base = ctx
            .host
            .call(
                "capability.worktree.resolveBase",
                json!({ "taskId": task_id, "attempt": attempt }),
            )
            .await?;
        if ctx.cancel.is_cancelled() {
            return Err(PluginError::new(
                "plugin_unavailable",
                "executor placement was cancelled",
            ));
        }
        let base_sha = base
            .get("sha")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let placed = ctx
            .host
            .call(
                "capability.worktree.createOrReuse",
                json!({
                    "taskId": task_id,
                    "attempt": attempt,
                    "baseSha": base_sha,
                }),
            )
            .await?;
        worktree = placed.get("workdir").and_then(Value::as_str).map(String::from);
    }

    if ctx.cancel.is_cancelled() {
        return Err(PluginError::new(
            "plugin_unavailable",
            "executor claim was cancelled",
        ));
    }

    let mut started_at: Option<f64> = owned.resume.as_ref().map(|r| r.started_at);
    let mut log_file: Option<String> = owned.resume.as_ref().map(|r| r.log_file.clone());
    if owned.resume.is_none() {
        let claim = ctx
            .host
            .call(
                "capability.process.claimRun",
                json!({ "taskId": task_id, "attempt": attempt }),
            )
            .await?;
        if let Some(wt) = &worktree {
            let claim_workdir = claim.get("workdir").and_then(Value::as_str);
            if claim_workdir != Some(wt.as_str()) {
                return Err(PluginError::new(
                    "capability_denied",
                    "executor worktree changed after placement",
                ));
            }
        }
        started_at = claim
            .get("startedAt")
            .and_then(Value::as_f64);
        log_file = claim.get("logFile").and_then(Value::as_str).map(String::from);
        if ctx.cancel.is_cancelled() {
            return Err(PluginError::new(
                "plugin_unavailable",
                "executor start was cancelled",
            ));
        }
        ctx.host
            .call(
                "capability.process.startRun",
                json!({
                    "task": claim.get("task").cloned().unwrap_or(Value::Null),
                    "attempt": attempt,
                    "runDir": 1,
                }),
            )
            .await?;
    }

    let deadline = if let Some(resume) = &owned.resume {
        resume.started_at * 1000.0 + owned.timeout_ms as f64
    } else {
        clock.now_ms() + owned.timeout_ms as f64
    };
    let mut uncertain_since: Option<f64> = None;
    let mut completed: Option<Completed> = None;

    loop {
        if ctx.cancel.is_cancelled() {
            return Err(PluginError::new(
                "plugin_unavailable",
                "executor run was cancelled; inspect the persisted wrapper",
            ));
        }
        let state = ctx
            .host
            .call(
                "capability.process.pollRun",
                json!({ "taskId": task_id, "attempt": attempt }),
            )
            .await?;
        let running = state.get("state").and_then(Value::as_str);
        let exit_code = state.get("exitCode").and_then(Value::as_i64);
        let state_interactive = state
            .get("interactive")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let report_status = state
            .get("report")
            .and_then(|r| r.get("status"))
            .and_then(Value::as_str);
        let report_summary = state
            .get("report")
            .and_then(|r| r.get("summary"))
            .and_then(Value::as_str);
        let report_at = state
            .get("report")
            .and_then(|r| r.get("at"))
            .and_then(Value::as_f64);

        if interactive && !state_interactive {
            return Err(PluginError::new(
                "plugin_refused",
                "interactive run observation has no session proof",
            ));
        }

        let report_terminal =
            report_status == Some("done") || report_status == Some("failed");
        if interactive
            && completed.is_none()
            && report_terminal
        {
            let receipt = ctx
                .host
                .call(
                    "capability.process.completeReportedRun",
                    json!({ "taskId": task_id, "attempt": attempt }),
                )
                .await?;
            let r_status = receipt.get("status").and_then(Value::as_str);
            let r_summary = receipt.get("summary").and_then(Value::as_str);
            let r_at = receipt.get("at").and_then(Value::as_f64);
            if r_status != report_status
                || r_summary != report_summary
                || r_at != report_at
            {
                return Err(PluginError::new(
                    "plugin_refused",
                    "interactive report completion changed",
                ));
            }
            completed = Some(Completed {
                status: receipt
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                summary: receipt
                    .get("summary")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                exit_code: receipt.get("exitCode").and_then(Value::as_i64).unwrap_or(0),
            });
            continue;
        }

        if running == Some("exited") && exit_code.is_some() {
            if let Some(c) = &completed
                && exit_code != Some(c.exit_code)
            {
                return Err(PluginError::new(
                    "plugin_refused",
                    "interactive exit changed after completion",
                ));
            }
            let encoded = ctx
                .host
                .call(
                    "capability.process.readRunOutput",
                    json!({ "taskId": task_id, "attempt": attempt }),
                )
                .await?;
            let stdout = decode_str(encoded.get("stdoutBase64"));
            let stderr = decode_str(encoded.get("stderrBase64"));
            let report = match &completed {
                Some(c) => c.summary.clone(),
                None if interactive => {
                    let suffix = report_summary
                        .map(|s| format!("\n\n{}", slice_utf16(s, -4000, None)))
                        .unwrap_or_default();
                    format!(
                        "Interactive session exited without an explicit completion report{suffix}"
                    )
                }
                None => {
                    let trimmed_stdout = js::trim(&stdout);
                    let trimmed_stderr = js::trim(&stderr);
                    let body = if !trimmed_stdout.is_empty() {
                        trimmed_stdout
                    } else {
                        trimmed_stderr
                    };
                    slice_utf16(body, -4000, None)
                }
            };
            if interactive && completed.is_none() && report_terminal {
                return Err(PluginError::new(
                    "plugin_refused",
                    "interactive completion has no host receipt",
                ));
            }
            let code = if interactive {
                match &completed {
                    Some(c) => {
                        if c.status == "done" {
                            0
                        } else {
                            1
                        }
                    }
                    None => {
                        let c = exit_code.unwrap_or(0);
                        if c == 0 {
                            1
                        } else {
                            c
                        }
                    }
                }
            } else {
                exit_code.unwrap_or(0)
            };
            let started = started_at.unwrap_or(0.0);
            let log = log_file.clone().unwrap_or_default();
            let executor = owned.executor.clone();
            let model = owned.model.clone();
            let mut result = json!({
                "backend": "direct",
                "report": report,
                "exec": { "code": code, "stdout": stdout, "stderr": stderr, "timedOut": false },
                "attempt": {
                    "executor": executor,
                    "model": model,
                    "startedAt": started,
                    "endedAt": clock.now_ms() / 1000.0,
                    "exitCode": code,
                    "timedOut": false,
                    "limitHit": false,
                    "log": log,
                }
            });
            if let Some(wt) = &worktree {
                result["worktree"] = json!(wt);
            }
            return Ok(result);
        }

        uncertain_since = if running == Some("uncertain") {
            Some(uncertain_since.unwrap_or(clock.now_ms()))
        } else {
            None
        };
        if let Some(u) = uncertain_since
            && clock.now_ms() - u >= 5000.0
        {
            return Err(PluginError::new(
                "plugin_unavailable",
                "executor wrapper state is uncertain; replacement launch refused",
            ));
        }
        if !interactive && clock.now_ms() >= deadline {
            return Err(PluginError::new(
                "plugin_timeout",
                "executor deadline reached; persisted wrapper requires stop reconciliation",
            ));
        }
        clock.sleep(200).await;
    }
}

fn decode_str(v: Option<&Value>) -> String {
    let base64 = v.and_then(Value::as_str).unwrap_or_default();
    String::from_utf8_lossy(&js::base64::decode_lenient(base64)).into_owned()
}