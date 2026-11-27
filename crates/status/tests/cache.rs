#![allow(clippy::unwrap_used)]
//! B12-8: the service status cache. The single-flight refresh, the 300 ms cold
//! warm-up and the 60 s timer are exercised against a fake plugin door whose
//! usage calls can be delayed, with Tokio's paused test clock.

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_plugin_ops::{extension::EntriesFuture, public::Entry};
use pacer_status::{
    cache::{STATUS_WARMUP_WAIT_MS, StatusCache},
    compute::{ActivityRebuilds, LoginPaths, StatusRuntime},
    usage::{NativeUsage, PluginDoor},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

const PLUGIN: &str = "pacer-usage";
const NOW: f64 = 1_790_000_000.0;
const STRATEGY: &str = "planner: claude-code\naccounts:\n  claude: {kind: claude}\nrunners:\n  claude-code: {}\npacing: {policy: priority, order: [claude-code]}\n";

struct Inner {
    entries: Vec<Entry>,
    /// Counts `entries()` calls: `compute_status` fetches them exactly once.
    computes: usize,
    delay: Duration,
    fail_entries: bool,
}

struct FakeDoor {
    inner: Arc<Mutex<Inner>>,
}

struct FakeCalls {
    inner: Arc<Mutex<Inner>>,
}

impl PluginDoor for FakeDoor {
    fn calls(&self) -> Box<dyn pacer_plugin_ops::extension::ExtensionCalls + '_> {
        Box::new(FakeCalls {
            inner: self.inner.clone(),
        })
    }
}

impl pacer_plugin_ops::extension::ExtensionCalls for FakeCalls {
    fn entries<'a>(&'a mut self, _: &'a Ctx) -> EntriesFuture<'a> {
        let (entries, fail) = {
            let mut inner = self.inner.lock().unwrap();
            inner.computes += 1;
            (inner.entries.clone(), inner.fail_entries)
        };
        if fail {
            return Box::pin(async { Err(CoreError::new(Code::Internal, "entries failed")) });
        }
        Box::pin(async move { Ok(entries) })
    }

    fn call<'a>(
        &'a mut self,
        _: &'a Ctx,
        _: &'a str,
        _: &'a str,
        _: Value,
    ) -> pacer_foundation::api::OpFuture<'a> {
        let delay = self.inner.lock().unwrap().delay;
        Box::pin(async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            Ok(json!({"reading": reading()}))
        })
    }
}

fn usage_plugin() -> Entry {
    Entry {
        id: PLUGIN.to_string(),
        manifest: Some(json!({"contributes": {"usage": {
            "providers": ["claude-code", "codex", "arkcli", "metered"]
        }}})),
        bundled: true,
        grant: json!({}),
        state: "ready".to_string(),
        error: None,
        pid: None,
        served: vec![],
        protocol: None,
        restarts: 0,
    }
}

fn reading() -> Value {
    json!({
        "windows": [{"lengthS": 18000, "usedPct": 20, "resetsAt": NOW + 7200.0}],
        "capturedAt": NOW,
        "stale": false,
        "source": "claude-code",
    })
}

struct Harness {
    inner: Arc<Mutex<Inner>>,
    home: PathBuf,
    pacer: PathBuf,
}

impl Harness {
    fn new(delay: Duration) -> Self {
        let home = tempfile::tempdir().unwrap().keep();
        let pacer = home.join(".pacer");
        std::fs::create_dir_all(pacer.join("strategies")).unwrap();
        std::fs::write(pacer.join("strategy.yaml"), STRATEGY).unwrap();
        let inner = Arc::new(Mutex::new(Inner {
            entries: vec![usage_plugin()],
            computes: 0,
            delay,
            fail_entries: false,
        }));
        Self { inner, home, pacer }
    }

    fn ctx(&self) -> Ctx {
        Ctx::with(
            self.home.clone(),
            self.pacer.clone(),
            HashMap::from([
                ("HOME".into(), self.home.to_string_lossy().into_owned()),
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("TMPDIR".into(), self.home.to_string_lossy().into_owned()),
            ]),
            NOW,
        )
    }

