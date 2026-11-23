//! End-to-end handler tests driven through the in-process [`Harness`], ported
//! from `test/plugins-classify-handler.test.ts` (C6). `classifier.adapters`
//! reads `host.config`; `classifier.ask` reads only the supplied snapshot and
//! dispatches over `net.http` / `secrets.check` for the external adapters.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_bundled_classify::plugin_with;
use pacer_plugin::testing::{Harness, HelloSpec};
use serde_json::{Value, json};
use std::sync::Arc;

const ADAPTERS: &str = "classifier.adapters";
const ASK: &str = "classifier.ask";

const PROJECTION: &str = r#"{
  "adapters": {
    "rules": {},
    "ollama": { "baseUrl": "http://localhost:1234/v1", "model": "fixture", "maxTokens": 512, "keyRef": null },
    "jev": { "baseUrl": "https://api.typesafe.ai", "model": "fixture", "keyRef": "env:FIXTURE", "usdPerMtokIn": null, "usdPerMtokOut": null }
  }
}"#;

async fn start_with_config(config: Value) -> Harness {
    let mut hello = HelloSpec::default();
    hello.config = config.clone();
    let mut host = Harness::start(plugin_with(Arc::new(|| 0.0)), hello).await;
    // The adapters handler reads `capability.config.get`, which the harness
    // answers only when scripted (as the TS host overrides `host.config`).
    let served = config;
    host.on_capability("capability.config.get", move |_| Ok(json!({ "config": served.clone() })));
    host
}

