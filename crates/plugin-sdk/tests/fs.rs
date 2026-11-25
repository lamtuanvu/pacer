#![allow(clippy::unwrap_used)]
//! `Host::fs` over the scripted [`Harness`], porting `test/plugin-sdk-fs.test.ts`.
//! Requires `--features testing`.

use pacer_plugin::{
    Manifest, Plugin,
    testing::{Harness, HelloSpec},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// An in-memory host filesystem mirroring the TS `fixture`: acknowledges
/// staging and release, streams `beginWrite`/`writeChunk`/`commitWrite`, and
/// records inline writes and releases.
#[derive(Default)]
struct Fs {
    written: Vec<Vec<u8>>,
    chunks: Vec<u8>,
    offset: usize,
    released: bool,
    member_count: usize,
}

fn manifest() -> Manifest {
    Manifest(
        json!({"id":"p","version":"1.0.0","publisher":"t","host":">=1.2","contributes":{"fs":{}}}),
    )
}

fn hello(offer: bool) -> HelloSpec {
    HelloSpec {
        features: if offer {
            vec!["fileWriteChunks".into()]
        } else {
            Vec::new()
        },
        ..Default::default()
    }
}

/// The plugin serves `test.fs`: it drives `Host::fs` over a script of
/// operations (all submitted eagerly, so later ops are queue-ordered behind
/// earlier ones, matching the TS fixture's shared `createFileSystem` tail).
fn plugin(offer_file_write: bool) -> Plugin {
    let mut p = Plugin::new(manifest()).handle("test.fs", |params, c| async move {
        if let Some(fl) = params.get("frameLimit").and_then(Value::as_u64) {
            c.host.set_frame_limit_for_test(fl as usize);
        }
        let fs = c.host.fs();
        let ops = params
            .get("ops")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut handles = Vec::new();
        for op in ops {
            let fs = fs.clone();
            handles.push(tokio::spawn(run_op(fs, op)));
        }
        let mut failure = None;
        for h in handles {
            match h.await.unwrap() {
                Ok(()) => {}
                Err(e) => failure = Some(e),
            }
        }
        match failure {
            Some(e) => Err(e),
            None => Ok(json!({ "ok": true })),
        }
    });
    if offer_file_write {
        p = p.features(vec!["fileWriteChunks"]);
    }
    p
}

async fn run_op(fs: pacer_plugin::FileSystem, op: Value) -> Result<(), pacer_plugin::PluginError> {
    match op.get("op").and_then(Value::as_str).unwrap_or_default() {
        "write" => {
            let path = op.get("path").and_then(Value::as_str).unwrap_or_default();
            let text = op.get("text").and_then(Value::as_str).unwrap_or_default();
            let mode = op.get("mode").and_then(Value::as_u64);
            fs.write(path, text, mode).await
        }
        "mkdir" => {
            let path = match op.get("path").and_then(Value::as_str) {
                Some(p) => p,
                None => return Ok(()),
            };
            fs.mkdir(path).await
        }
        "remove" => {
            let path = match op.get("path").and_then(Value::as_str) {
                Some(p) => p,
                None => return Ok(()),
            };
            let recursive = op.get("recursive").and_then(Value::as_bool);
            fs.remove(path, recursive).await
        }
        _ => Ok(()),
    }
}

/// Register the standard filesystem answers on `h`, driving `state`.
fn base_capabilities(h: &mut Harness, state: Arc<Mutex<Fs>>) {
    let s = state.clone();
    h.on_capability("capability.fs.beginWrite", move |_| {
        let mut s = s.lock().unwrap();
        s.chunks.clear();
        s.offset = 0;
        Ok(json!({ "handle": "owned-handle" }))
    });
    let s = state.clone();
    h.on_capability("capability.fs.writeChunk", move |p| {
        let mut s = s.lock().unwrap();
        let b64 = p.get("base64").and_then(Value::as_str).unwrap_or_default();
        let bytes = pacer_plugin::js::base64::decode(b64).unwrap_or_default();
        assert_eq!(pacer_plugin::js::base64::encode(&bytes), b64);
        assert!(bytes.len() <= 262144);
        let offset = p.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        assert_eq!(offset, s.offset);
        s.chunks.extend_from_slice(&bytes);
        s.offset += bytes.len();
        Ok(json!({ "bytes": s.offset }))
    });
    let s = state.clone();
    h.on_capability("capability.fs.commitWrite", move |_| {
        let mut s = s.lock().unwrap();
        let chunks = std::mem::take(&mut s.chunks);
        s.written.push(chunks);
        s.offset = 0;
        Ok(json!({ "ok": true }))
    });
    let s = state.clone();
    h.on_capability("capability.fs.write", move |p| {
        let mut s = s.lock().unwrap();
        let text = p.get("text").and_then(Value::as_str).unwrap_or_default();
        s.written.push(text.as_bytes().to_vec());
        Ok(json!({ "ok": true }))
    });
    let s = state.clone();
    h.on_capability("capability.fs.releaseWrite", move |_| {
        let mut s = s.lock().unwrap();
        s.released = true;
        Ok(json!({ "ok": true }))
    });
    let s = state.clone();
    h.on_capability("capability.fs.mkdir", move |_| {
        s.lock().unwrap().member_count += 1;
        Ok(json!({ "ok": true }))
    });
    let s = state.clone();
    h.on_capability("capability.fs.remove", move |_| {
        s.lock().unwrap().member_count += 1;
        Ok(json!({ "ok": true }))
    });
}

#[tokio::test]
async fn small_and_empty_writes_mkdir_and_remove_use_exact_inline_requests() {
    let state = Arc::new(Mutex::new(Fs::default()));
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h, state);
    let r = h
        .call(
            "test.fs",
            json!({ "ops": [
                { "op": "write", "path": "/owned/a", "text": "", "mode": 0o600 },
                { "op": "mkdir", "path": "/owned/dir" },
                { "op": "remove", "path": "/owned/dir", "recursive": true },
            ] }),
        )
        .await
        .unwrap();
    assert_eq!(r["ok"], true);
    let calls = h.capability_calls();
    assert_eq!(
        calls,
        vec![
            ("capability.fs.write".to_string(), json!({ "path": "/owned/a", "text": "", "mode": 0o600 })),
            ("capability.fs.mkdir".to_string(), json!({ "path": "/owned/dir" })),
            ("capability.fs.remove".to_string(), json!({ "path": "/owned/dir", "recursive": true })),
        ]
    );
    h.close().await;
}

