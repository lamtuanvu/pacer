//! Delivery tests for the external `ollama` classifier, ported from
//! `test/classify-ollama.test.ts` and `test/plugins-classify-adapters.test.ts`
//! (C6). A scripted `FakeHost` stands in for the real SDK host.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_bundled_classify::http::{ClassifierHost, Question};
use pacer_bundled_classify::{http, ollama};
use pacer_plugin::{HttpResponse, PluginError};
use serde_json::{Map, Value, json};
use std::sync::{Arc, Mutex};

struct FakeHost {
    response: Value,
    status: u16,
    present: bool,
    requests: Arc<Mutex<Vec<Value>>>,
    refs: Arc<Mutex<Vec<String>>>,
    transport_error: Option<PluginError>,
}

impl FakeHost {
    fn ok(response: Value) -> Self {
        Self {
            response,
            status: 200,
            present: true,
            requests: Arc::new(Mutex::new(Vec::new())),
            refs: Arc::new(Mutex::new(Vec::new())),
            transport_error: None,
        }
    }
}

impl ClassifierHost for FakeHost {
    async fn http(&self, request: Value) -> Result<HttpResponse, PluginError> {
        self.requests.lock().unwrap().push(request.clone());
        if let Some(e) = &self.transport_error {
            return Err(e.clone());
        }
        Ok(HttpResponse {
            status: self.status,
            headers: Map::new(),
            body: self.response.to_string(),
        })
    }
    async fn present(&self, reference: &str) -> Result<bool, PluginError> {
        self.refs.lock().unwrap().push(reference.to_owned());
        Ok(self.present)
    }
}

fn choice() -> Question {
    Question::Choice {
        id: "task_kind".into(),
        instructions: "Choose the task kind".into(),
        criteria: Map::from_iter([("tests".into(), json!("Testing work")), ("docs".into(), json!("Documentation work"))]),
    }
}
fn score() -> Question {
    Question::Score {
        id: "difficulty".into(),
        instructions: "Rate reliability".into(),
        min: 0.0,
        max: 1.0,
    }
}
fn yesno() -> Question {
    Question::YesNo {
        id: "guard".into(),
        instructions: "Is this execution work?".into(),
    }
}

const OLLAMA: &str = "http://127.0.0.1:1234/v1";
const MODEL: &str = "qwen3.6-35b-a3b";

fn ollama_config(base: &str, key_ref: Option<&str>) -> pacer_bundled_classify::config::OllamaConfig {
    pacer_bundled_classify::config::OllamaConfig {
        base_url: base.to_owned(),
        model: MODEL.to_owned(),
        max_tokens: 512,
        key_ref: key_ref.map(str::to_owned),
    }
}

fn clock(start: f64, step: f64) -> Arc<(Mutex<f64>, f64)> {
    Arc::new((Mutex::new(start), step))
}
fn tick(c: &(Mutex<f64>, f64)) -> f64 {
    let mut guard = c.0.lock().unwrap();
    let value = *guard;
    *guard += c.1;
    value
}

async fn ask(
    host: &impl ClassifierHost,
    config: &pacer_bundled_classify::config::OllamaConfig,
    state: &str,
    q: &Question,
    timeout: f64,
    c: &(Mutex<f64>, f64),
) -> Result<Value, PluginError> {
    ollama::ask_ollama(host, config, state, q, timeout, || tick(c)).await
}

