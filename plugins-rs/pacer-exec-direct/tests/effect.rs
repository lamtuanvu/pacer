//! Delivery tests for the direct process effect and the `executor.stop` /
//! `executor.sessionState` / `executor.available` points (M3 C10). The TS
//! effect tests are host-only, so every case here is derived from
//! `plugins/pacer-exec-direct/index.ts:161-212`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use pacer_bundled_exec_direct::{FakeClock, plugin_with};
use pacer_plugin::testing::Harness;
use serde_json::{Value, json};

/// A valid RFC 9562 v4 UUID matching `input::uuid_regex`.
const UUID: &str = "123e4567-e89b-12d3-a456-426614174000";

fn effect_params(effect: Value) -> Value {
    json!({
        "task": { "id": "t1", "rev": 1 },
        "attempt": 1,
        "runDir": 1,
        "effect": effect
    })
}

fn calls_named(h: &Harness, method: &str) -> Vec<Value> {
    h.capability_calls()
        .into_iter()
        .filter(|(m, _)| m == method)
        .map(|(_, p)| p)
        .collect()
}

// index.ts:177-193 — the direct effect spawns the exact issued process,
// merging env and secretEnv so secrets forward by reference.
#[tokio::test]
async fn direct_effect_spawns_exact_issued_process() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.process.spawn", |_| {
        Ok(json!({ "code": 0, "timedOut": false, "stderr": "" }))
    });
    let result = h
        .call(
            "executor.run",
            effect_params(json!({
                "argv": ["codex", "exec"],
                "cwd": "/w",
                "timeoutMs": 1000,
                "env": { "A": "1" },
                "secretEnv": { "K": "secrets:k" }
            })),
        )
        .await
        .unwrap();
    assert_eq!(result["status"], "done");
    assert_eq!(result["exitCode"], 0);
    assert_eq!(result["report"], "local process exited successfully");
    let spawn = calls_named(&h, "capability.process.spawn");
    assert_eq!(
        spawn,
        vec![json!({
            "argv": ["codex", "exec"],
            "cwd": "/w",
            "env": { "A": "1", "K": { "secretRef": "secrets:k" } },
            "timeoutMs": 1000
        })]
    );
    h.close().await;
}

// index.ts:181 — stdin is forwarded only when the effect supplies one.
#[tokio::test]
async fn stdin_is_forwarded_only_when_present() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.process.spawn", |_| {
        Ok(json!({ "code": 0, "timedOut": false, "stderr": "" }))
    });
    let with_stdin = effect_params(json!({
        "argv": ["bc"], "cwd": "/w", "timeoutMs": 1000, "stdin": "2+2"
    }));
    h.call("executor.run", with_stdin).await.unwrap();
    let called_with = calls_named(&h, "capability.process.spawn");
    let with_call = &called_with[0];
    assert_eq!(with_call["stdin"], "2+2");

    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.process.spawn", |_| {
        Ok(json!({ "code": 0, "timedOut": false, "stderr": "" }))
    });
    let no_stdin = effect_params(json!({
        "argv": ["bc"], "cwd": "/w", "timeoutMs": 1000
    }));
    h.call("executor.run", no_stdin).await.unwrap();
    let without_call = &calls_named(&h, "capability.process.spawn")[0];
    assert!(without_call.get("stdin").is_none());
    h.close().await;
}

// index.ts:192-193 — a nonzero exit reports the first 1024 stderr units.
#[tokio::test]
async fn nonzero_exit_reports_first_1024_stderr_units() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    let long_stderr = "e".repeat(3000);
    let answer_stderr = long_stderr.clone();
    h.on_capability("capability.process.spawn", move |_| {
        Ok(json!({ "code": 2, "timedOut": false, "stderr": answer_stderr }))
    });
    let result = h
        .call(
            "executor.run",
            effect_params(json!({
                "argv": ["codex"], "cwd": "/w", "timeoutMs": 1000
            })),
        )
        .await
        .unwrap();
    assert_eq!(result["status"], "failed");
    assert_eq!(result["exitCode"], 2);
    let report = result["report"].as_str().unwrap();
    assert!(report.starts_with("local process exited 2: "));
    let truncated = &report["local process exited 2: ".len()..];
    assert_eq!(truncated.len(), 1024);
    h.close().await;
}

// index.ts:185-189 — an `output` handle reads the first stderr chunk by id.
#[tokio::test]
async fn output_handles_read_first_stderr_kib() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.process.spawn", |_| {
        Ok(json!({
            "code": 0,
            "timedOut": false,
            "output": { "stdout": UUID, "stderr": UUID }
        }))
    });
    h.on_capability("capability.process.outputChunk", |params| {
        assert_eq!(params["handle"], UUID);
        assert_eq!(params["offset"], 0);
        assert_eq!(params["length"], 1024);
        Ok(json!({ "base64": "c29tZSByZW1vdGUgZmVlZGJhY2s=" }))
    });
    let result = h
        .call(
            "executor.run",
            effect_params(json!({
                "argv": ["codex"], "cwd": "/w", "timeoutMs": 1000
            })),
        )
        .await
        .unwrap();
    assert_eq!(result["status"], "done");
    let output = calls_named(&h, "capability.process.outputChunk");
    assert_eq!(output.len(), 1);
    h.close().await;
}

