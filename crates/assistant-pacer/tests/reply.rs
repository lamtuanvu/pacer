//! Harness tests for `assistant.reply` against a fake openai-compatible endpoint.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;
use pacer_assistant_pacer::plugin;
use pacer_plugin::testing::{Harness, HelloSpec};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use support::{
    AnthropicScript, FakeAnthropic, FakeGemini, FakeOpenAi, GeminiScript, ScriptedReply,
};

fn limits(max_tool_rounds: i64, deadline_ms: i64) -> Value {
    json!({
        "maxInputTokens": 8000,
        "maxOutputTokens": 1024,
        "maxToolRounds": max_tool_rounds,
        "deadlineMs": deadline_ms
    })
}

fn base_params(message: &str, tools: Value, limits: Value, base_url: &str) -> Value {
    json!({
        "conversationId": "c1",
        "turnId": "t1",
        "account": "ep",
        "backend": "pacer",
        "model": "test-model",
        "system": "You are the pacer assistant.",
        "digest": "digest: quiet.",
        "tools": tools,
        "history": [],
        "message": message,
        "endpoint": { "api": "openai-compatible", "baseUrl": base_url },
        "limits": limits
    })
}

fn provider_params(
    api: &str,
    message: &str,
    tools: Value,
    limits: Value,
    base_url: Option<&str>,
) -> Value {
    let mut endpoint = json!({ "api": api });
    if let Some(url) = base_url {
        endpoint["baseUrl"] = json!(url);
    }
    json!({
        "conversationId": "c1",
        "turnId": "t1",
        "account": "ep",
        "backend": "pacer",
        "model": "test-model",
        "system": "You are the pacer assistant.",
        "digest": "digest: quiet.",
        "tools": tools,
        "history": [],
        "message": message,
        "endpoint": endpoint,
        "limits": limits
    })
}

fn keyless_params(message: &str, tools: Value, limits: Value, base_url: &str) -> Value {
    let mut params = base_params(message, tools, limits, base_url);
    params["endpoint"]["keyless"] = json!(true);
    params
}

async fn start_harness() -> Harness {
    let mut h = Harness::start(
        plugin(),
        HelloSpec {
            config: json!({}),
            grants: vec![
                "secrets.resolve".into(),
                "net.http".into(),
                "assistant.tool".into(),
            ],
        },
    )
    .await;
    h.on_capability("capability.secrets.resolve", |_| {
        Ok(json!({ "value": "test-key" }))
    });
    h
}

#[tokio::test]
async fn missing_endpoint_fails_closed() {
    let fake = FakeOpenAi::start(VecDeque::from([ScriptedReply::Text {
        content: "should not run".into(),
        usage: (1, 1),
    }]))
    .await;
    let mut h = start_harness().await;
    let mut params = base_params("hi", json!([]), limits(0, 30_000), &fake.base_url);
    params.as_object_mut().unwrap().remove("endpoint");
    let err = h
        .call("assistant.reply", params)
        .await
        .expect_err("no endpoint");
    assert_eq!(err.code, "plugin_unavailable");
    assert!(fake.requests.lock().unwrap().is_empty());
    h.close().await;
}

#[tokio::test]
async fn missing_secret_fails_closed() {
    let fake = FakeOpenAi::start(VecDeque::from([ScriptedReply::Text {
        content: "should not run".into(),
        usage: (1, 1),
    }]))
    .await;
    let mut h = start_harness().await;
    h.on_capability("capability.secrets.resolve", |_| {
        Ok(json!({ "value": null }))
    });
    let err = h
        .call(
            "assistant.reply",
            base_params("hi", json!([]), limits(0, 30_000), &fake.base_url),
        )
        .await
        .expect_err("null key");
    assert_eq!(err.code, "plugin_unavailable");
    assert!(fake.requests.lock().unwrap().is_empty());
    h.close().await;
}

