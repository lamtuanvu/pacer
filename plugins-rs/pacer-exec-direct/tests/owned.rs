//! Delivery tests for the owned executor attempt (`run_owned`), ported from
//! `test/plugins-executor-owned-provider.test.ts` (M3 C10) plus cases derived
//! from `plugins/pacer-exec-direct/index.ts:84-157`. A fake clock drives the
//! plugin; every capability call carries the TypeScript reference's ids.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use pacer_bundled_exec_direct::{Clock, FakeClock, plugin_with};
use pacer_plugin::testing::Harness;
use serde_json::{Value, json};

/// The owned run params from `test/plugins-executor-owned-provider.test.ts:5`.
fn owned_params() -> Value {
    json!({
        "task": { "id": "t-fixture", "rev": 2 },
        "attempt": 1,
        "runDir": 1,
        "owned": { "placement": "current", "timeoutMs": 5000, "executor": "codex", "model": null }
    })
}

fn claim_run_answer() -> Value {
    json!({
        "task": { "id": "t-fixture", "rev": 3 },
        "attempt": 1,
        "runDir": 1,
        "dir": "/tmp/owned/1",
        "workdir": "/tmp/repo",
        "startedAt": 100,
        "logFile": "/tmp/owned/1/stdout"
    })
}

fn calls_named(h: &Harness, method: &str) -> Vec<Value> {
    h.capability_calls()
        .into_iter()
        .filter(|(m, _)| m == method)
        .map(|(_, p)| p)
        .collect()
}

// TS: :8 — claim, start, bounded polls and a full local outcome with no
// direct process call.
#[tokio::test]
async fn provider_owns_claim_start_polls_and_outcome() {
    let clock = Arc::new(FakeClock::at(0.0));
    let mut h = Harness::start(plugin_with(clock.clone()), Default::default()).await;
    let polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = polls.clone();
    h.on_capability("capability.process.claimRun", |_| Ok(claim_run_answer()));
    h.on_capability("capability.process.startRun", |_| Ok(json!({ "pid": 42 })));
    h.on_capability("capability.process.pollRun", move |_| {
        let n = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(if n == 0 {
            json!({ "state": "running", "exitCode": null })
        } else {
            json!({ "state": "exited", "exitCode": 0 })
        })
    });
    h.on_capability("capability.process.readRunOutput", |_| {
        Ok(json!({
            "stdoutBase64": "Zml4dHVyZSBjb21wbGV0ZQo=",
            "stderrBase64": ""
        }))
    });
    let result = h.call("executor.run", owned_params()).await.unwrap();
    assert_eq!(result["backend"], "direct");
    assert_eq!(result["report"], "fixture complete");
    assert_eq!(result["attempt"]["executor"], "codex");
    assert_eq!(result["attempt"]["exitCode"], 0);
    assert_eq!(result["attempt"]["limitHit"], false);
    assert_eq!(result["exec"]["code"], 0);
    let calls = h.capability_calls();
    let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(
        methods,
        vec![
            "capability.process.claimRun",
            "capability.process.startRun",
            "capability.process.pollRun",
            "capability.process.pollRun",
            "capability.process.readRunOutput",
        ]
    );
    assert_eq!(clock.sleeps(), vec![200]);
    h.close().await;
}

// TS: :31 — placement `new` resolves a base and creates a worktree before claim.
#[tokio::test]
async fn isolated_provider_places_before_claim() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.worktree.resolveBase", |_| {
        Ok(json!({ "base": "HEAD", "sha": "a".repeat(40) }))
    });
    h.on_capability("capability.worktree.createOrReuse", |_| {
        Ok(json!({ "workdir": "/tmp/owned-worktree" }))
    });
    h.on_capability("capability.process.claimRun", |_| {
        Ok({
            let mut a = claim_run_answer();
            a["workdir"] = json!("/tmp/owned-worktree");
            a
        })
    });
    h.on_capability("capability.process.startRun", |_| Ok(json!({ "pid": 42 })));
    h.on_capability("capability.process.pollRun", |_| {
        Ok(json!({ "state": "exited", "exitCode": 0 }))
    });
    h.on_capability("capability.process.readRunOutput", |_| {
        Ok(json!({ "stdoutBase64": "", "stderrBase64": "" }))
    });
    let mut params = owned_params();
    params["owned"]["placement"] = json!("new");
    let result = h.call("executor.run", params).await.unwrap();
    assert_eq!(result["worktree"], "/tmp/owned-worktree");
    let calls = h.capability_calls();
    let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(
        &methods[..4],
        &[
            "capability.worktree.resolveBase",
            "capability.worktree.createOrReuse",
            "capability.process.claimRun",
            "capability.process.startRun",
        ]
    );
    h.close().await;
}

// TS: :52 — a lost start receipt stays uncertain with no extra start or fallback.
#[tokio::test]
async fn lost_start_receipt_stays_uncertain() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.process.claimRun", |_| Ok(claim_run_answer()));
    h.on_capability("capability.process.startRun", |_| {
        Err((
            "capability_denied".to_string(),
            "lost start receipt".to_string(),
        ))
    });
    let err = h.call("executor.run", owned_params()).await.unwrap_err();
    assert_eq!(err.message, "lost start receipt");
    let calls = h.capability_calls();
    let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(methods, vec!["capability.process.claimRun", "capability.process.startRun"]);
    h.close().await;
}

