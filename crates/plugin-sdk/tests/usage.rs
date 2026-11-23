//! SDK `usage` feature tests, ported from `test/sp02-sdk-usage.test.ts`.
//!
//! The TS `stateHost` fixture is ported as harness capability answers over an
//! in-memory usage-state store plus a scriptable fs surface (the `capability.*`
//! methods the plugin's `reader_io` calls).

#![allow(clippy::unwrap_used)]

use pacer_plugin::{
    Manifest, Plugin,
    testing::Harness,
    usage::{Cursor, CursorFiles, ReaderIo},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// A scriptable `capability.usage.state.*` host: tracks the lease, staged
/// bytes, committed value/dirty flag, released flag and the call log, reading
/// from a seeded snapshot.
struct StateStore {
    snapshot: Vec<u8>,
    staged: Vec<u8>,
    committed: Option<Value>,
    dirty: bool,
    released: bool,
    calls: Vec<String>,
    /// When set, every `commit` fails like the TS fixture ("disk unavailable").
    fail_commit: bool,
}

impl StateStore {
    fn new(snapshot: Value) -> Self {
        Self {
            snapshot: serde_json::to_vec(&snapshot).unwrap(),
            staged: Vec::new(),
            committed: None,
            dirty: false,
            released: false,
            calls: Vec::new(),
            fail_commit: false,
        }
    }

    fn route(&mut self, method: &str, params: &Value) -> Result<Value, (String, String)> {
        self.calls.push(method.to_owned());
        let op = method.rsplit('.').next().unwrap_or("");
        match op {
            "begin" => Ok(json!({
                "lease": "fixture-lease",
                "bytes": self.snapshot.len(),
                "dirty": self.dirty
            })),
            "readChunk" => {
                let offset = params["offset"].as_u64().unwrap_or(0) as usize;
                let length = params["length"].as_u64().unwrap_or(0) as usize;
                let slice = &self.snapshot[offset..(offset + length).min(self.snapshot.len())];
                Ok(json!({ "base64": base64(slice) }))
            }
            "stageChunk" => {
                let parts: Vec<u8> = base64_decode(params["base64"].as_str().unwrap_or(""));
                self.staged.extend_from_slice(&parts);
                Ok(json!({ "bytes": self.staged.len() }))
            }
            "commit" => {
                if self.fail_commit {
                    return Err(("disk_unavailable".to_owned(), "disk unavailable".to_owned()));
                }
                self.committed = Some(serde_json::from_slice(&self.staged).unwrap_or(Value::Null));
                self.dirty = params["dirty"].as_bool().unwrap_or(false);
                Ok(json!({ "saved": true }))
            }
            "release" => {
                self.released = true;
                Ok(json!({ "ok": true }))
            }
            _ => Err(("unknown".to_owned(), format!("unexpected {method}"))),
        }
    }
}

fn base64(bytes: &[u8]) -> String {
    pacer_plugin::js::base64::encode(bytes)
}

fn base64_decode(s: &str) -> Vec<u8> {
    pacer_plugin::js::base64::decode_lenient(s)
}

/// A plugin whose `usage.drill` handler exercises one `reader_io` path.
/// `drill` selects the operation; the handler returns its raw result so the
/// test can also assert on the plugin-side outcome.
fn drill_plugin() -> Plugin {
    Plugin::new(Manifest(
        json!({"id":"u","version":"1.0.0","publisher":"t","host":"^1","contributes":{"usage":{}}}),
    ))
    .handle("usage.drill", |params, ctx| async move {
        let io = pacer_plugin::usage::reader_io(&ctx.host);
        match params["drill"].as_str().unwrap_or("") {
            "cursors-hydration" => {
                let result = io
                    .cursors(
                        "codex-cursors",
                        4,
                        &|v| v.get("valid").and_then(Value::as_bool) == Some(true),
                        Box::new(|files: &mut CursorFiles| {
                            Box::pin(async move {
                                let keys: Vec<String> = files.keys().cloned().collect();
                                // `files.good = files.good` (no-op identity set).
                                if let Some(good) = files.get("good") {
                                    files.set("good", good);
                                }
                                Ok(json!({ "keys": keys, "value": 17 }))
                            })
                        }),
                    )
                    .await?;
                Ok(result)
            }
            "cursors-large" => {
                let payload = "界".repeat(1500000);
                let result = io
                    .cursors(
                        "codex-cursors",
                        4,
                        &|_| true,
                        Box::new(move |files: &mut CursorFiles| {
                            Box::pin(async move {
                                // Replace `large` with a fresh reference → dirty.
                                if let Some(large) = files.get("large") {
                                    files.set("large", large);
                                }
                                Ok(json!(payload))
                            })
                        }),
                    )
                    .await?;
                Ok(result)
            }
            "cached-stale-fallback" => {
                let r = io
                    .cached_fetch(
                        "arkcli-usage-plan",
                        600_f64,
                        21600_f64,
                        Box::pin(async move { Ok(json!({ "fresh": true })) }),
                        true,
                        101_f64,
                        false,
                    )
                    .await?;
                Ok(json!(serde_value(&r)))
            }
            "cached-backward-clock" => {
                let r = io
                    .cached_fetch(
                        "arkcli-usage-plan",
                        600_f64,
                        21600_f64,
                        Box::pin(async move {
                            Err(pacer_plugin::PluginError::new("offline", "offline"))
                        }),
                        false,
                        99_f64,
                        false,
                    )
                    .await?;
                Ok(json!(serde_value(&r)))
            }
            "range-disappeared" => {
                let info = file_info("/fixture", 4, 4);
                let r = io.range("/fixture", 0, 4, &info).await;
                match r {
                    Ok(_) => Err(pacer_plugin::PluginError::new(
                        "internal",
                        "expected ENOENT",
                    )),
                    Err(e) if e.code == "ENOENT" => Ok(json!({ "code": e.code })),
                    Err(e) => Err(pacer_plugin::PluginError::new("internal", e.message)),
                }
            }
            "range-incomplete" => {
                let r = io.read("/fixture").await;
                match r {
                    Ok(_) => Err(pacer_plugin::PluginError::new(
                        "internal",
                        "expected incomplete",
                    )),
                    Err(e) => Ok(json!({ "message": e.message })),
                }
            }
            _ => Err(pacer_plugin::PluginError::new("internal", "unknown drill")),
        }
    })
}

fn file_info(path: &str, size: u64, inode: u64) -> pacer_plugin::usage::FileInfo {
    pacer_plugin::usage::FileInfo {
        path: path.to_owned(),
        size,
        mtime_ms: 1.0,
        inode,
        device: 1,
        mode: None,
    }
}

/// Flatten a `Cached` into a JSON that mirrors the TS result shape.
fn serde_value(c: &pacer_plugin::usage::Cached) -> serde_json::Value {
    let mut m = serde_json::Map::new();
    m.insert("value".to_owned(), c.value.clone().unwrap_or(Value::Null));
    m.insert(
        "capturedAt".to_owned(),
        c.captured_at.map(Value::from).unwrap_or(Value::Null),
    );
    m.insert("stale".to_owned(), json!(c.stale));
    if let Some(e) = &c.error {
        m.insert("error".to_owned(), json!(e));
    }
    Value::Object(m)
}

/// Register the usage-state answers plus any extra behavior onto the harness.
fn install_state(h: &mut Harness, store: Arc<Mutex<StateStore>>) {
    for op in ["begin", "readChunk", "stageChunk", "commit", "release"] {
        let method = format!("capability.usage.state.{op}");
        let store = store.clone();
        h.on_capability(&method.clone(), move |params| {
            let mut s = store.lock().unwrap();
            s.route(&method, &params).map_err(|(c, m)| (c, m))
        });
    }
}

fn cursor(aggregate: Value) -> Cursor {
    Cursor {
        size: 8,
        mtime: 2.0,
        inode: 3,
        offset: 8,
        aggregate,
        retained_since: None,
    }
}

#[tokio::test]
async fn cursor_hydration_honors_validator_and_dirty_identity() {
    let store = Arc::new(Mutex::new(StateStore::new(json!({
        "version": 4,
        "files": {
            "good": serde_json::to_value(cursor(json!({"valid": true}))).unwrap(),
            "bad": serde_json::to_value(cursor(json!({"valid": false}))).unwrap(),
        }
    }))));
    let p = drill_plugin();
    let mut h = Harness::start(p, Default::default()).await;
    install_state(&mut h, store.clone());
    let r = h
        .call("usage.drill", json!({"drill": "cursors-hydration"}))
        .await
        .unwrap();
    // Action sees only the valid cursor and returns 17.
    let value = r.get("value").and_then(Value::as_i64).unwrap();
    let keys = r.get("keys").and_then(Value::as_array).unwrap();
    assert_eq!(value, 17);
    assert_eq!(keys, &vec![json!("good")]);
    let s = store.lock().unwrap();
    // No change ⇒ commit dirty:false and no release (consumed by commit).
    assert_eq!(s.calls.iter().filter(|c| c.ends_with(".commit")).count(), 1);
    assert_eq!(
        s.calls.iter().filter(|c| c.ends_with(".release")).count(),
        0
    );
    assert_eq!(
        s.committed.as_ref().unwrap(),
        &json!({
            "version": 4,
            "files": {
                "good": serde_json::to_value(cursor(json!({"valid": true}))).unwrap()
            }
        })
    );
    h.close().await;
}

#[tokio::test]
async fn preserves_over_4mib_cursor_state_in_chunks() {
    let aggregate = json!({ "payload": "界".repeat(1500000) });
    let store = Arc::new(Mutex::new(StateStore::new(json!({
        "version": 4,
        "files": {
            "large": serde_json::to_value(Cursor {
                size: 1, mtime: 1.0, inode: 1, offset: 1,
                aggregate: aggregate.clone(), retained_since: None,
            }).unwrap()
        }
    }))));
    let p = drill_plugin();
    let mut h = Harness::start(p, Default::default()).await;
    install_state(&mut h, store.clone());
    h.call("usage.drill", json!({"drill": "cursors-large"}))
        .await
        .unwrap();
    let s = store.lock().unwrap();
    let committed = s.committed.as_ref().unwrap();
    assert_eq!(committed["files"]["large"]["aggregate"], aggregate);
    assert_eq!(
        s.calls
            .iter()
            .filter(|c| c.ends_with(".stageChunk"))
            .count()
            >= 16,
        true
    );
    // The replacement set a dirty marker.
    assert_eq!(s.calls.iter().filter(|c| c.ends_with(".commit")).count(), 1);
    h.close().await;
}

#[tokio::test]
async fn refresh_persistence_failure_keeps_stale_fallback() {
    let store = Arc::new(Mutex::new(StateStore::new(json!({
        "capturedAt": 100, "value": { "old": true }
    }))));
    store.lock().unwrap().fail_commit = true;
    let p = drill_plugin();
    let mut h = Harness::start(p, Default::default()).await;
    install_state(&mut h, store.clone());
    let r = h
        .call("usage.drill", json!({"drill": "cached-stale-fallback"}))
        .await
        .unwrap();
    let value = r.get("value").unwrap().clone();
    assert_eq!(value, json!({ "old": true }));
    assert_eq!(r.get("capturedAt").and_then(Value::as_f64), Some(100.0));
    assert_eq!(r.get("stale").and_then(Value::as_bool), Some(true));
    assert_eq!(
        r.get("error").and_then(Value::as_str),
        Some("disk unavailable")
    );

    // Backward clock: fetcher fails and now < capturedAt ⇒ fresh-offline, release.
    let store2 = Arc::new(Mutex::new(StateStore::new(json!({
        "capturedAt": 100, "value": { "old": true }
    }))));
    let p2 = drill_plugin();
    let mut h2 = Harness::start(p2, Default::default()).await;
    install_state(&mut h2, store2.clone());
    let r2 = h2
        .call("usage.drill", json!({"drill": "cached-backward-clock"}))
        .await
        .unwrap();
    assert_eq!(
        r2,
        json!({ "value": null, "capturedAt": null, "stale": false, "error": "offline" })
    );
    {
        let s2 = store2.lock().unwrap();
        assert_eq!(
            s2.calls.iter().filter(|c| c.ends_with(".release")).count(),
            1
        );
    }
    h.close().await;
    h2.close().await;
}

#[tokio::test]
async fn disappeared_ranged_files_and_incomplete_bytes() {
    // `range` with `{missing:true}` ⇒ ENOENT.
    let info = file_info("/fixture", 4, 4);
    let store = Arc::new(Mutex::new(StateStore::new(Value::Null)));
    let p = drill_plugin();
    let mut h = Harness::start(p, Default::default()).await;
    install_state(&mut h, store.clone());
    // `range` on a concurrently removed file ⇒ ENOENT.
    h.on_capability("capability.fs.readRange", move |_| {
        Ok(json!({ "missing": true }))
    });
    let r = h
        .call("usage.drill", json!({ "drill": "range-disappeared" }))
        .await
        .unwrap();
    assert_eq!(r["code"], "ENOENT");

    // Second part: a `ranged` read whose `readRange` returns 1 byte (of 4)
    // ⇒ "incomplete".
    let store2 = Arc::new(Mutex::new(StateStore::new(Value::Null)));
    let p2 = drill_plugin();
    let mut h2 = Harness::start(p2, Default::default()).await;
    install_state(&mut h2, store2.clone());
    let read_info = info.clone();
    h2.on_capability("capability.fs.read", move |_| {
        Ok(json!({ "ranged": read_info }))
    });
    let rr_info = info;
    h2.on_capability("capability.fs.readRange", move |_| {
        Ok(json!({ "base64": "eA==", "info": rr_info }))
    });
    let r2 = h2
        .call("usage.drill", json!({"drill": "range-incomplete"}))
        .await
        .unwrap();
    assert!(r2["message"].as_str().unwrap().contains("incomplete"));
    h.close().await;
    h2.close().await;
}
