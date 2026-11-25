//! Claude settings/status-line tests
//! (`test/install-uninstall-user-content.test.ts:15`, `test/doctor-hooks.test.ts`
//! fixture builders). Doctor itself is host-only.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support {
    pub mod fake_home;
}

use pacer_bundled_planners::claude::{ClaudeCommands, edit_claude_settings, edit_statusline_script};
use serde_json::Value;
use support::fake_home::{FakeHome, params};

fn texts() -> Value {
    serde_json::from_str(include_str!("fixtures/texts.json")).unwrap()
}

fn commands() -> ClaudeCommands {
    let command = "/usr/local/bin/pacer --account team";
    ClaudeCommands {
        session: format!("{command} msg hook session --planner claude-code"),
        guard: format!("{command} guard --planner claude-code"),
        stop: Some(format!("{command} msg hook stop --planner claude-code")),
        prompt: Some(format!("{command} msg hook prompt --planner claude-code")),
        statusline: format!("{command} statusline"),
    }
}

#[test]
fn edit_claude_settings_matches_golden() {
    let edit = edit_claude_settings(None, &commands(), "/home/test", false).unwrap();
    assert_eq!(edit.text, texts()["claudeSettings"].as_str().unwrap());
    assert!(edit.undo.len() == 2);
    assert_eq!(edit.script_path, None);
    assert!(!edit.needs_pipe);
}

#[test]
fn edit_statusline_script_matches_golden() {
    let script = "#!/bin/sh\ninput=$(cat)\nexit 0\n";
    let next = edit_statusline_script(script, "/usr/local/bin/pacer --account team")
        .unwrap()
        .unwrap();
    assert_eq!(next, texts()["statuslineScript"].as_str().unwrap());
    assert!(next.contains("# >>> pacer >>>"));
    assert!(next.contains("printf '%s' \"$input\" | /usr/local/bin/pacer --account team statusline 2>/dev/null"));
    assert_eq!(edit_statusline_script("#!/bin/sh\necho hi\n", "pacer").unwrap(), None);
}

#[tokio::test]
async fn user_settings_in_created_file_survive() {
    let home = FakeHome::new();
    let settings_path = "/home/test/.claude/settings.json";
    home.put(
        settings_path,
        "{\n  \"theme\": \"dark\",\n  \"statusLine\": { \"type\": \"command\", \"command\": \"/usr/bin/my-status\" }\n}\n",
    );
    let plan = home
        .install(params("claude-code", "/home/test/.claude", "/home/test", Some(false)))
        .await;
    let settings = home.get(settings_path).unwrap();
    assert!(settings.contains("\"theme\": \"dark\""));
    assert!(settings.contains("\"statusLine\""));
    assert!(settings.contains("SessionStart"));
    assert!(plan.record.files.iter().any(|file| file.path == settings_path));

    let result = home.uninstall("claude-code", plan.record).await;
    let restored = home.get(settings_path).unwrap();
    assert!(restored.contains("\"theme\": \"dark\""));
    assert!(!restored.contains("SessionStart"));
    assert!(
        result.uninstall_report.restored.len() >= 1
            || result.uninstall_report.reverted.len() >= 1
    );
}