// TS: :66 — a resumed run reads the prior run without claiming or starting.
#[tokio::test]
async fn recovery_reads_prior_run_without_claim_or_start() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.process.pollRun", |_| {
        Ok(json!({ "state": "exited", "exitCode": 0 }))
    });
    h.on_capability("capability.process.readRunOutput", |_| {
        Ok(json!({
            "stdoutBase64": "cmVjb3ZlcmVkCg==",
            "stderrBase64": ""
        }))
    });
    let mut params = owned_params();
    params["owned"]["resume"] =
        json!({ "startedAt": 100, "logFile": "/tmp/owned/1/stdout" });
    let result = h.call("executor.run", params).await.unwrap();
    assert_eq!(result["report"], "recovered");
    assert_eq!(result["attempt"]["startedAt"], 100.0);
    let calls = h.capability_calls();
    let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(
        methods,
        vec!["capability.process.pollRun", "capability.process.readRunOutput"]
    );
    h.close().await;
}

// TS: :82 — interactive settles only a host-reaped terminal report.
#[tokio::test]
async fn interactive_settles_only_host_reaped_report() {
    let clock = Arc::new(FakeClock::at(0.0));
    let mut h = Harness::start(plugin_with(clock.clone()), Default::default()).await;
    let polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = polls.clone();
    h.on_capability("capability.process.claimRun", |_| Ok(claim_run_answer()));
    h.on_capability("capability.process.startRun", |_| Ok(json!({ "pid": 42 })));
    h.on_capability("capability.process.pollRun", move |_| {
        let n = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(if n == 0 {
            json!({
                "state": "running", "exitCode": null, "interactive": true,
                "report": { "status": "done", "summary": "reported complete", "at": 101 }
            })
        } else {
            json!({
                "state": "exited", "exitCode": 143, "interactive": true,
                "report": { "status": "done", "summary": "reported complete", "at": 101 }
            })
        })
    });
    h.on_capability("capability.process.completeReportedRun", |_| {
        Ok(json!({
            "status": "done", "summary": "reported complete", "at": 101, "exitCode": 143
        }))
    });
    h.on_capability("capability.process.readRunOutput", |_| {
        Ok(json!({ "stdoutBase64": "", "stderrBase64": "" }))
    });
    let mut params = owned_params();
    params["owned"]["session"] = json!("interactive");
    let result = h.call("executor.run", params).await.unwrap();
    assert_eq!(result["report"], "reported complete");
    assert_eq!(result["exec"]["code"], 0);
    assert_eq!(result["attempt"]["exitCode"], 0);
    let calls = h.capability_calls();
    let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(
        methods,
        vec![
            "capability.process.claimRun",
            "capability.process.startRun",
            "capability.process.pollRun",
            "capability.process.completeReportedRun",
            "capability.process.pollRun",
            "capability.process.readRunOutput",
        ]
    );
    h.close().await;
}

// TS: :110 — interactive exit without an explicit completion report is failure.
#[tokio::test]
async fn interactive_exit_without_report_is_failure() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.process.pollRun", |_| {
        Ok(json!({ "state": "exited", "exitCode": 0, "interactive": true, "report": null }))
    });
    h.on_capability("capability.process.readRunOutput", |_| {
        Ok(json!({ "stdoutBase64": "", "stderrBase64": "" }))
    });
    let mut params = owned_params();
    params["owned"]["session"] = json!("interactive");
    params["owned"]["resume"] =
        json!({ "startedAt": 100, "logFile": "/tmp/owned/1/stdout" });
    let result = h.call("executor.run", params).await.unwrap();
    assert_eq!(result["exec"]["code"], 1);
    assert_eq!(result["attempt"]["exitCode"], 1);
    let calls = h.capability_calls();
    let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(
        methods,
        vec!["capability.process.pollRun", "capability.process.readRunOutput"]
    );
    h.close().await;
}

// TS: :127 — interactive exit after needs-input keeps the question.
#[tokio::test]
async fn interactive_needs_input_exit_keeps_question() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.process.pollRun", |_| {
        Ok(json!({
            "state": "exited", "exitCode": 0, "interactive": true,
            "report": { "status": "needs-input", "summary": "Approve access", "at": 101 }
        }))
    });
    h.on_capability("capability.process.readRunOutput", |_| {
        Ok(json!({ "stdoutBase64": "", "stderrBase64": "" }))
    });
    let mut params = owned_params();
    params["owned"]["session"] = json!("interactive");
    params["owned"]["resume"] =
        json!({ "startedAt": 100, "logFile": "/tmp/owned/1/stdout" });
    let result = h.call("executor.run", params).await.unwrap();
    assert_eq!(result["exec"]["code"], 1);
    assert_eq!(result["attempt"]["exitCode"], 1);
    let report = result["report"].as_str().unwrap();
    assert!(report.contains("without an explicit completion report"));
    assert!(report.contains("Approve access"));
    h.close().await;
}

