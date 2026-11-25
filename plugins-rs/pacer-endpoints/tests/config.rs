#![allow(clippy::unwrap_used)]
//! Unit tests for `endpointKeyEnv` and `renderOpencodeConfig`
//! (`src/opencode_config.rs`), porting the TS behavior from
//! `plugins/pacer-endpoints/opencode-config.ts`. Key ordering, `$schema`
//! first, and the apiKey placeholder rule are asserted byte-for-byte against
//! the JSON `Object.fromEntries` would produce.

use pacer_bundled_endpoints::{EndpointAccount, EndpointModel, endpoint_key_env, render_opencode_config};
use serde_json::json;

fn account(name: &str, base_url: &str, key_ref: Option<&str>, models: Vec<EndpointModel>) -> EndpointAccount {
    EndpointAccount {
        name: name.to_string(),
        base_url: base_url.to_string(),
        key_ref: key_ref.map(str::to_string),
        models,
    }
}

fn model(id: &str, context: u64, output: u64) -> EndpointModel {
    EndpointModel {
        id: id.to_string(),
        name: Some(format!("{id} model")),
        context,
        output,
        tools: true,
    }
}

#[test]
fn endpoint_key_env_prepends_pacer_key_and_normalizes_to_upper_underscore() {
    assert_eq!(endpoint_key_env("acme"), "PACER_KEY_ACME");
    assert_eq!(endpoint_key_env("my-cloud-a"), "PACER_KEY_MY_CLOUD_A");
    assert_eq!(endpoint_key_env("WeIrD"), "PACER_KEY_WEIRD");
}

#[test]
fn render_places_schema_first_and_orders_provider_models_keys_like_object_from_entries() {
    let accounts = vec![
        account("west", "https://west.example", Some("secret-a"), vec![model("gpt-5", 128_000, 8192)]),
        account("east", "https://east.example", None, vec![model("claude-opus", 200_000, 16_384)]),
    ];
    let rendered = render_opencode_config(&accounts);
    let obj = rendered.as_object().unwrap();
    // `$schema` must be the first key.
    let keys: Vec<_> = obj.keys().collect();
    assert_eq!(keys, vec!["$schema", "provider"]);

    let provider = obj["provider"].as_object().unwrap();
    assert_eq!(provider.len(), 2);
    let west = provider["pacer-west"].as_object().unwrap();
    // npm, name, options, models — insertion order preserved (Object.fromEntries).
    let west_keys: Vec<_> = west.keys().collect();
    assert_eq!(west_keys, vec!["npm", "name", "options", "models"]);
    assert_eq!(west["npm"], json!("@ai-sdk/openai-compatible"));
    assert_eq!(west["name"], json!("west (pacer)"));
    let opts = west["options"].as_object().unwrap();
    assert_eq!(opts["baseURL"], json!("https://west.example"));
    // keyRef present → apiKey placeholder; keyRef null → absent.
    assert_eq!(opts["apiKey"], json!("{env:PACER_KEY_WEST}"));

    // No keyRef → no apiKey key at all.
    let east = provider["pacer-east"].as_object().unwrap();
    let east_opts = east["options"].as_object().unwrap();
    assert!(!east_opts.contains_key("apiKey"));
    assert_eq!(east_opts["baseURL"], json!("https://east.example"));

    // Models record: id → { name, limit, tool_call }.
    let west_models = west["models"].as_object().unwrap();
    let m = west_models["gpt-5"].as_object().unwrap();
    let m_keys: Vec<_> = m.keys().collect();
    assert_eq!(m_keys, vec!["name", "limit", "tool_call"]);
    assert_eq!(m["limit"]["context"], json!(128_000));
    assert_eq!(m["limit"]["output"], json!(8192));
    assert_eq!(m["tool_call"], json!(true));
}

#[test]
fn render_last_duplicate_model_id_wins_and_objects_fit_expected_shape() {
    let accounts = vec![account(
        "acme",
        "https://acme.example",
        None,
        vec![
            model("model-x", 100, 100),
            model("model-x", 9999, 9999), // duplicate id → last wins
        ],
    )];
    let rendered = render_opencode_config(&accounts);
    let provider = rendered["provider"].as_object().unwrap();
    assert_eq!(provider.len(), 1);
    let models = provider["pacer-acme"]["models"].as_object().unwrap();
    assert_eq!(models.len(), 1, "duplicate model id collapses to the last entry");
    assert_eq!(models["model-x"]["limit"]["context"], json!(9999));
    assert_eq!(models["model-x"]["limit"]["output"], json!(9999));
}