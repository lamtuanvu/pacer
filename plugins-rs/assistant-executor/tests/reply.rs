//! Wire-level tests for `assistant.reply`, ported from the ask-mode reply
//! flow in `plugins/assistant-executor/index.ts` (`reply`, `run`, `readAll`)
//! and the plan's reply cases.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_bundled_assistant_executor::plugin;
use pacer_plugin::js;
use pacer_plugin::testing::{Harness, HelloSpec};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn lock(m: &Mutex<Vec<Value>>) -> std::sync::MutexGuard<'_, Vec<Value>> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Start a harness whose `capability.process.spawn` answers each call with the
/// next entry of `outputs` (in order); records every spawn params.
async fn harness(outputs: Vec<Value>) -> (Harness, Arc<Mutex<Vec<Value>>>) {
    let mut h = Harness::start(plugin(), HelloSpec::default()).await;
    let calls = Arc::new(Mutex::new(Vec::new()));
    let queue = Arc::new(Mutex::new(outputs));
    let spawn_calls = calls.clone();
    h.on_capability("capability.process.spawn", move |p| {
        spawn_calls.lock().unwrap().push(p);
        let mut q = queue.lock().unwrap();
        Ok(q.remove(0))
    });
    (h, calls)
}

/// An opencode JSONL run answering with `text`.
fn opencode_stdout(text: &str, with_error: bool) -> String {
    let mut events = vec![
        json!({ "type": "step_start", "sessionID": "ses_1", "part": {} }),
        json!({ "type": "text", "sessionID": "ses_1", "part": { "text": text } }),
        json!({ "type": "step_finish", "sessionID": "ses_1", "part": { "tokens": { "input": 10, "output": 2 } } }),
    ];
    if with_error {
        events.push(json!({ "type": "error", "sessionID": "ses_1", "error": { "type": "run", "message": "boom" } }));
    }
    events
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
}

// TS: index.ts:381 "no executor is invalid_input"
#[tokio::test]
async fn missing_executor_is_invalid_input() {
    let mut h = Harness::start(plugin(), HelloSpec::default()).await;
    h.on_capability("capability.process.spawn", |_| panic!("must not spawn"));
    let err = h.call("assistant.reply", json!({})).await.unwrap_err();
    assert_eq!(err.code, "invalid_input");
    assert_eq!(
        err.message,
        "The executor backend needs a host-issued ask-mode command."
    );
    assert!(h.capability_calls().is_empty());
    h.close().await;
}

// TS: opencode acp turn carries the editable config and grant as secret refs.
#[tokio::test]
async fn opencode_acp_turn_binds_config_and_grant_refs() {
    let (mut h, calls) =
        harness(vec![json!({ "code": 0, "stdout": opencode_stdout("Hello", false), "timedOut": false })]).await;
    let r = h
        .call(
            "assistant.reply",
            json!({
                "session": "ses_old",
                "executor": {
                    "configRef": "secrets:assistantAskConfig",
                    "grantRef": "secrets:assistantGrant",
                    "command": { "argv": ["opencode", "acp"], "cwd": "/ask", "env": {}, "stdin": "hi", "timeoutMs": 30000 }
                }
            }),
        )
        .await
        .unwrap();
    assert_eq!(r["message"], "Hello");
    assert_eq!(r["session"], "ses_1");
    assert_eq!(r["usage"], json!({ "input": 10.0, "output": 2.0, "coverage": "measured" }));
    {
        let c = lock(&calls);
        assert_eq!(c.len(), 1);
        let env = &c[0]["env"];
        assert_eq!(
            env["OPENCODE_CONFIG_CONTENT"],
            json!({ "secretRef": "secrets:assistantAskConfig" })
        );
        assert_eq!(
            env["PACER_ASSISTANT_GRANT"],
            json!({ "secretRef": "secrets:assistantAskGrant" })
        );
        assert_eq!(c[0]["timeoutMs"], json!(30000));
    }
    h.close().await;
}

// TS: codex turns bind only the grant secret ref, never the config content.
#[tokio::test]
async fn codex_turn_binds_only_the_grant() {
    let stdout = json!({ "codex": true, "text": "Hello over codex", "session": "th_1" }).to_string();
    let (mut h, calls) =
        harness(vec![json!({ "code": 0, "stdout": stdout, "timedOut": false })]).await;
    let r = h
        .call(
            "assistant.reply",
            json!({
                "executor": {
                    "configRef": "secrets:assistantAskConfig",
                    "command": { "argv": ["codex"], "cwd": "/ask", "env": {}, "stdin": "hi", "timeoutMs": 30000 }
                }
            }),
        )
        .await
        .unwrap();
    assert_eq!(r["message"], "Hello over codex");
    assert_eq!(r["session"], "th_1");
    {
        let c = lock(&calls);
        assert_eq!(c.len(), 1);
        let env = &c[0]["env"];
        assert_eq!(
            env["PACER_ASSISTANT_GRANT"],
            json!({ "secretRef": "secrets:assistantAskGrant" })
        );
        assert!(env.get("OPENCODE_CONFIG_CONTENT").is_none());
    }
    h.close().await;
}

