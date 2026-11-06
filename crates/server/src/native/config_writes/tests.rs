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
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
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
async fn host_add_missing_endpoint_bridge_refuses_before_write() {
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
        registry.get("host.add").unwrap(),
        json!({"alias":"box","ssh":"box-ssh"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::Unavailable);
    assert!(!dir.path().join("strategy.yaml").exists());
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
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::Unavailable);
    assert!(!dir.path().join("strategy.yaml").exists());
}

#[test]
fn empty_xdg_config_home_uses_relative_orca_directory_on_linux() {
    let ctx = Ctx::with(
        "/fixture".into(),
        "/fixture".into(),
        [("XDG_CONFIG_HOME".into(), "".into())].into(),
        0.0,
    );
    assert_eq!(
        super::legacy_dir_for_platform(&ctx, false),
        std::path::PathBuf::from("orca/plugins-data/lamtuanvu.pacer")
    );
}

#[tokio::test]
async fn strategy_list_and_show_read_named_files_without_publishing() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let yaml = "# A work plan\nplanner: codex\nproviders:\n  codex: {}\n";
    std::fs::write(home.join("strategy.yaml"), yaml).unwrap();
    std::fs::create_dir(home.join("strategies")).unwrap();
    std::fs::write(home.join("strategies/work.yaml"), yaml).unwrap();
    std::fs::write(home.join("strategies/broken.yaml"), "planner: [oops\n").unwrap();
    let ctx = Ctx::with(home.into(), home.into(), Default::default(), 0.0);
    let registry = crate::native::registry("");
    let list = crate::native::call_native(
        &ctx,
        registry.get("strategy.list").unwrap(),
        json!({}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(list[0]["name"], "default");
    assert_eq!(list[0]["active"], true);
    assert_eq!(
        list[1],
        json!({"name":"broken","active":false,"summary":"Invalid or missing strategy","description":""})
    );
    assert_eq!(list[2]["name"], "work");
    assert_eq!(list[2]["description"], "A work plan");
    assert_eq!(list[2]["active"], false);
    let show = crate::native::call_native(
        &ctx,
        registry.get("strategy.show").unwrap(),
        json!({"name":"work"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(show["yaml"], yaml);
    assert_eq!(show["active"], false);
    assert!(show["summary"].as_str().unwrap().contains("Codex"));
    let missing = crate::native::call_native(
        &ctx,
        registry.get("strategy.show").unwrap(),
        json!({"name":"missing"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(missing.code, Code::InvalidInput);
    assert_eq!(missing.message, "unknown strategy \"missing\"");
    assert_eq!(
        missing.hint.as_deref(),
        Some("Use strategy.list to choose a strategy and strategy.preview to validate a draft.")
    );
    assert!(!home.join("link/outbox.jsonl").exists());
}

#[test]
fn planner_and_backend_keys_stay_on_the_forward_path() {
    assert!(super::config_set_stays_forwarded(
        &json!({"key":"planner","value":"codex"})
    ));
    assert!(super::config_set_stays_forwarded(
        &json!({"key":"execution.backend","value":"orca"})
    ));
    assert!(!super::config_set_stays_forwarded(
        &json!({"key":"update_check","value":false})
    ));
}

#[tokio::test]
async fn pure_config_set_writes_publishes_and_strips_notes() {
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
    let result = crate::native::call_native(
        &ctx,
        registry.get("config.set").unwrap(),
        json!({"key":"update_check","value":false}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(result["key"], "update_check");
    assert_eq!(result["value"], false);
    assert!(result.get("notes").is_none());
    assert!(dir.path().join("link/outbox.jsonl").exists());
    let error = crate::native::call_native(
        &ctx,
        registry.get("config.set").unwrap(),
        json!({"key":"planner","value":"codex","integrations":"skip"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::Unavailable);
}

#[tokio::test]
async fn runner_settings_get_and_save_publish_runners_without_endpoint_bridge() {
    let dir = tempfile::tempdir().unwrap();
    let yaml = "# keep\nplanner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nrunners:\n  codex: {}\nrouting:\n  - kinds: [docs]\n    executors: [codex]\n  - default: [codex]\n";
    std::fs::write(dir.path().join("strategy.yaml"), yaml).unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        1_700_000_000.0,
    );
    let registry = crate::native::registry("");
    let base = crate::native::call_native(
        &ctx,
        registry.get("runner.settings.get").unwrap(),
        json!({}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert!(!dir.path().join("link/outbox.jsonl").exists());
    assert_eq!(base["order"], json!(["codex"]));

    let saved = crate::native::call_native(
        &ctx,
        registry.get("runner.settings.save").unwrap(),
        json!({
            "expectedRevision": base["revision"],
            "order": base["order"],
            "runners": [{"id": "codex", "enabled": false, "maxTasks": 3}],
        }),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_ne!(saved["revision"], base["revision"]);
    assert_eq!(saved["runners"][0]["enabled"], false);
    assert_eq!(saved["runners"][0]["maxTasks"], 3);
    assert_eq!(saved["warnings"].as_array().unwrap().len(), 2);
    assert!(dir.path().join("link/outbox.jsonl").exists());
    let outbox = std::fs::read_to_string(dir.path().join("link/outbox.jsonl")).unwrap();
    assert!(outbox.contains("\"area\":\"runners\""));

    let conflict = crate::native::call_native(
        &ctx,
        registry.get("runner.settings.save").unwrap(),
        json!({
            "expectedRevision": base["revision"],
            "order": base["order"],
            "runners": [{"id": "codex", "enabled": true, "maxTasks": 1}],
        }),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(conflict.code, Code::Conflict);
    assert_eq!(conflict.message, "Executor settings changed elsewhere.");
    assert_eq!(
        conflict.hint.as_deref(),
        Some("Reload saved settings, then reapply your changes.")
    );
}

#[tokio::test]
async fn cookie_presets_flag_rejects_custom_terminal_open_templates() {
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
    let mut env = std::collections::HashMap::new();
    env.insert("PACER_TERMINAL_PRESETS_ONLY".into(), "1".into());
    let ctx = Ctx::with(dir.path().into(), dir.path().into(), env, 0.0);
    let registry = crate::native::registry("");
    let error = crate::native::call_native(
        &ctx,
        registry.get("config.set").unwrap(),
        json!({"key":"terminal.open","value":"custom-{cmd}"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    assert!(error.message.contains("preset"));
}
