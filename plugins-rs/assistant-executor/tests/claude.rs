//! Claude stream-json parse tests for the assistant executor, ported from
//! `test/assistant-executor.test.ts` (:453, :510, :535) plus the plan's
//! `expect_from_command_requires_mode_and_version`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use pacer_bundled_assistant_executor::{
    AskCommand, ClaudeInitExpect, claude_expect_from_command, parse_claude_run,
};
use serde_json::{Map, Value, json};

fn expect_empty() -> ClaudeInitExpect {
    ClaudeInitExpect {
        permission_mode: "dontAsk".into(),
        cwd: "/ask".into(),
        version: "2.1.281".into(),
        tools: Vec::new(),
        pacer_mcp: false,
    }
}

fn init_event(cwd: &str, extra: Value, agents: bool) -> Value {
    let mut init = json!({
        "type": "system", "subtype": "init", "cwd": cwd, "permissionMode": "dontAsk",
        "claude_code_version": "2.1.281", "tools": [], "mcp_servers": [], "plugins": [],
        "slash_commands": [], "skills": [],
    });
    if agents {
        init["agents"] = json!(["claude", "Explore"]);
    }
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        init[k] = v;
    }
    init
}

// TS: :453 "parseClaudeRun reads text, session, usage, init evidence, tool_result by tool_use_id"
#[test]
fn parse_claude_run_reads_init_tools_and_tool_results() {
    let run = parse_claude_run(
        &[
            init_event(
                "/ask",
                json!({ "tools": [], "mcp_servers": [], "plugins": [], "slash_commands": [], "skills": [] }),
                true,
            ),
            json!({ "type": "assistant", "session_id": "ses_c1", "message": { "content": [
                { "type": "tool_use", "id": "tu1", "name": "Bash" },
                { "type": "tool_use", "id": "tu2", "name": "Read" },
                { "type": "text", "text": "Hello " },
            ] } }),
            json!({ "type": "user", "session_id": "ses_c1", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "tu2", "is_error": true },
            ] } }),
            json!({ "type": "assistant", "session_id": "ses_c1", "message": { "content": [{ "type": "text", "text": "there" }] } }),
            json!({ "type": "result", "subtype": "success", "session_id": "ses_c1", "result": "Hello there",
                "usage": { "input_tokens": 10, "output_tokens": 2, "cache_read_input_tokens": 4, "cache_creation_input_tokens": 1 } }),
            json!("not json"),
        ]
        .iter()
        .map(|v| if let Value::String(s) = v { s.clone() } else { v.to_string() })
        .collect::<Vec<_>>()
        .join("\n"),
        Some(&expect_empty()),
    );
    assert_eq!(run["text"], "Hello there");
    assert_eq!(run["session"], "ses_c1");
    assert_eq!(
        run["usage"],
        json!({ "input": 10.0, "output": 2.0, "cacheRead": 4.0, "cacheWrite": 1.0, "coverage": "measured" })
    );
    assert_eq!(
        run["tools"],
        json!([
            { "tool": "claude:init", "status": "empty" },
            { "tool": "Bash", "status": "completed" },
            { "tool": "Read", "status": "error" },
        ])
    );
}

// TS: :510 "parseClaudeRun fails closed on missing init, non-empty init and hook events"
#[test]
fn parse_claude_run_fails_closed() {
    let missing = parse_claude_run(
        &json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "hi" }] } }).to_string(),
        Some(&expect_empty()),
    );
    assert!(missing["error"].as_str().unwrap().contains("init event was missing"));

    let tools = parse_claude_run(
        &init_event("/ask", json!({ "tools": ["Bash"] }), false).to_string(),
        Some(&expect_empty()),
    );
    assert!(tools["error"].as_str().unwrap().contains("not empty"));
    assert!(tools["tools"].as_array().unwrap().contains(&json!({ "tool": "Bash", "status": "available" })));

    let hook = parse_claude_run(
        &[
            init_event("/ask", json!({}), false),
            json!({ "type": "system", "subtype": "hook_started" }),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n"),
        Some(&expect_empty()),
    );
    assert!(hook["error"].as_str().unwrap().contains("hook"));
    assert!(hook["tools"].as_array().unwrap().contains(&json!({ "tool": "claude:hook", "status": "present" })));
}

