//! Delivery tests for input and configuration validation, ported from
//! `test/plugins-classify-handler.test.ts` (C6). Every failure must map to
//! `invalid_input` with zod's single message.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_bundled_classify::config;
use serde_json::json;

fn valid_adapter() -> serde_json::Value {
    json!({
        "adapters": {
            "rules": {},
            "ollama": { "baseUrl": "http://localhost:1234/v1", "model": "fixture", "maxTokens": 512, "keyRef": null },
            "jev": { "baseUrl": "https://api.typesafe.ai", "model": "fixture", "keyRef": "env:FIXTURE", "usdPerMtokIn": null, "usdPerMtokOut": null },
        }
    })
}

#[test]
fn rules_config_must_be_empty_object() {
    config::parse_rules_config(&json!({})).unwrap();
    for bad in [json!({ "key": "value" }), json!({"a": 1}), json!([]), json!("x"), json!(null)] {
        let e = config::parse_rules_config(&bad).unwrap_err();
        assert_eq!(e.code, "invalid_input", "rules config {bad}");
    }
}

#[test]
fn ollama_config_strict_keys_and_types() {
    let ok = config::parse_ollama_config(
        &json!({ "baseUrl": "https://models.example.com/v1", "model": "m", "maxTokens": 512, "keyRef": "secrets:K" }),
    )
    .unwrap();
    assert_eq!(ok.model, "m");
    assert_eq!(ok.key_ref.as_deref(), Some("secrets:K"));

    for bad in [
        json!({ "baseUrl": "http://localhost", "model": "x", "maxTokens": 1, "keyRef": null, "apiKey": "secret" }),
        json!({ "baseUrl": "http://localhost", "model": "x", "maxTokens": 1, "keyRef": "raw-secret" }),
        json!({ "baseUrl": "not-a-url", "model": "x", "maxTokens": 1, "keyRef": null }),
        json!({ "baseUrl": "ftp://localhost", "model": "x", "maxTokens": 1, "keyRef": null }),
        json!({ "baseUrl": "http://user:pass@localhost", "model": "x", "maxTokens": 1, "keyRef": null }),
        json!({ "baseUrl": "http://localhost", "model": "", "maxTokens": 1, "keyRef": null }),
        json!({ "baseUrl": "http://localhost", "model": "x", "maxTokens": 0, "keyRef": null }),
        json!({ "baseUrl": "http://localhost", "model": "x", "maxTokens": 1.5, "keyRef": null }),
    ] {
        let e = config::parse_ollama_config(&bad).unwrap_err();
        assert_eq!(e.code, "invalid_input", "ollama config {bad}");
    }
}

#[test]
fn jev_config_strict_keys_and_nonnegative_nullable_prices() {
    let ok = config::parse_jev_config(
        &json!({ "baseUrl": "https://api.typesafe.ai", "model": "m", "keyRef": "secrets:K", "usdPerMtokIn": 2, "usdPerMtokOut": null }),
    )
    .unwrap();
    assert_eq!(ok.usd_per_mtok_in, Some(2.0));
    assert_eq!(ok.usd_per_mtok_out, None);

    for bad in [
        json!({ "baseUrl": "https://api.typesafe.ai", "model": "m", "keyRef": "secrets:K", "usdPerMtokIn": -1, "usdPerMtokOut": null }),
        json!({ "baseUrl": "https://api.typesafe.ai", "model": "m", "keyRef": "raw", "usdPerMtokIn": null, "usdPerMtokOut": null }),
        json!({ "baseUrl": "https://api.typesafe.ai", "model": "m", "keyRef": "secrets:K", "usdPerMtokIn": null }),
        json!({ "baseUrl": "https://api.typesafe.ai", "model": "m", "keyRef": "secrets:K", "usdPerMtokIn": null, "usdPerMtokOut": null, "extra": 1 }),
    ] {
        let e = config::parse_jev_config(&bad).unwrap_err();
        assert_eq!(e.code, "invalid_input", "jev config {bad}");
    }
}

#[test]
fn adapter_config_validates_all_three_adapters() {
    let parsed = config::parse_adapter_config(&valid_adapter()).unwrap();
    assert_eq!(parsed.ollama.model, "fixture");
    assert_eq!(parsed.jev.key_ref, "env:FIXTURE");

    for bad in [
        json!({}),
        json!({ "adapters": {} }),
        json!({ "adapters": { "rules": {}, "ollama": {} } }),
        json!({ "adapters": { "rules": {}, "ollama": {}, "jev": {} } }),
        json!({ "adapters": { "rules": {}, "ollama": {}, "jev": {}, "extra": {} } }),
    ] {
        let e = config::parse_adapter_config(&bad).unwrap_err();
        assert_eq!(e.code, "invalid_input", "adapter config {bad}");
    }
}

