#![allow(clippy::unwrap_used)]
use pacer_plugin_runtime::orca_policy::{
    LoginEnvironment, account_environment, launch_argv, resolve_placement,
};
use serde_json::json;
use std::{collections::HashMap, path::Path};
#[test]
fn placement_matches_ts_current_busy_dirty_and_js_trim() {
    assert_eq!(
        resolve_placement(
            &json!({"placement":{"requested":"current","reason":"\u{feff}why\u{feff}"}}),
            "new-child",
            true,
            false
        ),
        json!({"mode":"current","why":"agent: why"})
    );
    assert_eq!(
        resolve_placement(&json!({"kind":"research"}), "new-child", true, false)["mode"],
        "new"
    );
    assert_eq!(
        resolve_placement(
            &json!({"brief":{"goal":"continue uncommitted work"}}),
            "new-child",
            false,
            true
        )["why"],
        "builds on uncommitted work"
    );
    assert_eq!(
        resolve_placement(&json!({}), "current", false, true)["why"],
        "strategy default"
    );
}
#[test]
fn account_folder_uses_only_profile_keys_and_named_account_wins() {
    let login = LoginEnvironment {
        env: HashMap::from([("CODEX_HOME".into(), "/profile".into())]),
        profile_keys: vec!["CODEX_HOME".into()],
        login_shell: true,
    };
    assert_eq!(
        account_environment(
            &json!({"source":"default","kind":"codex"}),
            "codex",
            Path::new("/fixture"),
            None,
            &login
        )
        .unwrap()["CODEX_HOME"],
        "/profile"
    );
    assert_eq!(
        account_environment(
            &json!({"source":"path","kind":"codex","home":"~/named"}),
            "codex",
            Path::new("/fixture"),
            None,
            &login
        )
        .unwrap()["CODEX_HOME"],
        "/fixture/named"
    );
    let login = LoginEnvironment {
        profile_keys: vec![],
        ..login
    };
    assert!(
        account_environment(
            &json!({"source":"default"}),
            "codex",
            Path::new("/fixture"),
            None,
            &login
        )
        .unwrap()
        .is_empty()
    );
    assert!(
        account_environment(
            &json!({"connection":{}}),
            "codex",
            Path::new("/fixture"),
            None,
            &login
        )
        .is_err()
    );
}
#[test]
fn launch_matches_ts_codex_trust_and_claude_model_argv() {
    assert_eq!(
        launch_argv("codex", Some("model"), "/repo", "/tasks", "/source").unwrap(),
        vec![
            "codex",
            "--no-daemon",
            "-c",
            "projects={\"/repo\"={trust_level=\"trusted\"},\"/source\"={trust_level=\"trusted\"}}",
            "-C",
            "/repo",
            "--dangerously-bypass-approvals-and-sandbox",
            "--add-dir",
            "/tasks",
            "-m",
            "model"
        ]
    );
    assert_eq!(
        launch_argv("claude", Some("model"), "/repo", "/tasks", "/source").unwrap(),
        vec![
            "claude",
            "--dangerously-skip-permissions",
            "--model",
            "model"
        ]
    );
}
#[test]
fn mcp_answers_merge_rejections_sort_utf16_and_refuse_malformed_sources() {
    use pacer_plugin_runtime::orca_attempt::launch::mcp_choices;
    let root = std::env::temp_dir().join(format!("pacer-mcp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(root.join(".claude")).unwrap();
    let config = root.join("config.json");
    std::fs::write(root.join(".claude/settings.local.json"),json!({"enabledMcpjsonServers":["allowed","blocked","\u{e000}","\u{10000}"],"disabledMcpjsonServers":["declined"]}).to_string()).unwrap();
    std::fs::write(&config,json!({"projects":{root.to_string_lossy().as_ref():{"disabledMcpjsonServers":["blocked"]}}}).to_string()).unwrap();
    let choices = mcp_choices(&config, std::slice::from_ref(&root)).unwrap();
    assert_eq!(
        choices["enabled"],
        json!(["allowed", "\u{10000}", "\u{e000}"])
    );
    assert_eq!(choices["disabled"], json!(["blocked", "declined"]));
    std::fs::write(root.join(".claude/settings.local.json"), "[]").unwrap();
    assert!(mcp_choices(&config, std::slice::from_ref(&root)).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
