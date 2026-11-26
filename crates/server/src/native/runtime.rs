//! Server implementations of the `pacer-delegation` runtime traits, plus the
//! native `msg_writes::Bridge` that answers the `clean` effect locally.
//!
//! One `Runtime` is built per HTTP Listener and per stdio session. Plugin calls
//! go through the B0b plugin service. Runner spawn and supervision are still
//! owned by TypeScript at this base (B1 prerequisite), so those two traits use
//! the crate's inert doubles until the Rust owner lands.

use std::{sync::Arc, time::Duration};

use pacer_delegation::{
    Runtime,
    runtime::{NoSpawn, NoSupervisor, PluginCalls},
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

/// Build one runtime with the front door's plugin owner.
pub fn runtime(
    service: Arc<crate::native::plugins::Service>,
    core: Arc<crate::serve::core_child::CoreChild>,
) -> Arc<Runtime> {
    Arc::new(Runtime {
        plugins: Arc::new(ServerPlugins::new(service, core)),
        spawn: Arc::new(NoSpawn),
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
        spawn: Arc::new(NoSpawn),
        supervisor: Arc::new(NoSupervisor),
    })
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
