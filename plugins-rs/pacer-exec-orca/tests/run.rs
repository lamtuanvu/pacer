//! Delivery tests for `pacer-bundled-exec-orca` `run_orca` and the four
//! `executor.*` handlers, ported from `plugins/pacer-exec-orca/index.ts` (M3 C5).
//! A harness with a fake clock drives the plugin; every capability call carries
//! `{taskId:"t1", attempt:1}` as the TypeScript reference's `ids`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use pacer_bundled_exec_orca::{Clock, plugin_with};
use pacer_plugin::testing::Harness;
use serde_json::{Value, json};

/// A clock that records every requested pause and never actually waits.
struct FakeClock {
    sleeps: Arc<Mutex<Vec<u64>>>,
}

impl FakeClock {
    fn new() -> Self {
        Self {
            sleeps: Arc::new(Mutex::new(Vec::new())),
        }
    }
    fn sleeps(&self) -> Vec<u64> {
        self.sleeps.lock().unwrap().clone()
    }
}

impl Clock for FakeClock {
    fn sleep(&self, ms: u64) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        self.sleeps.lock().unwrap().push(ms);
        Box::pin(async {})
    }
}

fn run_params() -> Value {
    json!({
        "task": { "id": "t1", "rev": 1 },
        "attempt": 1,
        "runDir": 1,
        "orca": { "executor": "codex", "model": null, "timeoutMs": 60000 }
    })
}

/// The ordinary pre-start answers: live unset, provision succeeds.
fn on_provision_ok(h: &mut Harness) {
    h.on_capability("capability.orca.liveAnswer", |_| {
        Ok(json!({ "kind": "none" }))
    });
    h.on_capability("capability.orca.prepare", |_| Ok(json!({ "ok": true })));
    h.on_capability("capability.orca.place", |_| Ok(json!({ "ok": true })));
    h.on_capability("capability.orca.terminal", |_| Ok(json!({ "ok": true })));
}

fn calls_named(h: &Harness, method: &str) -> Vec<Value> {
    h.capability_calls()
        .into_iter()
        .filter(|(m, _)| m == method)
        .map(|(_, p)| p)
        .collect()
}

// TS: index.ts:111-115 — `executor.available` reflects `capability.orca.status`.
#[tokio::test]
async fn available_reports_status() {
    for (status, expected) in [
        (json!({ "ready": true }), json!({ "available": true })),
        (
            json!({ "ready": false, "reason": "x" }),
            json!({ "available": false, "reason": "x" }),
        ),
        (
            json!({ "ready": false }),
            json!({
                "available": false,
                "reason": "the Orca runtime is not ready"
            }),
        ),
    ] {
        let mut h =
            Harness::start(plugin_with(Arc::new(FakeClock::new())), Default::default()).await;
        h.on_capability("capability.orca.status", move |_| Ok(status.clone()));
        let result = h.call("executor.available", json!({})).await.unwrap();
        assert_eq!(result, expected);
        h.close().await;
    }
}

// TS: index.ts:117-119 — malformed input is refused with no host traffic.
#[tokio::test]
async fn invalid_run_input_is_refused() {
    let missing_orca = json!({
        "task": { "id": "t1", "rev": 1 },
        "attempt": 1,
        "runDir": 1
    });
    let bad_run_dir = {
        let mut p = run_params();
        p["runDir"] = json!(2);
        p
    };
    let empty_executor = {
        let mut p = run_params();
        p["orca"]["executor"] = json!("");
        p
    };
    let extra_key = {
        let mut p = run_params();
        p["extra"] = json!(true);
        p
    };
    let over_timeout = {
        let mut p = run_params();
        p["orca"]["timeoutMs"] = json!(1_800_001);
        p
    };
    for bad in [
        missing_orca,
        bad_run_dir,
        empty_executor,
        extra_key,
        over_timeout,
    ] {
        let mut h =
            Harness::start(plugin_with(Arc::new(FakeClock::new())), Default::default()).await;
        let err = h.call("executor.run", bad).await.unwrap_err();
        assert_eq!(err.code, "invalid_input");
        assert_eq!(err.message, "an Orca terminal-worker attempt is required");
        assert!(h.capability_calls().is_empty());
        h.close().await;
    }
}