#[tokio::test]
async fn full_4mib_multibyte_bom_survives_negotiated_writes() {
    let text = "\u{feff}".to_string() + &"界".repeat(1398100) + "x";
    assert_eq!(text.len(), 4194304);
    let state = Arc::new(Mutex::new(Fs::default()));
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h, state.clone());
    let r = h
        .call(
            "test.fs",
            json!({ "ops": [ { "op": "write", "path": "/owned/large", "text": text } ] }),
        )
        .await
        .unwrap();
    assert_eq!(r["ok"], true);
    let s = state.lock().unwrap();
    assert_eq!(s.written.len(), 1);
    assert_eq!(s.written[0], text.as_bytes());
    assert!(!s.released);
    let calls = h.capability_calls();
    assert!(!calls.iter().any(|(m, _)| m.ends_with(".releaseWrite")));
    drop(s);
    h.close().await;
}

#[tokio::test]
async fn full_4mib_nul_expansion_survives_negotiated_writes() {
    let text: String = "\0".repeat(4194304);
    let state = Arc::new(Mutex::new(Fs::default()));
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h, state.clone());
    let r = h
        .call(
            "test.fs",
            json!({ "ops": [ { "op": "write", "path": "/owned/large", "text": text } ] }),
        )
        .await
        .unwrap();
    assert_eq!(r["ok"], true);
    let s = state.lock().unwrap();
    assert_eq!(s.written.len(), 1);
    assert_eq!(s.written[0].len(), 4194304);
    assert!(!s.released);
    drop(s);
    h.close().await;
}

