#![allow(clippy::unwrap_used)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use serde_json::{Value, json};

#[tokio::test]
async fn failed_endpoint_sync_keeps_saved_edit_but_does_not_publish_success() {
    let dir = tempfile::tempdir().unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/config-writes-goldens.json"
    ))
    .unwrap();
    std::fs::write(
        dir.path().join("strategy.yaml"),
        fixture["initial"].as_str().unwrap(),
    )
    .unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        1_700_000_000.0,
    );
    let registry = crate::native::registry("");
    let op = registry.get("runner.remove").unwrap();
    let error = crate::native::call_native(
        &ctx,
        op,
        json!({"id":"cursor"}),
        None,
        Some(Box::pin(async {
            Err(CoreError::new(Code::PluginRefused, "fixture refused"))
        })),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::PluginRefused);
    assert_eq!(
        error.hint.as_deref(),
        Some("Check the runner id, account and host configuration.")
    );
    assert!(!dir.path().join("link/outbox.jsonl").exists());
    let strategy = pacer_config::strategy::load_strategy(dir.path()).unwrap();
    assert!(strategy["runners"].get("cursor").is_none());
}

#[tokio::test]
async fn missing_bridge_refuses_before_mutating_the_document() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        0.0,
    );
    let registry = crate::native::registry("");
    let error = crate::native::call_native(
        &ctx,
        registry.get("runner.set").unwrap(),
        json!({"id":"codex","rank":1}),
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::Unavailable);
    assert!(!dir.path().join("strategy.yaml").exists());
}
