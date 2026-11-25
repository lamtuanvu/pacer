//! Handler tests (from `index.ts:70-208`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support {
    pub mod fake_home;
}

use pacer_plugin::install::{
    BlockStyle, FileChange, PlannerCommandResult, PlannerRecord, UndoOp, sha256,
};
use pacer_plugin::testing::Harness;
use serde_json::{Value, json};
use support::fake_home::FakeHome;

fn record(files: Vec<FileChange>, commands: Vec<pacer_plugin::install::CommandUndo>) -> PlannerRecord {
    PlannerRecord {
        mcp: None,
        integration: None,
        planner: "codex-key".into(),
        account: None,
        folder: Some("/home/test/.codex".into()),
        config_env: None,
        installed_at: 1,
        pacer_argv: vec!["/usr/local/bin/pacer".into()],
        files,
        commands,
        notes: vec![],
        undo_connect: None,
        undone_at: None,
    }
}

#[tokio::test]
async fn detect_reads_version_and_hints() {
    let home = FakeHome::new();
    *home.spawn_result.lock().unwrap() = Some(PlannerCommandResult {
        code: 0,
        stdout: "claude-code 2.1.0 (Claude Code)".into(),
        stderr: String::new(),
    });
    let mut harness: Harness = home.start().await;
    let result = harness
        .call(
            "planner.detect",
            json!({
                "agent": "claude-code",
                "binary": { "path": "/usr/local/bin/claude", "name": "claude" },
                "probe": { "argv": ["/usr/local/bin/claude", "--version"], "timeoutMs": 5000 },
            }),
        )
        .await
        .unwrap();
    assert_eq!(result["version"], "2.1.0");
    assert_eq!(result["found"], true);
    assert_eq!(result["path"], "/usr/local/bin/claude");
    assert_eq!(result["install_hint"], "npm install -g @anthropic-ai/claude-code");
    harness.close().await;

    // Cursor never spawns, even with a probe offered.
    let home = FakeHome::new();
    let mut harness = home.start().await;
    let result = harness
        .call(
            "planner.detect",
            json!({
                "agent": "cursor",
                "binary": { "path": "/usr/local/bin/cursor-agent", "name": "cursor" },
                "probe": { "argv": ["cursor-agent", "--version"], "timeoutMs": 5000 },
            }),
        )
        .await
        .unwrap();
    assert_eq!(result["version"], Value::Null);
    assert!(result["install_hint"].as_str().unwrap().contains("cursor.com"));
    assert!(!harness
        .capability_calls()
        .iter()
        .any(|(method, _)| method == "capability.process.spawn"));
    harness.close().await;
}

#[tokio::test]
async fn check_intact_by_hash_or_pieces() {
    let home = FakeHome::new();
    let text = "# user policy\n<!-- >>> pacer >>> -->\nmanaged\n<!-- <<< pacer <<< -->\n";
    home.put("/home/test/.codex/AGENTS.md", text);
    let mut harness = home.start().await;
    let record = record(
        vec![
            FileChange {
                path: "/home/test/.codex/AGENTS.md".into(),
                action: "edited".into(),
                managed: None,
                backup: None,
                after_hash: Some(sha256(text)),
                exact: None,
                undo: vec![],
            },
            FileChange {
                path: "/home/test/.codex/hooks.json".into(),
                action: "edited".into(),
                managed: None,
                backup: None,
                after_hash: None,
                exact: None,
                undo: vec![UndoOp::Block { style: BlockStyle::Hash, restore: None }],
            },
        ],
        vec![],
    );
    home.put(
        "/home/test/.codex/hooks.json",
        "# >>> pacer >>>\nhooks\n# <<< pacer <<<\n",
    );
    let result = harness
        .call("planner.check", json!({ "files": record.files }))
        .await
        .unwrap();
    assert_eq!(result["intact"], true);
    assert_eq!(result["files"].as_array().unwrap().len(), 2);
    harness.close().await;
}

#[tokio::test]
async fn preview_changes_per_agent() {
    let home = FakeHome::new();
    home.put("/home/test/.codex/AGENTS.md", "# existing\n");
    let mut harness = home.start().await;
    let result = harness
        .call(
            "planner.preview",
            json!({
                "agent": "codex",
                "home": "/home/test",
                "env": {
                    "folder": "/home/test/.codex",
                    "plannerKey": "codex-key",
                    "pacerArgv": ["/usr/local/bin/pacer"],
                    "now": 1,
                },
                "prior": null,
            }),
        )
        .await
        .unwrap();
    let changes = result["changes"].as_array().unwrap();
    let find = |path: &str| {
        changes
            .iter()
            .find(|change| change["path"] == path)
            .and_then(|c| c["change"].as_str())
            .map(str::to_string)
    };
    assert_eq!(find("/home/test/.codex/AGENTS.md"), Some("update".into()));
    assert_eq!(find("/home/test/.codex/hooks.json"), Some("create".into()));
    assert_eq!(
        find("/home/test/.codex/skills/pacer/SKILL.md"),
        Some("create".into())
    );
    assert_eq!(result["undo"], "pacer uninstall codex-key");
    assert!(result.get("detail").is_none());
    harness.close().await;

    // Claude preview carries the settings detail and the kept row.
    let home = FakeHome::new();
    let mut harness = home.start().await;
    let result = harness
        .call(
            "planner.preview",
            json!({
                "agent": "claude-code",
                "home": "/home/test",
                "env": {
                    "folder": "/home/test/.claude",
                    "plannerKey": "claude-key",
                    "pacerArgv": ["/usr/local/bin/pacer"],
                    "now": 1,
                },
                "prior": null,
            }),
        )
        .await
        .unwrap();
    assert!(result["detail"].as_str().unwrap().starts_with("settings.json:"));
    assert!(result["changes"].as_array().unwrap().iter().any(|c| c["change"] == "kept"));
    harness.close().await;
}

#[tokio::test]
async fn uninstall_failed_command_keeps_record() {
    let home = FakeHome::new();
    home.run_results.lock().unwrap().insert(
        "mcp".into(),
        PlannerCommandResult {
            code: 1,
            stdout: String::new(),
            stderr: "boom".into(),
        },
    );
    let prior = record(
        vec![],
        vec![pacer_plugin::install::CommandUndo {
            undo: vec!["claude".into(), "mcp".into(), "remove".into()],
        }],
    );
    let mut harness = home.start().await;
    let error = harness
        .call(
            "planner.uninstall",
            json!({ "agent": "claude-code", "prior": prior }),
        )
        .await
        .expect_err("failed recorded command must be refused");
    assert!(error.message.contains("recorded command undo failed"));
    harness.close().await;
}
