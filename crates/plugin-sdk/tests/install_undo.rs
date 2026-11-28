#![allow(clippy::unwrap_used)]
//! Transcribed from test/plugin-sdk-install-undo.test.ts.
use pacer_plugin::install::{
    BlockStyle, HookFormat, UndoOp, apply_undo, merge_undo, pieces_present, remove_toml_table,
    upsert_block,
};
use serde_json::{Value, json};

const ORACLE: &str = include_str!("fixtures/install/undo-oracle.json");

fn ops(value: &Value) -> Vec<UndoOp> {
    serde_json::from_value(value.clone()).unwrap()
}

// test/plugin-sdk-install-undo.test.ts:6 applyUndo removes each kind in order
#[test]
fn apply_undo_every_kind() {
    let block = [UndoOp::Block {
        style: BlockStyle::Md,
        restore: None,
    }];
    assert_eq!(
        apply_undo(
            "mine\n\n<!-- >>> pacer >>> -->\none\n<!-- <<< pacer <<< -->\n",
            &block,
            &mut vec![]
        )
        .unwrap(),
        "mine\n"
    );
    assert_eq!(
        apply_undo(
            "top = 1\n[mcp_servers.pacer]\ncommand = \"pacer\"\n[next]\nx = 2\n",
            &[UndoOp::TomlTable {
                table: "mcp_servers.pacer".into()
            }],
            &mut vec![]
        )
        .unwrap(),
        "top = 1\n[next]\nx = 2\n"
    );
    assert_eq!(
        apply_undo(
            "[mcp_servers.pacer]\nx = 1",
            &[UndoOp::TomlTable {
                table: "mcp_servers.pacer".into()
            }],
            &mut vec![]
        )
        .unwrap(),
        ""
    );
    assert_eq!(
        apply_undo(
            "{\n  \"mcp\": {\"pacer\": {}},\n  \"mine\": true\n}\n",
            &[UndoOp::JsonMember {
                path: vec!["mcp".into(), "pacer".into()],
                drop_empty: Some(vec!["mcp".into()])
            }],
            &mut vec![]
        )
        .unwrap(),
        "{\n  \"mine\": true\n}\n"
    );
    let mixed = [
        UndoOp::Hooks {
            format: HookFormat::Claude,
            commands: vec!["pacer".into()],
            restore: vec![serde_json::from_value(json!({"event": "SessionStart", "hook": {"type": "command", "command": "legacy"}})).unwrap()],
        },
        UndoOp::JsonKey { key: "statusLine".into() },
    ];
    assert_eq!(
        apply_undo("{\"hooks\":{\"SessionStart\":[{\"hooks\":[{\"command\":\"pacer\"}]}]},\"statusLine\":{},\"mine\":1}", &mixed, &mut vec![]).unwrap(),
        format!("{}\n", serde_json::to_string_pretty(&json!({"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "legacy"}]}]}, "mine": 1})).unwrap())
    );
}

// test/plugin-sdk-install-undo.test.ts:17 piecesPresent never throws
#[test]
fn pieces_present_never_throws() {
    let block = [UndoOp::Block {
        style: BlockStyle::Md,
        restore: None,
    }];
    assert!(pieces_present(
        &upsert_block("", "one", BlockStyle::Md).unwrap(),
        &block
    ));
    assert!(!pieces_present("mine", &block));
    assert!(pieces_present(
        r#"{"mcp":{"pacer":{}}}"#,
        &[UndoOp::JsonMember {
            path: vec!["mcp".into(), "pacer".into()],
            drop_empty: None
        }]
    ));
    assert!(!pieces_present(
        "bad",
        &[UndoOp::JsonKey {
            key: "pacer".into()
        }]
    ));
    assert!(pieces_present(
        "[pacer]\nx=1",
        &[UndoOp::TomlTable {
            table: "pacer".into()
        }]
    ));
    assert!(pieces_present(
        r#"{"hooks":{"sessionStart":[{"command":"pacer"}]}}"#,
        &[UndoOp::Hooks {
            format: HookFormat::Cursor,
            commands: vec!["pacer".into()],
            restore: vec![]
        }]
    ));
}

// test/plugin-sdk-install-undo.test.ts:26 mergeUndo unions hooks and deduplicates
#[test]
fn merge_undo_union() {
    let old = [
        UndoOp::Block {
            style: BlockStyle::Md,
            restore: None,
        },
        UndoOp::Hooks {
            format: HookFormat::Cursor,
            commands: vec!["old".into()],
            restore: vec![],
        },
    ];
    let added = [
        UndoOp::Block {
            style: BlockStyle::Md,
            restore: None,
        },
        UndoOp::Hooks {
            format: HookFormat::Cursor,
            commands: vec!["new".into(), "old".into()],
            restore: vec![
                serde_json::from_value(
                    json!({"event": "sessionStart", "hook": {"command": "legacy"}}),
                )
                .unwrap(),
            ],
        },
    ];
    assert_eq!(
        merge_undo(&old, &added),
        vec![
            UndoOp::Block {
                style: BlockStyle::Md,
                restore: None
            },
            UndoOp::Hooks {
                format: HookFormat::Cursor,
                commands: vec!["old".into(), "new".into()],
                restore: vec![
                    serde_json::from_value(
                        json!({"event": "sessionStart", "hook": {"command": "legacy"}})
                    )
                    .unwrap()
                ],
            },
        ]
    );
}

// test/plugin-sdk-install-undo.test.ts:30 TOML trailing comment
#[test]
fn toml_table_with_trailing_comment() {
    let text = "[mcp_servers.pacer] # managed\ncommand = \"pacer\"\n[next]\nx = 2\n";
    assert_eq!(
        apply_undo(
            text,
            &[UndoOp::TomlTable {
                table: "mcp_servers.pacer".into()
            }],
            &mut vec![]
        )
        .unwrap(),
        "[next]\nx = 2\n"
    );
    assert!(pieces_present(
        text,
        &[UndoOp::TomlTable {
            table: "mcp_servers.pacer".into()
        }]
    ));
}

// test/plugin-sdk-install-undo.test.ts:36 quoted TOML keys
#[test]
fn toml_quoted_key_spelling() {
    let text = "top = 1\n[mcp_servers.\"pacer\"]\ncommand = \"pacer\"\n[next]\nx = 2\n";
    assert_eq!(
        remove_toml_table(text, "mcp_servers.pacer"),
        "top = 1\n[next]\nx = 2\n"
    );
    assert_eq!(
        apply_undo(
            text,
            &[UndoOp::TomlTable {
                table: "mcp_servers.pacer".into()
            }],
            &mut vec![]
        )
        .unwrap(),
        "top = 1\n[next]\nx = 2\n"
    );
    assert!(pieces_present(
        text,
        &[UndoOp::TomlTable {
            table: "mcp_servers.pacer".into()
        }]
    ));
    assert_eq!(
        apply_undo(
            "top = 1\n[mcp_servers.pacer]\nx = 1\n[next]\ny = 2\n",
            &[UndoOp::TomlTable {
                table: "mcp_servers.pacer".into()
            }],
            &mut vec![]
        )
        .unwrap(),
        "top = 1\n[next]\ny = 2\n"
    );
    assert_eq!(
        remove_toml_table("top = 1\n[mcp_servers.other]\nx = 1\n", "mcp_servers.pacer"),
        "top = 1\n[mcp_servers.other]\nx = 1\n"
    );
}

// test/plugin-sdk-install-undo.test.ts:47 SDK and host undo agree
#[test]
fn sdk_and_host_undo_agree() {
    let oracle: Value = serde_json::from_str(ORACLE).unwrap();
    for case in oracle.as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let undo = ops(&case["ops"]);
        let mut notes = Vec::new();
        assert_eq!(
            apply_undo(text, &undo, &mut notes).unwrap(),
            case["after"].as_str().unwrap()
        );
        let expected_notes: Vec<_> = case["notes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_str().unwrap())
            .collect();
        assert_eq!(notes, expected_notes);
        assert_eq!(pieces_present(text, &undo), case["present"]);
        let expected_merged = ops(&case["merged"]);
        assert_eq!(merge_undo(&undo, &undo), expected_merged);
    }
    assert_eq!(
        remove_toml_table("prefix\n[owned]\nx=1\n[next]\ny=2", "owned"),
        "prefix\n[next]\ny=2"
    );
    assert_eq!(
        remove_toml_table(
            "prefix\n[mcp_servers.\"pacer\"]\nx=1\n[next]\ny=2",
            "mcp_servers.pacer"
        ),
        "prefix\n[next]\ny=2"
    );
}

// test/plugin-sdk-install-undo.test.ts:68 mergeUndo retains restore ordering
#[test]
fn merge_undo_restore_ordering() {
    let old = [UndoOp::Block {
        style: BlockStyle::Hash,
        restore: Some(vec![
            serde_json::from_value(json!({"text": "first", "anchor": null})).unwrap(),
        ]),
    }];
    let added = [UndoOp::Block {
        style: BlockStyle::Hash,
        restore: Some(vec![
            serde_json::from_value(json!({"text": "first", "anchor": "other"})).unwrap(),
            serde_json::from_value(json!({"text": "second", "anchor": null})).unwrap(),
        ]),
    }];
    let before = json!({"old": old, "added": added}).to_string();
    let merged = merge_undo(&old, &added);
    assert_eq!(json!({"old": old, "added": added}).to_string(), before);
    if let UndoOp::Block {
        restore: Some(items),
        ..
    } = &merged[0]
    {
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].text, "first");
        assert_eq!(items[1].text, "second");
    } else {
        panic!("expected block undo");
    }
    assert_eq!(json!({"old": old, "added": added}).to_string(), before);
}
