//! Codex installer tests (from `test/install-codex.test.ts`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support {
    pub mod fake_home;
}

use serde_json::{Value, json};
use support::fake_home::{FakeHome, params};

fn texts() -> Value {
    serde_json::from_str(include_str!("fixtures/texts.json")).unwrap()
}

const FOLDER: &str = "/home/test/.codex";

#[test]
fn exact_mcp_block_and_parseable_argv() {
    let argv = vec![
        "/usr/local/bin/pacer".to_string(),
        "--account".to_string(),
        "team".to_string(),
    ];
    assert_eq!(
        pacer_bundled_planners::codex::codex_mcp_block(&argv),
        texts()["codexMcpBlock"].as_str().unwrap()
    );
}

#[tokio::test]
async fn hooks_after_trusted_groups_policy_and_trust_note() {
    let home = FakeHome::new();
    let plan = home
        .install(params("codex", FOLDER, "/home/test", Some(true)))
        .await;
    let hooks = home.get("/home/test/.codex/hooks.json").unwrap();
    let doc: Value = serde_json::from_str(&hooks).unwrap();
    let events = doc["hooks"].as_object().unwrap();
    for event in ["SessionStart", "PreToolUse", "Stop", "UserPromptSubmit"] {
        assert!(events.contains_key(event), "missing hook {event}");
    }
    let all = serde_json::to_string(&doc).unwrap();
    assert!(all.contains("\"timeout\":15"));
    assert!(all.contains("\"timeout\":10"));
    assert!(all.contains("Checking subscription budgets"));
    assert!(plan.notes.iter().any(|note| note.contains("review and trust")));
    assert!(home
        .get("/home/test/.codex/AGENTS.md")
        .unwrap()
        .contains("pacer delegation policy (Codex is the planner)"));
}

#[tokio::test]
async fn idempotent_and_byte_exact_uninstall() {
    let home = FakeHome::new();
    let first = home
        .install(params("codex", FOLDER, "/home/test", Some(true)))
        .await;
    let before: Vec<(String, String)> = home
        .paths()
        .into_iter()
        .filter_map(|p| home.get(&p).map(|t| (p, t)))
        .collect();
    let mut again = params("codex", FOLDER, "/home/test", Some(true));
    again["prior"] = json!(first.record);
    let second = home.install(again).await;
    let after: Vec<(String, String)> = home
        .paths()
        .into_iter()
        .filter_map(|p| home.get(&p).map(|t| (p, t)))
        .collect();
    assert_eq!(before, after, "reinstall is byte-exact / idempotent");
    assert!(
        second.files.is_empty(),
        "no file changes on an idempotent reinstall"
    );

    let result = home.uninstall("codex", second.record).await;
    for (path, _) in before {
        assert!(!home.has(&path), "uninstall removed {path}");
    }
    assert!(result.files.iter().all(|file| file.after.is_none()));
}

#[tokio::test]
async fn user_pacer_tables_untouched() {
    let home = FakeHome::new();
    let config = "[mcp_servers.\"pacer\"]\ncommand = \"user-owned\"\n";
    let path = format!("{FOLDER}/config.toml");
    home.put(&path, config);
    let plan = home
        .install(params("codex", FOLDER, "/home/test", Some(true)))
        .await;
    assert_eq!(home.get(&path).as_deref(), Some(config));
    assert!(plan
        .notes
        .iter()
        .any(|note| note.contains("already defines [mcp_servers.pacer]")));
}

#[tokio::test]
async fn fresh_home_uninstall_deletes_created_files() {
    let home = FakeHome::new();
    let created = home
        .install(params("codex", FOLDER, "/home/test", Some(true)))
        .await;
    let created_paths: Vec<String> = created
        .record
        .files
        .iter()
        .filter(|file| file.action == "created")
        .map(|file| file.path.clone())
        .collect();
    let result = home.uninstall("codex", created.record).await;
    for path in created_paths {
        assert!(!home.has(&path), "removed created file {path}");
    }
    assert!(result.uninstall_report.removed.len() >= 4);
}