#[tokio::test]
async fn invalid_mode_over_4mib_and_old_peer_oversized_writes_fail_before_effects() {
    let state = Arc::new(Mutex::new(Fs::default()));
    let mut h = Harness::start(plugin(false), hello(false)).await;
    base_capabilities(&mut h, state);
    // invalid mode
    let err = h.call(
        "test.fs",
        json!({ "ops": [ { "op": "write", "path": "/owned/a", "text": "x", "mode": 0o644 } ] }),
    )
    .await
    .unwrap_err();
    assert_eq!(err.message, "filesystem write mode must be 0600");
    // over 4MiB
    let err = h
        .call(
            "test.fs",
            json!({ "ops": [ { "op": "write", "path": "/owned/a", "text": "a".repeat(4194305) } ] }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.message, "filesystem write exceeds 4MiB UTF8");
    // 300000 NULs with an old peer (no fileWriteChunks) must refuse before begin
    let err = h
        .call(
            "test.fs",
            json!({ "ops": [ { "op": "write", "path": "/owned/a", "text": "\0".repeat(300000) } ] }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.message, "oversized filesystem write requires fileWriteChunks");
    assert!(h.capability_calls().is_empty());
    h.close().await;
}

#[tokio::test]
async fn unencodable_descriptor_fails_before_begin() {
    let state = Arc::new(Mutex::new(Fs::default()));
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h, state);
    // A frame limit small enough that even the placeholder beginWrite metadata
    // doesn't fit, so no capability call is made before begin.
    let err = h
        .call(
            "test.fs",
            json!({ "frameLimit": 64, "ops": [ { "op": "write", "path": "/owned/a", "text": "\0".repeat(300000) } ] }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.message, "filesystem complete frame exceeds limit");
    assert!(h.capability_calls().is_empty());
    h.close().await;
}

#[tokio::test]
async fn bad_byte_acknowledgements_release_staging_without_committing() {
    let state = Arc::new(Mutex::new(Fs::default()));
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h, state.clone());
    h.on_capability("capability.fs.writeChunk", |_| Ok(json!({ "bytes": 1 })));
    let err = h
        .call(
            "test.fs",
            json!({ "ops": [ { "op": "write", "path": "/owned/a", "text": "\0".repeat(300000) } ] }),
        )
        .await
        .unwrap_err();
    assert!(err.message.contains("acknowledgement"));
    let calls = h.capability_calls();
    assert_eq!(calls.last().unwrap().0, "capability.fs.releaseWrite");
    let s = state.lock().unwrap();
    assert!(s.written.is_empty());
    drop(s);
    h.close().await;
}

#[tokio::test]
async fn invalid_ok_replies_are_rejected_for_all_inline_methods() {
    let state = Arc::new(Mutex::new(Fs::default()));
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h, state);
    h.on_capability("capability.fs.write", |_| Ok(json!({ "ok": "true" })));
    h.on_capability("capability.fs.mkdir", |_| Ok(json!({ "ok": "true" })));
    h.on_capability("capability.fs.remove", |_| Ok(json!({ "ok": "true" })));
    for op in [
        json!({ "op": "write", "path": "/owned/a", "text": "x" }),
        json!({ "op": "mkdir", "path": "/owned/a" }),
        json!({ "op": "remove", "path": "/owned/a" }),
    ] {
        let err = h.call("test.fs", json!({ "ops": [op] })).await.unwrap_err();
        assert_eq!(err.message, "invalid filesystem acknowledgement");
    }
    h.close().await;
}

