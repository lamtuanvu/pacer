//! Delivery tests for the shared classifier adapter vocabulary, ported from
//! `test/classify-state.test.ts` (C6, plugin cases only) and
//! `plugins/pacer-classify/http.ts`. A scripted `FakeHost` stands in for the
//! real SDK `Host::http`, so no real network or host is involved.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_bundled_classify::http::{HttpError, PostJsonError, is_local_url, join_url, js_number, post_json};
use pacer_plugin::{HttpResponse, PluginError};
use serde_json::{Map, Value, json};
use std::sync::{Arc, Mutex};

struct FakeHost {
    response: Value,
    /// When set, the raw HTTP body text served verbatim (as the real host
    /// would) instead of `response.to_string()`. Used for non-JSON bodies.
    raw_body: Option<String>,
    status: u16,
    transport_error: Option<PluginError>,
    requests: Arc<Mutex<Vec<Value>>>,
}

impl FakeHost {
    fn ok(body: Value) -> Self {
        Self {
            response: body,
            raw_body: None,
            status: 200,
            transport_error: None,
            requests: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl pacer_bundled_classify::http::ClassifierHost for FakeHost {
    async fn http(&self, request: Value) -> Result<HttpResponse, PluginError> {
        self.requests.lock().unwrap().push(request.clone());
        if let Some(error) = &self.transport_error {
            return Err(error.clone());
        }
        Ok(HttpResponse {
            status: self.status,
            headers: Map::new(),
            body: self.raw_body.clone().unwrap_or_else(|| self.response.to_string()),
        })
    }
    async fn present(&self, reference: &str) -> Result<bool, PluginError> {
        // Not exercised by postJson itself; the classifiers use it.
        let _ = reference;
        Ok(true)
    }
}

// TS: classify-state.test.ts:102.
#[tokio::test]
async fn post_json_sends_json_with_secret_ref() {
    let host = FakeHost::ok(json!({ "body": json!({ "hello": "world" }) }));
    let body = json!({ "hello": "world" });
    let result = post_json(&host, "https://api.typesafe.ai/some", &body, 1000.0, Some("secrets:TYPESAFE_API_KEY")).await.unwrap();
    assert_eq!(result, json!({ "body": json!({ "hello": "world" }) }));
    let req = &host.requests.lock().unwrap()[0];
    assert_eq!(req["url"], json!("https://api.typesafe.ai/some"));
    assert_eq!(req["method"], json!("POST"));
    assert_eq!(req["headers"], json!({ "content-type": "application/json" }));
    assert_eq!(serde_json::from_str::<Value>(req["body"].as_str().unwrap()).unwrap(), body);
    assert_eq!(req["timeoutMs"], json!(1000));
    assert_eq!(req["authorization"], json!({ "secretRef": "secrets:TYPESAFE_API_KEY" }));
}

// TS: classify-state.test.ts:111.
#[tokio::test]
async fn post_json_http_error_has_status_and_body() {
    let mut host = FakeHost::ok(Value::Null);
    host.status = 500;
    host.raw_body = Some("unavailable".into());
    let error = post_json(&host, "http://x", &json!({}), 1000.0, None).await.unwrap_err();
    let PostJsonError::Http(e) = error else { panic!("expected Http") };
    assert_eq!(e.status, 500);
    assert_eq!(e.body, "unavailable");
    assert_eq!(e.into_plugin().message, "HTTP 500: unavailable");
}

// TS: classify-state.test.ts:122.
#[tokio::test]
async fn post_json_rejects_malformed_json() {
    let mut host = FakeHost::ok(Value::Null);
    host.raw_body = Some("not json".into());
    let error = post_json(&host, "http://x", &json!({}), 1000.0, None).await.unwrap_err();
    assert_eq!(error.status(), None);
    let plugin = error.into_plugin();
    assert_eq!(plugin.code, "internal");
    assert_eq!(plugin.message, "invalid JSON response body");
}

// TS: classify-state.test.ts:128.
#[tokio::test]
async fn post_json_forwards_timeout() {
    for timeout in [0.5, 120001.0, 1_000_000.0] {
        let host = FakeHost::ok(json!({}));
        post_json(&host, "http://x", &json!({}), timeout, None).await.unwrap();
        assert_eq!(host.requests.lock().unwrap()[0]["timeoutMs"], js_number(timeout));
    }
}

// TS: classify-state.test.ts:134.
#[test]
fn join_url_strips_trailing_base_slashes() {
    assert_eq!(join_url("http://127.0.0.1:1234/v1///", "/chat/completions"), "http://127.0.0.1:1234/v1/chat/completions");
    assert_eq!(join_url("https://example.com", "v1/systemone"), "https://example.com/v1/systemone");
}

// TS: classify-state.test.ts:139.
#[test]
fn is_local_url_loopback_and_localhost_only() {
    for host in ["localhost", "127.0.0.1", "[::1]", "x.localhost"] {
        assert!(is_local_url(&format!("http://{host}:1234/v1")), "{host}");
    }
    for url in ["https://example.com", "http://localhost.example.com", "http://notlocalhost", "invalid"] {
        assert!(!is_local_url(url), "{url}");
    }
}

// TS: classify-state.test.ts:152.
#[test]
fn http_error_caps_body_at_200_units() {
    let body = "x".repeat(200) + "private tail";
    let error = HttpError { status: 500, body, authenticated: false }.into_plugin();
    assert_eq!(error.message, "HTTP 500: ".to_owned() + &"x".repeat(200));
    assert!(!error.message.contains("private tail"));
}

// TS: classify-state.test.ts:164 — a host-side refusal (e.g. redirect) propagates.
#[tokio::test]
async fn redirect_refusal_propagates() {
    let mut host = FakeHost::ok(Value::Null);
    host.transport_error = Some(PluginError::new("capability_denied", "redirect not permitted"));
    let error = post_json(&host, "http://x", &json!({}), 1000.0, Some("secrets:K")).await.unwrap_err();
    let plugin = error.into_plugin();
    assert_eq!(plugin.code, "capability_denied");
    assert_eq!(plugin.message, "redirect not permitted");
}