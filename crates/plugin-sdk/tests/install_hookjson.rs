#![allow(clippy::unwrap_used)]
//! Transcribed from test/plugin-sdk-install-hookjson.test.ts.
use pacer_plugin::install::{
    HookFormat, HookSpec, add_hooks, edit_hooks_file, is_pacer_hook, remove_hooks, restore_hooks,
};
use serde_json::{Value, json};

fn settings() -> Value {
    json!({
      "env": {"OTHER_TOOL": "enabled"},
      "hooks": {
        "SessionStart": [
          {"hooks": [{"type": "command", "command": "ato session"}]},
          {"hooks": [{"type": "command", "command": "$HOME/.claude/scripts/budget/budget-status --hook", "timeout": 15, "statusMessage": "Checking subscription budgets"}]},
        ],
        "PreToolUse": [
          {"matcher": "Bash", "hooks": [{"type": "command", "command": "orca pre-tool"}]},
          {"matcher": "Agent|Task", "hooks": [{"type": "command", "command": "$HOME/.claude/scripts/budget/subagent_guard.py", "timeout": 15}]},
        ],
        "PreCompact": [{"hooks": [{"type": "command", "command": "orca compact"}]}],
      }
    })
}

fn specs() -> Vec<HookSpec> {
    vec![
        HookSpec {
            event: "SessionStart".into(),
            matcher: None,
            command: "/new/pacer status --hook claude-code".into(),
            timeout: Some(15),
            status_message: Some("Checking budgets".into()),
        },
        HookSpec {
            event: "PreToolUse".into(),
            matcher: Some("Agent|Task".into()),
            command: "/new/pacer guard --planner claude-code".into(),
            timeout: Some(15),
            status_message: None,
        },
    ]
}

// test/plugin-sdk-install-hookjson.test.ts:26 add_hooks appends idempotent pure
#[test]
fn add_hooks_appends_idempotent_pure() {
    let original = settings();
    let added = add_hooks(&original, HookFormat::Claude, &specs());
    assert_eq!(
        added,
        json!({
          "env": {"OTHER_TOOL": "enabled"},
          "hooks": {
            "SessionStart": [
              {"hooks": [{"type": "command", "command": "ato session"}]},
              {"hooks": [{"type": "command", "command": "$HOME/.claude/scripts/budget/budget-status --hook", "timeout": 15, "statusMessage": "Checking subscription budgets"}]},
              {"hooks": [{"type": "command", "command": "/new/pacer status --hook claude-code", "timeout": 15, "statusMessage": "Checking budgets"}]},
            ],
            "PreToolUse": [
              {"matcher": "Bash", "hooks": [{"type": "command", "command": "orca pre-tool"}]},
              {"matcher": "Agent|Task", "hooks": [{"type": "command", "command": "$HOME/.claude/scripts/budget/subagent_guard.py", "timeout": 15}]},
              {"matcher": "Agent|Task", "hooks": [{"type": "command", "command": "/new/pacer guard --planner claude-code", "timeout": 15}]},
            ],
            "PreCompact": [{"hooks": [{"type": "command", "command": "orca compact"}]}],
          }
        })
    );
    assert_eq!(add_hooks(&added, HookFormat::Claude, &specs()), added);
    assert_eq!(original, settings());
}

// test/plugin-sdk-install-hookjson.test.ts:43 skips existing command per event
#[test]
fn skips_existing_command_per_event() {
    let doc = json!({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "other"}, {"type": "command", "command": "pacer"}]}]}});
    let specs = [
        HookSpec {
            event: "PreToolUse".into(),
            matcher: Some("Agent".into()),
            command: "pacer".into(),
            timeout: None,
            status_message: None,
        },
        HookSpec {
            event: "SessionStart".into(),
            matcher: None,
            command: "pacer".into(),
            timeout: None,
            status_message: None,
        },
        HookSpec {
            event: "SessionStart".into(),
            matcher: None,
            command: "pacer".into(),
            timeout: None,
            status_message: None,
        },
    ];
    assert_eq!(
        add_hooks(&doc, HookFormat::Claude, &specs),
        json!({"hooks": {
            "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "other"}, {"type": "command", "command": "pacer"}]}],
            "SessionStart": [{"hooks": [{"type": "command", "command": "pacer"}]}],
        }})
    );
}

