//! Task-level locking using the foundation lock protocol.
use pacer_foundation::{Ctx, lock::{LockOptions, with_lock, with_lock_async}};
use std::future::Future;
use std::pin::Pin;

/// Options for task locking.
#[derive(Debug, Clone)]
pub struct TaskLockOptions {
    pub timeout: std::time::Duration,
    pub stale: std::time::Duration,
}

impl Default for TaskLockOptions {
    fn default() -> Self {
        Self {
            timeout: std::time::Duration::from_secs(20),
            stale: std::time::Duration::from_secs(120),
        }
    }
}

impl From<TaskLockOptions> for LockOptions {
    fn from(o: TaskLockOptions) -> Self {
        LockOptions {
            timeout: o.timeout,
            stale: o.stale,
        }
    }
}

/// Execute a closure with a per-task lock held.
pub fn with_task_lock<T>(ctx: &Ctx, task_id: &str, f: impl FnOnce() -> T) -> Result<T, pacer_foundation::lock::LockError> {
    let lock_name = format!("task-{task_id}");
    with_lock(ctx, &lock_name, LockOptions::default(), f)
}

/// Execute an async closure with a per-task lock held.
pub fn with_task_lock_async<T, F, Fut>(ctx: &Ctx, task_id: &str, f: F) -> Pin<Box<dyn Future<Output = Result<T, pacer_foundation::lock::LockError>> + Send>>
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let lock_name = format!("task-{task_id}");
    let ctx = ctx.clone();
    Box::pin(async move {
        with_lock_async(&ctx, &lock_name, LockOptions::default(), f).await
    })
}