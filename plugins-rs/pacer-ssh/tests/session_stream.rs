//! Tests of the owned full-session duplex bridge (`hostRunner.stream`), porting
//! `test/plugins-ssh-session-stream.test.ts` and the SDK owned-stream wire
//! contract in `crates/plugin-sdk/tests/stream.rs`. A `hostRunner.stream` call
//! opens a `capability.process.duplex.open` handle, pulls output frames (dropping
//! login chatter before `__PACER_BEGIN__`), pushes owned input frames, and
//! closes with a clean remote exit.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use base64::Engine;
use pacer_plugin::testing::Harness;
use serde_json::{Value, json};

/// A valid run dir under `.pacer-remote/runs`.
const RUN_D: &str = "/home/test/.pacer-remote/runs/t-20261124-000000-abcd/1";
/// A fixed valid stream id (UUIDv4).
const STREAM_ID: &str = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
/// A fixed valid duplex handle (UUIDv4).
const HANDLE: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/// The valid SESSION_PIPE stream request the bundled plugin accepts
/// (`session_stream.rs:86-108`).
fn stream_params(session: &str, timeout_ms: u64) -> Value {
    json!({
        "session": session,
        "script": "SESSION_PIPE",
        "args": [RUN_D],
        "streamId": STREAM_ID,
        "timeoutMs": timeout_ms,
        "maxBytes": 65_536,
    })
}

/// A host that answers duplex open/read/close from a scripted FIFO chunk
/// queue (delivered in insertion order via `remove(0)`, mirroring the
/// TypeScript harness's `chunks.shift()`) and records the calls it saw.
async fn open(h: &mut Harness) -> String {
    let result = h
        .call(
            "hostRunner.open",
            json!({ "alias": "box", "sshTarget": "host.example.com", "controlPath": "/tmp/private/cm-%C" }),
        )
        .await
        .expect("open succeeds");
    result.get("session").and_then(Value::as_str).expect("session id").to_owned()
}

// TS: :17 — the bridge pushes output past the marker and returns the framed
// byte count, with a clean remote exit.
#[tokio::test]
async fn stream_pushes_payload_and_closes_clean() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    let chunks = std::sync::Arc::new(std::sync::Mutex::new(vec![
        "login chatter\n__PACER_BE".to_string(),
        "GIN__\nhello".to_string(),
    ]));
    let queue = chunks.clone();
    h.on_capability("capability.process.duplex.open", move |_| {
        Ok(json!({ "handle": HANDLE }))
    });
    h.on_capability("capability.process.duplex.read", move |_| {
        let mut q = queue.lock().unwrap();
        if q.is_empty() {
            Ok(json!({ "base64": "", "eof": true }))
        } else {
            Ok(json!({ "base64": b64(&q.remove(0)), "eof": false }))
        }
    });
    h.on_capability("capability.process.duplex.close", |_| {
        Ok(json!({ "ok": true, "code": 0, "signal": null, "terminated": false }))
    });
    let result = h
        .call("hostRunner.stream", stream_params(&session, 60_000))
        .await
        .expect("stream succeeds");
    assert_eq!(result, json!({ "code": 0, "bytes": 5 }), "payload bytes after the marker");
    // The order must be open, then read (until eof), then close.
    let calls = h.capability_calls();
    let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
    assert!(methods.starts_with(&["capability.process.duplex.open"]), "open first: {methods:?}");
    let reads = methods.iter().filter(|m| m == &&"capability.process.duplex.read").count();
    assert!(reads >= 3, "reads until eof: {methods:?}");
    assert_eq!(methods.last(), Some(&"capability.process.duplex.close"), "close last: {methods:?}");
    assert_eq!(calls[0].1["timeoutMs"], 60_000, "open carries the timeout");
    h.close().await;
}

// TS: :17 — a non-zero remote exit code is reported as `plugin_unavailable`.
#[tokio::test]
async fn stream_nonzero_exit_is_unavailable() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    let chunks = std::sync::Arc::new(std::sync::Mutex::new(vec![
        "login chatter\n__PACER_BE".to_string(),
        "GIN__\nhello".to_string(),
    ]));
    let queue = chunks.clone();
    h.on_capability("capability.process.duplex.open", move |_| {
        Ok(json!({ "handle": HANDLE }))
    });
    h.on_capability("capability.process.duplex.read", move |_| {
        let mut q = queue.lock().unwrap();
        if q.is_empty() {
            Ok(json!({ "base64": "", "eof": true }))
        } else {
            Ok(json!({ "base64": b64(&q.remove(0)), "eof": false }))
        }
    });
    h.on_capability("capability.process.duplex.close", |_| {
        Ok(json!({ "ok": true, "code": 7, "signal": null, "terminated": false }))
    });
    let err = h
        .call("hostRunner.stream", stream_params(&session, 60_000))
        .await
        .expect_err("nonzero exit must be unavailable");
    assert_eq!(err.code, "plugin_unavailable");
    assert_eq!(err.message, "SSH session ended without a clean remote exit");
    h.close().await;
}