// test/plugin-sdk-install-hookjson.test.ts:55 legacy budget hooks round trip
#[test]
fn legacy_budget_hooks_round_trip() {
    let original = settings();
    let (kept, removed) = remove_hooks(&original, HookFormat::Claude, |c| {
        c.contains("/scripts/budget/")
    });
    assert_eq!(
        kept,
        json!({"env": {"OTHER_TOOL": "enabled"}, "hooks": {
            "SessionStart": [{"hooks": [{"type": "command", "command": "ato session"}]}],
            "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "orca pre-tool"}]}],
            "PreCompact": [{"hooks": [{"type": "command", "command": "orca compact"}]}],
        }})
    );
    assert_eq!(removed.len(), 2);
    assert_eq!(removed[0].event, "SessionStart");
    assert_eq!(removed[0].matcher, None);
    assert_eq!(
        removed[0].hook["command"],
        "$HOME/.claude/scripts/budget/budget-status --hook"
    );
    assert_eq!(removed[1].matcher.as_deref(), Some("Agent|Task"));
    assert_eq!(restore_hooks(&kept, HookFormat::Claude, &removed), original);
}

// test/plugin-sdk-install-hookjson.test.ts:72 remove hooks group and event rules
#[test]
fn remove_hooks_group_and_event_rules() {
    let doc = json!({"hooks": {
        "Mixed": [{"matcher": "Agent", "extra": true, "hooks": [{"type": "command", "command": "keep"}, {"type": "command", "command": "remove"}]}],
        "Gone": [{"hooks": [{"type": "command", "command": "remove"}]}],
        "Empty": [],
        "EmptyGroup": [{"hooks": []}],
    }});
    let (kept, removed) = remove_hooks(&doc, HookFormat::Claude, |c| c == "remove");
    assert_eq!(
        kept,
        json!({"hooks": {
            "Mixed": [{"matcher": "Agent", "extra": true, "hooks": [{"type": "command", "command": "keep"}]}],
            "Empty": [],
            "EmptyGroup": [{"hooks": []}],
        }})
    );
    assert_eq!(removed.len(), 2);
    assert_eq!(removed[0].matcher.as_deref(), Some("Agent"));
    assert_eq!(removed[1].event, "Gone");
}