// TS: :535 "parseClaudeRun allows builtin plugins, realpathed cwd, and rejects extras"
#[test]
fn builtin_plugins_and_realpathed_cwd_allowed_extras_rejected() {
    let dir = std::env::temp_dir().join(format!(
        "pacer-claude-cwd-{:?}",
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().subsec_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    let real = fs::canonicalize(&dir).unwrap();
    let real_str = real.to_string_lossy().into_owned();
    let dir_str = dir.to_string_lossy().into_owned();

    let builtins = json!([
        { "name": "agents-md", "path": "builtin", "source": "agents-md@builtin" },
        { "name": "telemetry", "path": "builtin", "source": "telemetry@builtin" },
    ]);
    let expect = ClaudeInitExpect {
        cwd: dir_str,
        ..expect_empty()
    };

    let ok = parse_claude_run(
        &init_event(&real_str, json!({ "plugins": builtins.clone() }), true).to_string(),
        Some(&expect),
    );
    assert!(ok.get("error").is_none());
    assert_eq!(ok["tools"], json!([{ "tool": "claude:init", "status": "empty" }]));

    let extra = parse_claude_run(
        &init_event(
            &real_str,
            json!({ "plugins": [builtins[0].clone(), builtins[1].clone(), { "name": "evil", "path": "/tmp/x", "source": "evil@local" }] }),
            false,
        )
        .to_string(),
        Some(&expect),
    );
    assert!(extra["error"].as_str().unwrap().contains("not empty"));
    assert!(extra["tools"].as_array().unwrap().contains(&json!({ "tool": "evil", "status": "available" })));

    let slash = parse_claude_run(
        &init_event(&real_str, json!({ "slash_commands": ["/help"] }), false).to_string(),
        Some(&expect),
    );
    assert!(slash["error"].as_str().unwrap().contains("not empty"));
    assert!(slash["tools"].as_array().unwrap().contains(&json!({ "tool": "/help", "status": "available" })));

    let _ = fs::remove_dir_all(&dir);
}

// Plan: `claude_expect_from_command` requires both `--permission-mode` and the
// CLAUDE_CODE_EXPECT_VERSION env.
#[test]
fn expect_from_command_requires_mode_and_version() {
    let cmd = |argv: Vec<&str>, env: Map<String, Value>| AskCommand {
        argv: argv.into_iter().map(str::to_owned).collect(),
        cwd: "/ask".into(),
        env,
        stdin: String::new(),
        timeout_ms: 30_000,
    };
    // Not a claude command.
    assert!(claude_expect_from_command(&cmd(vec!["opencode", "acp"], Map::new())).is_none());
    // Missing --permission-mode.
    assert!(claude_expect_from_command(&cmd(vec!["claude", "-p"], Map::new())).is_none());
    // Missing version env.
    assert!(claude_expect_from_command(&cmd(
        vec!["claude", "-p", "--permission-mode", "dontAsk"],
        Map::new()
    ))
    .is_none());
    // Both present.
    let mut env = Map::new();
    env.insert("CLAUDE_CODE_EXPECT_VERSION".into(), json!("2.1.281"));
    let expect = claude_expect_from_command(&cmd(
        vec!["claude", "-p", "--permission-mode", "dontAsk", "--mcp-config", "{\"mcpServers\":{}}"],
        env,
    ))
    .unwrap();
    assert_eq!(expect.permission_mode, "dontAsk");
    assert_eq!(expect.version, "2.1.281");
    assert!(!expect.pacer_mcp);
    assert!(expect.tools.is_empty());
}