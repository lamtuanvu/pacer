//! A service-owned stale-while-revalidate value, transcribed from
//! `src/serve/read-cache.ts`. Rebuilds start on a later poll, so even the
//! synchronous prefix of a builder cannot delay a warm read; a rebuild error
//! never discards a successful value. Cold builds are coalesced: concurrent
//! readers share one build.
use pacer_foundation::api::{Code, CoreError, OpFuture};
use serde_json::Value;
use std::sync::Arc;
use tokio::{sync::Mutex, task::JoinHandle, time::Instant};

/// The ready-to-wire value a snapshot build produces.
pub type Snapshot = Value;
pub type BuildResult = std::result::Result<Snapshot, CoreError>;

type Builder = Arc<dyn Fn() -> OpFuture<'static> + Send + Sync>;

struct Inner {
    value: Option<Snapshot>,
    built_at: Option<Instant>,
    /// A background (stale-triggered) rebuild in flight.
    pending: Option<JoinHandle<()>>,
    stopped: bool,
}

pub struct ReadCache {
    build: Builder,
    max_age: std::time::Duration,
    inner: Mutex<Inner>,
}

impl ReadCache {
    pub fn new(build: Builder, max_age: std::time::Duration) -> Arc<Self> {
        Arc::new(Self {
            build,
            max_age,
            inner: Mutex::new(Inner {
                value: None,
                built_at: None,
                pending: None,
                stopped: false,
            }),
        })
    }

    /// Serve the current value, or build one on first use. A stale value is
    /// served immediately while a rebuild happens in the background.
    pub async fn get(self: &Arc<Self>) -> BuildResult {
        let action = {
            let inner = self.inner.lock().await;
            if let Some(value) = inner.value.clone() {
                if inner.stopped {
                    return Ok(value);
                }
                let stale = inner
                    .built_at
                    .map_or(true, |at| at.elapsed() >= self.max_age);
                if !stale {
                    return Ok(value);
                }
                Some(value)
            } else {
                None
            }
        };
        match action {
            Some(value) => {
                self.ensure_pending().await;
                Ok(value)
            }
            None => self.cold_build().await,
        }
    }

    /// Force a rebuild even when a value is warm (used after `mode.hold`).
    pub async fn refresh(self: &Arc<Self>) -> BuildResult {
        let handle = self.inner.lock().await.pending.take();
        if let Some(handle) = handle {
            let _ = handle.await;
        }
        self.build_under_lock().await
    }

    /// Await any in-flight background build, then force a fresh build.
    pub async fn refresh_after_pending(self: &Arc<Self>) -> BuildResult {
        self.refresh().await
    }

    /// Stop triggering background rebuilds; callers still read the last value.
    pub fn stop(&self) {
        if let Ok(mut inner) = self.inner.try_lock() {
            inner.stopped = true;
            inner.pending = None;
        }
    }

    async fn cold_build(self: &Arc<Self>) -> BuildResult {
        // Coalesce concurrent cold builders: hold the lock across the build so
        // a later caller sees the populated value instead of building again.
        let result = self.build_under_lock().await;
        result
    }

    async fn build_under_lock(self: &Arc<Self>) -> BuildResult {
        let mut inner = self.inner.lock().await;
        if inner.stopped {
            return Err(CoreError::new(Code::Unavailable, "snapshot cache stopped"));
        }
        // Another caller may have populated a fresh value while we awaited the lock.
        if let Some(value) = inner.value.clone() {
            let stale = inner
                .built_at
                .map_or(true, |at| at.elapsed() >= self.max_age);
            if !stale {
                return Ok(value);
            }
        }
        let result = (self.build.clone())().await;
        match result {
            Ok(value) => {
                inner.value = Some(value.clone());
                inner.built_at = Some(Instant::now());
                Ok(value)
            }
            Err(error) => {
                // A rebuild error never discards a successful value; a cold
                // error still fails.
                if let Some(value) = inner.value.clone() {
                    Ok(value)
                } else {
                    Err(error)
                }
            }
        }
    }

    async fn ensure_pending(self: &Arc<Self>) {
        let mut inner = self.inner.lock().await;
        if inner.pending.is_some() || inner.stopped {
            return;
        }
        let this = self.clone();
        inner.pending = Some(tokio::spawn(async move {
            if let Ok(value) = (this.build)().await {
                let mut inner = this.inner.lock().await;
                inner.pending = None;
                if !inner.stopped {
                    inner.value = Some(value.clone());
                    inner.built_at = Some(Instant::now());
                }
            } else {
                let mut inner = this.inner.lock().await;
                inner.pending = None;
            }
        }));
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    fn builder(produce: Arc<dyn Fn() -> BuildResult + Send + Sync>) -> Builder {
        Arc::new(move || {
            let produce = produce.clone();
            Box::pin(async move { produce() })
        })
    }

    fn snafu() -> BuildResult {
        Err(CoreError::new(Code::Internal, "boom"))
    }

    #[tokio::test(start_paused = true)]
    async fn cold_build_is_coalesced_and_served() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let produce = {
            let calls = calls.clone();
            Arc::new(move || {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(json!({"seq": 1}))
            })
        };
        let cache = ReadCache::new(builder(produce), Duration::from_secs(1));
        let ca = cache.clone();
        let cb = cache.clone();
        let (av, bv) = tokio::join!(ca.get(), cb.get());
        assert_eq!(av.unwrap(), json!({"seq": 1}));
        assert_eq!(bv.unwrap(), json!({"seq": 1}));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn serves_stale_within_the_age_and_rebuilds_after() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let produce = {
            let calls = calls.clone();
            Arc::new(move || {
                let n = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                Ok(json!({"seq": n}))
            })
        };
        let cache = ReadCache::new(builder(produce), Duration::from_secs(1));
        assert_eq!(cache.clone().get().await.unwrap(), json!({"seq": 1}));
        // Within the max age the warm value is served without a rebuild.
        tokio::time::advance(Duration::from_millis(500)).await;
        assert_eq!(cache.clone().get().await.unwrap(), json!({"seq": 1}));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        // Past the max age the stale value is served and a rebuild starts.
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_eq!(cache.clone().get().await.unwrap(), json!({"seq": 1}));
        // Reaching the pending rebuild publishes the fresh value.
        cache.clone().refresh_after_pending().await.unwrap();
        assert_eq!(cache.clone().get().await.unwrap(), json!({"seq": 2}));
    }

    #[tokio::test(start_paused = true)]
    async fn cold_failure_rejects_and_a_rebuild_never_discards_a_value() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let produce = {
            let calls = calls.clone();
            Arc::new(move || {
                if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    snafu()
                } else {
                    Ok(json!({"seq": 9}))
                }
            })
        };
        let cache = ReadCache::new(builder(produce), Duration::from_secs(1));
        assert!(cache.clone().get().await.is_err());
        cache.clone().refresh().await.unwrap();
        assert_eq!(cache.clone().get().await.unwrap(), json!({"seq": 9}));
    }
}