// test/plugin-sdk-install-hookjson.test.ts:89 restore hooks appends separate groups
#[test]
fn restore_hooks_appends_separate_groups() {
    let doc =
        json!({"hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "keep"}]}]}});
    let removed = json!([{"event": "PreToolUse", "matcher": "Agent", "hook": {"type": "command", "command": "old", "timeout": 15}}]);
    let removed: Vec<pacer_plugin::install::RemovedHook> = serde_json::from_value(removed).unwrap();
    let restored = restore_hooks(&doc, HookFormat::Claude, &removed);
    assert_eq!(
        restored,
        json!({"hooks": {"PreToolUse": [
            {"hooks": [{"type": "command", "command": "keep"}]},
            {"matcher": "Agent", "hooks": [{"type": "command", "command": "old", "timeout": 15}]},
        ]}})
    );
}

// test/plugin-sdk-install-hookjson.test.ts:102 cursor flat hooks
#[test]
fn cursor_flat_hooks() {
    let doc = json!({"other": true, "hooks": {"sessionStart": [{"command": "other", "type": "command"}], "empty": []}});
    let specs = [HookSpec {
        event: "sessionStart".into(),
        matcher: Some("ignored".into()),
        command: "/pacer session-start --planner cursor".into(),
        timeout: Some(15),
        status_message: Some("ignored".into()),
    }];
    let added = add_hooks(&doc, HookFormat::Cursor, &specs);
    assert_eq!(
        added,
        json!({"other": true, "version": 1, "hooks": {"sessionStart": [
            {"command": "other", "type": "command"},
            {"command": "/pacer session-start --planner cursor", "timeout": 15},
        ], "empty": []}})
    );
    assert_eq!(add_hooks(&added, HookFormat::Cursor, &specs), added);
    let (kept, removed) = remove_hooks(&added, HookFormat::Cursor, |c| is_pacer_hook(c, "cursor"));
    assert_eq!(
        kept,
        json!({"other": true, "version": 1, "hooks": {"sessionStart": [{"command": "other", "type": "command"}], "empty": []}})
    );
    assert_eq!(removed.len(), 1);
    assert_eq!(restore_hooks(&kept, HookFormat::Cursor, &removed), added);
}

// test/plugin-sdk-install-hookjson.test.ts:117 cursor removes emptied events keeps version
#[test]
fn cursor_removes_emptied_events_keeps_version() {
    let doc =
        json!({"version": 2, "hooks": {"sessionStart": [{"command": "remove"}], "empty": []}});
    assert_eq!(add_hooks(&doc, HookFormat::Cursor, &[]), doc);
    let (kept, removed) = remove_hooks(&doc, HookFormat::Cursor, |_| true);
    assert_eq!(kept, json!({"version": 2, "hooks": {"empty": []}}));
    assert_eq!(removed.len(), 1);
}

// test/plugin-sdk-install-hookjson.test.ts:126 isPacerHook accepts and rejects
#[test]
fn is_pacer_hook_accepts_and_rejects() {
    for command in [
        "/old/pacer guard --planner claude-code",
        "bun /repo/src/cli.ts status --hook claude-code",
        "node /repo/cli.js session-start --planner claude-code",
    ] {
        assert!(is_pacer_hook(command, "claude-code"), "{command}");
    }
    for command in [
        "/old/pacer guard --planner codex",
        "/other guard --planner claude-code",
        "/old/pacer guard --planner claude-code --extra",
        "/old/pacer status --line",
        "/old/pacer status --hook claude-code-extra",
        "guard --planner claude-code",
        "$HOME/.claude/scripts/budget/budget-status --hook",
    ] {
        assert!(!is_pacer_hook(command, "claude-code"), "{command}");
    }
    assert!(is_pacer_hook("/pacer guard --planner codex", "codex"));
    assert!(is_pacer_hook(
        "/pacer session-start --planner cursor",
        "cursor"
    ));
}

// test/plugin-sdk-install-hookjson.test.ts:145 editHooksFile JSONC keeps other planners
#[test]
fn edit_hooks_file_jsonc_keeps_other_planners() {
    let old = "{\n    // Keep other tools and planners\n    \"env\": {\"OTHER_TOOL\": \"enabled\"},\n    \"hooks\": {\"SessionStart\": [\n      {\"hooks\": [{\"type\": \"command\", \"command\": \"other\"}]},\n      {\"hooks\": [{\"type\": \"command\", \"command\": \"/old/pacer status --hook claude-code\"}]},\n      {\"hooks\": [{\"type\": \"command\", \"command\": \"/old/pacer status --hook codex\"}]},\n    ]},\n  }";
    let spec = specs()[0].clone();
    let edited = edit_hooks_file(
        Some(old),
        HookFormat::Claude,
        std::slice::from_ref(&spec),
        "claude-code",
    )
    .unwrap();
    assert_eq!(
        pacer_plugin::install::parse_jsonc(&edited).unwrap(),
        json!({"env": {"OTHER_TOOL": "enabled"}, "hooks": {"SessionStart": [
            {"hooks": [{"type": "command", "command": "other"}]},
            {"hooks": [{"type": "command", "command": "/new/pacer status --hook claude-code", "timeout": 15, "statusMessage": "Checking budgets"}]},
            {"hooks": [{"type": "command", "command": "/old/pacer status --hook codex"}]},
        ]}})
    );
    assert!(edited.ends_with('\n'));
    assert_eq!(
        edit_hooks_file(
            Some(&edited),
            HookFormat::Claude,
            std::slice::from_ref(&spec),
            "claude-code"
        )
        .unwrap(),
        edited
    );
}

// test/plugin-sdk-install-hookjson.test.ts:165 editHooksFile replaces old Cursor hooks
#[test]
fn edit_hooks_file_replaces_old_cursor_hooks() {
    let old = r#"{"version":1,"hooks":{"sessionStart":[{"command":"other"},{"command":"/old/pacer session-start --planner cursor"}]}}"#;
    let specs = [HookSpec {
        event: "sessionStart".into(),
        matcher: None,
        command: "/new/pacer session-start --planner cursor".into(),
        timeout: None,
        status_message: None,
    }];
    assert_eq!(
        pacer_plugin::install::parse_jsonc(
            &edit_hooks_file(Some(old), HookFormat::Cursor, &specs, "cursor").unwrap()
        )
        .unwrap(),
        json!({"version": 1, "hooks": {"sessionStart": [{"command": "other"}, {"command": "/new/pacer session-start --planner cursor"}]}})
    );
}

// test/plugin-sdk-install-hookjson.test.ts:172 creates pretty empty Cursor config
#[test]
fn edit_hooks_file_creates_pretty_cursor_config() {
    assert_eq!(
        edit_hooks_file(None, HookFormat::Cursor, &[], "cursor").unwrap(),
        "{\n  \"version\": 1,\n  \"hooks\": {}\n}\n"
    );
}

// test/plugin-sdk-install-hookjson.test.ts:176 groups without hooks array survive
#[test]
fn groups_without_hooks_array_survive() {
    let groups = json!([{"matcher": "Bash"}, {"hooks": null}, {"hooks": {"command": "other"}}]);
    let doc = json!({"hooks": {"SessionStart": groups.clone()}});
    let added = add_hooks(&doc, HookFormat::Claude, std::slice::from_ref(&specs()[0]));
    assert_eq!(
        added["hooks"]["SessionStart"].as_array().unwrap()[..3],
        *groups.as_array().unwrap()
    );
    assert_eq!(added["hooks"]["SessionStart"].as_array().unwrap().len(), 4);
    assert_eq!(remove_hooks(&added, HookFormat::Claude, |_| true).0, doc);
    assert_eq!(
        remove_hooks(&doc, HookFormat::Claude, |_| true),
        (doc, vec![])
    );
}

// test/plugin-sdk-install-hookjson.test.ts:186 empty groups survive
#[test]
fn empty_groups_survive() {
    let doc =
        json!({"hooks": {"SessionStart": [{"hooks": []}, {"hooks": [{"command": "remove"}]}]}});
    assert_eq!(
        remove_hooks(&doc, HookFormat::Claude, |_| true).0,
        json!({"hooks": {"SessionStart": [{"hooks": []}]}})
    );
}

// test/plugin-sdk-install-hookjson.test.ts:191 missing matcher appended in place
#[test]
fn missing_matcher_appended_in_place() {
    let command = "/new/pacer guard --planner codex";
    let other = json!({"matcher": "Agent", "hooks": [{"type": "command", "command": command}]});
    let old = json!({"hooks": {"PreToolUse": [other.clone()]}}).to_string();
    let specs = [HookSpec {
        event: "PreToolUse".into(),
        matcher: Some("spawn_agent".into()),
        command: command.into(),
        timeout: Some(15),
        status_message: None,
    }];
    let edited = edit_hooks_file(Some(&old), HookFormat::Claude, &specs, "codex").unwrap();
    assert_eq!(
        pacer_plugin::install::parse_jsonc(&edited).unwrap()["hooks"]["PreToolUse"],
        json!([other, {"matcher": "spawn_agent", "hooks": [{"type": "command", "command": command, "timeout": 15}]}])
    );
}
