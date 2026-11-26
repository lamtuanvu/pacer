//! External runtime effects needed by native delegation, injected by `pacer-server`.
//!
//! Keeping these behind traits lets domain crates stay transport-free and lets tests
//! run the whole lifecycle with inert doubles.

use std::sync::Arc;
use std::time::Duration;

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::Value;

/// Plugin calls made by delegation (host clean, policy and executor effects).
pub trait PluginCalls: Send + Sync {
    /// Enabled plugin ids that implement `method`, in `pluginRegistry(ctx).list` order.
    fn providers(&self, ctx: &Ctx, method: &str) -> Vec<String>;

    /// Call `method` on `plugin` with a deadline.
    fn call<'a>(
        &'a self,
        ctx: &'a Ctx,
        plugin: &'a str,
        method: &'a str,
        params: Value,
        deadline: Duration,
    ) -> OpFuture<'a>;
}

/// Detached `_run <id>` launch (`src/tasks/api.ts:180-188`).
pub trait RunnerSpawn: Send + Sync {
    fn launch(&self, ctx: &Ctx, task_id: &str, admitted: Option<&str>) -> Result<Option<u32>, CoreError>;
}

/// One `drainQueue` pass then `superviseTask(id)`.
pub trait Supervisor: Send + Sync {
    fn tick<'a>(&'a self, ctx: &'a Ctx, id: &'a str) -> OpFuture<'a>;
}

/// The three runtime effects, cloned once per Listener and per stdio session.
#[derive(Clone)]
pub struct Runtime {
    pub plugins: Arc<dyn PluginCalls>,
    pub spawn: Arc<dyn RunnerSpawn>,
    pub supervisor: Arc<dyn Supervisor>,
}

fn unavailable(what: &str) -> CoreError {
    CoreError::new(Code::Unavailable, format!("{what} is unavailable"))
}

/// Test double: no plugins are enabled, so plugin-owned effects are skipped.
pub struct NoPlugins;
impl PluginCalls for NoPlugins {
    fn providers(&self, _: &Ctx, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn call<'a>(
        &'a self,
        _: &'a Ctx,
        _: &'a str,
        _: &'a str,
        _: Value,
        _: Duration,
    ) -> OpFuture<'a> {
        Box::pin(async { Err(unavailable("plugin calls")) })
    }
}

/// Test double for a runtime without an effectful Rust runner (B1 prerequisite).
pub struct NoSpawn;
impl RunnerSpawn for NoSpawn {
    fn launch(&self, _: &Ctx, _: &str, _: Option<&str>) -> Result<Option<u32>, CoreError> {
        Err(unavailable("runner spawn"))
    }
}

/// Test double for a runtime without a native supervision loop (B1 prerequisite).
pub struct NoSupervisor;
impl Supervisor for NoSupervisor {
    fn tick<'a>(&'a self, _: &'a Ctx, _: &'a str) -> OpFuture<'a> {
        Box::pin(async { Err(unavailable("supervisor")) })
    }
}

/// A runtime with only inert doubles, used by tests and by surfaces that have no owner yet.
impl Default for Runtime {
    fn default() -> Self {
        Self {
            plugins: Arc::new(NoPlugins),
            spawn: Arc::new(NoSpawn),
            supervisor: Arc::new(NoSupervisor),
        }
    }
}
