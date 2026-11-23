#![allow(clippy::unwrap_used)]
//! `Host::http` over the scripted [`Harness`], porting `test/plugins-sdk-http.test.ts`.
//! Requires `--features testing` (for `Host::set_frame_limit_for_test`).

use pacer_plugin::{
    Manifest, Plugin,
    js::base64,
    testing::{Harness, HelloSpec},
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

const LIMIT: usize = 4 * 1024 * 1024;

fn manifest() -> Manifest {
    Manifest(
        json!({"id":"p","version":"1.0.0","publisher":"t","host":">=1.2","contributes":{"http":{}}}),
    )
}

fn hello(offer: bool) -> HelloSpec {
    HelloSpec {
        features: if offer {
            vec!["httpBodyChunks".into()]
        } else {
            Vec::new()
        },
        ..Default::default()
    }
}

/// A plugin whose `test.http` handler drives `Host::http`. `frameLimit` sets
/// `set_frame_limit_for_test`; `suspend` makes the handler wait for the owning
/// call's cancellation before issuing the request (so "already cancelled" can be
/// scripted deterministically). The handler emits a `ready` progress event as
/// soon as it starts, so a test can tell when the owning call's cancellation
/// token is registered on the serve side before cancelling it.
fn plugin(features_offer: bool) -> Plugin {
    let mut p = Plugin::new(manifest()).handle("test.http", |params, c| async move {
        c.progress.send(json!({ "ready": true }));
        if let Some(fl) = params.get("frameLimit").and_then(Value::as_u64) {
            c.host.set_frame_limit_for_test(fl as usize);
        }
        if params.get("suspend").is_some() {
            c.cancel.cancelled().await;
        }
        let request = params.get("request").cloned().unwrap_or_else(|| json!({}));
        match c.host.http(request).await {
            Ok(r) => Ok(json!({
                "ok": true, "status": r.status, "body": r.body, "headers": r.headers
            })),
            Err(e) => Ok(json!({ "ok": false, "code": e.code, "message": e.message })),
        }
    });
    if features_offer {
        p = p.features(vec!["httpBodyChunks"]);
    }
    p
}

/// The default TS `fixture` mock host: acknowledges staging and release, and
/// answers `capability.net.http` with `{"status":200,headers,body:"ok"}`.
fn base_capabilities(h: &mut Harness) {
    h.on_capability("capability.net.http.body.begin", |_| {
        Ok(json!({ "handle": "upload" }))
    });
    h.on_capability("capability.net.http.body.stageChunk", |p| {
        let offset = p.get("offset").and_then(Value::as_u64).unwrap_or(0);
        let b64 = p.get("base64").and_then(Value::as_str).unwrap_or("");
        Ok(json!({ "bytes": offset + base64::decode_lenient(b64).len() as u64 }))
    });
    h.on_capability("capability.net.http.body.readChunk", |p| {
        let _offset = p.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let length = p.get("length").and_then(Value::as_u64).unwrap_or(0) as usize;
        Ok(json!({ "base64": base64::encode(&vec![0u8; length][..]) }))
    });
    h.on_capability("capability.net.http.body.release", |_| {
        Ok(json!({ "ok": true }))
    });
    h.on_capability("capability.net.http", |_| {
        Ok(json!({ "status": 200, "headers": {}, "body": "ok" }))
    });
    let _ = release_sink();
}

fn release_sink() -> Arc<Mutex<Vec<String>>> {
    Arc::new(Mutex::new(Vec::new()))
}

fn method_calls(h: &Harness) -> Vec<String> {
    h.capability_calls().into_iter().map(|(m, _)| m).collect()
}

/// The most recent `test.http` handler reply (find the last reply with an `ok` flag).
fn last_handler_reply(h: &Harness) -> Value {
    h.replies()
        .into_iter()
        .rev()
        .find(|r| r.get("result").and_then(|v| v.get("ok")).is_some())
        .and_then(|r| r.get("result").cloned())
        .unwrap_or(Value::Null)
}

/// The message of the most recent handler reply that either returned `ok:false`
/// or was turned into an error envelope (e.g. an owning call cancelled while
/// its result was in flight, which the SDK converts to `plugin_unavailable`).
fn last_failure_message(h: &Harness) -> Option<String> {
    h.replies().into_iter().rev().find_map(|r| {
        if r.get("result").and_then(|v| v.get("ok")) == Some(&json!(false)) {
            r.get("result")
                .and_then(|v| v.get("message"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        } else {
            r.get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        }
    })
}

/// Wait (polling, because the plugin runs on its own task) until the plugin's
/// `test.http` handler has started (its `ready` progress event) — that is, until
/// the owning call's cancellation token is registered on the serve side.
async fn wait_ready(h: &Harness) {
    for _ in 0..500 {
        if h.progress().iter().any(|p| p.get("ready").is_some()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    panic!("plugin handler never became ready");
}

/// Wait until a capability call matching `pred` is observed (without cancelling).
async fn wait_observed(h: &Harness, pred: impl Fn(&(String, Value)) -> bool) {
    for _ in 0..500 {
        if h.capability_calls().iter().any(&pred) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    panic!("expected capability call never observed");
}

/// Wait (polling, because the plugin runs on its own task) until `pred` holds
/// over the recorded capability calls, then cancel the owning call.
async fn wait_then_cancel(h: &Harness, id: &str, mut pred: impl FnMut(&(String, Value)) -> bool) {
    for _ in 0..500 {
        if h.capability_calls().iter().any(&mut pred) {
            h.cancel(id);
            return;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    panic!("expected capability call never observed before cancel timeout");
}

#[tokio::test]
async fn inline_string_request_keeps_the_public_shape() {
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h);
    let r = h
        .call(
            "test.http",
            json!({"request":{"url":"https://owned.invalid","method":"POST","body":"hello","timeoutMs":10}}),
        )
        .await
        .unwrap();
    assert_eq!(r["ok"], true);
    assert_eq!(r["status"], 200);
    assert_eq!(r["body"], "ok");
    assert_eq!(method_calls(&h), vec!["capability.net.http"]);
    h.close().await;
}

#[tokio::test]
async fn multibyte_4mib_body_stages_complete_bytes() {
    let body = "界".repeat(LIMIT / 3);
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h);
    let r = h
        .call(
            "test.http",
            json!({"request":{"url":"https://owned.invalid","method":"POST","body":body,"timeoutMs":10}}),
        )
        .await
        .unwrap();
    assert_eq!(r["ok"], true);
    let staged: usize = h
        .capability_calls()
        .iter()
        .filter(|(m, _)| m.ends_with(".stageChunk"))
        .map(|(_, p)| {
            base64::decode_lenient(p.get("base64").and_then(Value::as_str).unwrap_or("")).len()
        })
        .sum();
    assert_eq!(staged, body.as_bytes().len());
    h.close().await;
}

#[tokio::test]
async fn nul_expansion_uses_chunks() {
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h);
    let r = h
        .call(
            "test.http",
            json!({"request":{"url":"https://owned.invalid","method":"POST","body":"\0".repeat(1024 * 1024),"timeoutMs":10}}),
        )
        .await
        .unwrap();
    assert_eq!(r["ok"], true);
    assert!(
        h.capability_calls()
            .iter()
            .any(|(m, _)| m.ends_with(".begin")),
        "NUL JSON expansion must stage via body.begin"
    );
    h.close().await;
}

#[tokio::test]
async fn oversized_metadata_rejected_before_any_call() {
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h);
    let r = h
        .call(
            "test.http",
            json!({"frameLimit":64,"request":{"url":"x","method":"GET","timeoutMs":10}}),
        )
        .await
        .unwrap();
    assert_eq!(r["ok"], false);
    assert_eq!(
        r["message"],
        "HTTP oversized request requires httpBodyChunks"
    );
    assert!(h.capability_calls().is_empty());
    h.close().await;
}

#[tokio::test]
async fn feature_absence_refuses_before_begin() {
    let mut h = Harness::start(plugin(false), hello(false)).await;
    base_capabilities(&mut h);
    let r = h
        .call(
            "test.http",
            json!({"frameLimit":64,"request":{"url":"x","method":"POST","body":"\0".repeat(300000),"timeoutMs":10}}),
        )
        .await
        .unwrap();
    assert_eq!(r["ok"], false);
    assert_eq!(
        r["message"],
        "HTTP oversized request requires httpBodyChunks"
    );
    assert!(h.capability_calls().is_empty());
    h.close().await;
}

#[tokio::test]
async fn over_4mib_body_refused_before_effects() {
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h);
    let r = h
        .call(
            "test.http",
            json!({"request":{"url":"x","method":"POST","body":"a".repeat(LIMIT + 1),"timeoutMs":10}}),
        )
        .await
        .unwrap();
    assert_eq!(r["ok"], false);
    assert_eq!(r["message"], "HTTP body exceeds 4MiB UTF8");
    assert!(h.capability_calls().is_empty());
    h.close().await;
}

#[tokio::test]
async fn already_cancelled_request_has_no_effects() {
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h);
    let id = h
        .start_call(
            "test.http",
            json!({"suspend":true,"request":{"url":"x","method":"GET","timeoutMs":1}}),
        )
        .unwrap();
    // Wait until the handler is running (its cancel token registered), then cancel
    // so `host.http` sees an already-ended owning call when it finally issues.
    wait_ready(&h).await;
    h.cancel(&id);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(h.capability_calls().is_empty());
    let reply = last_failure_message(&h);
    assert!(
        reply.as_deref().is_some_and(|m| m.contains("ended")),
        "expected an 'ended' failure, got {:?}",
        reply
    );
    h.close().await;
}

#[tokio::test]
async fn response_4mib_roundtrips_multibyte_split() {
    let body = "界".repeat(LIMIT / 3);
    let bytes = body.as_bytes().to_vec();
    let released = Arc::new(Mutex::new(Vec::new()));
    let mut h = Harness::start(plugin(true), hello(true)).await;
    h.on_capability("capability.net.http", {
        let bytes = bytes.clone();
        move |_| {
            let n = bytes.len();
            Ok(json!({ "status": 200, "headers": {"x": "ok"}, "body": {"handle": "down", "bytes": n} }))
        }
    });
    h.on_capability("capability.net.http.body.readChunk", {
        let bytes = bytes.clone();
        move |p| {
            let offset = p.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
            let length = p.get("length").and_then(Value::as_u64).unwrap_or(0) as usize;
            Ok(json!({ "base64": base64::encode(&bytes[offset..offset + length]) }))
        }
    });
    {
        let released = released.clone();
        h.on_capability("capability.net.http.body.release", move |p| {
            released.lock().unwrap().push(
                p.get("handle")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            );
            Ok(json!({ "ok": true }))
        });
    }
    let r = h
        .call(
            "test.http",
            json!({"request":{"url":"x","method":"GET","timeoutMs":10}}),
        )
        .await
        .unwrap();
    assert_eq!(r["ok"], true);
    assert_eq!(r["body"], body);
    assert_eq!(*released.lock().unwrap(), vec!["down"]);
    h.close().await;
}

#[tokio::test]
async fn invalid_utf8_expansion_refuses_and_releases() {
    let bytes = vec![0xFFu8; 2 * 1024 * 1024];
    let released = Arc::new(Mutex::new(Vec::new()));
    let mut h = Harness::start(plugin(true), hello(true)).await;
    h.on_capability("capability.net.http", {
        let n = bytes.len();
        move |_| Ok(json!({ "status": 200, "headers": {}, "body": {"handle": "down", "bytes": n} }))
    });
    h.on_capability("capability.net.http.body.readChunk", {
        let bytes = bytes.clone();
        move |p| {
            let offset = p.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
            let length = p.get("length").and_then(Value::as_u64).unwrap_or(0) as usize;
            Ok(json!({ "base64": base64::encode(&bytes[offset..offset + length]) }))
        }
    });
    {
        let released = released.clone();
        h.on_capability("capability.net.http.body.release", move |p| {
            released.lock().unwrap().push(
                p.get("handle")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            );
            Ok(json!({ "ok": true }))
        });
    }
    let r = h
        .call(
            "test.http",
            json!({"request":{"url":"x","method":"GET","timeoutMs":10}}),
        )
        .await
        .unwrap();
    assert_eq!(r["ok"], false);
    assert!(
        r["message"]
            .as_str()
            .unwrap_or_default()
            .contains("decoded")
    );
    assert_eq!(*released.lock().unwrap(), vec!["down"]);
    h.close().await;
}

#[tokio::test]
async fn abort_after_begin_releases_and_never_sends_http() {
    let released = Arc::new(Mutex::new(Vec::new()));
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h);
    {
        let released = released.clone();
        h.on_capability("capability.net.http.body.release", move |p| {
            released.lock().unwrap().push(
                p.get("handle")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            );
            Ok(json!({ "ok": true }))
        });
    }
    let id = h
        .start_call(
            "test.http",
            // A body big enough that the request envelope exceeds the default
            // 1 MiB frame, forcing the staged-upload path (whose placeholder
            // still fits), so `begin` is observed before we abort.
            json!({"request":{"url":"x","method":"POST","body":"a".repeat(1_500_000),"timeoutMs":10}}),
        )
        .unwrap();
    wait_then_cancel(&h, &id, |c| c.0.ends_with(".begin")).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let calls = method_calls(&h);
    assert!(calls.iter().any(|m| m.ends_with(".begin")), "upload begun");
    assert!(
        calls.iter().any(|m| m.ends_with(".release")),
        "release attempted even after abort"
    );
    let reply = last_failure_message(&h);
    assert!(
        reply.as_deref().is_some_and(|m| m.contains("ended")),
        "expected an 'ended' failure, got {:?}",
        reply
    );
    assert_eq!(*released.lock().unwrap(), vec!["upload"]);
    h.close().await;
}

#[tokio::test]
async fn cleanup_failure_cannot_return_success() {
    let mut h = Harness::start(plugin(true), hello(true)).await;
    h.on_capability("capability.net.http", |_| {
        Ok(json!({ "status": 200, "headers": {}, "body": {"handle": "d", "bytes": 0} }))
    });
    h.on_capability("capability.net.http.body.release", |_| {
        Err(("internal".to_string(), "cleanup failure".to_string()))
    });
    let r = h
        .call(
            "test.http",
            json!({"request":{"url":"x","method":"GET","timeoutMs":10}}),
        )
        .await
        .unwrap();
    assert_eq!(r["ok"], false);
    assert!(
        r["message"]
            .as_str()
            .unwrap_or_default()
            .contains("cleanup failure")
    );
    h.close().await;
}

#[tokio::test]
async fn noncanonical_response_base64_rejects_and_releases() {
    let released = Arc::new(Mutex::new(Vec::new()));
    let mut h = Harness::start(plugin(true), hello(true)).await;
    h.on_capability("capability.net.http", |_| {
        Ok(json!({ "status": 200, "headers": {}, "body": {"handle": "d", "bytes": 1} }))
    });
    h.on_capability("capability.net.http.body.readChunk", |_| {
        Ok(json!({ "base64": "Zh==" })) // decodes to 0x66 but is noncanonical
    });
    {
        let released = released.clone();
        h.on_capability("capability.net.http.body.release", move |p| {
            released.lock().unwrap().push(
                p.get("handle")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            );
            Ok(json!({ "ok": true }))
        });
    }
    let r = h
        .call(
            "test.http",
            json!({"request":{"url":"x","method":"GET","timeoutMs":10}}),
        )
        .await
        .unwrap();
    assert_eq!(r["ok"], false);
    assert!(r["message"].as_str().unwrap_or_default().contains("chunk"));
    assert_eq!(*released.lock().unwrap(), vec!["d"]);
    h.close().await;
}

#[tokio::test]
async fn owning_deadline_abort_releases_response_handle() {
    let released = Arc::new(Mutex::new(Vec::new()));
    let mut h = Harness::start(plugin(true), hello(true)).await;
    h.on_capability("capability.net.http", |_| {
        Ok(json!({ "status": 200, "headers": {}, "body": {"handle": "d", "bytes": 1} }))
    });
    // readChunk stays pending (never resolves) so the owning deadline can fire
    // while it is in flight, and the SDK's cancellation turns it into "ended".
    h.on_capability_async("capability.net.http.body.readChunk", |_| async {
        std::future::pending().await
    });
    {
        let released = released.clone();
        h.on_capability("capability.net.http.body.release", move |p| {
            released.lock().unwrap().push(
                p.get("handle")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            );
            Ok(json!({ "ok": true }))
        });
    }
    let id = h
        .start_call(
            "test.http",
            json!({"request":{"url":"x","method":"GET","timeoutMs":1}}),
        )
        .unwrap();
    wait_then_cancel(&h, &id, |c| c.0.ends_with(".readChunk")).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let reply = last_failure_message(&h);
    assert!(
        reply.as_deref().is_some_and(|m| m.contains("ended")),
        "expected an 'ended' failure, got {:?}",
        reply
    );
    assert_eq!(*released.lock().unwrap(), vec!["d"]);
    h.close().await;
}

#[tokio::test]
async fn queue_advances_after_first_failure() {
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h);
    // The first `capability.net.http` returns a staged response that reads then
    // fails; the second is a plain success. A counter distinguishes them (the
    // TS source numbers the two calls 1 and 2).
    let n = Arc::new(Mutex::new(0usize));
    let net = n.clone();
    h.on_capability("capability.net.http", move |_| {
        let mut n = net.lock().unwrap();
        *n += 1;
        if *n == 1 {
            Ok(json!({ "status": 200, "headers": {}, "body": {"handle": "d", "bytes": 1} }))
        } else {
            Ok(json!({ "status": 200, "headers": {}, "body": "second" }))
        }
    });
    h.on_capability("capability.net.http.body.readChunk", |_| {
        Err(("internal".into(), "first failed".into()))
    });
    let first = h
        .call(
            "test.http",
            json!({"request":{"url":"x","method":"GET","timeoutMs":10}}),
        )
        .await
        .unwrap();
    assert_eq!(first["ok"], false);
    assert!(
        first["message"]
            .as_str()
            .unwrap_or_default()
            .contains("first failed")
    );
    let second = h
        .call(
            "test.http",
            json!({"request":{"url":"x","method":"GET","timeoutMs":10}}),
        )
        .await
        .unwrap();
    assert_eq!(second["ok"], true);
    assert_eq!(second["body"], "second");
    let order: Vec<String> = method_calls(&h)
        .into_iter()
        .filter(|m| {
            m == "capability.net.http" || m.ends_with(".readChunk") || m.ends_with(".release")
        })
        .collect();
    assert_eq!(
        order,
        vec![
            "capability.net.http",
            "capability.net.http.body.readChunk",
            "capability.net.http.body.release",
            "capability.net.http",
        ]
    );
    h.close().await;
}

