//! Wire-parity tests: the Rust SDK reproduces `@pacer/plugin`'s hello feature
//! negotiation, chunked result transfer, owning-call cancellation, secrets
//! presence, and error-reason gating. Every test carries the `packages/
//! plugin-sdk/src/index.ts` line it matches.

#![allow(clippy::unwrap_used)]
use pacer_plugin::{
    FEATURE_CHUNKED_RESULTS, FEATURE_FILE_WRITE_CHUNKS, FEATURE_HTTP_BODY_CHUNKS,
    FEATURE_PLANNER_INSTALL_TRANSACTIONS, FEATURE_POLICY_OBSERVATIONS,
    FEATURE_POLICY_REDACTION_METADATA, Manifest, Plugin, PluginError, TS_SDK_FEATURES,
    testing::{Harness, HelloSpec, HostError},
};
use serde_json::{Value, json};
use std::time::Duration;

const ALL_SIX: [&str; 6] = [
    FEATURE_CHUNKED_RESULTS,
    FEATURE_HTTP_BODY_CHUNKS,
    FEATURE_FILE_WRITE_CHUNKS,
    FEATURE_PLANNER_INSTALL_TRANSACTIONS,
    FEATURE_POLICY_OBSERVATIONS,
    FEATURE_POLICY_REDACTION_METADATA,
];

fn manifest(id: &str) -> Manifest {
    Manifest(json!({"id": id, "version": "1.0.0", "publisher": "t", "host": ">=1.11.0"}))
}

fn plugin(id: &str) -> Plugin {
    Plugin::new(manifest(id))
}

/// Wait until `pred` holds or ~2 s elapse; panics otherwise.
async fn wait_for(pred: impl Fn() -> bool) {
    for _ in 0..400 {
        if pred() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition not met within timeout");
}

fn big() -> Value {
    json!({ "text": "x".repeat(800_000) })
}

// ---------------------------------------------------------------------------
// 1. Feature negotiation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn hello_negotiates_accepted_offered_features_in_offer_order() {
    // TS: packages/plugin-sdk/src/index.ts:281-289
    let p = plugin("a").features(TS_SDK_FEATURES.to_vec());
    let h = Harness::start(
        p,
        HelloSpec {
            protocol: "1.11.0".into(),
            features: vec![
                "bogus".into(),
                FEATURE_POLICY_OBSERVATIONS.into(),
                FEATURE_CHUNKED_RESULTS.into(),
                FEATURE_HTTP_BODY_CHUNKS.into(),
                FEATURE_FILE_WRITE_CHUNKS.into(),
                FEATURE_PLANNER_INSTALL_TRANSACTIONS.into(),
                FEATURE_POLICY_REDACTION_METADATA.into(),
            ],
            ..HelloSpec::default()
        },
    )
    .await;
    // The offer minus "bogus", kept in offer order.
    assert_eq!(
        h.hello_result().unwrap()["features"],
        json!([
            FEATURE_POLICY_OBSERVATIONS,
            FEATURE_CHUNKED_RESULTS,
            FEATURE_HTTP_BODY_CHUNKS,
            FEATURE_FILE_WRITE_CHUNKS,
            FEATURE_PLANNER_INSTALL_TRANSACTIONS,
            FEATURE_POLICY_REDACTION_METADATA
        ])
    );
    h.close().await;
}

async fn gate_case(protocol: &str, expected: Option<Vec<&str>>) {
    let p = plugin("g").features(ALL_SIX.to_vec());
    let h = Harness::start(
        p,
        HelloSpec {
            protocol: protocol.into(),
            features: ALL_SIX.iter().map(|f| (*f).to_string()).collect(),
            ..HelloSpec::default()
        },
    )
    .await;
    let hello = h.hello_result().unwrap();
    match expected {
        Some(feats) => assert_eq!(hello["features"], json!(feats)),
        None => assert!(hello.get("features").is_none()),
    }
    h.close().await;
}

#[tokio::test]
async fn hello_gates_features_by_protocol_minor() {
    // TS: packages/plugin-sdk/src/index.ts:281-287
    gate_case(
        "1.3.0",
        Some(vec![FEATURE_CHUNKED_RESULTS, FEATURE_HTTP_BODY_CHUNKS]),
    )
    .await;
    gate_case(
        "1.5.0",
        Some(vec![
            FEATURE_CHUNKED_RESULTS,
            FEATURE_HTTP_BODY_CHUNKS,
            FEATURE_FILE_WRITE_CHUNKS,
            FEATURE_PLANNER_INSTALL_TRANSACTIONS,
        ]),
    )
    .await;
    gate_case(
        "1.7.0",
        Some(vec![
            FEATURE_CHUNKED_RESULTS,
            FEATURE_HTTP_BODY_CHUNKS,
            FEATURE_FILE_WRITE_CHUNKS,
            FEATURE_PLANNER_INSTALL_TRANSACTIONS,
            FEATURE_POLICY_OBSERVATIONS,
        ]),
    )
    .await;
    gate_case("2.0.0", None).await;
}