#[tokio::test]
async fn plain_answer() {
    let fake = FakeOpenAi::start(VecDeque::from([ScriptedReply::Text {
        content: "Hello from the model.".into(),
        usage: (11, 5),
    }]))
    .await;
    let mut h = start_harness().await;
    let result = h
        .call(
            "assistant.reply",
            base_params("hi", json!([]), limits(0, 30_000), &fake.base_url),
        )
        .await
        .expect("reply");
    assert_eq!(result["message"], "Hello from the model.");
    assert_eq!(result["usage"]["input"], 11);
    assert_eq!(result["usage"]["output"], 5);
    assert_eq!(result["usage"]["coverage"], "measured");
    assert!(result.get("session").is_none() || result["session"].is_null());
    let deltas: Vec<_> = h
        .notifications()
        .into_iter()
        .filter(|(m, _)| m == "assistant.delta")
        .collect();
    assert!(
        deltas.iter().any(|(_, p)| p["kind"] == "text"),
        "expected a text delta, got {deltas:?}"
    );
    let (auth, max_tokens) = {
        let reqs = fake.requests.lock().unwrap();
        (
            reqs[0].authorization.clone(),
            reqs[0].body["max_tokens"].clone(),
        )
    };
    assert_eq!(auth.as_deref(), Some("Bearer test-key"));
    assert_eq!(max_tokens, 1024);
    h.close().await;
}

#[tokio::test]
async fn keyless_endpoint_omits_authorization() {
    let fake = FakeOpenAi::start(VecDeque::from([ScriptedReply::Text {
        content: "local model".into(),
        usage: (4, 2),
    }]))
    .await;
    let mut h = start_harness().await;
    // secrets.resolve would return a key; keyless must not call it / must not send Authorization.
    h.on_capability("capability.secrets.resolve", |_| {
        panic!("keyless turns must not resolve a key");
    });
    let result = h
        .call(
            "assistant.reply",
            keyless_params("hi", json!([]), limits(0, 30_000), &fake.base_url),
        )
        .await
        .expect("keyless reply");
    assert_eq!(result["message"], "local model");
    assert!(
        fake.requests.lock().unwrap()[0].authorization.is_none(),
        "keyless must omit Authorization, got {:?}",
        fake.requests.lock().unwrap()[0].authorization
    );
    h.close().await;
}

#[tokio::test]
async fn empty_resolved_key_still_fails_closed() {
    let fake = FakeOpenAi::start(VecDeque::from([ScriptedReply::Text {
        content: "should not run".into(),
        usage: (1, 1),
    }]))
    .await;
    let mut h = start_harness().await;
    h.on_capability("capability.secrets.resolve", |_| {
        Ok(json!({ "value": "   " }))
    });
    let err = h
        .call(
            "assistant.reply",
            base_params("hi", json!([]), limits(0, 30_000), &fake.base_url),
        )
        .await
        .expect_err("whitespace key");
    assert_eq!(err.code, "plugin_unavailable");
    assert!(fake.requests.lock().unwrap().is_empty());
    h.close().await;
}

#[tokio::test]
async fn response_without_created_is_tolerated() {
    let fake = FakeOpenAi::start(VecDeque::from([ScriptedReply::TextWithoutCreated {
        content: "no created field".into(),
        usage: (3, 1),
    }]))
    .await;
    let mut h = start_harness().await;
    let result = h
        .call(
            "assistant.reply",
            base_params("hi", json!([]), limits(0, 30_000), &fake.base_url),
        )
        .await
        .expect("missing created");
    assert_eq!(result["message"], "no created field");
    h.close().await;
}

