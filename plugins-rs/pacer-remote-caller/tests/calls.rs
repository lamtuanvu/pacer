//! Delivery tests for pacer-remote-caller's five `remoteCaller.*` handlers,
//! ported from `plugins/pacer-remote-caller/index.ts` (M3 C2). The host broker
//! owns session admission and revocation; the plugin only calls
//! `capability.hosts.*` with the request's alias and the fixed scripts.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_plugin::testing::{Harness, HelloSpec, HostError};
use serde_json::{Value, json};

fn session_answer() -> Value {
    json!({ "session": "s1" })
}
fn ok_run(_: Value) -> Result<Value, (String, String)> {
    Ok(json!({ "code": 0, "timedOut": false, "stdout": "", "stderr": "" }))
}
fn ok_close(_: Value) -> Result<Value, (String, String)> {
    Ok(json!({ "ok": true }))
}
fn ok_fetch(_: Value) -> Result<Value, (String, String)> {
    Ok(json!({ "ok": true }))
}

/// Start a harness with scripted success answers for every `capability.hosts.*`
/// point. Override a point by passing `None` for the ones to script, or just
/// call `on_capability_async` again after `start` to replace an answer.
async fn harness() -> Harness {
    let mut h = Harness::start(pacer_bundled_remote_caller::plugin(), HelloSpec::default()).await;
    h.on_capability("capability.hosts.open", |_| Ok(session_answer()));
    h.on_capability("capability.hosts.run", ok_run);
    h.on_capability("capability.hosts.fetch", ok_fetch);
    h.on_capability("capability.hosts.close", ok_close);
    h
}

fn calls(h: &Harness) -> Vec<(String, Value)> {
    h.capability_calls()
}

fn first_call(h: &Harness, method: &str) -> Value {
    calls(h)
        .iter()
        .find(|(m, _)| m == method)
        .unwrap_or_else(|| panic!("expected a {method} call"))
        .1
        .clone()
}

// TS: plugins/pacer-remote-caller/index.ts manifest (byte-equal, M3 C0a).
#[test]
fn manifest_names_precise_remote_caller_contribution_and_required_scope() {
    let m: Value = serde_json::from_str(pacer_bundled_remote_caller::MANIFEST).unwrap();
    assert_eq!(m["host"], "^1.7");
    assert_eq!(m["contributes"], json!({ "remoteCaller": {} }));
    assert_eq!(m["reentrant"], true);
    assert_eq!(m["tier"], "free");
    assert_eq!(m["capabilities"], json!([{ "name": "hosts" }]));
}

// TS: remoteCaller.reachability — open, PROBE {args:[],15000/65536}, close.
#[tokio::test]
async fn reachability_runs_probe_and_reports_reachable() {
    let mut h = harness().await;
    let r = h
        .call("remoteCaller.reachability", json!({ "alias": "r1" }))
        .await
        .unwrap();
    assert_eq!(r, json!({ "reachable": true }));
    assert_eq!(
        first_call(&h, "capability.hosts.open"),
        json!({ "alias": "r1" })
    );
    assert_eq!(
        first_call(&h, "capability.hosts.run"),
        json!({
            "session": "s1", "script": "PROBE", "args": [],
            "timeoutMs": 15000, "maxBytes": 65536
        })
    );
    assert_eq!(first_call(&h, "capability.hosts.close"), json!({ "session": "s1" }));
    h.close().await;
}

#[tokio::test]
async fn reachability_unreachable_when_probe_code_nonzero_or_timed_out() {
    for (code, timed_out) in [(127i64, false), (0, true), (1, true)] {
        let mut h = harness().await;
        h.on_capability("capability.hosts.run", move |_| {
            Ok(json!({ "code": code, "timedOut": timed_out }))
        });
        let r = h
            .call("remoteCaller.reachability", json!({ "alias": "r1" }))
            .await
            .unwrap();
        assert_eq!(r, json!({ "reachable": false }));
        // Close still runs in every case.
        assert!(calls(&h).iter().any(|(m, _)| m == "capability.hosts.close"));
        h.close().await;
    }
}