#[tokio::test]
async fn plugin_without_features_omits_the_key() {
    // TS: packages/plugin-sdk/src/index.ts:289 (`...(features.length ? { features } : {})`)
    let p = plugin("n");
    let h = Harness::start(
        p,
        HelloSpec {
            features: ALL_SIX.iter().map(|f| (*f).to_string()).collect(),
            ..HelloSpec::default()
        },
    )
    .await;
    assert!(h.hello_result().unwrap().get("features").is_none());
    h.close().await;
}

// ---------------------------------------------------------------------------
// 2. Chunked results
// ---------------------------------------------------------------------------

fn usage_plugin() -> Plugin {
    let value = big();
    plugin("u").handle("usage.read", move |_, _| {
        let value = value.clone();
        async move { Ok(value) }
    })
}

#[tokio::test]
async fn usage_read_result_over_768_kib_is_sent_in_chunks() {
    // TS: packages/plugin-sdk/src/index.ts:314-325
    let mut h = Harness::start(
        usage_plugin(),
        HelloSpec {
            features: vec![FEATURE_CHUNKED_RESULTS.into()],
            ..HelloSpec::default()
        },
    )
    .await;
    let original = big();
    let returned = h
        .call("usage.read", json!({ "account": "a" }))
        .await
        .unwrap();
    // `call` reassembles the original value from the chunks.
    assert_eq!(returned, original);
    let chunks = h.raw_results();
    let offsets: Vec<u64> = chunks
        .iter()
        .map(|c| c["offset"].as_u64().unwrap())
        .collect();
    assert_eq!(offsets, vec![0, 262144, 524288, 786432]);
    for c in &chunks {
        assert!(c.get("request").is_some(), "chunk must echo the request id");
        assert!(c.get("base64").and_then(Value::as_str).is_some());
    }
    // The final envelope reports the full byte length.
    let replies = h.replies();
    let final_reply = replies.last().unwrap();
    assert_eq!(
        final_reply["result"]["_chunkedResult"]["bytes"],
        json!(800_011)
    );
    h.close().await;
}

#[tokio::test]
async fn small_usage_result_is_not_chunked() {
    // TS: packages/plugin-sdk/src/index.ts:317 (`bytes.length > 768 * 1024`)
    let p = plugin("s").handle("usage.read", |_, _| async move { Ok(json!({"ok": true})) });
    let mut h = Harness::start(
        p,
        HelloSpec {
            features: vec![FEATURE_CHUNKED_RESULTS.into()],
            ..HelloSpec::default()
        },
    )
    .await;
    let r = h.call("usage.read", json!({})).await.unwrap();
    assert_eq!(r, json!({"ok": true}));
    assert!(h.raw_results().is_empty());
    h.close().await;
}

#[tokio::test]
async fn other_methods_are_never_chunked() {
    // TS: packages/plugin-sdk/src/index.ts:314 (only usage.read and planner.*)
    let value = big();
    let p = plugin("d").handle("notifier.deliver", move |_, _| {
        let value = value.clone();
        async move { Ok(value) }
    });
    let mut h = Harness::start(
        p,
        HelloSpec {
            features: vec![FEATURE_CHUNKED_RESULTS.into()],
            ..HelloSpec::default()
        },
    )
    .await;
    let r = h.call("notifier.deliver", json!({})).await.unwrap();
    assert_eq!(r, big());
    assert!(h.raw_results().is_empty());
    h.close().await;
}

