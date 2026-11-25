//! Delivery tests for `pacer-bundled-assistant`, ported from
//! `plugins/assistant/index.ts` (M3 C4). The `params` fixture is
//! `test/assistant-plugin.test.ts:13-21`, with the plan's test limits
//! (`maxOutputTokens:256,maxToolRounds:2,deadlineMs:5000`).
//!
//! Network scenarios run through a scripted [`FakeTransport`] so no real
//! request leaves the test. `params` for `assistant.respond` (transcribing
//! the TS) uses `baseUrl "http://models.test/v1/"`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use pacer_bundled_assistant::{TransportError, chat_request, chat_result, plugin_with, respond};
use pacer_plugin::{CancellationToken, Plugin, testing::Harness};
use serde_json::{Value, json};

fn params(max_tool_rounds: i64) -> Value {
    json!({
        "conversationId": "conv-1",
        "turnId": "turn-1",
        "messages": [
            { "role": "user", "content": "hi" },
            { "role": "assistant", "content": "", "toolCalls": [{ "id": "c1", "name": "snapshot", "arguments": {} }] },
            { "role": "tool", "toolCallId": "c1", "content": "<data>{}</data>" }
        ],
        "tools": [{ "name": "snapshot", "description": "d", "parameters": { "type": "object" } }],
        "context": { "system": "sys", "backend": { "kind": "endpoint", "account": "ep", "model": "m1", "baseUrl": "http://models.test/v1/" } },
        "limits": { "maxOutputTokens": 256, "maxToolRounds": max_tool_rounds, "deadlineMs": 5000 }
    })
}

type Script = Result<(String, u16, Vec<u8>), TransportError>;

/// A scripted chat transport: pops replies in order, records every call
/// (url, bearer, parsed body, deadline), and awaits the script queue when it
/// is empty so a script that is never pushed genuinely suspends (the hang
/// case that lets a pre-cancelled token win the select).
struct FakeTransport {
    inner: Arc<Mutex<FakeInner>>,
    ready: Arc<tokio::sync::Notify>,
}

struct FakeInner {
    scripts: Vec<Script>,
    recorded: Vec<(String, Option<String>, Value, Duration)>,
}

impl FakeTransport {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(FakeInner {
                scripts: Vec::new(),
                recorded: Vec::new(),
            })),
            ready: Arc::new(tokio::sync::Notify::new()),
        }
    }
    fn push(&self, script: Script) {
        self.lock().scripts.push(script);
        self.ready.notify_waiters();
    }
    fn lock(&self) -> MutexGuard<'_, FakeInner> {
        match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

