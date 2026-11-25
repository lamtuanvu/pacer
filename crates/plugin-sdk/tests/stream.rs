#![allow(clippy::unwrap_used)]
//! Owned streams over the scripted [`Harness`], porting `test/plugin-sdk-session-stream.test.ts`
//! and the `hostRunner.stream` wire contract in `plugins/pacer-ssh/index.ts`.

use pacer_plugin::{
    Ctx, HostError, Manifest, Plugin, testing::{Harness, HelloSpec},
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::oneshot;

fn manifest() -> Manifest {
    Manifest(
        json!({"id":"fx-stream","version":"1.0.0","publisher":"test","host":">=1.2",
               "contributes":{"hostRunner":{"kinds":["ssh"]}}}),
    )
}

fn hello() -> HelloSpec {
    HelloSpec::default()
}

const STREAM_ID: &str = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

/// A `hostRunner.stream` handler whose `op` drives one owned-stream operation.
/// Returns a record detailing what happened so a test can assert the wire
/// effect without depending on unsupported harness recording.
fn stream_plugin() -> Plugin {
    let err_val = |e: pacer_plugin::PluginError| json!({"ok": false, "code": e.code, "message": e.message});
    Plugin::new(manifest()).handle("hostRunner.stream", move |params, c: Ctx| {
        async move {
            let Some(stream) = c.owned_stream() else {
                return Ok(json!({"code": -1, "owned": false}));
            };
            let op = params.get("op").and_then(Value::as_str).unwrap_or("");
            let stream_id = params
                .get("streamId")
                .and_then(Value::as_str)
                .unwrap_or(STREAM_ID);
            match op {
                "progress" => {
                    let bytes = params
                        .get("bytes")
                        .and_then(Value::as_u64)
                        .map(|n| vec![0x61u8; n as usize])
                        .unwrap_or_else(|| b"abc".to_vec());
                    let seq = params.get("seq").and_then(Value::as_u64).unwrap_or(0);
                    Ok(match stream.progress(stream_id, seq, &bytes).await {
                        Ok(()) => json!({"code": 0, "bytes": bytes.len()}),
                        Err(e) => err_val(e),
                    })
                }
                "read" => {
                    let frame = match stream.next_input().await {
                        Ok(f) => f,
                        Err(e) => return Ok(err_val(e)),
                    };
                    let n = frame.bytes().len();
                    Ok(match frame.ack().await {
                        Ok(()) => json!({"code": 0, "bytes": n}),
                        Err(e) => err_val(e),
                    })
                }
                "read_twice" => {
                    if let Err(e) = stream.next_input().await {
                        return Ok(json!({"first": e.code, "second": "never"}));
                    }
                    let second = stream.next_input().await;
                    Ok(json!({
                        "first": "ok",
                        "second": second.map(|_| json!("ok")).unwrap_or_else(|e| json!(e.code))
                    }))
                }
                _ => Ok(json!({"code": 0, "bytes": 0})),
            }
        }
    })
}

fn ordinary_plugin() -> Plugin {
    Plugin::new(manifest()).handle("diagnostic.ping", |_, c| async move {
        Ok(json!({"stream": c.owned_stream().is_some()}))
    })
}

/// Poll `cond` until it yields true (with a 3 s deadline) so a test can wait
/// for a wire frame to appear without a hard-coded sleep.
async fn wait_for(mut cond: impl FnMut() -> bool) {
    let until = std::time::Instant::now() + Duration::from_secs(3);
    while !cond() && std::time::Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(cond(), "condition was not satisfied within the deadline");
}

/// Compose the two halves of a one-shot gate used to hold an ack answer until
/// the test releases it (so the plugin visibly waits for its sequence ack).
fn ack_gate() -> (
    Arc<Mutex<Option<oneshot::Sender<Value>>>>,
    Arc<Mutex<Option<oneshot::Receiver<Value>>>>,
) {
    let (tx, rx) = oneshot::channel();
    (Arc::new(Mutex::new(Some(tx))), Arc::new(Mutex::new(Some(rx))))
}

/// Install an answer for `method` that blocks until the test sends the value.
fn gate_ack(h: &mut Harness, method: &str, rx: Arc<Mutex<Option<oneshot::Receiver<Value>>>>) {
    h.on_capability_async(method, move |_| {
        let rx = rx.clone();
        async move {
            let rx = rx
                .lock()
                .unwrap()
                .take()
                .ok_or_else(|| HostError::new("plugin_unavailable", "ack gate already consumed"))?;
            let value = rx
                .await
                .map_err(|_| HostError::new("plugin_unavailable", "ack gate dropped"))?;
            Ok(json!({ "seq": value }))
        }
    });
}

fn release(tx: Arc<Mutex<Option<oneshot::Sender<Value>>>>, seq: Value) {
    tx.lock().unwrap().take().expect("gate not yet released").send(seq).unwrap();
}

/// Find the plugin → host response carrying `id` in `replies`. The harness
/// records response ids in string form (wire.rs converts numeric ids to their
/// string representation), so compare against that.
fn reply_for(replies: &[Value], id: u64) -> Option<Value> {
    let key = json!(id.to_string());
    replies.iter().cloned().find(|r| r.get("id") == Some(&key))
}

#[test]
fn progress_waits_for_scoped_ack_and_is_unavailable_to_ordinary_calls() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut ordinary = Harness::start(ordinary_plugin(), hello()).await;
            let resp = ordinary
                .call_unowned("diagnostic.ping", json!({}))
                .await
                .unwrap_or(Value::Null);
            assert_eq!(
                resp.get("stream"),
                Some(&Value::Bool(false)),
                "an ordinary call must not be given an owned stream"
            );
            ordinary.close().await;

            let (tx, rx) = ack_gate();
            let mut s = Harness::start(stream_plugin(), hello()).await;
            gate_ack(&mut s, "$/streamAck", rx);
            let id: u64 = s
                .start_call(
                    "hostRunner.stream",
                    json!({"op":"progress", "streamId": STREAM_ID, "seq": 0, "bytes": 3}),
                )
                .unwrap()
                .parse()
                .unwrap();

            // The SDK emits `$/progress` with `{ id, event }` and then waits
            // for the scoped `$/streamAck` round trip before replying.
            wait_for(|| {
                s.notifications()
                    .iter()
                    .any(|(m, _)| m == "$/progress")
            })
            .await;
            let progress = s
                .notifications()
                .iter()
                .find(|(m, _)| m == "$/progress")
                .expect("progress emit")
                .1
                .clone();
            assert_eq!(progress.get("id"), Some(&json!(id)));
            let event = progress.get("event").expect("owned progress event");
            assert_eq!(event.get("streamId"), Some(&json!(STREAM_ID)));
            assert_eq!(event.get("seq"), Some(&json!(0)));
            // The handler fills `bytes` with `0x61 * n`, so 3 bytes emit "YWFh".
            assert_eq!(event.get("base64"), Some(&json!("YWFh")));

            // The plugin is still awaiting its sequence ack: it has made the
            // `$/streamAck` capability call but has not replied to the stream
            // request.
            wait_for(|| {
                s.capability_calls_with_meta()
                    .iter()
                    .any(|(m, _, _)| m == "$/streamAck")
            })
            .await;
            let ack_meta = s
                .capability_calls_with_meta()
                .iter()
                .find(|(m, _, _)| m == "$/streamAck")
                .map(|(_, _, meta)| meta.clone())
                .flatten();
            assert!(
                ack_meta.is_some(),
                "streamAck must carry the owning capability-call token"
            );
            assert!(
                reply_for(&s.replies(), id).is_none(),
                "handler must not reply before its scoped streamAck"
            );

            release(tx, json!(0));
            wait_for(|| reply_for(&s.replies(), id).is_some()).await;
            let reply = reply_for(&s.replies(), id).expect("stream reply");
            assert_eq!(reply.get("result"), Some(&json!({"code": 0, "bytes": 3})));
            s.close().await;
        });
}