fn ask(adapter: &str, config: Value, extra: serde_json::Map<String, Value>) -> Value {
    let mut params = serde_json::Map::new();
    params.insert("adapter".into(), json!(adapter));
    params.insert("config".into(), config);
    params.insert(
        "state".into(),
        json!(r#"{"goal":"add tests"}"#),
    );
    params.insert(
        "question".into(),
        json!({ "type": "choice", "id": "task_kind", "instructions": "classify", "criteria": { "tests": "tests", "default": "other" } }),
    );
    params.insert("timeoutMs".into(), json!(0.5));
    for (k, v) in extra {
        params.insert(k, v);
    }
    Value::Object(params)
}

#[tokio::test]
async fn adapters_uses_configured_url_and_refuses_absent_projection() {
    // TS: plugins-classify-handler.test.ts:13.
    let mut host = start_with_config(serde_json::from_str(PROJECTION).unwrap()).await;
    let result = host.call(ADAPTERS, json!({})).await.unwrap();
    assert_eq!(
        result,
        json!({
            "adapters": [
                { "id": "rules", "external": false },
                { "id": "ollama", "external": false },
                { "id": "jev", "external": true },
            ]
        })
    );
    host.close().await;

    // A remote ollama base URL marks ollama external.
    let mut remote = start_with_config(serde_json::from_str(
        r#"{"adapters":{"rules":{},"ollama":{"baseUrl":"https://remote.example/v1","model":"fixture","maxTokens":512,"keyRef":null},"jev":{"baseUrl":"https://api.typesafe.ai","model":"fixture","keyRef":"env:FIXTURE","usdPerMtokIn":null,"usdPerMtokOut":null}}}"#,
    )
    .unwrap())
    .await;
    let result = remote.call(ADAPTERS, json!({})).await.unwrap();
    assert_eq!(result["adapters"][1]["external"], json!(true));
    remote.close().await;

    // An absent/empty projection is rejected.
    let mut empty = start_with_config(json!({})).await;
    let error = empty.call(ADAPTERS, json!({})).await.unwrap_err();
    assert_eq!(error.code, "invalid_input");
    empty.close().await;
}

#[tokio::test]
async fn rules_dispatch_preserves_reading_and_timeout_domain() {
    // TS: plugins-classify-handler.test.ts:9.
    let mut host = start_with_config(json!({})).await;
    for timeout in [0.5, 120001.0, 9e15] {
        let params = ask("rules", json!({}), serde_json::Map::new());
        let mut map = params.as_object().unwrap().clone();
        map.insert("timeoutMs".into(), json!(timeout));
        let result = host.call(ASK, Value::Object(map)).await.unwrap();
        assert_eq!(result["value"], json!("tests"));
        assert_eq!(result["confidence"], json!(0.7));
        assert_eq!(result["latencyMs"], json!(0));
        assert_eq!(result["costUsd"], json!(0));
    }
    host.close().await;
}

#[tokio::test]
async fn handler_refuses_invalid_input_before_capabilities() {
    // TS: plugins-classify-handler.test.ts:10-11.
    let mut host = start_with_config(json!({})).await;
    let base = ask("rules", json!({}), serde_json::Map::new());
    let bad_cases: Vec<Value> = vec![
        json!({ "adapter": "rules", "state": "x", "question": base["question"].clone(), "timeoutMs": 1 }),
        ask("rules", json!({ "key": "value" }), serde_json::Map::new()),
        ask("unknown", json!({}), serde_json::Map::new()),
        ask("rules", json!({}), serde_json::Map::from_iter([("state".into(), json!(7))])),
        ask("rules", json!({}), serde_json::Map::from_iter([("timeoutMs".into(), json!(0))])),
        ask("rules", json!({}), serde_json::Map::from_iter([("question".into(), json!({ "type": "bad" }))])),
        ask(
            "ollama",
            json!({ "baseUrl": "http://localhost", "model": "x", "maxTokens": 1, "keyRef": null, "apiKey": "secret" }),
            serde_json::Map::new(),
        ),
        ask(
            "ollama",
            json!({ "baseUrl": "http://localhost", "model": "x", "maxTokens": 1, "keyRef": "raw-secret" }),
            serde_json::Map::new(),
        ),
    ];
    for bad in &bad_cases {
        let error = host.call(ASK, bad.clone()).await.unwrap_err();
        assert_eq!(error.code, "invalid_input", "for {bad}");
    }
    host.close().await;
}

#[tokio::test]
async fn ask_uses_supplied_snapshot_without_consulting_mutable_host_config() {
    // TS: plugins-classify-handler.test.ts:19 — the ollama ask must read only
    // the supplied config, never `host.config`.
    let mut host = start_with_config(json!({})).await;
    host.on_capability("capability.config.get", |_| Err(("internal".into(), "must not read config".into())));
    let ollama_cfg = json!({ "baseUrl": "http://localhost:1234/v1", "model": "fixture", "maxTokens": 512, "keyRef": null });
    host.on_capability("capability.net.http", |request| {
        assert_eq!(request["url"], json!("http://localhost:1234/v1/chat/completions"));
        assert_eq!(serde_json::from_str::<Value>(request["body"].as_str().unwrap()).unwrap()["model"], json!("fixture"));
        Ok(json!({
            "status": 200,
            "headers": {},
            "body": r#"{"choices":[{"message":{"content":"{\"choice\":\"tests\",\"confidence\":0.8}"}}]}"#,
        }))
    });
    let params = ask("ollama", ollama_cfg, serde_json::Map::new());
    let result = host.call(ASK, params).await.unwrap();
    assert_eq!(result["value"], json!("tests"));
    assert_eq!(result["confidence"], json!(0.8));
    assert_eq!(result["costUsd"], json!(0));
    assert!(!host.capability_calls().iter().any(|(m, _)| m == "capability.config.get"));
    host.close().await;
}

#[tokio::test]
async fn adapters_reads_real_host_config() {
    // The real flow: `adapters` reads the config the host serves at hello.
    let mut host = start_with_config(json!({
        "adapters": {
            "rules": {},
            "ollama": { "baseUrl": "http://localhost:1234/v1", "model": "m", "maxTokens": 16, "keyRef": null },
            "jev": { "baseUrl": "https://api.typesafe.ai", "model": "m", "keyRef": "env:X", "usdPerMtokIn": null, "usdPerMtokOut": null },
        }
    }))
    .await;
    let result = host.call(ADAPTERS, json!({})).await.unwrap();
    assert_eq!(result["adapters"][0]["id"], json!("rules"));
    host.close().await;
}