impl pacer_bundled_assistant::ChatTransport for FakeTransport {
    fn post(
        &self,
        url: String,
        bearer: Option<String>,
        body: String,
        deadline: Duration,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(u16, Vec<u8>), TransportError>> + Send>,
    > {
        let inner = self.inner.clone();
        let ready = self.ready.clone();
        Box::pin(async move {
            // Record the call, then pop the next scripted reply, awaiting
            // readiness when the queue is empty so a script that is never
            // pushed suspends forever — a "model that never answers" (the
            // cancel case).
            {
                let mut guard = match inner.lock() {
                    Ok(g) => g,
                    Err(poisoned) => poisoned.into_inner(),
                };
                let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                guard.recorded.push((url, bearer, parsed, deadline));
            }
            let script = loop {
                let script = {
                    let mut guard = match inner.lock() {
                        Ok(g) => g,
                        Err(poisoned) => poisoned.into_inner(),
                    };
                    if !guard.scripts.is_empty() {
                        Some(guard.scripts.remove(0))
                    } else {
                        None
                    }
                };
                match script {
                    Some(script) => break script,
                    None => ready.notified().await,
                }
            };
            match script {
                Ok((_, status, bytes)) => Ok((status, bytes)),
                Err(error) => Err(error),
            }
        })
    }
}

fn script_ok(fake: &FakeTransport, status: u16, body: Value) {
    fake.push(Ok((
        String::new(),
        status,
        serde_json::to_vec(&body).unwrap(),
    )));
}

fn plugin_with_fake(fake: Arc<FakeTransport>) -> Plugin {
    plugin_with(fake)
}

// TS: plugins/assistant/index.ts manifest (byte-equal, M3 C0a).
#[test]
fn manifest_names_precise_assistant_contribution_and_capabilities() {
    let m: Value = serde_json::from_str(pacer_bundled_assistant::MANIFEST).unwrap();
    assert_eq!(m["host"], "^1.3");
    assert_eq!(m["contributes"], json!({ "assistant": {} }));
    assert_eq!(m["reentrant"], true);
    assert_eq!(m["tier"], "free");
    assert_eq!(
        m["capabilities"],
        json!([
            { "name": "secrets.resolve", "scopes": ["endpoint"] },
            { "name": "net.http" }
        ])
    );
}

// TS: assistant:28 — an assistant message with tool calls, a tool result, one
// tool, and `maxToolRounds:0` dropping the `tools` key.
#[test]
fn maps_messages_tool_calls_and_tools_onto_an_openai_request() {
    let body = chat_request(&params(2));
    assert_eq!(
        body["messages"][0],
        json!({ "role": "system", "content": "sys" })
    );
    assert_eq!(
        body["messages"][2]["tool_calls"][0]["function"]["name"],
        json!("snapshot")
    );
    assert_eq!(
        body["messages"][3],
        json!({ "role": "tool", "tool_call_id": "c1", "content": "<data>{}</data>" })
    );
    assert_eq!(body["tools"].as_array().map(Vec::len), Some(1));

    let no_tools = chat_request(&params(0));
    assert!(no_tools.get("tools").is_none());
}

// TS: assistant:36 — resolve the key through the host, send it as a Bearer
// header, and parse usage (including a tool call).
#[tokio::test]
async fn reads_the_key_through_the_host_sends_bearer_and_parses_usage() {
    let fake = Arc::new(FakeTransport::new());
    script_ok(
        &fake,
        200,
        json!({
            "choices": [{ "message": {
                "content": "Hello",
                "tool_calls": [{ "id": "c9", "function": { "name": "budget", "arguments": "{\"x\":1}" } }]
            } }],
            "usage": { "prompt_tokens": 12, "completion_tokens": 3 }
        }),
    );
    let mut h = Harness::start(plugin_with_fake(fake.clone()), Default::default()).await;
    h.on_capability("capability.secrets.resolve", |_| {
        Ok(json!({ "value": "sk-test-key" }))
    });
    let r = h.call("assistant.respond", params(2)).await.unwrap();
    assert_eq!(
        r,
        json!({
            "message": "Hello",
            "toolCalls": [{ "id": "c9", "name": "budget", "arguments": { "x": 1 } }],
            "usage": { "input": 12, "output": 3, "coverage": "measured" }
        })
    );
    let calls = h.capability_calls();
    assert_eq!(
        calls,
        vec![(
            "capability.secrets.resolve".to_string(),
            json!({ "ref": "endpoint/ep" })
        )]
    );
    let rec = fake.lock().recorded[0].clone();
    assert_eq!(rec.0, "http://models.test/v1/chat/completions");
    assert_eq!(rec.1, Some("sk-test-key".to_string()));
    assert_eq!(rec.2, chat_request(&params(2)));
    assert_eq!(rec.3, Duration::from_millis(5000));
    h.close().await;
}

// TS: assistant:43 — missing usage is unknown coverage, not zero.
#[test]
fn missing_usage_is_unknown_coverage() {
    let out = chat_result(&json!({ "choices": [{ "message": { "content": "x" } }] })).unwrap();
    assert_eq!(
        out["usage"],
        json!({ "input": 0, "output": 0, "coverage": "unknown" })
    );
}

// TS: assistant:46 — an HTTP error names the status only; the body (which can
// echo the key) is never decoded. The fake's reply is never parsed as JSON.
#[tokio::test]
async fn http_error_names_the_status_only() {
    let fake = Arc::new(FakeTransport::new());
    script_ok(&fake, 401, json!({ "raw": "invalid key sk-test-key" }));
    let mut h = Harness::start(plugin_with_fake(fake.clone()), Default::default()).await;
    h.on_capability("capability.secrets.resolve", |_| {
        Ok(json!({ "value": "sk-test-key" }))
    });
    let err = h.call("assistant.respond", params(2)).await.unwrap_err();
    assert_eq!(err.code, "plugin_unavailable");
    assert_eq!(err.message, "The model endpoint answered HTTP 401.");
    // Only one capability call; the transport saw the request but the reply's
    // body was never handed to `chat_result` (no decode happens for non-2xx).
    assert_eq!(h.capability_calls().len(), 1);
    h.close().await;
}

// TS: read the key through the host — a null value sends no Authorization.
#[tokio::test]
async fn null_key_sends_no_authorization() {
    let fake = Arc::new(FakeTransport::new());
    script_ok(
        &fake,
        200,
        json!({ "choices": [{ "message": { "content": "x" } }] }),
    );
    let mut h = Harness::start(plugin_with_fake(fake.clone()), Default::default()).await;
    h.on_capability("capability.secrets.resolve", |_| {
        Ok(json!({ "value": null }))
    });
    let _ = h.call("assistant.respond", params(2)).await.unwrap();
    let rec = fake.lock().recorded[0].clone();
    assert_eq!(rec.1, None);
    h.close().await;
}

// TS: respond — a transport deadline maps to plugin_timeout.
#[tokio::test]
async fn deadline_maps_to_plugin_timeout() {
    let fake = FakeTransport::new();
    fake.lock().scripts.push(Err(TransportError::Timeout));
    let cancel = CancellationToken::new();
    let err = respond(&params(2), None, &cancel, &fake).await.unwrap_err();
    assert_eq!(err.code, "plugin_timeout");
    assert_eq!(err.message, "The model did not answer in time.");
    // The deadline passed to the transport is 5000 ms.
    assert_eq!(fake.lock().recorded[0].3, Duration::from_millis(5000));
}

// TS: respond — an unreachable endpoint maps to plugin_unavailable.
#[tokio::test]
async fn unreachable_maps_to_plugin_unavailable() {
    let fake = FakeTransport::new();
    fake.lock().scripts.push(Err(TransportError::Unreachable));
    let cancel = CancellationToken::new();
    let err = respond(&params(2), None, &cancel, &fake).await.unwrap_err();
    assert_eq!(err.code, "plugin_unavailable");
    assert_eq!(err.message, "The model endpoint could not be reached.");
}

// TS: respond — a cancelled turn maps to plugin_unavailable "The turn was cancelled."
#[tokio::test]
async fn cancel_maps_to_turn_cancelled() {
    // A fake that never answers; the pre-cancelled token wins the select.
    let fake = FakeTransport::new();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let err = respond(&params(2), None, &cancel, &fake).await.unwrap_err();
    assert_eq!(err.code, "plugin_unavailable");
    assert_eq!(err.message, "The turn was cancelled.");
}

// TS: chatResult — no message is refused.
#[test]
fn no_message_is_refused() {
    let err = chat_result(&json!({ "choices": [] })).unwrap_err();
    assert_eq!(err.code, "plugin_refused");
    assert_eq!(err.message, "The model returned no message.");
}

// TS: chatResult — unparseable or missing-function tool calls default.
#[test]
fn tool_call_defaults() {
    let out = chat_result(&json!({
        "choices": [{
            "message": {
                "tool_calls": [
                    { "function": { "name": "a", "arguments": "not json" } },
                    { "function": {} }
                ]
            }
        }]
    }))
    .unwrap();
    assert_eq!(
        out["toolCalls"],
        json!([{ "id": "call-0", "name": "a", "arguments": {} }])
    );
}