// TS: remoteCaller.fetch — open, fetch echo request timeouts, close.
#[tokio::test]
async fn fetch_echoes_request_timeouts_and_returns_fetch_result() {
    let mut h = harness().await;
    let r = h
        .call(
            "remoteCaller.fetch",
            json!({ "alias": "r1", "timeoutMs": 5000, "maxBytes": 2048 }),
        )
        .await
        .unwrap();
    assert_eq!(r, json!({ "ok": true }));
    assert_eq!(
        first_call(&h, "capability.hosts.fetch"),
        json!({ "session": "s1", "timeoutMs": 5000, "maxBytes": 2048 })
    );
    assert_eq!(first_call(&h, "capability.hosts.close"), json!({ "session": "s1" }));
    h.close().await;
}

// TS: remoteCaller.fetch — absent timeout fields are dropped from the fetch call.
#[tokio::test]
async fn fetch_omits_absent_timeout_fields() {
    let mut h = harness().await;
    let r = h
        .call("remoteCaller.fetch", json!({ "alias": "r2" }))
        .await
        .unwrap();
    assert_eq!(r, json!({ "ok": true }));
    assert_eq!(
        first_call(&h, "capability.hosts.fetch"),
        json!({ "session": "s1" })
    );
    // Open still carries the request's alias; only timeout fields are dropped.
    assert_eq!(
        first_call(&h, "capability.hosts.open"),
        json!({ "alias": "r2" })
    );
    h.close().await;
}

// TS: remoteCaller.fetch — a failed primary keeps its error even when close
// also fails (the `failed` flag swallows close errors).
#[tokio::test]
async fn fetch_failure_preserves_original_error_when_close_fails_too() {
    let mut h = harness().await;
    h.on_capability_async("capability.hosts.fetch", |_| async {
        Err(HostError::new("plugin_refused", "fetch declined"))
    });
    h.on_capability_async("capability.hosts.close", |_| async {
        Err(HostError::new("lease_retired", "session retired"))
    });
    let err = h
        .call("remoteCaller.fetch", json!({ "alias": "r1" }))
        .await
        .unwrap_err();
    assert_eq!(err.code, "plugin_refused");
    assert_eq!(err.message, "fetch declined");
    h.close().await;
}

// TS: remoteCaller.fetch — a failed primary keeps its error when close succeeds.
#[tokio::test]
async fn fetch_failure_propagates_error_and_still_closes() {
    let mut h = harness().await;
    h.on_capability_async("capability.hosts.fetch", |_| async {
        Err(HostError::new("net_unreachable", "remote host down"))
    });
    let err = h
        .call("remoteCaller.fetch", json!({ "alias": "r1" }))
        .await
        .unwrap_err();
    assert_eq!(err.code, "net_unreachable");
    // Close was attempted (and succeeded) despite the failure.
    assert!(calls(&h).iter().any(|(m, _)| m == "capability.hosts.close"));
    h.close().await;
}

// TS: remoteCaller.fetch — a close failure after a successful fetch replaces
// the reply (no `failed` flag was set, so close is not swallowed).
#[tokio::test]
async fn fetch_close_failure_after_success_replaces_reply() {
    let mut h = harness().await;
    h.on_capability_async("capability.hosts.close", |_| async {
        Err(HostError::new("lease_retired", "session retired"))
    });
    let err = h
        .call("remoteCaller.fetch", json!({ "alias": "r1" }))
        .await
        .unwrap_err();
    assert_eq!(err.code, "lease_retired");
    assert_eq!(err.message, "session retired");
    h.close().await;
}