// TS: claude turns keep plain env values and bind the grant as a secret ref
// only when an MCP config is present; a missing expected init surface refuses
// the turn after the single spawn.
#[tokio::test]
async fn claude_turn_uses_plain_env_and_requires_init_expectation() {
    let (mut h, calls) =
        harness(vec![json!({ "code": 0, "stdout": "{}", "timedOut": false })]).await;
    let r = h
        .call(
            "assistant.reply",
            json!({
                "executor": {
                    "grantRef": "secrets:assistantGrant",
                    "command": {
                        "argv": ["claude", "-p", "--mcp-config", "{\"mcpServers\":{\"pacer\":{}}}"],
                        "cwd": "/ask",
                        "env": { "CLAUDE_CONFIG_DIR": "/home/work" },
                        "stdin": "hi",
                        "timeoutMs": 30000
                    }
                }
            }),
        )
        .await;
    let err = r.unwrap_err();
    assert_eq!(err.code, "plugin_refused");
    assert!(err.message.contains("missing its expected init surface"));
    {
        let c = lock(&calls);
        assert_eq!(c.len(), 1);
        let env = &c[0]["env"];
        assert_eq!(env["CLAUDE_CONFIG_DIR"], json!("/home/work"));
        assert_eq!(
            env["PACER_ASSISTANT_GRANT"],
            json!({ "secretRef": "secrets:assistantGrant" })
        );
        assert!(env.get("OPENCODE_CONFIG_CONTENT").is_none());
    }
    h.close().await;
}

// TS: run reads buffered stdout via outputChunk in chunks until empty.
#[tokio::test]
async fn output_handles_are_read_in_chunks_until_empty() {
    let message = json!({ "acp": true, "text": "Hello from handle", "session": "ses_h" });
    let bytes = serde_json::to_string(&message).unwrap().into_bytes();
    // Split the *decoded bytes* in half so each chunk is independently valid
    // base64 that read_all reassembles into the full message.
    let split = bytes.len() / 2;
    let chunks = Arc::new(Mutex::new(vec![
        js::base64::encode(&bytes[..split]),
        js::base64::encode(&bytes[split..]),
        String::new(),
    ]));
    let mut h = Harness::start(plugin(), HelloSpec::default()).await;
    h.on_capability("capability.process.spawn", |_| {
        Ok(json!({ "code": 0, "timedOut": false, "output": { "stdout": "handle-1" } }))
    });
    let chunk_queue = chunks.clone();
    h.on_capability("capability.process.outputChunk", move |_| {
        let mut q = chunk_queue.lock().unwrap();
        let next = if q.is_empty() { String::new() } else { q.remove(0) };
        Ok(json!({ "base64": next }))
    });
    let r = h
        .call(
            "assistant.reply",
            json!({
                "executor": {
                    "command": { "argv": ["opencode", "acp"], "cwd": "/ask", "env": {}, "stdin": "hi", "timeoutMs": 30000 }
                }
            }),
        )
        .await
        .unwrap();
    assert_eq!(r["message"], "Hello from handle");
    assert_eq!(r["session"], "ses_h");
    h.close().await;
}

// TS: a failed resume with a stored session runs the host's fallback command.
#[tokio::test]
async fn resume_failure_runs_the_fallback() {
    // First (resume) run yields no text and a nonzero exit; the fallback then
    // answers with text and a fresh session.
    let first = opencode_stdout("", false);
    let second = opencode_stdout("recovered", false);
    let (mut h, calls) = harness(vec![
        json!({ "code": 5, "stdout": first, "timedOut": false }),
        json!({ "code": 0, "stdout": second, "timedOut": false }),
    ])
    .await;
    let r = h
        .call(
            "assistant.reply",
            json!({
                "session": "ses_gone",
                "executor": {
                    "command": { "argv": ["opencode", "acp"], "cwd": "/ask", "env": {}, "stdin": "resume", "timeoutMs": 30000 },
                    "fallback": { "argv": ["opencode", "acp"], "cwd": "/ask", "env": {}, "stdin": "seed-transcript", "timeoutMs": 30000 }
                }
            }),
        )
        .await
        .unwrap();
    assert_eq!(r["message"], "recovered");
    {
        let c = lock(&calls);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0]["stdin"], json!("resume"));
        assert_eq!(c[1]["stdin"], json!("seed-transcript"));
    }
    h.close().await;
}