#[test]
fn input_is_one_owned_frame_and_acks_only_after_provider_work() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let received: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
            let rec = received.clone();
            let plugin = Plugin::new(manifest()).handle("hostRunner.stream", move |params, c| {
                let rec = rec.clone();
                async move {
                    let Some(stream) = c.owned_stream() else {
                        return Ok(json!({"code": -1, "owned": false}));
                    };
                    if params.get("op").and_then(Value::as_str) != Some("read") {
                        return Ok(json!({"code": 0}));
                    }
                    let frame = match stream.next_input().await {
                        Ok(f) => f,
                        Err(e) => return Ok(json!({"ok": false, "code": e.code})),
                    };
                    *rec.lock().unwrap() = frame.bytes().to_vec();
                    let n = frame.bytes().len();
                    Ok(match frame.ack().await {
                        Ok(()) => json!({"code": 0, "bytes": n}),
                        Err(e) => json!({"ok": false, "code": e.code}),
                    })
                }
            });

            let (tx, rx) = ack_gate();
            let mut s = Harness::start(plugin, hello()).await;
            gate_ack(&mut s, "$/streamInputAck", rx);
            let id: u64 = s
                .start_call("hostRunner.stream", json!({"op":"read", "streamId": STREAM_ID}))
                .unwrap()
                .parse()
                .unwrap();

            s.send(
                "$/streamInput",
                json!({"request": id, "streamId": STREAM_ID, "seq": 0, "base64": "YWJj"}),
            );

            // The provider has consumed the frame and requested its input ack,
            // but has not yet replied to the stream request.
            wait_for(|| {
                s.capability_calls_with_meta()
                    .iter()
                    .any(|(m, _, _)| m == "$/streamInputAck")
            })
            .await;
            assert_eq!(&*received.lock().unwrap(), b"abc");
            assert!(
                reply_for(&s.replies(), id).is_none(),
                "handler must not reply before its stream input ack"
            );

            release(tx, json!(0));
            wait_for(|| reply_for(&s.replies(), id).is_some()).await;
            let reply = reply_for(&s.replies(), id).expect("stream reply");
            assert_eq!(reply.get("result"), Some(&json!({"code": 0, "bytes": 3})));
            s.close().await;
        });
}

