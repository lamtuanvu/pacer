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