#[tokio::test]
async fn whole_transactions_await_cleanup_and_queued_abort_has_no_effects() {
    let state = Arc::new(Mutex::new(Fs::default()));
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h, state.clone());
    // First write's writeChunk fails after an external barrier; the second
    // (mkdir) is queued behind it and must be aborted with no capability effect.
    let entered = Arc::new(Mutex::new(false));
    let release = Arc::new(tokio::sync::Barrier::new(2));
    let enter = entered.clone();
    let barrier = release.clone();
    h.on_capability_async("capability.fs.writeChunk", move |_| {
        let enter = enter.clone();
        let barrier = barrier.clone();
        async move {
            *enter.lock().unwrap() = true;
            barrier.wait().await;
            Err(pacer_plugin::testing::HostError::new("internal", "owned stage failure"))
        }
    });
    let id = h
        .start_call(
            "test.fs",
            json!({ "ops": [
                { "op": "write", "path": "/owned/a", "text": "\0".repeat(300000) },
                { "op": "mkdir", "path": "/owned/queued" },
            ] }),
        )
        .unwrap();
    // Wait until the first write is inside writeChunk (holding the queue).
    for _ in 0..500 {
        if *entered.lock().unwrap() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    h.cancel(&id);
    // The queued mkdir must be aborted without issuing a capability call.
    let mkdir_calls = h
        .capability_calls()
        .iter()
        .filter(|(m, _)| m == "capability.fs.mkdir")
        .count();
    assert_eq!(mkdir_calls, 0);
    // The whole transaction still awaits cleanup (release attempted for write).
    release.wait().await;
    for _ in 0..500 {
        if state.lock().unwrap().released {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    assert!(state.lock().unwrap().released);
    let replies = h.replies();
    let codes: Vec<&str> = replies
        .iter()
        .filter(|r| r.get("ok") == Some(&json!(false)))
        .filter_map(|r| {
            r.get("error")?
                .get("message")?
                .as_str()
                .filter(|m| m.contains("ended") || m.contains("stage"))
        })
        .collect();
    assert!(!codes.is_empty(), "first write must fail");
    h.close().await;
}

#[tokio::test]
async fn unrelated_cleanup_failure_is_not_hidden_and_next_transaction_proceeds() {
    let state = Arc::new(Mutex::new(Fs::default()));
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h, state.clone());
    h.on_capability("capability.fs.writeChunk", |_| {
        Err(("internal".into(), "stage failed".into()))
    });
    h.on_capability("capability.fs.releaseWrite", |_| {
        Err(("internal".into(), "cleanup failed".into()))
    });
    let err = h
        .call(
            "test.fs",
            json!({ "ops": [ { "op": "write", "path": "/owned/a", "text": "\0".repeat(300000) } ] }),
        )
        .await
        .unwrap_err();
    assert!(err.message.contains("cleanup failed"));
    // The next transaction can proceed despite the earlier cleanup failure.
    let r2 = h
        .call(
            "test.fs",
            json!({ "ops": [ { "op": "mkdir", "path": "/owned/next" } ] }),
        )
        .await
        .unwrap();
    assert_eq!(r2["ok"], true);
    let calls = h.capability_calls();
    assert_eq!(calls.last().unwrap().0, "capability.fs.mkdir");
    h.close().await;
}

#[tokio::test]
async fn admitted_inline_calls_cannot_report_success_after_owner_abort() {
    let state = Arc::new(Mutex::new(Fs::default()));
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h, state);
    // The owning call is aborted while `capability.fs.write` is in flight, so
    // the inline write must be rejected after its reply ("active()" after call).
    h.on_capability("capability.fs.write", |_| {
        Err(("internal".into(), "aborted".into()))
    });
    let err = h
        .call(
            "test.fs",
            json!({ "ops": [ { "op": "write", "path": "/owned/a", "text": "x" } ] }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.message, "aborted");
    h.close().await;
}

#[tokio::test]
async fn failed_consumed_commit_still_attempts_owned_release() {
    let state = Arc::new(Mutex::new(Fs::default()));
    let mut h = Harness::start(plugin(true), hello(true)).await;
    base_capabilities(&mut h, state.clone());
    let s = state.clone();
    h.on_capability("capability.fs.commitWrite", move |_| {
        s.lock().unwrap().member_count += 1;
        Err(("internal".into(), "commit failed".into()))
    });
    let err = h
        .call(
            "test.fs",
            json!({ "ops": [ { "op": "write", "path": "/owned/a", "text": "\0".repeat(300000) } ] }),
        )
        .await
        .unwrap_err();
    assert!(err.message.contains("commit failed"));
    let calls = h.capability_calls();
    assert_eq!(calls.last().unwrap().0, "capability.fs.releaseWrite");
    assert!(state.lock().unwrap().released);
    h.close().await;
}