#[tokio::test]
async fn planner_install_chunks_only_with_planner_transactions() {
    // TS: packages/plugin-sdk/src/index.ts:314 (`&& negotiatedFeatures.has("plannerInstallTransactions")`)

    // plannerInstallTransactions offered and accepted → chunked.
    let value = big();
    let chunked_p = plugin("pl")
        .features(vec![
            FEATURE_PLANNER_INSTALL_TRANSACTIONS,
            FEATURE_CHUNKED_RESULTS,
        ])
        .handle("planner.install", move |_, _| {
            let value = value.clone();
            async move { Ok(value) }
        });
    let mut chunked = Harness::start(
        chunked_p,
        HelloSpec {
            features: vec![
                FEATURE_PLANNER_INSTALL_TRANSACTIONS.into(),
                FEATURE_CHUNKED_RESULTS.into(),
            ],
            ..HelloSpec::default()
        },
    )
    .await;
    let r = chunked.call("planner.install", json!({})).await.unwrap();
    assert_eq!(r, big());
    assert!(!chunked.raw_results().is_empty());
    chunked.close().await;

    // Without plannerInstallTransactions the same result is a plain reply.
    let value = big();
    let plain_p = plugin("pl").features(vec![FEATURE_CHUNKED_RESULTS]).handle(
        "planner.install",
        move |_, _| {
            let value = value.clone();
            async move { Ok(value) }
        },
    );
    let mut plain = Harness::start(
        plain_p,
        HelloSpec {
            features: vec![FEATURE_CHUNKED_RESULTS.into()],
            ..HelloSpec::default()
        },
    )
    .await;
    let r = plain.call("planner.install", json!({})).await.unwrap();
    assert_eq!(r, big());
    assert!(plain.raw_results().is_empty());
    plain.close().await;
}

#[tokio::test]
async fn chunk_ack_mismatch_fails_plugin_refused() {
    // TS: packages/plugin-sdk/src/index.ts:322 (`ack.bytes !== offset + part.length`)
    let mut h = Harness::start(
        usage_plugin(),
        HelloSpec {
            features: vec![FEATURE_CHUNKED_RESULTS.into()],
            ..HelloSpec::default()
        },
    )
    .await;
    h.on_capability("$/resultChunk", |_| Ok(json!({ "bytes": 1 })));
    let err = h.call("usage.read", json!({})).await.unwrap_err();
    assert_eq!(err.code, "plugin_refused");
    assert_eq!(err.message, "incomplete result chunk acknowledgement");
    h.close().await;
}

#[tokio::test]
async fn chunking_requires_the_offer_in_hello() {
    // TS: packages/plugin-sdk/src/index.ts:291-292 (reads hello.features)
    let mut h = Harness::start(usage_plugin(), HelloSpec::default()).await;
    let r = h.call("usage.read", json!({})).await.unwrap();
    assert_eq!(r, big());
    assert!(h.raw_results().is_empty());
    h.close().await;
}

// ---------------------------------------------------------------------------
// 3. Cancellation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn call_after_cancel_rejects_without_sending() {
    // TS: packages/plugin-sdk/src/index.ts:145 (cleanup === false → reject on abort)
    let p = plugin("ca").handle("observe", |_, c| async move {
        let _ = c.cancel.cancelled().await;
        let r = c
            .host
            .call("capability.log", json!({"level": "info", "message": "x"}))
            .await;
        let e = r.err().unwrap();
        c.progress.send(json!({"code": e.code, "msg": e.message}));
        Ok(json!({}))
    });
    let mut h = Harness::start(p, HelloSpec::default()).await;
    let id = h.start_call("observe", json!({})).unwrap();
    // Let the handler park on cancellation, then cancel the owning call.
    tokio::time::sleep(Duration::from_millis(20)).await;
    h.cancel(&id);
    wait_for(|| !h.progress().is_empty()).await;
    let p = h.progress();
    assert_eq!(p.last().unwrap()["code"], "plugin_unavailable");
    assert_eq!(p.last().unwrap()["msg"], "owning plugin call ended");
    // No capability request was sent after the owning call was cancelled.
    assert!(h.capability_calls().is_empty());
    h.close().await;
}

#[tokio::test]
async fn pending_call_rejects_when_owning_call_is_cancelled() {
    // TS: packages/plugin-sdk/src/index.ts:131-158 (abort rejects the pending call)
    let p = plugin("pd").handle("observe", |_, c| async move {
        let r = c.host.config().await;
        let e = r.err().unwrap();
        c.progress.send(json!({"code": e.code, "msg": e.message}));
        Ok(json!({}))
    });
    let mut h = Harness::start(p, HelloSpec::default()).await;
    h.on_capability_async("capability.config.get", |_| async {
        std::future::pending().await
    });
    let id = h.start_call("observe", json!({})).unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    h.cancel(&id);
    wait_for(|| !h.progress().is_empty()).await;
    let p = h.progress();
    assert_eq!(p.last().unwrap()["code"], "plugin_unavailable");
    assert_eq!(p.last().unwrap()["msg"], "owning plugin call ended");
    h.close().await;
}

