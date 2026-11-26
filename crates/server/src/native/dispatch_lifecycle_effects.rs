//! Native `dispatch` lifecycle effects (B2-9 submit/child, B2-10 wait/review/
//! stop, B2-11 retry/answer). The server installs this once at startup as the
//! [`LifecycleEffects`] implementation; the ops route through
//! `pacer_delegation::work` after `dispatch_ops`'s `check` admits the request.
//! The runtime replicates `msg_effects`: no policy plugins, a native `_run`
//! launcher and no supervisor, until later batches wire those.
#![allow(clippy::result_large_err)]
use pacer_delegation::runtime::{NoPlugins, NoSupervisor, RunnerSpawn, Runtime};
use pacer_dispatch_ops::lifecycle_ops::LifecycleEffects;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::{runner_log_path, self_command};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    process::{Command, Stdio},
    sync::Arc,
};

fn unavailable() -> CoreError {
    CoreError::new(Code::Unavailable, "native dispatch lifecycle effect unavailable")
}

/// Detached `_run <id>` launcher, matching `runnerProcess` (`src/tasks/api.ts`).
struct NativeSpawn;

impl RunnerSpawn for NativeSpawn {
    fn launch(&self, ctx: &Ctx, task_id: &str, _admitted: Option<&str>) -> Result<Option<u32>, CoreError> {
        let exe = std::env::current_exe().map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
        let argv1 = std::env::args().nth(1);
        let command = self_command(&exe.to_string_lossy(), argv1.as_deref());
        let (program, prefix) = command.split_first().ok_or_else(unavailable)?;
        let mut env: HashMap<String, String> = ctx.env.clone();
        env.remove("PACER_HOST_SOCKET");
        env.remove("PACER_RUN_GRANT");
        if env.get("PACER_ROLE").map(String::as_str) == Some("orchestrator") {
            env.remove("PACER_ROLE");
        }
        env.insert("HOME".into(), ctx.home.to_string_lossy().into_owned());
        env.insert("PACER_HOME".into(), ctx.pacer_home.to_string_lossy().into_owned());
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(runner_log_path(&ctx.pacer_home))
            .ok();
        let mut process = Command::new(program);
        process
            .args(prefix)
            .arg("_run")
            .arg(task_id)
            .envs(env)
            .stdin(Stdio::null());
        match log {
            Some(file) => {
                let file: File = file;
                process
                    .stdout(file.try_clone().map(Stdio::from).unwrap_or_else(|_| Stdio::null()))
                    .stderr(Stdio::from(file));
            }
            None => {
                process.stdout(Stdio::null()).stderr(Stdio::null());
            }
        }
        let child = process.spawn().map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
        Ok(Some(child.id()))
    }
}

fn runtime() -> Runtime {
    Runtime {
        plugins: Arc::new(NoPlugins),
        spawn: Arc::new(NativeSpawn),
        supervisor: Arc::new(NoSupervisor),
    }
}

/// `dispatch.retry` and `dispatch.answer` share the restart ledger; the op
/// schema has already validated these fields before the effect is called.
fn restart_input(params: &Value) -> Result<pacer_delegation::work::RestartInput, CoreError> {
    Ok(pacer_delegation::work::RestartInput {
        expect_rev: params
            .get("expect_rev")
            .and_then(Value::as_i64)
            .ok_or_else(unavailable)?,
        request_id: params
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or_else(unavailable)?
            .to_owned(),
        feedback: params.get("feedback").and_then(Value::as_str).map(str::to_owned),
        text: params.get("text").and_then(Value::as_str).map(str::to_owned),
    })
}

/// Runtime-backed lifecycle effects serving every `dispatch` lifecycle op.
pub struct NativeDispatchEffects {
    rt: Runtime,
}

impl NativeDispatchEffects {
    pub fn new() -> Self {
        Self { rt: runtime() }
    }
}

impl LifecycleEffects for NativeDispatchEffects {
    fn submit<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a> {
        let rt = self.rt.clone();
        Box::pin(async move { pacer_delegation::work::submit_work(ctx, &rt, &params).await })
    }

    fn child<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a> {
        let rt = self.rt.clone();
        Box::pin(async move { pacer_delegation::work::delegate_child(ctx, &rt, &params).await })
    }

    fn wait<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a> {
        let rt = self.rt.clone();
        Box::pin(async move {
            let id = params.get("id").and_then(Value::as_str).ok_or_else(unavailable)?;
            let timeout_s = params
                .get("timeout_s")
                .and_then(Value::as_u64)
                .unwrap_or(600)
                .min(u32::MAX as u64) as u32;
            pacer_delegation::work::wait_work(ctx, &rt, id, timeout_s).await
        })
    }

    fn review<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a> {
        let rt = self.rt.clone();
        Box::pin(async move {
            let id = params.get("id").and_then(Value::as_str).ok_or_else(unavailable)?;
            let accepted = params.get("accepted").and_then(Value::as_bool).ok_or_else(unavailable)?;
            let note = params.get("note").and_then(Value::as_str);
            let expect_rev = params.get("expect_rev").and_then(Value::as_i64);
            pacer_delegation::work::review_work(ctx, &rt, id, accepted, note, expect_rev).await
        })
    }

    fn retry<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a> {
        let rt = self.rt.clone();
        Box::pin(async move {
            let id = params.get("id").and_then(Value::as_str).ok_or_else(unavailable)?;
            let input = restart_input(&params)?;
            pacer_delegation::work::retry_work(ctx, &rt, id, input).await
        })
    }

    fn answer<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a> {
        let rt = self.rt.clone();
        Box::pin(async move {
            let id = params.get("id").and_then(Value::as_str).ok_or_else(unavailable)?;
            let input = restart_input(&params)?;
            pacer_delegation::work::answer_work(ctx, &rt, id, input).await
        })
    }

    fn stop<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a> {
        let rt = self.rt.clone();
        Box::pin(async move {
            let id = params.get("id").and_then(Value::as_str).ok_or_else(unavailable)?;
            let expect_rev = params.get("expect_rev").and_then(Value::as_i64);
            pacer_delegation::work::stop_work(ctx, &rt, id, expect_rev).await
        })
    }
}