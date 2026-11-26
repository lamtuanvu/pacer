//! Server implementations of the `pacer-delegation` runtime traits, plus the
//! native `msg_writes::Bridge` that answers the `clean` effect locally.
//!
//! One `Runtime` is built per HTTP Listener and per stdio session. Plugin calls
//! go through the B0b plugin service. Runner spawn and supervision are still
//! owned by TypeScript at this base (B1 prerequisite), so those two traits use
//! the crate's inert doubles until the Rust owner lands.

use std::{sync::Arc, time::Duration};

use std::{fs::OpenOptions, process::{Command, Stdio}};
#[cfg(unix)]
use std::os::unix::process::CommandExt;

use pacer_delegation::{
    Runtime,
    runtime::{NoSupervisor, PluginCalls, RunnerSpawn},
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_messaging_ops::msg_writes::Bridge as MsgWriteBridge;
use serde_json::{Value, json};

/// Plugin owner shared by a Listener or a stdio session.
pub struct ServerPlugins {
    service: Arc<crate::native::plugins::Service>,
    core: Arc<crate::serve::core_child::CoreChild>,
}

impl ServerPlugins {
    pub fn new(
        service: Arc<crate::native::plugins::Service>,
        core: Arc<crate::serve::core_child::CoreChild>,
    ) -> Self {
        Self { service, core }
    }
}

impl PluginCalls for ServerPlugins {
    /// B0c owns the native plugin registry; until it lands there is no local
    /// provider table to enumerate, so no host-owned worktree is claimed.
    fn providers(&self, _: &Ctx, _: &str) -> Vec<String> {
        Vec::new()
    }

    fn call<'a>(
        &'a self,
        ctx: &'a Ctx,
        _plugin: &'a str,
        method: &'a str,
        params: Value,
        deadline: Duration,
    ) -> OpFuture<'a> {
        let link = crate::native::plugins::http_link(&self.core);
        let call = self.service.call(ctx, link, method, params);
        Box::pin(async move {
            tokio::time::timeout(deadline, call)
                .await
                .map_err(|_| CoreError::new(Code::PluginTimeout, "plugin call timed out"))?
        })
    }
}

/// Interim `RunnerSpawn` until B1 owns `_run`: launch the TypeScript core's detached
/// `_run <id>` exactly as `launchTaskRunner` does (`src/tasks/api.ts:180-200`).
pub struct CoreSpawn;

impl RunnerSpawn for CoreSpawn {
    fn launch(
        &self,
        ctx: &Ctx,
        task_id: &str,
        admitted: Option<&str>,
    ) -> Result<Option<u32>, CoreError> {
        let argv: Vec<String> = serde_json::from_str(
            &ctx.env
                .get("PACER_CORE_ARGV")
                .ok_or_else(|| CoreError::new(Code::Unavailable, "PACER_CORE_ARGV is unset"))?,
        )
        .map_err(|error| CoreError::new(Code::Internal, format!("invalid core argv: {error}")))?;
        let (program, prefix) = argv
            .split_first()
            .ok_or_else(|| CoreError::new(Code::Unavailable, "runner self command is empty"))?;
        let logs = ctx.pacer_home.join("logs");
        std::fs::create_dir_all(&logs)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let log = options
            .open(pacer_lifecycle::runner_log_path(&ctx.pacer_home))
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        let mut command = Command::new(program);
        command.args(prefix).args(["_run", task_id]);
        for (name, value) in &ctx.env {
            command.env(name, value);
        }
        // The child claims its own lease in desktop-updates/admission.sqlite; our
        // preparation lease lives in tasks.db and must not be handed to `_run`.
        let _ = admitted;
        command
            .env("HOME", &ctx.home)
            .env("PACER_HOME", &ctx.pacer_home)
            .env_remove("PACER_HOST_SOCKET")
            .env_remove("PACER_RUN_GRANT")
            .stdin(Stdio::null())
            .stdout(Stdio::from(
                log.try_clone()
                    .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?,
            ))
            .stderr(Stdio::from(log));
        if ctx.env.get("PACER_ROLE").map(String::as_str) == Some("orchestrator") {
            command.env_remove("PACER_ROLE");
        }
        #[cfg(unix)]
        command.process_group(0);
        let child = command
            .spawn()
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        Ok(Some(child.id()))
    }
}