#[tokio::test]
async fn requests_structured_openai_compatible_body_and_maps_reply() {
    // TS: classify-ollama.test.ts:36.
    let host = FakeHost::ok(json!({
        "choices": [{ "message": { "content": r#"{"choice":"tests","confidence":0.9}"# } }]
    }));
    let c = clock(100.0, 7.0);
    let cfg = ollama_config(OLLAMA, Some("secrets:TYPESAFE_API_KEY"));
    let answer = ask(&host, &cfg, r#"{"goal":"Add tests"}"#, &choice(), 1000.0, &c)
        .await
        .unwrap();
    assert_eq!(answer, json!({ "value": "tests", "confidence": 0.9, "latencyMs": 7, "costUsd": 0 }));

    let req = &host.requests.lock().unwrap()[0];
    assert_eq!(req["url"], json!(format!("{OLLAMA}/chat/completions")));
    assert_eq!(req["method"], json!("POST"));
    assert_eq!(req["timeoutMs"], json!(1000));
    assert_eq!(req["authorization"], json!({ "secretRef": "secrets:TYPESAFE_API_KEY" }));
    assert_eq!(req["headers"], json!({ "content-type": "application/json" }));
    let body: Value = serde_json::from_str(req["body"].as_str().unwrap()).unwrap();
    assert_eq!(body["model"], json!(MODEL));
    assert_eq!(body["temperature"], json!(0));
    assert_eq!(body["stream"], json!(false));
    assert_eq!(body["max_tokens"], json!(512));
    assert_eq!(body["response_format"]["type"], json!("json_schema"));
    assert_eq!(
        body["response_format"]["json_schema"]["schema"],
        json!({
            "type": "object",
            "properties": {
                "choice": { "type": "string", "enum": ["tests", "docs"] },
                "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            },
            "required": ["choice", "confidence"],
            "additionalProperties": false,
        })
    );
    assert!(body["response_format"]["json_schema"].get("strict").is_none());
    assert!(body["messages"].to_string().contains("Choose the task kind"));
    assert!(body["messages"].to_string().contains("Testing work"));
    let content = body["messages"][0]["content"].as_str().unwrap();
    assert!(content.contains(r#"{"goal":"Add tests"}"#));
    assert_eq!(*host.refs.lock().unwrap(), vec!["secrets:TYPESAFE_API_KEY".to_owned()]);
}

#[tokio::test]
async fn fenced_json_reply_parses_through_the_adapter() {
    let host = FakeHost::ok(json!({
        "choices": [{ "message": { "content": "```json\n{\"choice\":\"docs\",\"confidence\":1}\n```" } }]
    }));
    let c = clock(0.0, 5.0);
    let cfg = ollama_config(OLLAMA, None);
    let answer = ask(&host, &cfg, "state", &choice(), 1000.0, &c).await.unwrap();
    assert_eq!(answer["value"], json!("docs"));
    assert_eq!(answer["confidence"], json!(1.0));
    assert_eq!(answer["costUsd"], json!(0));
}

#[tokio::test]
async fn missing_optional_key_uses_anonymous_request() {
    // TS: plugins-classify-adapters.test.ts:58.
    let mut host = FakeHost::ok(json!({
        "choices": [{ "message": { "content": r#"{"answer":false,"confidence":0.8}"# } }]
    }));
    host.present = false;
    let c = clock(0.0, 1.0);
    let cfg = ollama_config("https://models.example.test/v1", Some("secrets:OPTIONAL"));
    let answer = ask(&host, &cfg, "s", &yesno(), 20.0, &c).await.unwrap();
    assert_eq!(answer["value"], json!(false));
    assert!(host.requests.lock().unwrap()[0].get("authorization").is_none());
}

#[test]
fn schema_cover_choice_score_and_yesno() {
    // TS: plugins-classify-adapters.test.ts:48.
    let choice_schema = ollama::schema_for(&choice());
    assert_eq!(
        choice_schema["properties"]["choice"],
        json!({ "type": "string", "enum": ["tests", "docs"] })
    );
    let score_schema = ollama::schema_for(&score());
    assert_eq!(
        score_schema["properties"]["score"],
        json!({ "type": "number", "minimum": 0, "maximum": 1 })
    );
    let yesno_schema = ollama::schema_for(&yesno());
    assert_eq!(yesno_schema["properties"]["answer"], json!({ "type": "boolean" }));
    for schema in [&choice_schema, &score_schema, &yesno_schema] {
        assert_eq!(schema["type"], json!("object"));
        assert_eq!(schema["additionalProperties"], json!(false));
        assert_eq!(schema["required"][1], json!("confidence"));
    }
}

#[test]
fn prompts_keep_score_bounds_and_state() {
    // TS: plugins-classify-adapters.test.ts:51.
    let prompt = ollama::prompt_for(&choice(), "state\n界");
    assert_eq!(
        prompt,
        "Choose the task kind\nCriteria: {\"tests\":\"Testing work\",\"docs\":\"Documentation work\"}\nReturn only JSON with choice and confidence (a number between 0 and 1).\nState:\nstate\n界"
    );
    let score_prompt = ollama::prompt_for(&score(), "state");
    assert!(score_prompt.contains("Rate reliability"));
    assert!(score_prompt.contains("Score must be between 0 and 1."));
    assert!(score_prompt.contains("state"));
    let yesno_prompt = ollama::prompt_for(&yesno(), "state");
    assert!(yesno_prompt.contains("Answer must be a boolean."));
}

#[test]
fn parse_local_answer_accepts_valid_replies() {
    // TS: plugins-classify-adapters.test.ts:54.
    let (value, confidence) = ollama::parse_local_answer(
        &choice(),
        "```json\n{\"choice\":\"tests\",\"confidence\":0.9}\n```",
    )
    .unwrap();
    assert_eq!(value, json!("tests"));
    assert_eq!(confidence, 0.9);

    let (value, confidence) = ollama::parse_local_answer(&score(), r#"{"score":0,"confidence":0}"#).unwrap();
    assert_eq!(value, json!(0));
    assert_eq!(confidence, 0.0);
}

#[test]
fn parse_local_answer_rejects_invalid_inputs() {
    for (q, content) in [
        (&choice(), r#"{"choice":"feature","confidence":0.9}"#),
        (&choice(), r#"I recommend {"choice":"tests","confidence":0.9}"#),
        (&score(), r#"{"score":1.1,"confidence":0.9}"#),
        (&score(), r#"{"score":"0.8","confidence":0.9}"#),
        (&yesno(), r#"{"answer":"yes","confidence":0.9}"#),
        (&yesno(), r#"{"answer":true}"#),
        (&yesno(), r#"{"answer":true,"confidence":-0.1}"#),
        (&yesno(), "null"),
        (&yesno(), "[]"),
        (&yesno(), r#"{"answer":false,"confidence":2}"#),
    ] {
        let error = ollama::parse_local_answer(q, content).unwrap_err();
        assert_eq!(error.code, "internal", "content {content}");
    }
}

#[tokio::test]
async fn http_non_2xx_rejects_with_status() {
    let mut host = FakeHost::ok(Value::Null);
    host.status = 500;
    host.response = json!("unavailable");
    let c = clock(0.0, 1.0);
    let cfg = ollama_config(OLLAMA, Some("secrets:KEY"));
    let error = ask(&host, &cfg, "s", &yesno(), 1000.0, &c).await.unwrap_err();
    // Authenticated failures carry only the status (`HTTP <status>`), no body.
    assert_eq!(error.code, "invalid_input");
    assert_eq!(error.message, "HTTP 500");
}

#[tokio::test]
async fn transport_error_propagates_unchanged() {
    let mut host = FakeHost::ok(Value::Null);
    host.transport_error = Some(PluginError::new("plugin_unavailable", "host closed the connection"));
    let c = clock(0.0, 1.0);
    let cfg = ollama_config(OLLAMA, None);
    let error = ask(&host, &cfg, "s", &yesno(), 1000.0, &c).await.unwrap_err();
    assert_eq!(error.code, "plugin_unavailable");
}

#[test]
fn is_local_url_distinguishes_loopback_from_remote() {
    for local in ["http://127.0.0.1:1234/v1", "http://localhost:1234/v1", "http://[::1]:1234/v1", "http://model.localhost/v1"] {
        assert!(http::is_local_url(local), "{local}");
    }
    assert!(!http::is_local_url("https://models.example.com/v1"));
}

#[test]
fn join_url_uses_single_slash() {
    assert_eq!(http::join_url("http://x/v1///", "chat/completions"), "http://x/v1/chat/completions");
    assert_eq!(http::join_url("http://x", "/v1/systemone"), "http://x/v1/systemone");
}

// A host that records the order of `present` and clock reads.
struct OrderHost {
    order: Arc<Mutex<Vec<String>>>,
    inner: FakeHost,
}
impl ClassifierHost for OrderHost {
    async fn http(&self, request: Value) -> Result<HttpResponse, PluginError> {
        self.inner.http(request).await
    }
    async fn present(&self, reference: &str) -> Result<bool, PluginError> {
        self.order.lock().unwrap().push("presence".into());
        self.inner.present(reference).await
    }
}

#[tokio::test]
async fn latency_excludes_secret_presence_lookup() {
    // TS: plugins-classify-adapters.test.ts:71 — presence is checked before the
    // clock starts; the clock is read exactly twice (start and stop).
    let order = Arc::new(Mutex::new(Vec::<String>::new()));
    let inner = FakeHost::ok(json!({ "choices": [{ "message": { "content": r#"{"answer":true,"confidence":1}"# } }] }));
    let host = OrderHost { order: order.clone(), inner };
    let cfg = ollama_config(OLLAMA, Some("secrets:KEY"));
    let now = Arc::new(Mutex::new(1.0f64));
    ollama::ask_ollama(&host, &cfg, "s", &yesno(), 1000.0, || {
        order.lock().unwrap().push("clock".into());
        let mut g = now.lock().unwrap();
        let v = *g;
        *g += 0.0;
        v
    })
    .await
    .unwrap();
    assert_eq!(*order.lock().unwrap(), vec!["presence", "clock", "clock"]);
}