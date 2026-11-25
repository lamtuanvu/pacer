//! OpenCode installer round-trip. Expected files come from the parity driver
//! and are recorded in `texts.json` (no dedicated TS unit test).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support {
    pub mod fake_home;
}

use support::fake_home::{FakeHome, params};

const DIR: &str = "/home/test/.config/opencode";

#[tokio::test]
async fn install_and_uninstall_round_trip() {
    let home = FakeHome::new();
    let plan = home.install(params("opencode", DIR, "/home/test", Some(true))).await;
    let config = home.get(&format!("{DIR}/opencode.json")).unwrap();
    assert!(config.contains("$schema"));
    assert!(config.contains("\"mcp\""));
    assert!(config.contains("\"pacer\""));
    assert!(config.contains("\"enabled\": true"));
    assert!(home
        .get(&format!("{DIR}/AGENTS.md"))
        .unwrap()
        .contains("pacer delegation policy (OpenCode is the planner)"));
    assert!(plan.notes.iter().any(|note| note.contains("policy-only")));

    let result = home.uninstall("opencode", plan.record).await;
    assert!(!home.has(&format!("{DIR}/opencode.json")));
    assert!(!home.has(&format!("{DIR}/AGENTS.md")));
    assert!(!home.has(&format!("{DIR}/skills/pacer/SKILL.md")));
    assert!(result.files.iter().all(|file| file.after.is_none()));
}

#[tokio::test]
async fn existing_jsonc_is_modified_in_place() {
    let home = FakeHome::new();
    let jsonc = format!("{DIR}/opencode.jsonc");
    home.put(&jsonc, "{\n  // a comment\n  \"theme\": \"dark\"\n}\n");
    home.install(params("opencode", DIR, "/home/test", Some(true))).await;
    let text = home.get(&jsonc).unwrap();
    assert!(text.contains("\"pacer\""));
    assert!(!home.has(&format!("{DIR}/opencode.json")));
}