#[tokio::test]
async fn tool_call_loop_forwards_to_host() {
    let fake = FakeOpenAi::start(VecDeque::from([
        ScriptedReply::ToolCalls {
            calls: vec![(
                "call-1".into(),
                "snapshot".into(),
                json!({ "scope": "tasks" }),
            )],
            usage: (20, 8),
        },
        ScriptedReply::Text {
            content: "There are 3 tasks.".into(),
            usage: (40, 6),
        },
    ]))
    .await;
    let mut h = start_harness().await;
    let tool_hits = Arc::new(AtomicUsize::new(0));
    let hits = tool_hits.clone();
    h.on_capability("capability.assistant.tool", move |params| {
        hits.fetch_add(1, Ordering::SeqCst);
        assert_eq!(params["turnId"], "t1");
        assert_eq!(params["name"], "snapshot");
        Ok(json!({
            "name": "snapshot",
            "content": "<data tool=\"snapshot\">\n{\"open\":3}\n</data>",
            "ok": true
        }))
    });
    let tools = json!([{
        "name": "snapshot",
        "description": "Read a snapshot",
        "parameters": { "type": "object", "properties": { "scope": { "type": "string" } } }
    }]);
    let result = h
        .call(
            "assistant.reply",
            base_params("how many tasks?", tools, limits(2, 30_000), &fake.base_url),
        )
        .await
        .expect("reply");
    assert_eq!(result["message"], "There are 3 tasks.");
    assert_eq!(tool_hits.load(Ordering::SeqCst), 1);
    let caps: Vec<_> = h
        .capability_calls()
        .into_iter()
        .filter(|(m, _)| m == "capability.assistant.tool")
        .collect();
    assert_eq!(caps.len(), 1);
    let activity = h
        .notifications()
        .into_iter()
        .any(|(m, p)| m == "assistant.delta" && p["kind"] == "activity");
    assert!(activity, "expected an activity delta for the tool");
    // Tool message content must be the host text as-is (not a JSON string literal of it).
    let second_body = fake.requests.lock().unwrap()[1].body.clone();
    let tool_msg = second_body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|m| m["role"] == "tool")
        .expect("tool message on second request");
    let tool_text = match &tool_msg["content"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .find_map(|p| p.get("text").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default(),
        other => panic!("unexpected tool content shape: {other}"),
    };
    assert!(
        tool_text.starts_with("<data tool="),
        "tool content must start with <data tool=, got {tool_text:?}"
    );
    assert!(
        !tool_text.starts_with('"'),
        "tool content must not be a JSON-encoded string, got {tool_text:?}"
    );
    h.close().await;
}

#[tokio::test]
async fn max_tool_rounds_cap() {
    let script = (0..8)
        .map(|i| ScriptedReply::ToolCalls {
            calls: vec![(format!("call-{i}"), "snapshot".into(), json!({}))],
            usage: (10, 2),
        })
        .collect::<VecDeque<_>>();
    let fake = FakeOpenAi::start(script).await;
    let mut h = start_harness().await;
    let rounds = Arc::new(AtomicUsize::new(0));
    let count = rounds.clone();
    h.on_capability("capability.assistant.tool", move |_| {
        count.fetch_add(1, Ordering::SeqCst);
        Ok(json!({ "name": "snapshot", "content": "ok", "ok": true }))
    });
    let tools = json!([{
        "name": "snapshot",
        "description": "Read",
        "parameters": { "type": "object" }
    }]);
    let _ = h
        .call(
            "assistant.reply",
            base_params("loop", tools, limits(2, 30_000), &fake.base_url),
        )
        .await;
    let used = rounds.load(Ordering::SeqCst);
    assert!(
        used <= 2,
        "expected at most 2 tool rounds, got {used}; requests={}",
        fake.requests.lock().unwrap().len()
    );
    assert!(
        used >= 1,
        "expected the model to call the tool at least once"
    );
    h.close().await;
}

#[tokio::test]
async fn deadline_stops_a_hanging_model() {
    let fake = FakeOpenAi::start(VecDeque::from([ScriptedReply::Hang])).await;
    let mut h = start_harness().await;
    let started = std::time::Instant::now();
    let err = h
        .call(
            "assistant.reply",
            base_params("slow", json!([]), limits(0, 1000), &fake.base_url),
        )
        .await
        .expect_err("deadline");
    assert_eq!(err.code, "plugin_timeout");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "took {:?}",
        started.elapsed()
    );
    h.close().await;
}

#[tokio::test]
async fn cancellation_aborts_promptly() {
    let fake = FakeOpenAi::start(VecDeque::from([ScriptedReply::Hang])).await;
    let mut h = start_harness().await;
    let id = h
        .start_call(
            "assistant.reply",
            base_params("cancel-me", json!([]), limits(0, 60_000), &fake.base_url),
        )
        .expect("start");
    tokio::time::sleep(Duration::from_millis(150)).await;
    let started = std::time::Instant::now();
    h.cancel(&id);
    // Give the plugin a moment to observe cancel; then close.
    tokio::time::sleep(Duration::from_millis(300)).await;
    h.close().await;
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "cancel did not stop promptly: {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn only_passed_in_tools_are_offered() {
    let fake = FakeOpenAi::start(VecDeque::from([ScriptedReply::Text {
        content: "ok".into(),
        usage: (3, 1),
    }]))
    .await;
    let mut h = start_harness().await;
    let tools = json!([
        { "name": "snapshot", "description": "A", "parameters": { "type": "object" } },
        { "name": "propose_action", "description": "B", "parameters": { "type": "object" } }
    ]);
    let _ = h
        .call(
            "assistant.reply",
            base_params("tools?", tools, limits(2, 30_000), &fake.base_url),
        )
        .await
        .expect("reply");
    let offered = fake.tool_names_offered();
    assert_eq!(offered.len(), 1);
    let mut names = offered[0].clone();
    names.sort();
    assert_eq!(names, vec!["propose_action", "snapshot"]);
    assert!(!names.iter().any(|n| n == "shell" || n == "web_fetch"));
    h.close().await;
}