#[tokio::test]
async fn scoped_result_after_cancel_becomes_plugin_unavailable() {
    // TS: packages/plugin-sdk/src/index.ts:311-313 (scoped + aborted → plugin_unavailable)
    let p = plugin("sc").handle("usage.read", |_, _| async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        Ok(json!({"ok": true}))
    });
    let mut h = Harness::start(p, HelloSpec::default()).await;
    let id = h.start_call("usage.read", json!({})).unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    h.cancel(&id);
    wait_for(|| !h.replies().is_empty()).await;
    let replies = h.replies();
    let reply = replies.last().unwrap();
    assert!(!reply["ok"].as_bool().unwrap());
    assert_eq!(reply["error"]["code"], "plugin_unavailable");
    assert_eq!(reply["error"]["message"], "owning plugin call ended");
    h.close().await;
}

#[tokio::test]
async fn unowned_call_result_after_cancel_is_returned() {
    // TS: packages/plugin-sdk/src/index.ts:311-313 (unscoped, unowned → returned)
    let p = plugin("un").handle("backup", |_, _| async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        Ok(json!({"ok": true}))
    });
    let mut h = Harness::start(p, HelloSpec::default()).await;
    let id = h.start_call_unowned("backup", json!({})).unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    h.cancel(&id);
    wait_for(|| !h.replies().is_empty()).await;
    let replies = h.replies();
    let reply = replies.last().unwrap();
    assert!(reply["ok"].as_bool().unwrap());
    assert_eq!(reply["result"], json!({"ok": true}));
    h.close().await;
}

// ---------------------------------------------------------------------------
// 4. Error data
// ---------------------------------------------------------------------------

#[tokio::test]
async fn host_error_reason_reaches_the_plugin() {
    // TS: packages/plugin-sdk/src/index.ts:337-341 (reason gate)
    async fn denied_reason(code: &str) -> Option<String> {
        let p = plugin("he").handle("check", |_, c| async move {
            let r = c.host.call("capability.config.get", json!({})).await;
            Ok(json!({ "reason": r.err().and_then(|e| e.reason) }))
        });
        let mut h = Harness::start(p, HelloSpec::default()).await;
        let code = code.to_owned();
        h.on_capability_async("capability.config.get", move |_| {
            let code = code.clone();
            async move { Err(HostError::new(code, "x").with_reason("credential_reflection")) }
        });
        let out = h.call("check", json!({})).await.unwrap();
        let reason = out.get("reason").and_then(Value::as_str).map(str::to_owned);
        h.close().await;
        reason
    }
    assert_eq!(
        denied_reason("capability_denied").await.as_deref(),
        Some("credential_reflection")
    );
    assert_eq!(denied_reason("invalid_input").await, None);
}

#[tokio::test]
async fn plugin_error_data_carries_hint_and_kept_reason() {
    // TS: packages/plugin-sdk/src/index.ts:235-240 and :62-65
    async fn wire_error(code: &str) -> Value {
        let label = code.to_owned();
        let p = plugin("pe").handle("act", move |_, _| {
            let code = label.clone();
            async move {
                Err(PluginError::new(code, "m")
                    .with_hint("h")
                    .with_reason("credential_reflection"))
            }
        });
        let mut h = Harness::start(p, HelloSpec::default()).await;
        let _ = h.call("act", json!({})).await;
        let replies = h.replies();
        let error = replies
            .last()
            .unwrap()
            .get("error")
            .cloned()
            .unwrap_or(Value::Null);
        h.close().await;
        error
    }
    let err = wire_error("capability_denied").await;
    assert_eq!(err["code"], "capability_denied");
    assert_eq!(err["hint"], "h");
    assert_eq!(err["reason"], "credential_reflection");
    // `not_allowed` keeps the hint but drops the reason.
    let err = wire_error("not_allowed").await;
    assert_eq!(err["code"], "not_allowed");
    assert_eq!(err["hint"], "h");
    assert!(err.get("reason").is_none());
}

#[tokio::test]
async fn secrets_present_reads_capability_secrets_check() {
    // TS: packages/plugin-sdk/src/index.ts:222 (capability.secrets.check)
    let p = plugin("sp").handle("serve", |_, c| async move {
        let present = c.host.secrets_present("secrets:K").await?;
        Ok(json!({"present": present}))
    });
    let mut h = Harness::start(p, HelloSpec::default()).await;
    h.on_capability("capability.secrets.check", |p| {
        assert_eq!(p["ref"], "secrets:K");
        Ok(json!({"present": true}))
    });
    let r = h.call("serve", json!({})).await.unwrap();
    assert_eq!(r["present"], true);
    // The scoped check carried the owning `_meta`.
    let (_, _, meta) = h.capability_calls_with_meta().pop().unwrap();
    let Some(meta) = meta else {
        panic!("owning call must carry _meta");
    };
    assert!(meta.get("capabilityCall").and_then(Value::as_str).is_some());
    h.close().await;
}