/// Build one runtime with the front door's plugin owner.
pub fn runtime(
    service: Arc<crate::native::plugins::Service>,
    core: Arc<crate::serve::core_child::CoreChild>,
) -> Arc<Runtime> {
    Arc::new(Runtime {
        plugins: Arc::new(ServerPlugins::new(service, core)),
        spawn: Arc::new(CoreSpawn),
        supervisor: Arc::new(NoSupervisor),
    })
}

/// Plugin owner for one stdio session: its reverse-bridge link is the Core channel.
pub struct SessionPlugins {
    service: Arc<crate::native::plugins::Service>,
    link: Arc<dyn pacer_plugin_ops::ipc::CoreIpc>,
}

impl PluginCalls for SessionPlugins {
    fn providers(&self, _: &Ctx, _: &str) -> Vec<String> {
        Vec::new()
    }

    fn call<'a>(
        &'a self,
        ctx: &'a Ctx,
        _plugin: &'a str,
        method: &'a str,
        params: Value,
        deadline: Duration,
    ) -> OpFuture<'a> {
        let ipc = Arc::clone(&self.link);
        let core = async move { Some((ipc, String::new())) };
        let call = self.service.call(ctx, core, method, params);
        Box::pin(async move {
            tokio::time::timeout(deadline, call)
                .await
                .map_err(|_| CoreError::new(Code::PluginTimeout, "plugin call timed out"))?
        })
    }
}

/// Build the runtime for a single stdio connection.
pub fn session_runtime(
    service: Arc<crate::native::plugins::Service>,
    link: Arc<dyn pacer_plugin_ops::ipc::CoreIpc>,
) -> Arc<Runtime> {
    Arc::new(Runtime {
        plugins: Arc::new(SessionPlugins { service, link }),
        spawn: Arc::new(CoreSpawn),
        supervisor: Arc::new(NoSupervisor),
    })
}

/// Native `task.delegate` effects, backed by this front door's delegation runtime.
pub struct DelegateEffects {
    pub runtime: Arc<Runtime>,
}

impl pacer_task_ops::task_delegation_ops::DelegationEffects for DelegateEffects {
    fn delegate<'a>(&'a self, ctx: &'a Ctx, params: &'a Value) -> OpFuture<'a> {
        Box::pin(async move {
            let client = ctx.env.get("PACER_CLIENT").map(String::as_str).unwrap_or_default();
            let origin = if client.starts_with("app")
                || client.starts_with("desktop")
                || client.starts_with("tui")
                || client.starts_with("tray")
            {
                "human"
            } else {
                "external:local"
            };
            pacer_delegation::delegate::delegate(ctx, &self.runtime, params, Some(origin)).await
        })
    }
}

/// Wraps the existing Core message bridge so the `clean` effect is answered by
/// native auto-clean while `deliver`, `notify` and `publish` still reach Core.
pub struct MsgBridge<'a, B: MsgWriteBridge> {
    pub inner: &'a mut B,
    pub ctx: &'a Ctx,
    pub delegation: &'a Runtime,
}

impl<B: MsgWriteBridge> MsgWriteBridge for MsgBridge<'_, B> {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        let ctx = self.ctx;
        let delegation = self.delegation;
        if request["kind"].as_str() == Some("clean") {
            let id = request["id"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            return Box::pin(async move {
                pacer_delegation::cleanup::auto_clean_task(ctx, delegation, &id).await;
                Ok(json!({"ok": true}))
            });
        }
        self.inner.call(request)
    }
}