// TS: index.ts:67 — a live fallback is reported before any provisioning.
#[tokio::test]
async fn live_fallback_returns_before_prepare() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::new())), Default::default()).await;
    h.on_capability("capability.orca.liveAnswer", |_| {
        Ok(json!({ "kind": "fallback", "reason": "r" }))
    });
    let result = h.call("executor.run", run_params()).await.unwrap();
    assert_eq!(result, json!({ "orca": { "fallback": { "reason": "r" } } }));
    assert_eq!(
        h.capability_calls(),
        vec![(
            "capability.orca.liveAnswer".to_string(),
            json!({ "taskId": "t1", "attempt": 1 })
        )]
    );
    h.close().await;
}

// TS: index.ts:68 — an attached live worker is supervised without starting.
#[tokio::test]
async fn live_attached_supervises_without_starting() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::new())), Default::default()).await;
    h.on_capability("capability.orca.liveAnswer", |_| {
        Ok(json!({ "kind": "attached", "dispatchId": "d" }))
    });
    h.on_capability("capability.orca.wait", |_| {
        Ok(json!({ "kind": "done", "outcome": "succeeded", "subject": "s", "body": "b" }))
    });
    h.on_capability("capability.orca.settle", |_| Ok(json!({ "ok": true })));
    let finish_answer = json!({ "final": true });
    h.on_capability("capability.orca.finish", move |_| Ok(finish_answer.clone()));
    let result = h.call("executor.run", run_params()).await.unwrap();
    assert_eq!(result, json!({ "final": true }));
    assert_eq!(
        h.capability_calls(),
        vec![
            (
                "capability.orca.liveAnswer".to_string(),
                json!({ "taskId": "t1", "attempt": 1 })
            ),
            (
                "capability.orca.wait".to_string(),
                json!({ "taskId": "t1", "attempt": 1 })
            ),
            (
                "capability.orca.settle".to_string(),
                json!({ "taskId": "t1", "attempt": 1, "settled": true })
            ),
            (
                "capability.orca.finish".to_string(),
                json!({
                    "taskId": "t1", "attempt": 1,
                    "code": 0, "timedOut": false, "settled": true,
                    "summary": "s\n\nb", "keepAlive": false
                })
            ),
        ]
    );
    h.close().await;
}

// TS: index.ts:71 — a refusal keeps the planner's reason; otherwise fallback.
#[tokio::test]
async fn prepare_refusal_and_fallback() {
    for (prepared, expected) in [
        (
            json!({ "ok": false, "reason": "r", "refuse": true }),
            json!({ "orca": { "refused": { "reason": "r" } } }),
        ),
        (
            json!({ "ok": false, "reason": "r", "refuse": false }),
            json!({ "orca": { "fallback": { "reason": "r" } } }),
        ),
    ] {
        let mut h =
            Harness::start(plugin_with(Arc::new(FakeClock::new())), Default::default()).await;
        on_provision_ok(&mut h);
        h.on_capability("capability.orca.prepare", move |_| Ok(prepared.clone()));
        let result = h.call("executor.run", run_params()).await.unwrap();
        assert_eq!(result, expected);
        h.close().await;
    }
}

// TS: index.ts:73 — a place failure abandons with the reason and reports the
// host's abandon answer as the fallback.
#[tokio::test]
async fn place_failure_abandons() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::new())), Default::default()).await;
    on_provision_ok(&mut h);
    h.on_capability("capability.orca.place", |_| {
        Ok(json!({ "ok": false, "reason": "p" }))
    });
    h.on_capability("capability.orca.abandon", |_| Ok(json!({ "reason": "p2" })));
    let result = h.call("executor.run", run_params()).await.unwrap();
    assert_eq!(
        result,
        json!({ "orca": { "fallback": { "reason": "p2" } } })
    );
    assert_eq!(
        calls_named(&h, "capability.orca.abandon"),
        vec![json!({ "taskId": "t1", "attempt": 1, "reason": "p" })]
    );
    h.close().await;
}

// TS: index.ts:75 — a terminal failure abandons the same way.
#[tokio::test]
async fn terminal_failure_abandons() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::new())), Default::default()).await;
    on_provision_ok(&mut h);
    h.on_capability("capability.orca.terminal", |_| {
        Ok(json!({ "ok": false, "reason": "t" }))
    });
    h.on_capability("capability.orca.abandon", |_| Ok(json!({ "reason": "p2" })));
    let result = h.call("executor.run", run_params()).await.unwrap();
    assert_eq!(
        result,
        json!({ "orca": { "fallback": { "reason": "p2" } } })
    );
    assert_eq!(
        calls_named(&h, "capability.orca.abandon"),
        vec![json!({ "taskId": "t1", "attempt": 1, "reason": "t" })]
    );
    h.close().await;
}

