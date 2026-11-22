//! Wire-parity tests: the Rust SDK reproduces `@pacer/plugin`'s hello feature
//! negotiation, chunked result transfer, owning-call cancellation, secrets
//! presence, and error-reason gating.

#![allow(clippy::unwrap_used)]
use pacer_plugin::{
    Manifest, Plugin, PluginError,
    testing::{Harness, HelloSpec},
};
use serde_json::{Value, json};
use std::time::Duration;

fn plugin(id: &str, methods: &[&str]) -> pacer_plugin::Plugin {
    let mut p = Plugin::new(Manifest(
        json!({"id": id, "version": "1.0.0", "publisher": "t", "host": ">=1.11.0"}),
    ));
    for m in methods {
        p = p.handle(m, |_, _| async move { Ok(json!({})) });
    }
    p
}

fn big_result() -> Value {
    json!({ "payload": "x".repeat(800 * 1024) })
}

#[tokio::test]
async fn negotiates_features_gated_by_protocol_version() {
    let p = Plugin::new(Manifest(
        json!({"id":"f","version":"1.0.0","publisher":"t","host":">=1.3.0"}),
    ))
    .features(vec!["chunkedResults", "policyObservations"]);
    let h = Harness::start(
        p,
        HelloSpec {
            features: vec!["chunkedResults".into(), "policyObservations".into()],
            protocol: "1.3.0".into(),
            ..HelloSpec::default()
        },
    )
    .await;
    let hello = h.hello_result().unwrap();
    // chunkedResults only needs protocol >= 1.1; policyObservations needs >= 1.6.
    assert_eq!(hello["features"], json!(["chunkedResults"]));
    h.close().await;
}

#[tokio::test]
async fn hello_omits_features_when_none_negotiated() {
    let p = plugin("o", &[]);
    let h = Harness::start(
        p,
        HelloSpec {
            features: vec!["chunkedResults".into()],
            ..HelloSpec::default()
        },
    )
    .await;
    assert!(h.hello_result().unwrap().get("features").is_none());
    h.close().await;
}

#[tokio::test]
async fn chunks_large_usage_results() {
    let big = big_result();
    let total = serde_json::to_vec(&big).unwrap().len();
    let p = Plugin::new(Manifest(
        json!({"id":"u","version":"1.0.0","publisher":"t","host":">=1.11.0"}),
    ))
    .handle("usage.read", move |_, _| {
        let big = big.clone();
        async move { Ok(big) }
    });
    let mut h = Harness::start(
        p,
        HelloSpec {
            features: vec!["chunkedResults".into()],
            ..HelloSpec::default()
        },
    )
    .await;
    let r = h
        .call_unowned("usage.read", json!({"account":"a"}))
        .await
        .unwrap();
    // Plugin replies only with the chunked envelope once every chunk is acked.
    assert_eq!(r["_chunkedResult"]["bytes"], json!(total));
    let chunks = h.raw_results();
    assert!(
        chunks.len() >= 4,
        "expected multiple chunks, got {:?}",
        chunks.len()
    );
    let mut offset = 0usize;
    for c in &chunks {
        let off = c["offset"].as_u64().unwrap() as usize;
        assert_eq!(off, offset, "chunks must be contiguous");
        let base64 = c["base64"].as_str().unwrap();
        let len = pacer_plugin::js::base64::decode_lenient(base64).len();
        assert!(len <= 262_144);
        offset += len;
    }
    assert_eq!(offset, total);
    h.close().await;
}