#[tokio::test]
async fn no_tools_when_max_tool_rounds_is_zero() {
    let fake = FakeOpenAi::start(VecDeque::from([ScriptedReply::Text {
        content: "done".into(),
        usage: (2, 1),
    }]))
    .await;
    let mut h = start_harness().await;
    let tools = json!([
        { "name": "snapshot", "description": "A", "parameters": { "type": "object" } }
    ]);
    let _ = h
        .call(
            "assistant.reply",
            base_params("no tools", tools, limits(0, 30_000), &fake.base_url),
        )
        .await
        .expect("reply");
    let offered = fake.tool_names_offered();
    assert_eq!(offered, vec![Vec::<String>::new()]);
    h.close().await;
}

#[tokio::test]
async fn input_cap_stops_before_another_completion() {
    // First completion is a tool call; the huge tool result then exceeds maxInputTokens
    // before a second completion is sent.
    let fake = FakeOpenAi::start(VecDeque::from([
        ScriptedReply::ToolCalls {
            calls: vec![("call-1".into(), "snapshot".into(), json!({}))],
            usage: (50, 5),
        },
        ScriptedReply::Text {
            content: "should not run".into(),
            usage: (1, 1),
        },
    ]))
    .await;
    let mut h = start_harness().await;
    h.on_capability("capability.assistant.tool", |_| {
        Ok(json!({
            "name": "snapshot",
            "content": "X".repeat(8_000),
            "ok": true
        }))
    });
    let tools = json!([{
        "name": "snapshot",
        "description": "Read",
        "parameters": { "type": "object" }
    }]);
    let tight = json!({
        "maxInputTokens": 200,
        "maxOutputTokens": 1024,
        "maxToolRounds": 4,
        "deadlineMs": 30_000
    });
    let result = h
        .call(
            "assistant.reply",
            base_params("cap", tools, tight, &fake.base_url),
        )
        .await
        .expect("input cap returns a reply");
    let msg = result["message"].as_str().unwrap_or("");
    assert!(
        msg.contains("input limit") || !msg.contains("should not run"),
        "unexpected message: {msg}"
    );
    assert_eq!(
        fake.requests.lock().unwrap().len(),
        1,
        "second completion must not run past the input cap"
    );
    assert!(result["usage"]["input"].as_i64().unwrap_or(0) >= 50);
    h.close().await;
}

#[tokio::test]
async fn max_depth_reports_accumulated_usage() {
    let script = (0..4)
        .map(|i| ScriptedReply::ToolCalls {
            calls: vec![(format!("call-{i}"), "snapshot".into(), json!({}))],
            usage: (30, 7),
        })
        .collect::<VecDeque<_>>();
    let fake = FakeOpenAi::start(script).await;
    let mut h = start_harness().await;
    h.on_capability("capability.assistant.tool", |_| {
        Ok(json!({ "name": "snapshot", "content": "ok", "ok": true }))
    });
    let tools = json!([{
        "name": "snapshot",
        "description": "Read",
        "parameters": { "type": "object" }
    }]);
    // depth = max_tool_rounds + 1 = 2; forcing MaxDepth after tool rounds.
    let result = h
        .call(
            "assistant.reply",
            base_params("depth", tools, limits(1, 30_000), &fake.base_url),
        )
        .await
        .expect("max-depth still returns a result");
    let input = result["usage"]["input"].as_i64().unwrap_or(0);
    let output = result["usage"]["output"].as_i64().unwrap_or(0);
    assert!(
        input > 0 || output > 0,
        "max-depth path must report real usage, got {:?}",
        result["usage"]
    );
    assert_eq!(result["usage"]["coverage"], "measured");
    h.close().await;
}