#[test]
fn progress_emits_exact_owned_wire_frame() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut s = Harness::start(stream_plugin(), hello()).await;
            let id: u64 = s
                .start_call(
                    "hostRunner.stream",
                    json!({"op":"progress", "streamId": STREAM_ID, "seq": 7, "bytes": 5}),
                )
                .unwrap()
                .parse()
                .unwrap();
            wait_for(|| reply_for(&s.replies(), id).is_some()).await;
            let progress = s
                .notifications()
                .iter()
                .find(|(m, _)| m == "$/progress")
                .expect("progress emit")
                .1
                .clone();
            let event = progress.get("event").expect("owned progress event");
            assert_eq!(progress.get("id"), Some(&json!(id)));
            assert_eq!(event.get("seq"), Some(&json!(7)));
            assert_eq!(event.get("base64"), Some(&json!("YWFhYWE=")));
            let reply = reply_for(&s.replies(), id).expect("stream reply");
            assert_eq!(reply.get("result"), Some(&json!({"code": 0, "bytes": 5})));
            s.close().await;
        });
}

#[test]
fn evolution_keeps_ordinary_stream_unowned() {
    // A `hostRunner.stream` request without an owning-call token must not be
    // granted an owned stream (index.ts:296-300).
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut s = Harness::start(stream_plugin(), hello()).await;
            let id: u64 = s
                .start_call_unowned("hostRunner.stream", json!({"op":"read", "streamId": STREAM_ID}))
                .unwrap()
                .parse()
                .unwrap();
            wait_for(|| reply_for(&s.replies(), id).is_some()).await;
            let reply = reply_for(&s.replies(), id).expect("stream reply");
            assert_eq!(reply.get("result"), Some(&json!({"code": -1, "owned": false})));
            s.close().await;
        });
}

#[test]
fn progress_rejects_an_ack_mismatch() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut s = Harness::start(stream_plugin(), hello()).await;
            // Answer the sequence ack with a wrong seq so the owner detects it.
            s.on_capability("$/streamAck", |_| Ok(json!({"seq": 999})));
            let id: u64 = s
                .start_call(
                    "hostRunner.stream",
                    json!({"op":"progress", "streamId": STREAM_ID, "seq": 0, "bytes": 3}),
                )
                .unwrap()
                .parse()
                .unwrap();
            wait_for(|| reply_for(&s.replies(), id).is_some()).await;
            let reply = reply_for(&s.replies(), id).expect("stream reply");
            assert_eq!(
                reply.get("result"),
                Some(&json!({"ok": false, "code": "plugin_refused", "message": "invalid stream progress acknowledgement"}))
            );
            s.close().await;
        });
}

#[test]
fn a_second_input_consumer_is_refused_until_the_first_is_acknowledged() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut s = Harness::start(stream_plugin(), hello()).await;
            let id: u64 = s
                .start_call("hostRunner.stream", json!({"op":"read_twice", "streamId": STREAM_ID}))
                .unwrap()
                .parse()
                .unwrap();
            s.send(
                "$/streamInput",
                json!({"request": id, "streamId": STREAM_ID, "seq": 0, "base64": "YWJj"}),
            );
            wait_for(|| reply_for(&s.replies(), id).is_some()).await;
            let reply = reply_for(&s.replies(), id).expect("stream reply");
            // The frame stays delivered (not yet acked) so a second consumer
            // is refused with capability_denied rather than hanging.
            assert_eq!(reply.get("result").and_then(|r| r.get("first")), Some(&json!("ok")));
            assert_eq!(
                reply.get("result").and_then(|r| r.get("second")),
                Some(&json!("capability_denied"))
            );
            s.close().await;
        });
}

#[test]
fn invalid_stream_input_is_rejected_with_plugin_refused() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut s = Harness::start(stream_plugin(), hello()).await;
            let id: u64 = s
                .start_call("hostRunner.stream", json!({"op":"read", "streamId": STREAM_ID}))
                .unwrap()
                .parse()
                .unwrap();
            // A frame whose base64 is not canonical (round-trip fails) must be
            // rejected: the waiting `next_input` is woken with plugin_refused.
            s.send(
                "$/streamInput",
                json!({"request": id, "streamId": STREAM_ID, "seq": 0, "base64": "not base64!!"}),
            );
            wait_for(|| reply_for(&s.replies(), id).is_some()).await;
            // An invalid frame (non-canonical base64) aborts the owning call
            // (index.ts:262-264): `next_input` is woken with `plugin_refused`,
            // but because the scoped call was aborted its result is dropped as
            // `plugin_unavailable` (index.ts:145-146). Assert the wire effect.
            let reply = reply_for(&s.replies(), id).expect("stream reply");
            assert_eq!(
                reply.get("error").and_then(|e| e.get("code")),
                Some(&json!("plugin_unavailable"))
            );
            s.close().await;
        });
}