#[test]
fn question_union_accepts_choice_score_and_yesno() {
    let choice = config::parse_question(&json!({
        "type": "choice", "id": "task_kind", "instructions": "classify",
        "criteria": { "tests": "tests", "default": "other" }
    }))
    .unwrap();
    assert_eq!(choice.id(), "task_kind");
    assert_eq!(choice.kind(), "choice");

    let score = config::parse_question(&json!({
        "type": "score", "id": "difficulty", "instructions": "score", "min": 0, "max": 1
    }))
    .unwrap();
    assert_eq!(score.kind(), "score");

    let yesno = config::parse_question(&json!({
        "type": "yesno", "id": "guard", "instructions": "execute?"
    }))
    .unwrap();
    assert_eq!(yesno.kind(), "yesno");

    for bad in [
        json!({ "type": "bad" }),
        json!({ "type": "choice", "id": "x", "instructions": "y", "criteria": { "a": 1 } }),
        json!({ "type": "choice", "id": "x", "instructions": "y", "criteria": {}, "extra": 1 }),
        json!({ "type": "score", "id": "x", "instructions": "y", "min": 0 }),
        json!({ "type": "yesno" }),
    ] {
        let e = config::parse_question(&bad).unwrap_err();
        assert_eq!(e.code, "invalid_input", "question {bad}");
    }
}

#[test]
fn handler_refuses_missing_or_wrong_snapshot_and_invalid_input() {
    // Adapts test/plugins-classify-handler.test.ts:10.
    let valid_ask = json!({
        "adapter": "rules",
        "config": {},
        "state": "{\"goal\":\"add tests\"}",
        "question": { "type": "choice", "id": "task_kind", "instructions": "classify", "criteria": { "tests": "tests", "default": "other" } },
        "timeoutMs": 0.5,
    });

    for bad in [
        json!({ "adapter": "unknown", "config": {}, "state": "{}", "question": valid_ask["question"].clone(), "timeoutMs": 1 }),
        json!({ "adapter": "rules", "config": {}, "state": 7, "question": valid_ask["question"].clone(), "timeoutMs": 1 }),
        json!({ "adapter": "rules", "config": {}, "state": "{}", "question": valid_ask["question"].clone(), "timeoutMs": 0 }),
        json!({ "adapter": "rules", "config": {}, "state": "{}", "question": valid_ask["question"].clone(), "timeoutMs": serde_json::Value::Null }),
        json!({ "adapter": "rules", "config": {}, "state": "{}", "question": { "type": "bad" }, "timeoutMs": 1 }),
    ] {
        let e = config::parse_ask_input(&bad).unwrap_err();
        assert_eq!(e.code, "invalid_input", "ask input {bad}");
    }

    // `parse_ask_input` requires `config` to be present but carries any object
    // through verbatim (the adapter's own config validation runs at dispatch).
    // The configured-key checks for rules/ollama/jev live in handler.rs.
    let carried = config::parse_ask_input(&json!({
        "adapter": "rules",
        "config": { "k": "v" },
        "state": "{}",
        "question": valid_ask["question"].clone(),
        "timeoutMs": 1,
    }))
    .unwrap();
    assert_eq!(carried.config, json!({ "k": "v" }));

    let missing_config = json!({ "adapter": "rules", "state": "{}", "question": valid_ask["question"].clone(), "timeoutMs": 1 });
    let e = config::parse_ask_input(&missing_config).unwrap_err();
    assert_eq!(e.code, "invalid_input");
}

#[test]
fn ask_input_accepts_fractional_and_huge_timeouts_and_carries_config() {
    let question = json!({
        "type": "choice", "id": "task_kind", "instructions": "classify",
        "criteria": { "tests": "tests", "default": "other" }
    });
    for timeout in [0.5, 120001.0, 9e15] {
        let input = config::parse_ask_input(&json!({
            "adapter": "rules", "config": {}, "state": "x", "question": question.clone(), "timeoutMs": timeout
        }))
        .unwrap();
        assert_eq!(input.timeout_ms, timeout);
        assert_eq!(input.adapter, config::Adapter::Rules);
    }
}

#[test]
fn ask_input_limits_state_utf16_length() {
    let question = json!({ "type": "yesno", "id": "g", "instructions": "i" });
    // 256*1024 boundary: a state of exactly that length is accepted. "界" is a
    // single UTF-16 code unit (BMP), so 256*1024 characters hit the boundary.
    let mut state = "界".repeat(256 * 1024);
    assert_eq!(pacer_plugin::js::utf16_len(&state), 256 * 1024);
    let input = config::parse_ask_input(&json!({
        "adapter": "rules", "config": {}, "state": state.clone(), "question": question.clone(), "timeoutMs": 1
    }))
    .unwrap();
    assert_eq!(input.state, state);

    state.push('界');
    let e = config::parse_ask_input(&json!({
        "adapter": "rules", "config": {}, "state": state, "question": question, "timeoutMs": 1
    }))
    .unwrap_err();
    assert_eq!(e.code, "invalid_input");
}