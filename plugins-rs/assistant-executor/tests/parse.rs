//! Parse tests for the assistant executor, ported from
//! `test/assistant-executor.test.ts` (:414) plus the plan's new parse cases.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_bundled_assistant_executor::{parse_acp_run, parse_run};
use serde_json::{Value, json};

// TS: :420 "parseRun reads text, the session, usage and errors"
#[test]
fn parse_run_reads_text_session_usage_and_errors() {
    let run = parse_run(
        &[
            json!({ "type": "step_start", "sessionID": "ses_1", "part": {} }),
            json!({ "type": "text", "sessionID": "ses_1", "part": { "text": "Hello " } }),
            json!({ "type": "text", "sessionID": "ses_1", "part": { "text": "there" } }),
            json!({
                "type": "step_finish",
                "sessionID": "ses_1",
                "part": { "tokens": { "input": 10, "output": 2, "cache": { "read": 4, "write": 1 } } }
            }),
            json!("not json"),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n"),
    )
    .unwrap();
    assert_eq!(run["text"], "Hello there");
    assert_eq!(run["session"], "ses_1");
    assert_eq!(
        run["usage"],
        json!({ "input": 10.0, "output": 2.0, "cacheRead": 4.0, "cacheWrite": 1.0, "coverage": "measured" })
    );
    assert!(run.get("error").is_none());

    let err = parse_run(
        &json!({ "type": "error", "sessionID": "s", "error": { "type": "provider.no-route", "message": "Model unavailable" } })
            .to_string(),
    )
    .unwrap();
    assert_eq!(err["error"], "provider.no-route: Model unavailable");
}

// Plan: a run with two steps but only one carrying tokens is "partial".
#[test]
fn parse_run_partial_coverage() {
    let run = parse_run(
        &[
            json!({ "type": "step_finish", "part": { "tokens": { "input": 5, "output": 5 } } }),
            json!({ "type": "step_finish", "part": {} }),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n"),
    )
    .unwrap();
    assert_eq!(run["usage"]["coverage"], "partial");
}

// Plan: ACP host JSON caps `tools` at 64.
#[test]
fn parse_acp_run_takes_host_json_and_caps_tools() {
    let tools: Vec<Value> = (0..66).map(|i| json!({ "tool": format!("t{i}"), "status": "completed" })).collect();
    let raw = json!({ "acp": true, "text": "t", "session": "s", "tools": tools });
    let run = parse_acp_run(&raw.to_string()).unwrap();
    assert_eq!(run["text"], "t");
    assert_eq!(run["session"], "s");
    assert_eq!(run["tools"].as_array().unwrap().len(), 64);
    assert_eq!(run["usage"], json!({ "input": 0, "output": 0, "coverage": "unknown" }));
}

// Plan: a JSON `null` JSONL line errors (TS throws a TypeError there).
#[test]
fn null_jsonl_line_is_internal() {
    let err = parse_run("null\n").unwrap_err();
    assert_eq!(err.code, "internal");
}