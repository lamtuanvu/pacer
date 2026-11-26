//! Native `task.wait` (`taskWait`, `src/tasks/api.ts`).
//!
//! One loop tick is a `Supervisor::tick` (queue drain plus supervision) followed
//! by an agent-session check and a one-second sleep, until
//! `pacer_lifecycle::task_wait_settled` or the timeout. Over stdio the caller
//! spawns this beside the request loop so later lines still get answered.
#![allow(clippy::result_large_err)]

use std::time::{Duration, Instant};

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_lifecycle::task_wait_settled;
use pacer_store::TaskStore;
use serde_json::Value;

use crate::delegate::summarize;
use crate::runtime::Runtime;

#[cfg(test)]
mod tests;

fn unknown(id: &str) -> CoreError {
    CoreError::new(Code::UnknownTask, format!("unknown task {id}"))
}

fn internal(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Internal, message)
}

/// Wait until `id` settles or `timeout_s` elapses, then return its summary.
/// `timeout_s` has already been validated by the operation schema (1..=3000).
pub async fn wait_task(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    timeout_s: u32,
) -> Result<Value, CoreError> {
    let started = Instant::now();
    let deadline = Duration::from_secs(u64::from(timeout_s));
    loop {
        let tick_ctx = Ctx {
            now: ctx.now + started.elapsed().as_secs_f64(),
            ..ctx.clone()
        };
        // B1 owns the native drain/supervise loop. Until then the injected
        // supervisor is inert; a failed tick must not turn a wait into an error.
        let _ = runtime.supervisor.tick(&tick_ctx, id).await;

        let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
        let task = store.read(id).map_err(|e| internal(e.to_string()))?;
        let Some(task) = task else { return Err(unknown(id)) };

        let (agent_checks, agent_session) = match store.connection() {
            Ok(db) => (
                super::stop::agent_checks_pending(db, id),
                super::stop::active_agent_sessions(db, id),
            ),
            Err(_) => (false, false),
        };
        if task_wait_settled(&task, agent_checks, agent_session)
            || started.elapsed() >= deadline
        {
            return Ok(summarize(&task));
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
}
