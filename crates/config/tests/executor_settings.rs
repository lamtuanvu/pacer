#![allow(clippy::unwrap_used)]
use pacer_config::executor_settings::{read_executor_settings, save_executor_settings};
use serde_json::json;
use std::fs;

fn home_with(strategy: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("strategy.yaml"), strategy).unwrap();
    dir
}

#[test]
fn batch_save_is_atomic_and_preserves_comments() {
    let home = home_with(
        "# keep runner\nplanner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nrunners:\n  codex: {}\nrouting:\n  - kinds: [docs]\n    executors: [codex]\n  - default: [codex]\n",
    );
    let base = read_executor_settings(home.path()).unwrap();
    let result = save_executor_settings(
        home.path(),
        &json!({
            "expectedRevision": base["revision"],
            "order": base["order"],
            "runners": base["runners"].as_array().unwrap().iter().map(|r| {
                json!({"id": r["id"], "enabled": false, "maxTasks": 3})
            }).collect::<Vec<_>>(),
        }),
    )
    .unwrap();
    assert_ne!(result["revision"], base["revision"]);
    let text = fs::read_to_string(home.path().join("strategy.yaml")).unwrap();
    assert!(text.contains("# keep runner"));
    assert!(text.contains("enabled: false"));
    assert!(text.contains("max_tasks: 3"));
    assert_eq!(result["warnings"].as_array().unwrap().len(), 2);
}

#[test]
fn invalid_capacity_and_stale_revision_refuse() {
    let home = home_with(
        "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nrunners:\n  codex: {}\n",
    );
    let base = read_executor_settings(home.path()).unwrap();
    let before = fs::read_to_string(home.path().join("strategy.yaml")).unwrap();
    for max_tasks in [0, 17] {
        assert!(
            save_executor_settings(
                home.path(),
                &json!({
                    "expectedRevision": base["revision"],
                    "order": base["order"],
                    "runners": [{"id": "codex", "enabled": true, "maxTasks": max_tasks}],
                }),
            )
            .is_err()
        );
    }
    assert_eq!(
        fs::read_to_string(home.path().join("strategy.yaml")).unwrap(),
        before
    );
    fs::write(
        home.path().join("strategy.yaml"),
        format!("{before}\n# another client\n"),
    )
    .unwrap();
    assert!(
        save_executor_settings(
            home.path(),
            &json!({
                "expectedRevision": base["revision"],
                "order": base["order"],
                "runners": base["runners"],
            }),
        )
        .is_err()
    );
}

#[test]
fn legacy_settings_migrate_before_batch_edit() {
    let home =
        home_with("# legacy\nplanner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
    let before = fs::read_to_string(home.path().join("strategy.yaml")).unwrap();
    let base = read_executor_settings(home.path()).unwrap();
    let result = save_executor_settings(
        home.path(),
        &json!({
            "expectedRevision": base["revision"],
            "order": base["order"],
            "runners": base["runners"].as_array().unwrap().iter().map(|r| {
                json!({"id": r["id"], "enabled": r["enabled"], "maxTasks": 2})
            }).collect::<Vec<_>>(),
        }),
    )
    .unwrap();
    assert_eq!(result["runners"][0]["maxTasks"], 2);
    assert_eq!(
        fs::read_to_string(home.path().join("strategy.yaml.pre-accounts.bak")).unwrap(),
        before
    );
}
