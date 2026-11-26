//! Native message effects: `deliver`, `notify` and live `answer` are served by
//! `pacer_delegation` instead of the retired TypeScript message-effects bridge.
//! Only worktree auto-clean still falls through to the existing Core bridge until
//! B3-5 lands its native auto-clean; `publish` is already native in `msg_writes`.
#![allow(clippy::result_large_err)]
use crate::native::trace;
use pacer_delegation::{
    answer,
    runtime::{PluginCalls, RunnerSpawn, Runtime, Supervisor},
    turns,
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::{runner_log_path, self_command};
use pacer_messaging_ops::msg_writes::Bridge;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    process::{Command, Stdio},
    sync::Arc,
    time::Duration,
};

fn unavailable() -> CoreError {
    CoreError::new(Code::Unavailable, "delegation runtime effect unavailable")
}

/// No policy plugins are wired until B0b lands; message turns use the repository's
/// project executor selection and the task's prior executor.
struct NoPlugins;

impl PluginCalls for NoPlugins {
    fn providers(&self, _ctx: &Ctx, _method: &str) -> Vec<String> {
        Vec::new()
    }

    fn call<'a>(
        &'a self,
        _ctx: &'a Ctx,
        _plugin: &'a str,
        _method: &'a str,
        _params: Value,
        _deadline: Duration,
    ) -> OpFuture<'a> {
        Box::pin(async { Err(unavailable()) })
    }
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

struct NoSupervisor;

impl Supervisor for NoSupervisor {
    fn tick<'a>(&'a self, _ctx: &'a Ctx, _id: &'a str) -> OpFuture<'a> {
        Box::pin(async { Ok(json!({})) })
    }
}

fn runtime() -> Runtime {
    Runtime {
        plugins: Arc::new(NoPlugins),
        spawn: Arc::new(NativeSpawn),
        supervisor: Arc::new(NoSupervisor),
    }
}

/// A `Bridge` that answers message turns natively and forwards the remaining effects.
pub struct NativeMsgEffects<'a, B: Bridge> {
    ctx: Ctx,
    rt: Runtime,
    inner: &'a mut B,
    read_model_schema: bool,
}

impl<'a, B: Bridge> NativeMsgEffects<'a, B> {
    pub fn new(ctx: Ctx, inner: &'a mut B) -> Self {
        Self {
            ctx,
            rt: runtime(),
            inner,
            read_model_schema: false,
        }
    }

    /// The HTTP door's Core child runs a read model that creates `msg_liveness`;
    /// keep that schema identical when effects are answered natively.
    pub fn with_read_model_schema(ctx: Ctx, inner: &'a mut B) -> Self {
        Self {
            ctx,
            rt: runtime(),
            inner,
            read_model_schema: true,
        }
    }
}

impl<B: Bridge> Bridge for NativeMsgEffects<'_, B> {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        let executor_session = self.ctx.env.contains_key("PACER_TASK_ID");
        if (self.read_model_schema || executor_session)
            && let Err(error) = turns::ensure_read_model_schema(&self.ctx)
        {
            eprintln!("pacer: message read-model schema effect failed: {}", error.message);
        }
        let kind = request["kind"].as_str().unwrap_or_default().to_owned();
        match kind.as_str() {
            "deliver" => {
                trace("msg-effects deliver", None);
                let result = turns::deliver(&self.ctx, &self.rt, request["to"].as_str().unwrap_or_default());
                Box::pin(async { result })
            }
            "notify" => {
                trace("msg-effects notify", None);
                let result = turns::notify_message(&self.ctx, &self.rt, request["id"].as_str().unwrap_or_default())
                    .map(|()| json!({"ok": true}));
                Box::pin(async { result })
            }
            "answer" => {
                trace("msg-effects answer", None);
                let ctx = self.ctx.clone();
                let id = request["id"].as_str().unwrap_or_default().to_owned();
                Box::pin(async move {
                    match answer::deliver_live_answer(&ctx, &id).await {
                        Ok(true) => Ok(json!({"delivery": "live"})),
                        Ok(false) => Ok(json!({"delivery": "not_live"})),
                        Err(error) => Err(error),
                    }
                })
            }
            _ => self.inner.call(request),
        }
    }
}

fn clean_ids(request: &Value) -> Option<Vec<String>> {
    (request["kind"] == "clean").then(|| {
        request["id"]
            .as_str()
            .into_iter()
            .map(str::to_owned)
            .collect()
    })
}

/// The HTTP door's inner bridge: only worktree auto-clean still goes to Core.
pub struct HttpEffects {
    pub target: Option<(u16, String)>,
}

impl Bridge for HttpEffects {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        let Some(ids) = clean_ids(&request) else {
            return Box::pin(async { Err(unavailable()) });
        };
        let target = self.target.clone();
        Box::pin(async move { crate::native::task_clean_sync::http(target, &ids).await })
    }
}

/// The stdio door's inner bridge: only worktree auto-clean still goes to Core.
pub struct StdioEffects<'a, W> {
    pub core: &'a mut W,
    pub prefix: &'a str,
    pub key: &'a str,
    pub replies: &'a mut tokio::sync::mpsc::UnboundedReceiver<Value>,
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> Bridge for StdioEffects<'_, W> {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        let Some(ids) = clean_ids(&request) else {
            return Box::pin(async { Err(unavailable()) });
        };
        let prefix = self.prefix;
        let key = self.key;
        Box::pin(async move {
            crate::native::task_clean_sync::stdio(self.core, prefix, key, &ids, self.replies).await
        })
    }
}
