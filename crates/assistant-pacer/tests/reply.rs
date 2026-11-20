//! Harness tests for `assistant.reply` against a fake openai-compatible endpoint.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;
use support::{FakeOpenAi, ScriptedReply};
use pacer_assistant_pacer::plugin;
use pacer_plugin::testing::{Harness, HelloSpec};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

fn limits(max_tool_rounds: i64, deadline_ms: i64) -> Value {
    json!({
        "maxInputTokens": 8000,
        "maxOutputTokens": 1024,
        "maxToolRounds": max_tool_rounds,
        "deadlineMs": deadline_ms
    })
}

fn base_params(message: &str, tools: Value, limits: Value) -> Value {
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
        "limits": limits
    })
}

async fn start_harness(base_url: &str) -> Harness {
    let mut h = Harness::start(
        plugin(),
        HelloSpec {
            config: json!({ "baseUrl": base_url }),
            grants: vec![
                "secrets.resolve".into(),
                "net.http".into(),
                "assistant.tool".into(),
                "config.get".into(),
            ],
        },
    )
    .await;
    let url = base_url.to_owned();
    h.on_capability("capability.config.get", move |_| {
        Ok(json!({ "config": { "baseUrl": url } }))
    });
    h.on_capability("capability.secrets.resolve", |_| {
        Ok(json!({ "value": "test-key" }))
    });
    h
}

#[tokio::test]
async fn missing_secret_fails_closed() {
    let fake = FakeOpenAi::start(VecDeque::from([ScriptedReply::Text {
        content: "should not run".into(),
        usage: (1, 1),
    }]))
    .await;
    let mut h = start_harness(&fake.base_url).await;
    h.on_capability("capability.secrets.resolve", |_| Ok(json!({ "value": null })));
    let err = h
        .call(
            "assistant.reply",
            base_params("hi", json!([]), limits(0, 30_000)),
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
    let mut h = start_harness(&fake.base_url).await;
    let result = h
        .call(
            "assistant.reply",
            base_params("hi", json!([]), limits(0, 30_000)),
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
    assert_eq!(
        fake.requests.lock().unwrap()[0].authorization.as_deref(),
        Some("Bearer test-key")
    );
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
    let mut h = start_harness(&fake.base_url).await;
    let tool_hits = Arc::new(AtomicUsize::new(0));
    let hits = tool_hits.clone();
    h.on_capability("capability.assistant.tool", move |params| {
        hits.fetch_add(1, Ordering::SeqCst);
        assert_eq!(params["turnId"], "t1");
        assert_eq!(params["name"], "snapshot");
        Ok(json!({
            "name": "snapshot",
            "content": "<data>3 tasks</data>",
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
            base_params("how many tasks?", tools, limits(2, 30_000)),
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
    let mut h = start_harness(&fake.base_url).await;
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
            base_params("loop", tools, limits(2, 30_000)),
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
    let mut h = start_harness(&fake.base_url).await;
    let started = std::time::Instant::now();
    let err = h
        .call(
            "assistant.reply",
            base_params("slow", json!([]), limits(0, 1000)),
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
    let mut h = start_harness(&fake.base_url).await;
    let id = h
        .start_call(
            "assistant.reply",
            base_params("cancel-me", json!([]), limits(0, 60_000)),
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
    let mut h = start_harness(&fake.base_url).await;
    let tools = json!([
        { "name": "snapshot", "description": "A", "parameters": { "type": "object" } },
        { "name": "propose_action", "description": "B", "parameters": { "type": "object" } }
    ]);
    let _ = h
        .call(
            "assistant.reply",
            base_params("tools?", tools, limits(2, 30_000)),
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
    let mut h = start_harness(&fake.base_url).await;
    let tools = json!([
        { "name": "snapshot", "description": "A", "parameters": { "type": "object" } }
    ]);
    let _ = h
        .call(
            "assistant.reply",
            base_params("no tools", tools, limits(0, 30_000)),
        )
        .await
        .expect("reply");
    let offered = fake.tool_names_offered();
    assert_eq!(offered, vec![Vec::<String>::new()]);
    h.close().await;
}