    fn rt(&self) -> Arc<StatusRuntime> {
        let door = Arc::new(FakeDoor {
            inner: self.inner.clone(),
        });
        Arc::new(StatusRuntime {
            usage: NativeUsage::new(door.clone()),
            door,
            login: Arc::new(LoginPaths::default()),
            activity: Arc::new(ActivityRebuilds::default()),
        })
    }
}

#[tokio::test(start_paused = true)]
async fn cold_get_waits_at_most_300ms_then_reports_warming_up() {
    let h = Harness::new(Duration::from_secs(1));
    let cache = StatusCache::new(h.rt());
    let ctx = h.ctx();
    // Poll the refresh first so `get` sees an in-flight compute. Measure inside
    // the reader: the joined refresh itself keeps running past the 300 ms wait.
    let read = async {
        let started = tokio::time::Instant::now();
        let result = cache.get().await;
        (started.elapsed(), result)
    };
    let (_, (elapsed, result)) = tokio::join!(cache.refresh(&ctx), read);
    let error = result.unwrap_err();
    assert_eq!(elapsed, Duration::from_millis(STATUS_WARMUP_WAIT_MS));
    assert_eq!(error.code, Code::Unavailable);
    assert_eq!(error.message, "status is warming up");
}

#[tokio::test(start_paused = true)]
async fn cold_get_waits_for_a_refresh_that_finishes_quickly() {
    let h = Harness::new(Duration::from_millis(100));
    let cache = StatusCache::new(h.rt());
    let ctx = h.ctx();
    let started = tokio::time::Instant::now();
    let (_, result) = tokio::join!(cache.refresh(&ctx), cache.get());
    assert!(result.is_ok());
    assert!(started.elapsed() < Duration::from_millis(STATUS_WARMUP_WAIT_MS));
}

#[tokio::test(start_paused = true)]
async fn a_failed_compute_is_reported_then_cleared_by_the_next_refresh() {
    let h = Harness::new(Duration::ZERO);
    h.inner.lock().unwrap().fail_entries = true;
    let cache = StatusCache::new(h.rt());
    cache.refresh(&h.ctx()).await;
    let error = cache.get().await.unwrap_err();
    assert_eq!(error.message, "entries failed");

    h.inner.lock().unwrap().fail_entries = false;
    cache.refresh(&h.ctx()).await;
    assert!(cache.get().await.is_ok());
}

#[tokio::test(start_paused = true)]
async fn two_concurrent_refreshes_compute_once() {
    let h = Harness::new(Duration::from_millis(100));
    let cache = StatusCache::new(h.rt());
    let a = cache.clone();
    let b = cache.clone();
    let ctx = h.ctx();
    tokio::join!(a.refresh(&ctx), b.refresh(&ctx));
    assert_eq!(cache.compute_count().await, 1);
}

#[tokio::test(start_paused = true)]
async fn refresh_after_pending_waits_then_computes_again() {
    let h = Harness::new(Duration::from_millis(100));
    let cache = StatusCache::new(h.rt());
    let refresher = {
        let cache = cache.clone();
        let ctx = h.ctx();
        tokio::spawn(async move { cache.refresh(&ctx).await })
    };
    while cache.compute_count().await < 1 {
        tokio::task::yield_now().await;
    }
    cache.refresh_after_pending(&h.ctx()).await;
    assert_eq!(cache.compute_count().await, 2);
    refresher.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn start_refreshes_at_zero_and_every_60_seconds() {
    let h = Harness::new(Duration::ZERO);
    let cache = StatusCache::new(h.rt());
    let home = h.home.clone();
    let pacer = h.pacer.clone();
    let handle = cache.start(move || {
        Ctx::with(
            home.clone(),
            pacer.clone(),
            HashMap::from([
                ("HOME".into(), home.to_string_lossy().into_owned()),
                ("PATH".into(), "/usr/bin:/bin".into()),
            ]),
            NOW,
        )
    });
    while cache.compute_count().await < 1 {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_secs(59)).await;
    tokio::task::yield_now().await;
    assert_eq!(cache.compute_count().await, 1);
    tokio::time::advance(Duration::from_secs(1)).await;
    while cache.compute_count().await < 2 {
        tokio::task::yield_now().await;
    }
    handle.abort();
}
