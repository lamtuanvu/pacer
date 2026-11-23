#![allow(clippy::unwrap_used)]
//! Integration tests for `discoverModels` (`src/models.rs`) driven through the
//! real bundled plugin. Credential transport, status mapping and the exact
//! `/models` request URL are asserted byte-for-byte against models.ts, using
//! scripted `capability.net.http` answers.

mod support;

use pacer_plugin::testing::{Harness, HostError};
use serde_json::{Value, json};

use support::{hello, plugin};
use std::sync::{Arc, Mutex};

/// Register a `capability.net.http` answer returning a fixed response, and a
/// recorder for the request the plugin actually made.
fn http_answer(
    h: &mut Harness,
    status: u16,
    body: &str,
    requests: Arc<Mutex<Vec<Value>>>,
) {
    let requests = requests.clone();
    let body = body.to_string();
    h.on_capability("capability.net.http", move |p| {
        requests.lock().unwrap().push(p.clone());
        Ok(json!({ "status": status, "headers": {}, "body": body }))
    });
}

/// Drive `endpoint.models` and unwrap the result value.
async fn call_models(h: &mut Harness, params: Value) -> Value {
    h.call("endpoint.models", params).await.unwrap()
}

fn discover_params(base_url: &str, key_ref: Option<&str>) -> Value {
    let mut p = json!({ "baseUrl": base_url });
    if let Some(k) = key_ref {
        p["keyRef"] = json!(k);
    }
    p
}

#[track_caller]
fn assert_not_listed(r: &Value, error: &str, detail: &str) {
    assert_eq!(r["listed"], json!(false));
    assert_eq!(r["error"], json!(error));
    assert_eq!(r["detail"], json!(detail));
}

#[tokio::test]
async fn success_lists_models_from_data_entry() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut h = Harness::start(plugin(), hello()).await;
    http_answer(
        &mut h,
        200,
        r#"{"data":[{"id":"gpt-5","name":"gpt-5","context_length":128000,"max_output_tokens":8192,"tools":true}]}"#,
        requests.clone(),
    );
    // keyRef present → the request carries authorization.secretRef.
    let r = call_models(&mut h, discover_params("https://acme.example", Some("sec-1"))).await;
    assert_eq!(r["listed"], json!(true));
    assert_eq!(
        r["models"],
        json!([{ "id": "gpt-5", "name": "gpt-5", "context": 128000, "output": 8192, "tools": true }])
    );
    let req = &requests.lock().unwrap()[0];
    assert_eq!(req["url"], json!("https://acme.example/models"));
    assert_eq!(req["method"], json!("GET"));
    assert_eq!(req["authorization"], json!({ "secretRef": "sec-1" }));
    h.close().await;
}

#[tokio::test]
async fn success_strips_trailing_slash_and_dedupe_duplicate_ids() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut h = Harness::start(plugin(), hello()).await;
    http_answer(
        &mut h,
        200,
        r#"{"data":[
            {"model":"a","name":"A","context_length":1},
            {"model":"a","name":"A2","context_length":2},
            {}
        ]}"#,
        requests.clone(),
    );
    let r = call_models(&mut h, discover_params("https://a.example/", None)).await;
    assert_eq!(r["listed"], json!(true));
    assert_eq!(r["models"], json!([{ "id": "a", "name": "A", "context": 1 }]));
    // Trailing slash removed before appending /models.
    let req = &requests.lock().unwrap()[0];
    assert_eq!(req["url"], json!("https://a.example/models"));
    h.close().await;
}

#[tokio::test]
async fn status_codes_map_to_verbatim_errors() {
    let cases: Vec<(u16, &str, &str)> = vec![
        (401, "refused", "The key was refused."),
        (403, "refused", "The key was refused."),
        (404, "not_listed", "This endpoint doesn't list models. Enter model ids."),
        (500, "http_error", "Model discovery failed (HTTP 500)."),
        (300, "http_error", "Model discovery failed (HTTP 300)."),
    ];
    for (status, error, detail) in cases {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let mut h = Harness::start(plugin(), hello()).await;
        http_answer(&mut h, status, "irrelevant", requests.clone());
        let r = call_models(&mut h, discover_params("https://a.example", Some("k"))).await;
        assert_not_listed(&r, error, detail);
        h.close().await;
    }
}

#[tokio::test]
async fn invalid_urls_and_schemes_are_rejected_before_any_http() {
    for base in [
        "not a url",
        "ftp://a.example",
        "https://u:p@a.example",
        "https://u@a.example",
    ] {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let mut h = Harness::start(plugin(), hello()).await;
        http_answer(&mut h, 200, "", requests.clone());
        let r = call_models(&mut h, discover_params(base, None)).await;
        assert_not_listed(&r, "invalid_url", "Check the URL and try again.");
        assert!(requests.lock().unwrap().is_empty(), "no http for {base}");
        h.close().await;
    }
}