// TS: without a stored session the fallback is never run.
#[tokio::test]
async fn no_fallback_without_session() {
    let (mut h, calls) =
        harness(vec![json!({ "code": 5, "stdout": opencode_stdout("", false), "timedOut": false })]).await;
    let r = h
        .call(
            "assistant.reply",
            json!({
                "executor": {
                    "command": { "argv": ["opencode", "acp"], "cwd": "/ask", "env": {}, "stdin": "hi", "timeoutMs": 30000 },
                    "fallback": { "argv": ["opencode", "acp"], "cwd": "/ask", "env": {}, "stdin": "seed", "timeoutMs": 30000 }
                }
            }),
        )
        .await;
    // No text and a nonzero code with no session → unavailable with the exit.
    let err = r.unwrap_err();
    assert_eq!(err.code, "plugin_unavailable");
    assert_eq!(err.message, "The agent exited 5 without an answer.");
    assert_eq!(lock(&calls).len(), 1);
    h.close().await;
}

// TS: index.ts:400 a timed out run is a plugin_timeout.
#[tokio::test]
async fn timeout_is_plugin_timeout() {
    let (mut h, _calls) = harness(vec![json!({ "code": 0, "stdout": "", "timedOut": true })]).await;
    let r = h
        .call(
            "assistant.reply",
            json!({
                "executor": {
                    "command": { "argv": ["opencode", "acp"], "cwd": "/ask", "env": {}, "stdin": "hi", "timeoutMs": 30000 }
                }
            }),
        )
        .await;
    let err = r.unwrap_err();
    assert_eq!(err.code, "plugin_timeout");
    assert_eq!(err.message, "The agent did not answer in time.");
    h.close().await;
}

// TS: index.ts:405 a claude error refuses the turn even when text arrived.
#[tokio::test]
async fn claude_error_refuses_even_with_text() {
    // A claude CONTROL digest with text and an error that is not a
    // "digest only" pass (and a hook error means sawHook) still refuses.
    let stdout = json!({
        "claudeControl": true,
        "text": "answer text",
        "error": "a hook lifecycle event ran",
        "toolsHealthy": false
    })
    .to_string();
    let (mut h, _calls) = harness(vec![json!({ "code": 0, "stdout": stdout, "timedOut": false })]).await;
    let r = h
        .call(
            "assistant.reply",
            json!({
                "executor": {
                    "command": { "argv": ["claude"], "cwd": "/ask", "env": {}, "stdin": "hi", "timeoutMs": 30000 }
                }
            }),
        )
        .await;
    let err = r.unwrap_err();
    assert_eq!(err.code, "plugin_refused");
    assert!(err.message.contains("hook"));
    h.close().await;
}

// TS: index.ts:406 no text is unavailable, naming the exit code.
#[tokio::test]
async fn no_text_is_unavailable_with_exit_code() {
    // opencode run with no text event and exit code 0.
    let stdout = json!({ "type": "step_finish", "part": {} }).to_string();
    let (mut h, _calls) = harness(vec![json!({ "code": 0, "stdout": stdout, "timedOut": false })]).await;
    let r = h
        .call(
            "assistant.reply",
            json!({
                "executor": {
                    "command": { "argv": ["opencode", "acp"], "cwd": "/ask", "env": {}, "stdin": "hi", "timeoutMs": 30000 }
                }
            }),
        )
        .await;
    let err = r.unwrap_err();
    assert_eq!(err.code, "plugin_unavailable");
    assert_eq!(err.message, "The agent exited 0 without an answer.");
    h.close().await;
}

// TS: index.ts:407 and parse.acp caps tools at 64.
#[tokio::test]
async fn tools_are_capped_at_64() {
    let tools: Vec<Value> = (0..66)
        .map(|i| json!({ "tool": format!("t{i}"), "status": "completed" }))
        .collect();
    let stdout = json!({ "acp": true, "text": "done", "session": "s", "tools": tools }).to_string();
    let (mut h, _calls) = harness(vec![json!({ "code": 0, "stdout": stdout, "timedOut": false })]).await;
    let r = h
        .call(
            "assistant.reply",
            json!({
                "executor": {
                    "command": { "argv": ["opencode", "acp"], "cwd": "/ask", "env": {}, "stdin": "hi", "timeoutMs": 30000 }
                }
            }),
        )
        .await
        .unwrap();
    assert_eq!(r["message"], "done");
    assert_eq!(r["tools"].as_array().unwrap().len(), 64);
    h.close().await;
}