//! Runtime effects a delegation cannot own, injected by the front doors (B3-5).
//! Kept here so message turns can port `src/messaging/turns.ts` without the op
//! crates depending on this crate; the server supplies the real implementations.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{CoreError, OpFuture},
};
use serde_json::Value;
use std::{sync::Arc, time::Duration};

/// Enabled plugin ids implementing `method`, in registry order.
pub trait PluginCalls: Send + Sync {
    fn providers(&self, ctx: &Ctx, method: &str) -> Vec<String>;
    fn call<'a>(
        &'a self,
        ctx: &'a Ctx,
        plugin: &'a str,
        method: &'a str,
        params: Value,
        deadline: Duration,
    ) -> OpFuture<'a>;
}

/// `launchTaskRunner` (`src/tasks/api.ts:180-188`): detached `_run <id>`.
pub trait RunnerSpawn: Send + Sync {
    fn launch(&self, ctx: &Ctx, task_id: &str, admitted: Option<&str>) -> Result<Option<u32>, CoreError>;
}

/// One queue-drain pass plus `superviseTask(id)`.
pub trait Supervisor: Send + Sync {
    fn tick<'a>(&'a self, ctx: &'a Ctx, id: &'a str) -> OpFuture<'a>;
}

#[derive(Clone)]
pub struct Runtime {
    pub plugins: Arc<dyn PluginCalls>,
    pub spawn: Arc<dyn RunnerSpawn>,
    pub supervisor: Arc<dyn Supervisor>,
}