#[tokio::test]
async fn provider_error_hides_key_material() {
    let secret = "sk-leaked-provider-key-VALUE";
    let fake = FakeOpenAi::start(VecDeque::from([ScriptedReply::HttpError {
        status: 401,
        body: format!("unauthorized key={secret} in request"),
    }]))
    .await;
    let mut h = start_harness().await;
    let err = h
        .call(
            "assistant.reply",
            base_params("boom", json!([]), limits(0, 30_000), &fake.base_url),
        )
        .await
        .expect_err("provider error");
    assert_eq!(err.code, "plugin_unavailable");
    assert!(
        !err.message.contains(secret),
        "user-visible error leaked key: {}",
        err.message
    );
    assert!(err.message.contains("model call failed"));
    h.close().await;
}

#[tokio::test]
async fn remaining_output_budget_is_passed_per_call() {
    // R3: each call gets the unused remainder of maxOutputTokens, not the full turn budget.
    let fake = FakeOpenAi::start(VecDeque::from([
        ScriptedReply::ToolCalls {
            calls: vec![("call-1".into(), "snapshot".into(), json!({}))],
            usage: (10, 40),
        },
        ScriptedReply::Text {
            content: "done".into(),
            usage: (20, 5),
        },
    ]))
    .await;
    let mut h = start_harness().await;
    h.on_capability("capability.assistant.tool", |_| {
        Ok(json!({ "name": "snapshot", "content": "ok", "ok": true }))
    });
    let tools = json!([{
        "name": "snapshot",
        "description": "Read",
        "parameters": { "type": "object" }
    }]);
    let tight = json!({
        "maxInputTokens": 8000,
        "maxOutputTokens": 100,
        "maxToolRounds": 2,
        "deadlineMs": 30_000
    });
    let result = h
        .call(
            "assistant.reply",
            base_params("budget", tools, tight, &fake.base_url),
        )
        .await
        .expect("reply");
    assert_eq!(result["message"], "done");
    let maxes: Vec<u64> = fake
        .requests
        .lock()
        .unwrap()
        .iter()
        .map(|r| r.body["max_tokens"].as_u64().unwrap())
        .collect();
    assert_eq!(maxes.len(), 2);
    assert_eq!(maxes[0], 100);
    assert_eq!(
        maxes[1], 60,
        "second call must see remaining budget, got {maxes:?}"
    );
    assert_eq!(result["usage"]["output"], 45);
    h.close().await;
}

#[tokio::test]
async fn anthropic_plain_answer_and_tool_round() {
    let fake = FakeAnthropic::start(VecDeque::from([
        AnthropicScript::ToolUse {
            id: "tu1".into(),
            name: "snapshot".into(),
            input: json!({}),
            usage: (12, 4),
        },
        AnthropicScript::Text {
            content: "From Anthropic.".into(),
            usage: (20, 6),
        },
    ]))
    .await;
    let mut h = start_harness().await;
    h.on_capability("capability.assistant.tool", |_| {
        Ok(json!({ "name": "snapshot", "content": "ok", "ok": true }))
    });
    let tools = json!([{
        "name": "snapshot",
        "description": "Read",
        "parameters": { "type": "object" }
    }]);
    let result = h
        .call(
            "assistant.reply",
            provider_params(
                "anthropic",
                "hi",
                tools,
                limits(2, 30_000),
                Some(&fake.base_url),
            ),
        )
        .await
        .expect("anthropic reply");
    assert_eq!(result["message"], "From Anthropic.");
    assert_eq!(
        fake.requests.lock().unwrap()[0].api_key.as_deref(),
        Some("test-key")
    );
    assert_eq!(fake.requests.lock().unwrap()[0].body["max_tokens"], 1024);
    assert_eq!(fake.requests.lock().unwrap().len(), 2);
    h.close().await;
}

#[tokio::test]
async fn anthropic_default_base_url_when_omitted() {
    // Without a fake on the real Anthropic host this fails closed as a transport/provider error —
    // proving the plugin accepts a missing baseUrl for anthropic (does not require endpoint.baseUrl).
    let mut h = start_harness().await;
    let err = h
        .call(
            "assistant.reply",
            provider_params("anthropic", "hi", json!([]), limits(0, 2_000), None),
        )
        .await
        .expect_err("real anthropic unreachable");
    assert_eq!(err.code, "plugin_unavailable");
    h.close().await;
}