#[tokio::test]
async fn queued_abort_rejects_with_no_effects() {
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h);
    // First call holds the transaction queue on a `capability.net.http` answer
    // that stays pending forever; the second queued call is aborted.
    h.on_capability_async("capability.net.http", |_| async {
        std::future::pending().await
    });
    let first = h
        .start_call(
            "test.http",
            json!({"request":{"url":"x","method":"GET","timeoutMs":10}}),
        )
        .unwrap();
    // Wait until the first call is inside `capability.net.http` (holding the
    // queue), then queue the second and abort it before it can acquire.
    wait_observed(&h, |(m, _)| m == "capability.net.http").await;
    let second = h
        .start_call_unowned(
            "test.http",
            json!({"request":{"url":"x","method":"GET","timeoutMs":10}}),
        )
        .unwrap();
    h.cancel(&second);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(last_handler_reply(&h)["ok"], json!(false));
    let replies = h.replies();
    let codes: Vec<&str> = replies
        .iter()
        .filter(|r| r.get("result").and_then(|v| v.get("ok")) == Some(&json!(false)))
        .filter_map(|r| {
            r.get("result")?
                .get("message")?
                .as_str()
                .filter(|m| m.contains("ended"))
        })
        .collect();
    assert!(
        !codes.is_empty(),
        "queued call must abort with owning plugin call ended"
    );
    assert_eq!(
        h.capability_calls()
            .iter()
            .filter(|(m, _)| m == "capability.net.http")
            .count(),
        1,
        "only the first call reaches a capability effect"
    );
    // Let the first call finish so the harness can close cleanly.
    h.cancel(&first);
    h.call("nope", json!({})).await.ok(); // drain
    h.close().await;
}
