#![allow(clippy::unwrap_used)]
use pacer_plugin::{
    Manifest, Plugin,
    testing::{Harness, HelloSpec},
};
use serde_json::json;

#[tokio::test]
async fn harness_answers_capabilities_and_records_progress() {
    let p = Plugin::new(Manifest(
        json!({"id":"u","version":"1.0.0","publisher":"t","host":"^1","contributes":{"usage":{}}}),
    ))
    .handle("usage.read", |_p, c| async move {
        c.progress.send(json!({"step":1}));
        let f = c
            .host
            .call("capability.fs.read", json!({"path":"$HOME/x"}))
            .await?;
        Ok(json!({"windows": [], "text": f["text"]}))
    });
    let mut h = Harness::start(
        p,
        HelloSpec {
            grants: vec!["fs.read".into()],
            ..Default::default()
        },
    )
    .await;
    h.on_capability("capability.fs.read", |_| Ok(json!({"text":"hi"})));
    let r = h.call("usage.read", json!({"account":"a"})).await.unwrap();
    assert_eq!(r["text"], "hi");
    assert_eq!(h.progress(), vec![json!({"step":1})]);
    assert_eq!(h.capability_calls()[0].0, "capability.fs.read");
    h.close().await;
}

#[tokio::test]
async fn unanswered_capabilities_are_denied() {
    let p = Plugin::new(Manifest(
        json!({"id":"u","version":"1.0.0","publisher":"t","host":"^1"}),
    ))
    .handle("diagnostic.ping", |_p, c| async move {
        Ok(json!({"err": c.host.call("capability.net.http", json!({})).await.unwrap_err().code}))
    });
    let mut h = Harness::start(p, HelloSpec::default()).await;
    assert_eq!(
        h.call("diagnostic.ping", json!({})).await.unwrap()["err"],
        "capability_denied"
    );
    h.close().await;
}

/// The SDK must echo `_meta.capabilityCall` on capability requests made while serving a call.
/// Without that echo the real host refuses every scoped capability (assistant.tool, fs.read, …).
#[tokio::test]
async fn scoped_capability_calls_echo_the_owning_call_token() {
    let p = Plugin::new(Manifest(
        json!({"id":"a","version":"1.0.0","publisher":"t","host":">=1.11.0"}),
    ))
    .handle("assistant.reply", |_p, c| async move {
        let out = c
            .host
            .call(
                "capability.assistant.tool",
                json!({"turnId":"t1","name":"snapshot","params":{}}),
            )
            .await?;
        Ok(out)
    });
    let mut h = Harness::start(
        p,
        HelloSpec {
            grants: vec!["assistant.tool".into()],
            ..Default::default()
        },
    )
    .await;
    h.on_capability("capability.assistant.tool", |_| {
        Ok(json!({"name":"snapshot","content":"ok","ok":true}))
    });
    let r = h
        .call("assistant.reply", json!({"message":"hi"}))
        .await
        .unwrap();
    assert_eq!(r["content"], "ok");
    let meta = h
        .capability_calls_with_meta()
        .into_iter()
        .find(|(m, _, _)| m == "capability.assistant.tool")
        .and_then(|(_, _, meta)| meta);
    let token = meta
        .as_ref()
        .and_then(|m| m.get("capabilityCall"))
        .and_then(|v| v.as_str());
    assert!(
        token.is_some_and(|t| t.starts_with("harness-")),
        "expected echoed capabilityCall, got {meta:?}"
    );
    h.close().await;
}