#[tokio::test]
async fn anthropic_provider_error_class() {
    let fake = FakeAnthropic::start(VecDeque::from([AnthropicScript::HttpError {
        status: 429,
        body: "rate limited".into(),
    }]))
    .await;
    let mut h = start_harness().await;
    let err = h
        .call(
            "assistant.reply",
            provider_params(
                "anthropic",
                "hi",
                json!([]),
                limits(0, 30_000),
                Some(&fake.base_url),
            ),
        )
        .await
        .expect_err("rate limit");
    assert_eq!(err.code, "plugin_unavailable");
    assert!(err.message.contains("rate limited") || err.message.contains("model call failed"));
    h.close().await;
}

#[tokio::test]
async fn gemini_plain_answer() {
    let fake = FakeGemini::start(VecDeque::from([GeminiScript::Text {
        content: "From Gemini.".into(),
        usage: (8, 3),
    }]))
    .await;
    let mut h = start_harness().await;
    let result = h
        .call(
            "assistant.reply",
            provider_params(
                "gemini",
                "hi",
                json!([]),
                limits(0, 30_000),
                Some(&fake.base_url),
            ),
        )
        .await
        .expect("gemini reply");
    assert_eq!(result["message"], "From Gemini.");
    assert_eq!(
        fake.requests.lock().unwrap()[0].api_key.as_deref(),
        Some("test-key")
    );
    let max_out =
        fake.requests.lock().unwrap()[0].body["generationConfig"]["maxOutputTokens"].as_u64();
    assert_eq!(max_out, Some(1024));
    h.close().await;
}

#[tokio::test]
async fn gemini_tool_round() {
    let fake = FakeGemini::start(VecDeque::from([
        GeminiScript::FunctionCall {
            name: "snapshot".into(),
            args: json!({}),
            usage: (8, 3),
        },
        GeminiScript::Text {
            content: "From Gemini.".into(),
            usage: (15, 4),
        },
    ]))
    .await;
    let mut h = start_harness().await;
    h.on_capability("capability.assistant.tool", |_| {
        Ok(json!({ "name": "snapshot", "content": "ok", "ok": true }))
    });
    // Empty properties: Rig's Gemini Schema conversion rejects bare `{type:object}`.
    let tools = json!([{
        "name": "snapshot",
        "description": "Read",
        "parameters": { "type": "object", "properties": {} }
    }]);
    let result = h
        .call(
            "assistant.reply",
            provider_params(
                "gemini",
                "hi",
                tools,
                limits(2, 30_000),
                Some(&fake.base_url),
            ),
        )
        .await
        .expect("gemini tool round");
    assert_eq!(result["message"], "From Gemini.");
    assert_eq!(fake.requests.lock().unwrap().len(), 2);
    h.close().await;
}

#[tokio::test]
async fn gemini_provider_error_class() {
    let fake = FakeGemini::start(VecDeque::from([GeminiScript::HttpError {
        status: 401,
        body: "bad key".into(),
    }]))
    .await;
    let mut h = start_harness().await;
    let err = h
        .call(
            "assistant.reply",
            provider_params(
                "gemini",
                "hi",
                json!([]),
                limits(0, 30_000),
                Some(&fake.base_url),
            ),
        )
        .await
        .expect_err("auth");
    assert_eq!(err.code, "plugin_unavailable");
    assert!(err.message.contains("auth") || err.message.contains("model call failed"));
    h.close().await;
}

#[tokio::test]
async fn keyless_rejected_for_anthropic() {
    let fake = FakeAnthropic::start(VecDeque::from([AnthropicScript::Text {
        content: "no".into(),
        usage: (1, 1),
    }]))
    .await;
    let mut h = start_harness().await;
    let mut params = provider_params(
        "anthropic",
        "hi",
        json!([]),
        limits(0, 30_000),
        Some(&fake.base_url),
    );
    params["endpoint"]["keyless"] = json!(true);
    let err = h
        .call("assistant.reply", params)
        .await
        .expect_err("keyless anthropic");
    assert_eq!(err.code, "invalid_input");
    assert!(fake.requests.lock().unwrap().is_empty());
    h.close().await;
}
