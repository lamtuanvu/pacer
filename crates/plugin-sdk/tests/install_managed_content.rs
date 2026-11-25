#![allow(clippy::unwrap_used)]
//! Transcribed from test/plugin-sdk-install-managed-content.test.ts.
use pacer_plugin::install::{HookFormat, UndoOp, managed_content, sha256};
use serde_json::{Value, json};

// test/plugin-sdk-install-managed-content.test.ts:8 ignores unrelated, detects timeout
#[test]
fn ignores_unrelated_detects_timeout_change() {
    let ops = vec![UndoOp::Hooks {
        format: HookFormat::Claude,
        commands: vec!["pacer guard --planner codex".into()],
        restore: vec![],
    }];
    let text = json!({"hooks": {"PreToolUse": [{"matcher": "spawn_agent", "hooks": [{"command": "pacer guard --planner codex", "timeout": 15}]}]}}).to_string();
    assert_eq!(
        managed_content(&text, &ops).unwrap(),
        managed_content(
            &text.replace("{\"hooks\"", "{\"theme\":\"dark\",\"hooks\""),
            &ops
        )
        .unwrap()
    );
    assert_ne!(
        managed_content(&text, &ops).unwrap(),
        managed_content(&text.replace("\"timeout\":15", "\"timeout\":30"), &ops).unwrap()
    );
}

// test/plugin-sdk-install-managed-content.test.ts:14 ambiguous blocks throw
#[test]
fn ambiguous_blocks_throw() {
    let block = "<!-- >>> pacer >>> -->\nhello\n<!-- <<< pacer <<< -->\n";
    let ops = [UndoOp::Block {
        style: pacer_plugin::install::BlockStyle::Md,
        restore: None,
    }];
    assert!(managed_content(&format!("{block}{block}"), &ops).is_err());
    assert!(managed_content("<!-- >>> pacer >>> -->", &ops).is_err());
}

// test/plugin-sdk-install-managed-content.test.ts:19 hash matches fixture manifests
#[test]
fn hash_matches_fixture_manifests() {
    for (agent, fixture) in [
        (
            "claude-code",
            include_str!("../../../test/fixtures/install/claude-code.json"),
        ),
        (
            "codex",
            include_str!("../../../test/fixtures/install/codex.json"),
        ),
        (
            "cursor",
            include_str!("../../../test/fixtures/install/cursor.json"),
        ),
        (
            "opencode",
            include_str!("../../../test/fixtures/install/opencode.json"),
        ),
    ] {
        let full: Value = serde_json::from_str(fixture).unwrap();
        let records = full["manifest"]["planners"][agent].as_object().unwrap();
        for file in records["files"].as_array().unwrap() {
            let Some(hash) = file["managed"]["hash"].as_str() else {
                continue;
            };
            let path = file["path"].as_str().unwrap();
            let text = full["after"][path]["text"].as_str().unwrap();
            let ops: Vec<UndoOp> = serde_json::from_value(file["undo"].clone()).unwrap();
            assert_eq!(
                sha256(&managed_content(text, &ops).unwrap()),
                hash,
                "{agent}/{path}"
            );
        }
    }
}