// TS: remoteCaller.identity — SET_IDENTITY with the three identity args.
#[tokio::test]
async fn identity_sets_identity_with_three_args() {
    let mut h = harness().await;
    let r = h
        .call(
            "remoteCaller.identity",
            json!({ "alias": "r1", "path": "/a", "name": "Ada", "email": "a@x" }),
        )
        .await
        .unwrap();
    assert_eq!(r, json!({ "code": 0, "timedOut": false, "stdout": "", "stderr": "" }));
    assert_eq!(
        first_call(&h, "capability.hosts.run"),
        json!({
            "session": "s1", "script": "SET_IDENTITY",
            "args": ["/a", "Ada", "a@x"],
            "timeoutMs": 50000, "maxBytes": 65536
        })
    );
    assert_eq!(first_call(&h, "capability.hosts.close"), json!({ "session": "s1" }));
    h.close().await;
}

// TS: remoteCaller.questionRead — QUESTION with the single path arg.
#[tokio::test]
async fn question_read_passes_path_arg() {
    let mut h = harness().await;
    h.on_capability("capability.hosts.run", |_| {
        Ok(json!({ "code": 0, "timedOut": false, "output": "yes" }))
    });
    let r = h
        .call("remoteCaller.questionRead", json!({ "alias": "r1", "path": "/q" }))
        .await
        .unwrap();
    assert_eq!(r, json!({ "code": 0, "timedOut": false, "output": "yes" }));
    assert_eq!(
        first_call(&h, "capability.hosts.run"),
        json!({
            "session": "s1", "script": "QUESTION", "args": ["/q"],
            "timeoutMs": 20000, "maxBytes": 8192
        })
    );
    assert_eq!(first_call(&h, "capability.hosts.close"), json!({ "session": "s1" }));
    h.close().await;
}

// TS: remoteCaller.usageRead — `home` follows JS truthiness (`""` -> `[]`).
#[tokio::test]
async fn usage_read_home_follows_js_truthiness() {
    // Unset home -> args [].
    {
        let mut h = harness().await;
        let _ = h.call("remoteCaller.usageRead", json!({ "alias": "r1" })).await.unwrap();
        assert_eq!(
            first_call(&h, "capability.hosts.run")["args"],
            json!([])
        );
        h.close().await;
    }
    // Empty string home -> args [].
    {
        let mut h = harness().await;
        let _ = h
            .call("remoteCaller.usageRead", json!({ "alias": "r1", "home": "" }))
            .await
            .unwrap();
        assert_eq!(first_call(&h, "capability.hosts.run")["args"], json!([]));
        h.close().await;
    }
    // Non-empty home -> args [home].
    {
        let mut h = harness().await;
        h.on_capability("capability.hosts.run", |_| {
            Ok(json!({ "code": 0, "timedOut": false, "usage": "u" }))
        });
        let _ = h
            .call("remoteCaller.usageRead", json!({ "alias": "r1", "home": "/home/me" }))
            .await
            .unwrap();
        assert_eq!(
            first_call(&h, "capability.hosts.run"),
            json!({
                "session": "s1", "script": "CODEX_USAGE", "args": ["/home/me"],
                "timeoutMs": 60000, "maxBytes": 65536
            })
        );
        h.close().await;
    }
}

// TS: the open call carries `{alias}` only when the request has an `alias`
// field; a missing alias opens `{}` without failing the handler.
#[tokio::test]
async fn missing_alias_opens_empty_object() {
    let mut h = harness().await;
    let r = h
        .call("remoteCaller.reachability", json!({}))
        .await
        .unwrap();
    assert_eq!(r, json!({ "reachable": true }));
    assert_eq!(first_call(&h, "capability.hosts.open"), json!({}));
    h.close().await;
}

// TS: every scoped capability call echoes the owning call's capability token.
#[tokio::test]
async fn every_hosts_call_is_scoped_to_the_owning_call() {
    let mut h = harness().await;
    let _ = h
        .call("remoteCaller.identity", json!({ "alias": "r1" }))
        .await
        .unwrap();
    let tokens = h
        .capability_calls_with_meta()
        .into_iter()
        .filter(|(m, _, _)| m.starts_with("capability.hosts."))
        .map(|(_, _, meta)| {
            meta.and_then(|m| m.get("capabilityCall").cloned()).unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(tokens.len(), 3); // open, run, close
    assert!(tokens.iter().all(|t| t == &tokens[0]));
    h.close().await;
}