// index.ts:192 — a timed-out run is failed with the timed-out report.
#[tokio::test]
async fn timed_out_is_failed() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.process.spawn", |_| {
        Ok(json!({ "code": 0, "timedOut": true, "stderr": "" }))
    });
    let result = h
        .call(
            "executor.run",
            effect_params(json!({
                "argv": ["codex"], "cwd": "/w", "timeoutMs": 1000
            })),
        )
        .await
        .unwrap();
    assert_eq!(result["status"], "failed");
    assert_eq!(result["report"], "local process timed out");
    h.close().await;
}

// index.ts:170-176 — a detached effect launches a run and reports launched.
#[tokio::test]
async fn detached_launch_starts_run() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.process.startRun", |_| {
        Ok(json!({ "pid": 42 }))
    });
    let result = h
        .call(
            "executor.run",
            effect_params(json!({
                "argv": ["codex"], "cwd": "/w", "timeoutMs": 1000, "detached": true
            })),
        )
        .await
        .unwrap();
    assert_eq!(result["status"], "launched");
    assert_eq!(result["pid"], 42);
    assert_eq!(result["report"], "detached wrapper started");
    let start = calls_named(&h, "capability.process.startRun");
    assert_eq!(
        start,
        vec![json!({
            "task": { "id": "t1", "rev": 1 },
            "attempt": 1,
            "runDir": 1
        })]
    );
    h.close().await;
}

// index.ts:167 — no valid effect shape is refused with the verbatim text.
#[tokio::test]
async fn invalid_effect_is_refused() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    let err = h
        .call(
            "executor.run",
            json!({ "task": { "id": "t1", "rev": 1 }, "attempt": 1, "runDir": 1 }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, "invalid_input");
    assert_eq!(err.message, "direct process effect is required");
    assert!(h.capability_calls().is_empty());
    h.close().await;
}

// index.ts:145 — a spawn result whose output handle is not a UUID is `internal`.
#[tokio::test]
async fn bad_spawn_result_is_internal() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.process.spawn", |_| {
        Ok(json!({
            "code": 0,
            "timedOut": false,
            "output": { "stdout": "x", "stderr": UUID }
        }))
    });
    let err = h
        .call(
            "executor.run",
            effect_params(json!({
                "argv": ["codex"], "cwd": "/w", "timeoutMs": 1000
            })),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, "internal");
    h.close().await;
}

// index.ts:195-204 — stop forwards task/attempt/graceMs to the local or remote
// capability.
#[tokio::test]
async fn stop_local_and_remote() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.process.stopRun", |_| {
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
    let local = calls_named(&h, "capability.process.stopRun");
    assert_eq!(
        local,
        vec![json!({ "taskId": "t1", "attempt": 1, "graceMs": 100 })]
    );

    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.hosts.stopOwned", |_| {
        Ok(json!({ "code": 0, "killed": true }))
    });
    let result = h
        .call(
            "executor.stop",
            json!({ "taskId": "t1", "attempt": 1, "graceMs": 100, "remote": true }),
        )
        .await
        .unwrap();
    assert_eq!(result, json!({ "code": 0, "killed": true }));
    let remote = calls_named(&h, "capability.hosts.stopOwned");
    assert_eq!(
        remote,
        vec![json!({ "taskId": "t1", "attempt": 1, "graceMs": 100 })]
    );
    h.close().await;
}

// index.ts:196-197 — an out-of-range graceMs is `internal` (zod parse).
#[tokio::test]
async fn stop_bad_params_is_internal() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    let err = h
        .call(
            "executor.stop",
            json!({ "taskId": "t1", "attempt": 1, "graceMs": 25001 }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, "internal");
    assert!(h.capability_calls().is_empty());
    h.close().await;
}

// index.ts:205-212 — sessionState names the builtin host with no handle.
#[tokio::test]
async fn session_state_is_builtin() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    h.on_capability("capability.process.inspectRun", |_| {
        Ok(json!({ "state": "running" }))
    });
    let result = h
        .call("executor.sessionState", json!({ "taskId": "t1", "attempt": 1 }))
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({ "state": "running", "host": "builtin", "handle": null })
    );
    assert_eq!(
        calls_named(&h, "capability.process.inspectRun"),
        vec![json!({ "taskId": "t1", "attempt": 1 })]
    );
    h.close().await;
}

// index.ts:160 — available is always true for the direct executor.
#[tokio::test]
async fn available_is_true() {
    let mut h = Harness::start(plugin_with(Arc::new(FakeClock::at(0.0))), Default::default()).await;
    let result = h.call("executor.available", json!({})).await.unwrap();
    assert_eq!(result, json!({ "available": true }));
    h.close().await;
}

#[allow(dead_code)]
fn _reachable() {
    let _ = UUID;
    let _ = calls_named as fn(&Harness, &str) -> Vec<Value>;
}