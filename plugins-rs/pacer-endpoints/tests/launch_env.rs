#![allow(clippy::unwrap_used)]
//! Integration tests for `launchEnv` (`src/launch_env.rs`) driven through the
//! real bundled plugin. Asserts the written config bytes equal
//! `serde_json::to_string_pretty(render)+"\n"`, that `secretEnv` carries the
//! keyRef (never the value), and that the OPENCODE_CONFIG path lands under
//! `{pacerHome}/opencode`.

mod support;

use pacer_bundled_endpoints::{endpoint_key_env, render_opencode_config};
use pacer_plugin::testing::Harness;
use serde_json::{Value, json};

use support::{base_fs_answers, hello, plugin, InMemoryFs};
use std::sync::{Arc, Mutex};

fn account(name: &str, base_url: &str, key_ref: Option<&str>) -> Value {
    json!({
        "name": name,
        "baseUrl": base_url,
        "keyRef": key_ref,
        "models": [{
            "id": "gpt-5",
            "context": 128000,
            "output": 8192,
            "tools": true
        }]
    })
}

fn launch_params(pacer_home: &str, account: Option<Value>) -> Value {
    let mut p = json!({ "pacerHome": pacer_home, "accounts": [] });
    if let Some(acc) = account {
        p["account"] = acc;
    }
    p
}

/// Build the EndpointAccount JSON array the parser sees from `accounts`.
fn accounts_json(accounts: &[Value]) -> Value {
    Value::Array(accounts.to_vec())
}

#[tokio::test]
async fn writes_exact_pretty_config_and_returns_env_with_secret_ref() {
    let state = Arc::new(Mutex::new(InMemoryFs::default()));
    let mut h = Harness::start(plugin(), hello()).await;
    base_fs_answers(&mut h, state.clone());

    let acc = account("acme", "https://acme.example", Some("ref-1"));
    let param = {
        let mut p = launch_params("/home/u/.pacer", Some(acc.clone()));
        p["accounts"] = accounts_json(&[acc.clone()]);
        p
    };
    let r = h.call("endpoint.launchEnv", param).await.unwrap();

    // Written config equals the exact pretty render (+ trailing newline).
    let state = state.lock().unwrap();
    assert_eq!(state.written.len(), 1);
    let (path, text, mode) = &state.written[0];
    assert_eq!(path, "/home/u/.pacer/opencode/opencode.json");
    assert_eq!(*mode, Some(0o600));
    let accounts_parsed: Vec<Value> = vec![acc];
    // Re-render through the exact crate API and compare byte-for-byte.
    let rendered = render_for(&accounts_parsed);
    let expected = format!("{}\n", serde_json::to_string_pretty(&rendered).unwrap());
    assert_eq!(text, &expected);

    // Returns env with OPENCODE_CONFIG and secretEnv carrying the keyRef.
    drop(state);
    assert_eq!(r["env"]["OPENCODE_CONFIG"], json!("/home/u/.pacer/opencode/opencode.json"));
    assert_eq!(r["secretEnv"], json!({ endpoint_key_env("acme"): "ref-1" }));
    assert_eq!(r["env"].as_object().unwrap().len(), 1, "only OPENCODE_CONFIG in env");
    h.close().await;
}

#[tokio::test]
async fn no_account_means_empty_secret_env() {
    let state = Arc::new(Mutex::new(InMemoryFs::default()));
    let mut h = Harness::start(plugin(), hello()).await;
    base_fs_answers(&mut h, state.clone());

    let r = h
        .call("endpoint.launchEnv", launch_params("/home/u/.pacer", None))
        .await
        .unwrap();
    assert_eq!(r["secretEnv"], json!({}));
    assert_eq!(r["env"]["OPENCODE_CONFIG"], json!("/home/u/.pacer/opencode/opencode.json"));
    h.close().await;
}

#[tokio::test]
async fn empty_pacer_home_joins_to_opencode_only() {
    let state = Arc::new(Mutex::new(InMemoryFs::default()));
    let mut h = Harness::start(plugin(), hello()).await;
    base_fs_answers(&mut h, state.clone());
    let r = h
        .call("endpoint.launchEnv", launch_params("", None))
        .await
        .unwrap();
    assert_eq!(r["env"]["OPENCODE_CONFIG"], json!("opencode/opencode.json"));
    h.close().await;
}

/// Render through the crate's public API for the given account JSON values.
fn render_for(accounts: &[Value]) -> Value {
    let parsed: Vec<pacer_bundled_endpoints::EndpointAccount> = accounts
        .iter()
        .map(|v| serde_json::from_value(v.clone()).unwrap())
        .collect();
    render_opencode_config(&parsed)
}