#[tokio::test]
async fn cancelling_owning_call_aborts_capability_calls() {
    let mut p = Plugin::new(Manifest(json!(
        {"id":"c","version":"1.0.0","publisher":"t","host":">=1.11.0"}
    )));
    p = p.handle("usage.read", |_, c| async move {
        // Deterministic: wait for the owning call's cancellation to propagate,
        // then confirm a capability call made by this owner is rejected.
        let reached = tokio::time::timeout(Duration::from_millis(800), c.cancel.cancelled())
            .await
            .is_ok();
        assert!(
            reached,
            "owning call cancellation should propagate to the handler"
        );
        let err = c
            .host
            .call("capability.fs.read", json!({"path":"$HOME/x"}))
            .await
            .unwrap_err();
        c.progress
            .send(json!({"code": err.code, "msg": err.message}));
        Ok(json!({}))
    });
    let mut h = Harness::start(p, HelloSpec::default()).await;
    h.on_capability("capability.fs.read", |_| Ok(json!({"text":"hi"})));
    let id = h.start_call("usage.read", json!({})).unwrap();
    h.cancel(&id);
    for _ in 0..200 {
        if !h.progress().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let p = h.progress();
    assert_eq!(p.first().unwrap()["code"], "plugin_unavailable");
    assert_eq!(p.first().unwrap()["msg"], "owning plugin call ended");
    h.close().await;
}

#[tokio::test]
async fn secrets_present_queries_the_host() {
    let p = Plugin::new(Manifest(
        json!({"id":"s","version":"1.0.0","publisher":"t","host":">=1.11.0"}),
    ))
    .handle("serve", |_, c| async move {
        let present = c.host.secrets_present("ref1").await?;
        Ok(json!({"present": present}))
    });
    let mut h = Harness::start(p, HelloSpec::default()).await;
    h.on_capability("capability.secrets.check", |p| {
        assert_eq!(p["ref"], "ref1");
        Ok(json!({"present": true}))
    });
    let r = h.call("serve", json!({})).await.unwrap();
    assert_eq!(r["present"], true);
    h.close().await;
}

#[tokio::test]
async fn reason_is_only_carried_for_credential_reflection() {
    let denied = |_| {
        Err(PluginError::new("capability_denied", "refused").with_reason("credential_reflection"))
    };
    let p = plugin("r1", &["run"]).handle("run", move |_, _| async move { denied(()) });
    let mut h = Harness::start(p, HelloSpec::default()).await;
    let err = h.call("run", json!({})).await.unwrap_err();
    assert_eq!(err.reason.as_deref(), Some("credential_reflection"));
    h.close().await;

    let other = Plugin::new(Manifest(
        json!({"id":"r2","version":"1.0.0","publisher":"t","host":">=1.11.0"}),
    ))
    .handle("run", move |_, _| async move {
        Err(PluginError::new("capability_denied", "refused").with_reason("other"))
    });
    let mut h2 = Harness::start(other, HelloSpec::default()).await;
    let err2 = h2.call("run", json!({})).await.unwrap_err();
    assert_eq!(err2.reason, None);
    h2.close().await;
}

#[tokio::test]
async fn cleanup_call_ignores_owning_cancellation() {
    let p = Plugin::new(Manifest(
        json!({"id":"cl","version":"1.0.0","publisher":"t","host":">=1.11.0"}),
    ))
    .handle("usage.read", |_, c| async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let out = c
            .host
            .call_cleanup("capability.fs.write", json!({"path":"x","data":"y"}))
            .await;
        c.progress.send(json!({"ok": out.is_ok()}));
        Ok(json!({}))
    });
    let mut h = Harness::start(p, HelloSpec::default()).await;
    h.on_capability("capability.fs.write", |_| Ok(json!({"ok": true})));
    let id = h.start_call("usage.read", json!({})).unwrap();
    h.cancel(&id);
    for _ in 0..200 {
        if !h.progress().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(h.progress().first().unwrap()["ok"], true);
    h.close().await;
}

#[tokio::test]
async fn unowned_call_lacks_an_owning_token() {
    let p = Plugin::new(Manifest(
        json!({"id":"un","version":"1.0.0","publisher":"t","host":">=1.11.0"}),
    ))
    .handle("ping", |_, c| async move {
        let err = c
            .host
            .call("capability.fs.read", json!({}))
            .await
            .unwrap_err();
        Ok(json!({"code": err.code}))
    });
    let mut h = Harness::start(p, HelloSpec::default()).await;
    h.on_capability("capability.fs.read", |_| Ok(json!({"text":"hi"})));
    let r = h.call_unowned("ping", json!({})).await.unwrap();
    // No active owning token was issued for an unowned request.
    assert_eq!(r["code"], "capability_denied");
    h.close().await;
}

#[tokio::test]
async fn serves_numeric_id_requests() {
    let p = plugin("n", &["ping"]).handle("ping", |_, _| async move { Ok(json!({"ok": true})) });
    let mut h = Harness::start(p, HelloSpec::default()).await;
    let r = h.call("ping", json!({})).await.unwrap();
    assert_eq!(r["ok"], true);
    h.close().await;
}