// TS: index.ts:78 — a refused start abandons with the code and message.
#[tokio::test]
async fn start_refused_abandons_with_code_and_message() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::new())), Default::default()).await;
    on_provision_ok(&mut h);
    h.on_capability("capability.orca.start", |_| {
        Ok(json!({ "kind": "refused", "code": "E1", "message": "m" }))
    });
    h.on_capability("capability.orca.abandon", |_| Ok(json!({ "reason": "p2" })));
    let result = h.call("executor.run", run_params()).await.unwrap();
    assert_eq!(
        result,
        json!({ "orca": { "fallback": { "reason": "p2" } } })
    );
    assert_eq!(
        calls_named(&h, "capability.orca.abandon"),
        vec![json!({
            "taskId": "t1",
            "attempt": 1,
            "reason": "orca worker-start refused (E1: m)"
        })]
    );
    h.close().await;
}

// TS: index.ts:80-87 — an uncertain start is looked up three times with a
// 5s pause, then unstarted when never found.
#[tokio::test]
async fn uncertain_start_looks_up_three_times() {
    let clock = Arc::new(FakeClock::new());
    let mut h = Harness::start(plugin_with(clock.clone()), Default::default()).await;
    on_provision_ok(&mut h);
    h.on_capability("capability.orca.start", |_| {
        Ok(json!({ "kind": "uncertain" }))
    });
    h.on_capability("capability.orca.lookup", |_| Ok(json!({ "kind": "none" })));
    h.on_capability("capability.orca.unstarted", |_| {
        Ok(json!({ "ok": true, "disposition": "unstarted" }))
    });
    let result = h.call("executor.run", run_params()).await.unwrap();
    assert_eq!(result, json!({ "ok": true, "disposition": "unstarted" }));
    assert_eq!(calls_named(&h, "capability.orca.lookup").len(), 3);
    assert_eq!(
        calls_named(&h, "capability.orca.unstarted"),
        vec![json!({ "taskId": "t1", "attempt": 1 })]
    );
    assert_eq!(clock.sleeps(), vec![5000, 5000]);
    h.close().await;
}

// TS: index.ts:80-87 — an uncertain start found on a later lookup is adopted,
// supervised, settled, and finished.
#[tokio::test]
async fn uncertain_start_found_adopts() {
    let clock = Arc::new(FakeClock::new());
    let lookup_count = Arc::new(AtomicUsize::new(0));
    let count = lookup_count.clone();
    let mut h = Harness::start(plugin_with(clock), Default::default()).await;
    on_provision_ok(&mut h);
    h.on_capability("capability.orca.start", |_| {
        Ok(json!({ "kind": "uncertain", "reason": "warm" }))
    });
    h.on_capability("capability.orca.lookup", move |_| {
        let n = count.fetch_add(1, Ordering::SeqCst);
        Ok(if n == 0 {
            json!({ "kind": "unknown" })
        } else {
            json!({ "kind": "found" })
        })
    });
    h.on_capability("capability.orca.adopt", |_| {
        Ok(json!({
            "kind": "started", "dispatchId": "d", "state": "ready",
            "stage": null, "failedStage": null, "lastError": null
        }))
    });
    h.on_capability("capability.orca.wait", |_| {
        Ok(json!({ "kind": "done", "outcome": "succeeded", "subject": "ok", "body": "" }))
    });
    h.on_capability("capability.orca.settle", |_| Ok(json!({ "ok": true })));
    h.on_capability("capability.orca.finish", |_| {
        Ok(json!({ "ok": true, "done": true }))
    });
    let result = h.call("executor.run", run_params()).await.unwrap();
    assert_eq!(result, json!({ "ok": true, "done": true }));
    let mut methods: Vec<String> = h.capability_calls().into_iter().map(|(m, _)| m).collect();
    methods.retain(|m| {
        m != "capability.orca.liveAnswer"
            && m != "capability.orca.prepare"
            && m != "capability.orca.place"
            && m != "capability.orca.terminal"
            && m != "capability.orca.start"
    });
    assert_eq!(
        methods,
        vec![
            "capability.orca.lookup",
            "capability.orca.lookup",
            "capability.orca.adopt",
            "capability.orca.wait",
            "capability.orca.settle",
            "capability.orca.finish",
        ]
    );
    h.close().await;
}