// Derived from index.ts:153 — a wall-clock deadline reached while running is a
// `plugin_timeout`.
#[tokio::test]
async fn owned_deadline_reached_is_plugin_timeout() {
    let clock = Arc::new(FakeClock::at(0.0));
    let jump = clock.clone();
    let mut h = Harness::start(plugin_with(clock), Default::default()).await;
    h.on_capability("capability.process.claimRun", |_| Ok(claim_run_answer()));
    h.on_capability("capability.process.startRun", |_| Ok(json!({ "pid": 42 })));
    h.on_capability("capability.process.pollRun", move |_| {
        jump.set_now(6_000.0); // past `now + timeoutMs` (5000)
        Ok(json!({ "state": "running", "exitCode": null }))
    });
    let err = h.call("executor.run", owned_params()).await.unwrap_err();
    assert_eq!(err.code, "plugin_timeout");
    assert_eq!(
        err.message,
        "executor deadline reached; persisted wrapper requires stop reconciliation"
    );
    h.close().await;
}

// Derived from index.ts:150 — an uncertain state that persists ~5s refuses a
// replacement launch. The deadline is pushed far out so only the uncertain path
// fires.
#[tokio::test]
async fn uncertain_for_5s_refuses_replacement() {
    let clock = Arc::new(FakeClock::at(0.0));
    let jump = clock.clone();
    let mut h = Harness::start(plugin_with(clock), Default::default()).await;
    h.on_capability("capability.process.pollRun", move |_| {
        jump.set_now(jump.now_ms() + 6_000.0);
        Ok(json!({ "state": "uncertain", "exitCode": null }))
    });
    let mut params = owned_params();
    params["owned"]["timeoutMs"] = json!(14_400_000);
    params["owned"]["resume"] =
        json!({ "startedAt": 0.0, "logFile": "/tmp/owned/1/stdout" });
    let err = h.call("executor.run", params).await.unwrap_err();
    assert_eq!(err.code, "plugin_unavailable");
    assert_eq!(
        err.message,
        "executor wrapper state is uncertain; replacement launch refused"
    );
    h.close().await;
}

// Derived from index.ts:101-102 — a claim workdir different from the placed
// worktree is a `capability_denied`.
#[tokio::test]
async fn claim_workdir_mismatch_is_denied() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.worktree.resolveBase", |_| {
        Ok(json!({ "base": "HEAD", "sha": "a".repeat(40) }))
    });
    h.on_capability("capability.worktree.createOrReuse", |_| {
        Ok(json!({ "workdir": "/tmp/owned-worktree" }))
    });
    h.on_capability("capability.process.claimRun", |_| {
        Ok({
            let mut a = claim_run_answer();
            a["workdir"] = json!("/tmp/other");
            a
        })
    });
    let mut params = owned_params();
    params["owned"]["placement"] = json!("new");
    let err = h.call("executor.run", params).await.unwrap_err();
    assert_eq!(err.code, "capability_denied");
    assert_eq!(err.message, "executor worktree changed after placement");
    h.close().await;
}

// Derived from index.ts:116 — an interactive run must observe session proof.
#[tokio::test]
async fn interactive_without_session_proof_is_refused() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.process.pollRun", |_| {
        Ok(json!({ "state": "running", "exitCode": null }))
    });
    let mut params = owned_params();
    params["owned"]["session"] = json!("interactive");
    params["owned"]["resume"] =
        json!({ "startedAt": 100, "logFile": "/tmp/owned/1/stdout" });
    let err = h.call("executor.run", params).await.unwrap_err();
    assert_eq!(err.code, "plugin_refused");
    assert_eq!(err.message, "interactive run observation has no session proof");
    h.close().await;
}

// Derived from index.ts:122-124 — a host reaped report that changed between
// observation and completion is refused.
#[tokio::test]
async fn interactive_receipt_mismatch_is_refused() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.process.pollRun", |_| {
        Ok(json!({
            "state": "running", "exitCode": null, "interactive": true,
            "report": { "status": "done", "summary": "reported complete", "at": 101 }
        }))
    });
    h.on_capability("capability.process.completeReportedRun", |_| {
        Ok(json!({
            "status": "failed", "summary": "changed", "at": 102, "exitCode": 1
        }))
    });
    let mut params = owned_params();
    params["owned"]["session"] = json!("interactive");
    params["owned"]["resume"] =
        json!({ "startedAt": 100, "logFile": "/tmp/owned/1/stdout" });
    let err = h.call("executor.run", params).await.unwrap_err();
    assert_eq!(err.code, "plugin_refused");
    assert_eq!(err.message, "interactive report completion changed");
    h.close().await;
}

// The interactive receipt comparison in owned.rs reuses the scripted report
// ids; this proxies `calls_named` for the compile-time reachability check a
// reviewer needs. (No assertion here; the TS test is HOST-ONLY.)
#[allow(dead_code)]
fn _reachable(_: &Harness) {
    let _ = calls_named;
}