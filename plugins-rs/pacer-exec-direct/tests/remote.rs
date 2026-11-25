//! Delivery tests for the remote owned-executor attempt (`run_owned_remote`),
//! ported from `test/plugins-executor-owned-provider.test.ts:142-208` (M3 C10)
//! plus cases derived from `plugins/pacer-exec-direct/index.ts:40-82`. A fake
//! clock drives the plugin; every capability call carries the TypeScript
//! reference's ids.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use pacer_bundled_exec_direct::{Clock, FakeClock, plugin_with};
use pacer_plugin::testing::Harness;
use serde_json::{Value, json};

/// The remote run params from `test/plugins-executor-owned-provider.test.ts:155`.
fn remote_params() -> Value {
    json!({
        "task": { "id": "t-fixture", "rev": 2 },
        "attempt": 1,
        "runDir": 1,
        "remote": { "timeoutMs": 5000, "executor": "codex@box", "model": null }
    })
}

fn prepare_answer() -> Value {
    json!({ "worktree": "/home/x/worktree", "branch": "pacer/t-fixture" })
}

fn claim_answer() -> Value {
    json!({ "startedAt": 100, "logFile": "/tmp/owned/1/stdout" })
}

/// The empty-output answers common to every terminal remote run.
fn on_terminal_output(h: &mut Harness) {
    h.on_capability("capability.hosts.readOwnedOutput", |_| {
        Ok(json!({ "stdoutBase64": "", "stderrBase64": "" }))
    });
    h.on_capability("capability.hosts.transferOwned", |_| {
        Ok(json!({ "transferred": false }))
    });
}

// TS: :142 — placement, claim, start, a single observation and the full pipe
// outcome ready to return.
#[tokio::test]
async fn remote_provider_owns_placement_to_outcome() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.hosts.prepareOwned", |_| Ok(prepare_answer()));
    h.on_capability("capability.hosts.claimOwned", |_| Ok(claim_answer()));
    h.on_capability("capability.hosts.startOwned", |_| Ok(json!({ "pid": 42 })));
    h.on_capability("capability.hosts.pollOwned", |_| {
        Ok(json!({ "state": "exited", "exitCode": 0 }))
    });
    h.on_capability("capability.hosts.readOwnedOutput", |_| {
        Ok(json!({
            "stdoutBase64": "cmVtb3RlIGNvbXBsZXRlCg==",
            "stderrBase64": ""
        }))
    });
    h.on_capability("capability.hosts.transferOwned", |_| {
        Ok(json!({ "transferred": false }))
    });
    let result = h.call("executor.run", remote_params()).await.unwrap();
    assert_eq!(result["backend"], "direct");
    assert_eq!(result["report"], "remote complete");
    assert_eq!(result["attempt"]["executor"], "codex@box");
    assert_eq!(result["attempt"]["exitCode"], 0);
    let calls = h.capability_calls();
    let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(
        methods,
        vec![
            "capability.hosts.prepareOwned",
            "capability.hosts.claimOwned",
            "capability.hosts.startOwned",
            "capability.hosts.pollOwned",
            "capability.hosts.readOwnedOutput",
            "capability.hosts.transferOwned",
        ]
    );
    h.close().await;
}

// TS: :165 — a lost start receipt propagates; a resumed run only polls, reads
// output and transfers, never preparing or claiming.
#[tokio::test]
async fn remote_never_retries_unreceipted_start_or_claims_on_resume() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.hosts.prepareOwned", |_| Ok(prepare_answer()));
    h.on_capability("capability.hosts.claimOwned", |_| Ok(claim_answer()));
    h.on_capability("capability.hosts.startOwned", |_| {
        Err((
            "capability_denied".to_string(),
            "lost START receipt".to_string(),
        ))
    });
    let err = h.call("executor.run", remote_params()).await.unwrap_err();
    assert_eq!(err.message, "lost START receipt");
    let calls = h.capability_calls();
    let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(
        methods,
        vec![
            "capability.hosts.prepareOwned",
            "capability.hosts.claimOwned",
            "capability.hosts.startOwned",
        ]
    );
    h.close().await;

    // A resumed run skips prepare, claim and start entirely.
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.hosts.pollOwned", |_| {
        Ok(json!({ "state": "exited", "exitCode": 0 }))
    });
    h.on_capability("capability.hosts.readOwnedOutput", |_| {
        Ok(json!({ "stdoutBase64": "", "stderrBase64": "" }))
    });
    h.on_capability("capability.hosts.transferOwned", |_| {
        Ok(json!({ "transferred": false }))
    });
    let mut params = remote_params();
    params["remote"]["resume"] =
        json!({ "startedAt": 100, "logFile": "/tmp/owned/1/stdout" });
    let result = h.call("executor.run", params).await.unwrap();
    assert_eq!(result["report"], "");
    let calls = h.capability_calls();
    let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(
        methods,
        vec![
            "capability.hosts.pollOwned",
            "capability.hosts.readOwnedOutput",
            "capability.hosts.transferOwned",
        ]
    );
    h.close().await;
}