// TS: index.ts:96-99 — a started worker that did not start ready is finished
// without waiting, marking an agent-launch failure broken.
#[tokio::test]
async fn failed_start_finishes_without_wait() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::new())), Default::default()).await;
    on_provision_ok(&mut h);
    h.on_capability("capability.orca.start", |_| {
        Ok(json!({
            "kind": "started", "dispatchId": "d", "state": "failed",
            "stage": "s", "failedStage": "agent launch", "lastError": "e"
        }))
    });
    h.on_capability("capability.orca.settle", |_| Ok(json!({ "ok": true })));
    h.on_capability("capability.orca.finish", |_| {
        Ok(json!({ "ok": true, "final": true }))
    });
    let result = h.call("executor.run", run_params()).await.unwrap();
    assert_eq!(result, json!({ "ok": true, "final": true }));
    let mut methods: Vec<String> = h.capability_calls().into_iter().map(|(m, _)| m).collect();
    methods.retain(|m| {
        m != "capability.orca.liveAnswer"
            && m != "capability.orca.prepare"
            && m != "capability.orca.place"
            && m != "capability.orca.terminal"
            && m != "capability.orca.start"
    });
    assert!(methods.iter().all(|m| m != "capability.orca.wait"));
    let finish = calls_named(&h, "capability.orca.finish");
    assert_eq!(finish.len(), 1);
    let finish = &finish[0];
    assert_eq!(finish["settled"], json!(true));
    assert_eq!(finish["launchBroken"], json!("orca agent launch failed: e"));
    assert_eq!(
        finish["summary"],
        json!("orca worker failed to start at agent launch: e")
    );
    assert_eq!(finish["keepAlive"], json!(false));
    h.close().await;
}

// TS: index.ts:100-101 — an interactive lane's needs-input worker is kept
// alive (no settle), and finished with keepAlive true.
#[tokio::test]
async fn interactive_needs_input_keeps_the_worker() {
    let mut p = run_params();
    p["orca"]["session"] = json!("interactive");
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::new())), Default::default()).await;
    on_provision_ok(&mut h);
    h.on_capability("capability.orca.start", |_| {
        Ok(json!({
            "kind": "started", "dispatchId": "d", "state": "ready",
            "stage": null, "failedStage": null, "lastError": null
        }))
    });
    h.on_capability("capability.orca.wait", |_| {
        Ok(json!({ "kind": "settled", "state": "needs_input", "error": null }))
    });
    h.on_capability("capability.orca.finish", |_| {
        Ok(json!({ "ok": true, "final": true }))
    });
    let result = h.call("executor.run", p).await.unwrap();
    assert_eq!(result, json!({ "ok": true, "final": true }));
    assert!(calls_named(&h, "capability.orca.settle").is_empty());
    let finish = calls_named(&h, "capability.orca.finish");
    assert_eq!(finish.len(), 1);
    assert_eq!(finish[0]["keepAlive"], json!(true));
    h.close().await;
}

// TS: index.ts:124 — `executor.stop` forwards only task and attempt, not graceMs.
#[tokio::test]
async fn stop_forwards_only_task_and_attempt() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::new())), Default::default()).await;
    h.on_capability("capability.orca.stop", |_| {
        Ok(json!({ "code": 0, "killed": true }))
    });
    let result = h
        .call(
            "executor.stop",
            json!({ "taskId": "t1", "attempt": 1, "graceMs": 100 }),
        )
        .await
        .unwrap();
    assert_eq!(result, json!({ "code": 0, "killed": true }));
    assert_eq!(
        calls_named(&h, "capability.orca.stop"),
        vec![json!({ "taskId": "t1", "attempt": 1 })]
    );
    h.close().await;
}

// TS: index.ts:121-124 — an out-of-range graceMs is rejected as `internal`
// (zod parse, code-only parity).
#[tokio::test]
async fn stop_invalid_params_is_internal() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::new())), Default::default()).await;
    let err = h
        .call(
            "executor.stop",
            json!({ "taskId": "t1", "attempt": 1, "graceMs": 30000 }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, "internal");
    assert!(h.capability_calls().is_empty());
    h.close().await;
}

// TS: index.ts:126-131 — `executor.sessionState` names the orca host.
#[tokio::test]
async fn session_state_names_orca() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::new())), Default::default()).await;
    h.on_capability("capability.orca.sessionState", |_| {
        Ok(json!({ "state": "running", "handle": "h" }))
    });
    let result = h
        .call(
            "executor.sessionState",
            json!({ "taskId": "t1", "attempt": 1 }),
        )
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({ "state": "running", "host": "orca", "handle": "h" })
    );
    assert_eq!(
        calls_named(&h, "capability.orca.sessionState"),
        vec![json!({ "taskId": "t1", "attempt": 1 })]
    );
    h.close().await;
}
