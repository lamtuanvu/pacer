//! The service-owned status cache (`src/serve/http.ts:126-161, 1044`). One
//! writing `computeStatus` runs at a time; its value replaces the last good
//! one, while an error is kept until a later success clears it. A cold reader
//! waits at most [`STATUS_WARMUP_WAIT_MS`] before answering "warming up", so a
//! first-run activity rebuild never stalls the listener.

use crate::compute::{StatusOptions, StatusRuntime, compute_status};
use futures::{FutureExt, future::BoxFuture, future::Shared};
use pacer_config::strategy::load_strategy;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tokio::{sync::Mutex, task::JoinHandle, time::interval};

/// How long a request waits for the first status before answering as starting.
pub const STATUS_WARMUP_WAIT_MS: u64 = 300;
/// The refresh cadence (`http.ts:1044`). The first tick is immediate.
pub const STATUS_REFRESH_S: u64 = 60;

type Pending = Shared<BoxFuture<'static, ()>>;

struct State {
    value: Option<Value>,
    error: Option<String>,
    /// One writing compute at a time (`refreshStatus`'s `statusPending`).
    pending: Option<Pending>,
    /// Completed computes; exposed for tests and for the latency evidence.
    computes: usize,
}

pub struct StatusCache {
    rt: Arc<StatusRuntime>,
    state: Arc<Mutex<State>>,
}

/// One compute, shared by every caller that arrives while it runs. The task
/// publishes its own outcome and clears `pending` before it resolves, so the
/// next `refresh` starts a fresh compute.
fn refresh_task(rt: Arc<StatusRuntime>, state: Arc<Mutex<State>>, ctx: Ctx) -> Pending {
    async move {
        {
            let mut started = state.lock().await;
            started.computes += 1;
        }
        let result = async {
            let strategy = load_strategy(&ctx.pacer_home)
                .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
            compute_status(&ctx, &strategy, &StatusOptions::default(), &rt).await
        }
        .await;
        let mut guard = state.lock().await;
        match result {
            Ok(value) => {
                guard.value = Some(value);
                guard.error = None;
            }
            Err(error) => guard.error = Some(error.message),
        }
        guard.pending = None;
    }
    .boxed()
    .shared()
}

impl StatusCache {
    pub fn new(rt: Arc<StatusRuntime>) -> Arc<Self> {
        Arc::new(Self {
            rt,
            state: Arc::new(Mutex::new(State {
                value: None,
                error: None,
                pending: None,
                computes: 0,
            })),
        })
    }

    /// Number of completed computes, for the cache tests and latency evidence.
    pub async fn compute_count(&self) -> usize {
        self.state.lock().await.computes
    }

    /// `refreshStatus`: one writing compute of the active strategy at a time.
    /// Concurrent callers join the same compute; errors are kept, values replace.
    pub async fn refresh(&self, ctx: &Ctx) {
        let pending = {
            let mut state = self.state.lock().await;
            if let Some(pending) = state.pending.clone() {
                pending
            } else {
                let pending = refresh_task(self.rt.clone(), self.state.clone(), ctx.clone());
                state.pending = Some(pending.clone());
                pending
            }
        };
        let _ = pending.await;
    }

    /// `refreshStatusAfterPending`: wait for a running refresh, then refresh
    /// again. B1.4's usage loop calls this after `refresh_all_usage`.
    pub async fn refresh_after_pending(&self, ctx: &Ctx) {
        let pending = self.state.lock().await.pending.clone();
        if let Some(pending) = pending {
            let _ = pending.await;
        }
        self.refresh(ctx).await;
    }

    /// `status()`: the cached value, or the last refresh error. A cold caller
    /// waits up to [`STATUS_WARMUP_WAIT_MS`] for the first refresh, then gets
    /// `unavailable` / "status is warming up".
    pub async fn get(&self) -> Result<Value, CoreError> {
        {
            let state = self.state.lock().await;
            if let Some(value) = &state.value {
                return Ok(value.clone());
            }
        }
        let pending = self.state.lock().await.pending.clone();
        if let Some(pending) = pending {
            let _ =
                tokio::time::timeout(Duration::from_millis(STATUS_WARMUP_WAIT_MS), pending).await;
        }
        let state = self.state.lock().await;
        if let Some(value) = &state.value {
            return Ok(value.clone());
        }
        if let Some(message) = &state.error {
            return Err(CoreError::new(Code::Unavailable, message.clone()));
        }
        Err(CoreError::new(Code::Unavailable, "status is warming up"))
    }

    /// The 60 s timer (`http.ts:1044`): an immediate first tick, then one per
    /// [`STATUS_REFRESH_S`]. `ctx` builds a fresh `Ctx` per tick like TS `getCtx()`.
    pub fn start(
        self: &Arc<Self>,
        ctx: impl Fn() -> Ctx + Send + Sync + 'static,
    ) -> JoinHandle<()> {
        let this = self.clone();
        tokio::spawn(async move {
            let mut ticks = interval(Duration::from_secs(STATUS_REFRESH_S));
            loop {
                ticks.tick().await;
                this.refresh(&ctx()).await;
            }
        })
    }
}