// session_stream.rs:94-107 — a read deadline too short for its idle poll is
// refused before the broker opens.
#[tokio::test]
async fn stream_too_short_timeout_is_refused() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    h.on_capability("capability.process.duplex.open", |_| {
        panic!("broker must not open for a too-short timeout");
    });
    let err = h
        .call("hostRunner.stream", stream_params(&session, 1999))
        .await
        .expect_err("sub-2000 timeout must be denied");
    assert_eq!(err.code, "capability_denied");
    assert_eq!(err.message, "remote session stream was not issued for this provider");
    assert!(h.capability_calls().is_empty(), "no duplex call for a refused stream");
    h.close().await;
}

// session_stream.rs:87-90 — a missing marker means the payload never framed;
// the bridge still closes and reports the result. (The outgoing loop reaches
// eof with no marker, and there was nothing to deliver.)
#[tokio::test]
async fn stream_missing_marker_is_refused() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    let chunks = std::sync::Arc::new(std::sync::Mutex::new(vec![
        "chatter only\n".to_string(),
    ]));
    let queue = chunks.clone();
    h.on_capability("capability.process.duplex.open", move |_| {
        Ok(json!({ "handle": HANDLE }))
    });
    h.on_capability("capability.process.duplex.read", move |_| {
        let mut q = queue.lock().unwrap();
        if q.is_empty() {
            Ok(json!({ "base64": "", "eof": true }))
        } else {
            Ok(json!({ "base64": b64(&q.remove(0)), "eof": false }))
        }
    });
    h.on_capability("capability.process.duplex.close", |_| {
        Ok(json!({ "ok": true, "code": 0, "signal": null, "terminated": false }))
    });
    let err = h
        .call("hostRunner.stream", stream_params(&session, 60_000))
        .await
        .expect_err("missing marker must be refused");
    assert_eq!(err.code, "plugin_refused");
    assert_eq!(err.message, "SSH session payload marker missing");
    h.close().await;
}

// SDK-owned input: driving `$/streamInput` writes the frame back to the bridge.
// Mirrors `crates/plugin-sdk/tests/stream.rs` input framing; the default
// `$/streamInputAck` acknowledges with `{seq}`. The remote keeps the pipe
// open (the outgoing `duplex.read` stalls after the marker) until the host
// delivers its input, then the remote signals eof so the call closes clean.
#[tokio::test]
async fn stream_input_pushes_a_write() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    let writes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen_writes = writes.clone();
    // First read yields the marker frame; later reads park until the input
    // write is observed, then signal eof (so `outgoing` stays in-flight
    // while the owned input arrives and is written to the bridge).
    let delivered = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    h.on_capability_async("capability.process.duplex.read", {
        let seen_writes = seen_writes.clone();
        move |_| {
        let delivered = delivered.clone();
        let seen = seen_writes.clone();
        async move {
            if !delivered.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return Ok(json!({ "base64": b64("__PACER_BEGIN__\nready"), "eof": false }));
            }
            // Stall until the plugin has written the delivered input back to
            // the bridge (a few seconds), then conclude the remote pipe.
            let until = std::time::Instant::now() + std::time::Duration::from_secs(3);
            while seen.lock().unwrap().is_empty() && std::time::Instant::now() < until {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            Ok(json!({ "base64": "", "eof": true }))
        }
    }
    });
    h.on_capability("capability.process.duplex.open", move |_| {
        Ok(json!({ "handle": HANDLE }))
    });
    h.on_capability("capability.process.duplex.write", move |params| {
        let pair = (
            params.get("handle").and_then(Value::as_str).unwrap_or_default().to_string(),
            params.get("base64").and_then(Value::as_str).unwrap_or_default().to_string(),
        );
        seen_writes.lock().unwrap().push(pair);
        let bytes = params
            .get("base64")
            .and_then(Value::as_str)
            .map(decoded_len)
            .unwrap_or(0);
        Ok(json!({ "bytes": bytes }))
    });
    h.on_capability("capability.process.duplex.close", |_| {
        Ok(json!({ "ok": true, "code": 0, "signal": null, "terminated": false }))
    });
    let id = h
        .start_call("hostRunner.stream", stream_params(&session, 60_000))
        .expect("stream start");
    let request: u64 = id.parse().expect("numeric stream request id");
    // The incoming loop waits on `owned.next_input()`; feed one frame whose
    // base64 decodes to `hi`.
    h.send(
        "$/streamInput",
        json!({ "request": request, "streamId": STREAM_ID, "seq": 0, "base64": b64("hi") }),
    );
    wait_for(|| !writes.lock().unwrap().is_empty()).await;
    // The write went to the bridge handle with the exact outgoing bytes.
    let writes = writes.lock().unwrap();
    assert_eq!(writes.len(), 1, "exactly one duplex.write for one input frame");
    assert_eq!(writes[0].0, HANDLE, "duplex.write carries the bridge handle");
    assert_eq!(writes[0].1, b64("hi"), "duplex.write carries the input bytes");
    drop(writes);
    h.close().await;
}

fn b64(v: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(v.as_bytes())
}

fn decoded_len(v: &str) -> usize {
    base64::engine::general_purpose::STANDARD
        .decode(v)
        .map(|b| b.len())
        .unwrap_or(0)
}

/// Poll `cond` until it yields true (3 s deadline) so a test can wait for a
/// frame to appear without a hard-coded sleep.
async fn wait_for(mut cond: impl FnMut() -> bool) {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !cond() && std::time::Instant::now() < until {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(cond(), "condition was not satisfied within the deadline");
}