#[tokio::test]
async fn invalid_json_and_absent_entries_are_not_listed() {
    // Invalid JSON body → invalid_response.
    {
        let mut h = Harness::start(plugin(), hello()).await;
        http_answer(&mut h, 200, "not json", Arc::new(Mutex::new(Vec::new())));
        let r = call_models(&mut h, discover_params("https://a.example", None)).await;
        assert_not_listed(&r, "invalid_response", "The endpoint returned an invalid model list.");
        h.close().await;
    }
    // Missing data/models → not_listed.
    {
        let mut h = Harness::start(plugin(), hello()).await;
        http_answer(&mut h, 200, r#"{"foo":1}"#, Arc::new(Mutex::new(Vec::new())));
        let r = call_models(&mut h, discover_params("https://a.example", None)).await;
        assert_not_listed(&r, "not_listed", "This endpoint doesn't list models. Enter model ids.");
        h.close().await;
    }
}

#[tokio::test]
async fn bom_leading_fefficiently_stripped_from_response_body() {
    let mut h = Harness::start(plugin(), hello()).await;
    http_answer(
        &mut h,
        200,
        "\u{feff}{\"data\":[{\"id\":\"gpt-5\",\"name\":\"gpt-5\"}]}",
        Arc::new(Mutex::new(Vec::new())),
    );
    let r = call_models(&mut h, discover_params("https://a.example", None)).await;
    assert_eq!(r["listed"], json!(true));
    assert_eq!(r["models"], json!([{ "id": "gpt-5", "name": "gpt-5" }]));
    h.close().await;
}

#[tokio::test]
async fn transport_and_credential_errors_are_mapped() {
    // Unreachable (any non-credential-reflected capability error).
    {
        let mut h = Harness::start(plugin(), hello()).await;
        h.on_capability_async("capability.net.http", |_| async {
            Err(HostError::new("net_error", "dns"))
        });
        let r = call_models(&mut h, discover_params("https://a.example", None)).await;
        assert_not_listed(&r, "unreachable", "Endpoint unreachable. Check the URL and try again.");
        h.close().await;
    }
    // credential_reflection denial → invalid_response.
    {
        let mut h = Harness::start(plugin(), hello()).await;
        h.on_capability_async("capability.net.http", |_| async {
            Err(HostError::new("capability_denied", "refused").with_reason("credential_reflection"))
        });
        let r = call_models(&mut h, discover_params("https://a.example", Some("k"))).await;
        assert_not_listed(&r, "invalid_response", "The endpoint returned an invalid model list.");
        h.close().await;
    }
    // No answer → capability_denied without credential_reflection → unreachable.
    {
        let mut h = Harness::start(plugin(), hello()).await;
        let r = call_models(&mut h, discover_params("https://a.example", None)).await;
        assert_not_listed(&r, "unreachable", "Endpoint unreachable. Check the URL and try again.");
        h.close().await;
    }
}

#[tokio::test]
async fn two_xx_passes_through_to_body_parsing() {
    // A 2xx status other than 2** (here 299) is a success passthrough: the
    // body must still parse as JSON to be listed. Non-JSON → invalid_response.
    let mut h = Harness::start(plugin(), hello()).await;
    http_answer(&mut h, 299, "not json", Arc::new(Mutex::new(Vec::new())));
    let r = call_models(&mut h, discover_params("https://a.example", None)).await;
    assert_not_listed(&r, "invalid_response", "The endpoint returned an invalid model list.");
    h.close().await;
}

#[tokio::test]
async fn no_key_ref_means_no_authorization_in_request() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut h = Harness::start(plugin(), hello()).await;
    http_answer(
        &mut h,
        200,
        r#"{"data":[]}"#,
        requests.clone(),
    );
    let r = call_models(&mut h, discover_params("https://a.example", None)).await;
    assert_eq!(r["listed"], json!(true));
    let req = &requests.lock().unwrap()[0];
    assert!(req.get("authorization").is_none(), "no keyRef → no authorization key");
    h.close().await;
}

#[tokio::test]
async fn model_field_precedence_matches_typescript() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut h = Harness::start(plugin(), hello()).await;
    http_answer(
        &mut h,
        200,
        r#"{"data":[{
            "id":"m1",
            "name":"explicit name",
            "display_name":"disp",
            "context_window":8000,
            "max_model_len":9999,
            "model_info":{"x.context_length":555,"y":1},
            "max_output_tokens":4096,
            "max_completion_tokens":999999,
            "tools":false
        }]}"#,
        requests.clone(),
    );
    let r = call_models(&mut h, discover_params("https://a.example", None)).await;
    assert_eq!(r["listed"], json!(true));
    let m = &r["models"][0];
    // name: display_name wins over name; context follows the documented field
    // order (context_length, max_model_len, ...) so max_model_len is used
    // before context_window; output: max_output_tokens first; tools: exact bool.
    assert_eq!(m["name"], json!("disp"));
    assert_eq!(m["context"], json!(9999));
    assert_eq!(m["output"], json!(4096));
    assert_eq!(m["tools"], json!(false));
    h.close().await;
}