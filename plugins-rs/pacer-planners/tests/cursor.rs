//! Cursor installer tests (from `test/install-cursor.test.ts:27-90`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support {
    pub mod fake_home;
}

use serde_json::Value;
use support::fake_home::{FakeHome, params};

const DIR: &str = "/home/test/.cursor";
const MCP: &str = "/home/test/.cursor/mcp.json";

#[tokio::test]
async fn inline_config_preserved_idempotent_exact_uninstall() {
    let home = FakeHome::new();
    let original = "{\n  \"mcpServers\": {\n    \"other\": { \"command\": \"keep\" }\n  }\n}\n";
    home.put(MCP, original);
    let plan = home.install(params("cursor", DIR, "/home/test", Some(true))).await;
    let text = home.get(MCP).unwrap();
    assert!(text.contains("\"other\""));
    assert!(text.contains("\"pacer\""));
    let result = home.uninstall("cursor", plan.record).await;
    assert_eq!(home.get(MCP).as_deref(), Some(original));
    assert!(
        result.uninstall_report.restored.len() >= 1
            || result.uninstall_report.reverted.len() >= 1
    );
}

#[tokio::test]
async fn hook_commands_timeouts_order() {
    let home = FakeHome::new();
    home.install(params("cursor", DIR, "/home/test", Some(false))).await;
    let hooks: Value = serde_json::from_str(&home.get("/home/test/.cursor/hooks.json").unwrap()).unwrap();
    let all = serde_json::to_string(&hooks).unwrap();
    assert!(all.contains("session-start --planner cursor"));
    assert!(all.contains("guard --planner cursor"));
    assert!(all.contains("\"timeout\":15"));
    assert_eq!(hooks["version"], 1);
}

#[tokio::test]
async fn pretty_mcp_for_missing_and_empty() {
    for initial in [None, Some(""), Some("  \n")] {
        let home = FakeHome::new();
        if let Some(text) = initial {
            home.put(MCP, text);
        }
        home.install(params("cursor", DIR, "/home/test", Some(true))).await;
        let text = home.get(MCP).unwrap();
        assert!(text.starts_with("{\n  \"mcpServers\": {\n    \"pacer\": {\n"), "{text}");
        assert!(text.contains("\"args\": [\n"));
        assert!(text.ends_with("\n}\n"));
    }
}