// TS: :194 — an uncertain transfer propagates after the observation and
// output read, with no extra start or direct SSH.
#[tokio::test]
async fn remote_refuses_uncertain_transfer() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.hosts.pollOwned", |_| {
        Ok(json!({ "state": "exited", "exitCode": 0 }))
    });
    h.on_capability("capability.hosts.readOwnedOutput", |_| {
        Ok(json!({ "stdoutBase64": "", "stderrBase64": "" }))
    });
    h.on_capability("capability.hosts.transferOwned", |_| {
        Err((
            "capability_denied".to_string(),
            "transfer receipt lost".to_string(),
        ))
    });
    let mut params = remote_params();
    params["remote"]["resume"] =
        json!({ "startedAt": 100, "logFile": "/tmp/owned/1/stdout" });
    let err = h.call("executor.run", params).await.unwrap_err();
    assert_eq!(err.message, "transfer receipt lost");
    let calls = h.capability_calls();
    let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(
        methods,
        vec![
            "capability.hosts.pollOwned",
            "capability.hosts.readOwnedOutput",
            "capability.hosts.transferOwned",
        ]
    );
    h.close().await;
}

// Derived from index.ts:66 — a `reason` on the transfer is a `plugin_refused`.
#[tokio::test]
async fn transfer_reason_is_refused() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.hosts.pollOwned", |_| {
        Ok(json!({ "state": "exited", "exitCode": 0 }))
    });
    on_terminal_output(&mut h);
    h.on_capability("capability.hosts.transferOwned", |_| {
        Ok(json!({ "transferred": false, "reason": "no upstream" }))
    });
    let mut params = remote_params();
    params["remote"]["resume"] =
        json!({ "startedAt": 100, "logFile": "/tmp/owned/1/stdout" });
    let err = h.call("executor.run", params).await.unwrap_err();
    assert_eq!(err.code, "plugin_refused");
    assert_eq!(err.message, "remote transfer is unresolved: no upstream");
    h.close().await;
}

// Derived from index.ts:72-73 — a transferred review worktree names the branch
// and commit count and prefixes the report with the fetched summary.
#[tokio::test]
async fn transferred_result_names_branch_and_commits() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.hosts.pollOwned", |_| {
        Ok(json!({ "state": "exited", "exitCode": 0 }))
    });
    h.on_capability("capability.hosts.readOwnedOutput", |_| {
        Ok(json!({
            "stdoutBase64": "Y29tcGxldGUgcmV2aWV3Cg==",
            "stderrBase64": ""
        }))
    });
    h.on_capability("capability.hosts.transferOwned", |_| {
        Ok(json!({
            "transferred": true,
            "branch": "pacer/t",
            "commits": 2,
            "reviewWorktree": "/w"
        }))
    });
    let mut params = remote_params();
    params["remote"]["resume"] =
        json!({ "startedAt": 100, "logFile": "/tmp/owned/1/stdout" });
    let result = h.call("executor.run", params).await.unwrap();
    assert_eq!(result["worktree"], "/w");
    let report = result["report"].as_str().unwrap();
    assert!(report.starts_with("ran on remote host; fetched pacer/t (2 commits)\n\n"));
    assert!(report.ends_with("complete review"));
    h.close().await;
}

// Derived from index.ts:52 — a wall-clock deadline reached while running is a
// `plugin_timeout`. A resumed run with `startedAt: 0` has deadline
// `0*1000 + timeoutMs`; the poll moves the clock just past it.
#[tokio::test]
async fn remote_deadline_reached_is_plugin_timeout() {
    let clock = Arc::new(FakeClock::at(0.0));
    let jump = clock.clone();
    let mut h = Harness::start(plugin_with(clock), Default::default()).await;
    h.on_capability("capability.hosts.pollOwned", move |_| {
        jump.set_now(6_000.0); // past `startedAt*1000 + timeoutMs` (5000)
        Ok(json!({ "state": "running", "exitCode": null }))
    });
    let mut params = remote_params();
    params["remote"]["resume"] =
        json!({ "startedAt": 0.0, "logFile": "/tmp/owned/1/stdout" });
    let err = h.call("executor.run", params).await.unwrap_err();
    assert_eq!(err.code, "plugin_timeout");
    assert_eq!(
        err.message,
        "remote deadline reached; persisted run requires stop reconciliation"
    );
    h.close().await;
}

// Derived from index.ts:76-77 — an uncertain state that persists ~5s refuses a
// replacement launch. The deadline is pushed far out so only the uncertain
// path fires.
#[tokio::test]
async fn remote_uncertain_for_5s_refuses_replacement() {
    let clock = Arc::new(FakeClock::at(0.0));
    let jump = clock.clone();
    let mut h = Harness::start(plugin_with(clock), Default::default()).await;
    h.on_capability("capability.hosts.pollOwned", move |_| {
        jump.set_now(jump.now_ms() + 6_000.0);
        Ok(json!({ "state": "uncertain", "exitCode": null }))
    });
    let mut params = remote_params();
    params["remote"]["timeoutMs"] = json!(14_400_000);
    params["remote"]["resume"] =
        json!({ "startedAt": 0.0, "logFile": "/tmp/owned/1/stdout" });
    let err = h.call("executor.run", params).await.unwrap_err();
    assert_eq!(err.code, "plugin_unavailable");
    assert_eq!(
        err.message,
        "remote run state is uncertain; replacement launch refused"
    );
    h.close().await;
}

#[allow(dead_code)]
fn _reachable() {
    let _ = prepare_answer;
    let _ = on_terminal_output as fn(&mut Harness);
}