//! Delivery tests for the external `jev` classifier, ported from
//! `test/classify-jev.test.ts` and `test/plugins-classify-adapters.test.ts`
//! (C6). A scripted `FakeHost` stands in for the real SDK host.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_bundled_classify::http::{ClassifierHost, Question, js_number};
use pacer_bundled_classify::{config, jev};
use pacer_plugin::{HttpResponse, PluginError};
use serde_json::{Map, Value, json};
use std::sync::{Arc, Mutex};

struct FakeHost {
    response: Value,
    status: u16,
    present: bool,
    requests: Arc<Mutex<Vec<Value>>>,
    refs: Arc<Mutex<Vec<String>>>,
}

impl FakeHost {
    fn ok(response: Value) -> Self {
        Self {
            response,
            status: 200,
            present: true,
            requests: Arc::new(Mutex::new(Vec::new())),
            refs: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl ClassifierHost for FakeHost {
    async fn http(&self, request: Value) -> Result<HttpResponse, PluginError> {
        self.requests.lock().unwrap().push(request.clone());
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
        instructions: "Choose kind".into(),
        criteria: Map::from_iter([("docs".into(), json!("Documentation")), ("tests".into(), json!("Tests"))]),
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
        instructions: "Execution work?".into(),
    }
}

const JEV: &str = "https://api.typesafe.ai";
const KEY: &str = "secrets:TYPESAFE_API_KEY";

fn jev_config(
    base: &str,
    usd_in: Option<f64>,
    usd_out: Option<f64>,
) -> config::JevConfig {
    config::JevConfig {
        base_url: base.to_owned(),
        model: "jev-latest".into(),
        key_ref: KEY.to_owned(),
        usd_per_mtok_in: usd_in,
        usd_per_mtok_out: usd_out,
    }
}

fn choice_fixture() -> Value {
    json!({
        "model": "jev-latest",
        "answers": { "task_kind": { "type": "choice", "choice": "docs", "probabilities": { "docs": 0.8, "tests": 0.2 }, "confidence": 0.9 } },
        "usage": { "input_tokens": 100, "output_tokens": 20 },
    })
}
fn score_fixture() -> Value {
    json!({ "answers": { "difficulty": { "type": "score", "score": 0.7 } }, "usage": { "input_tokens": 100, "output_tokens": 20 } })
}
fn probability_fixture() -> Value {
    json!({ "answers": { "guard": { "type": "probability", "probability": 0.3 } }, "usage": { "input_tokens": 100, "output_tokens": 20 } })
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
    cfg: &config::JevConfig,
    state: &str,
    q: &Question,
    timeout: f64,
    c: &(Mutex<f64>, f64),
) -> Result<Value, PluginError> {
    jev::ask_jev(host, cfg, state, q, timeout, || tick(c)).await
}

#[tokio::test]
async fn posts_authenticated_jev_request_through_base() {
    // TS: classify-jev.test.ts:66.
    let host = FakeHost::ok(choice_fixture());
    let cfg = jev_config(JEV, None, None);
    let c = clock(10.0, 25.0);
    let answer = ask(&host, &cfg, "state", &choice(), 1000.0, &c).await.unwrap();
    assert_eq!(
        answer,
        json!({ "value": "docs", "probabilities": { "docs": 0.8, "tests": 0.2 }, "confidence": 0.9, "latencyMs": 25 })
    );

    let req = &host.requests.lock().unwrap()[0];
    assert_eq!(req["url"], json!(format!("{JEV}/v1/systemone")));
    assert_eq!(req["method"], json!("POST"));
    assert_eq!(req["authorization"], json!({ "secretRef": KEY }));
    let body: Value = serde_json::from_str(req["body"].as_str().unwrap()).unwrap();
    assert_eq!(
        body,
        json!({
            "state": "state",
            "model": "jev-latest",
            "questions": { "task_kind": { "type": "choice", "instructions": "Choose kind", "criteria": { "docs": "Documentation", "tests": "Tests" } } },
        })
    );
    assert_eq!(*host.refs.lock().unwrap(), vec![KEY.to_owned()]);
}

#[test]
fn builds_score_and_probability_question_bodies() {
    // TS: classify-jev.test.ts:78.
    let score_req = jev::jev_request("s", &score(), "custom");
    assert_eq!(
        score_req,
        json!({ "state": "s", "model": "custom", "questions": { "difficulty": { "type": "score", "instructions": "Rate reliability", "criteria": { "min": "0 is the lowest score", "max": "1 is the highest score" } } } })
    );
    let yesno_req = jev::jev_request("s", &yesno(), "custom");
    assert_eq!(
        yesno_req,
        json!({ "state": "s", "model": "custom", "questions": { "guard": { "type": "probability", "instructions": "Execution work?", "criteria": { "yes": "The answer is yes", "no": "The answer is no" } } } })
    );
}

#[tokio::test]
async fn maps_score_response_and_clamps_bounds() {
    let host = FakeHost::ok(score_fixture());
    let cfg = jev_config(JEV, None, None);
    let c = clock(0.0, 0.0);
    let answer = ask(&host, &cfg, "s", &score(), 1000.0, &c).await.unwrap();
    assert_eq!(answer["value"], json!(0.7));
    assert_eq!(answer["confidence"], json!(0.5));
    assert_eq!(jev::map_jev_answer(&score(), &json!({ "type": "score", "score": 2 })).unwrap().0, js_number(1.0));
    assert_eq!(jev::map_jev_answer(&score(), &json!({ "type": "score", "score": -1 })).unwrap().0, js_number(0.0));
}

#[tokio::test]
async fn maps_probability_response_with_inclusive_yes_boundary() {
    let host = FakeHost::ok(probability_fixture());
    let cfg = jev_config(JEV, None, None);
    let c = clock(0.0, 0.0);
    let answer = ask(&host, &cfg, "s", &yesno(), 1000.0, &c).await.unwrap();
    assert_eq!(answer["value"], json!(false));
    assert_eq!(answer["confidence"], json!(0.7));
    assert_eq!(answer["probabilities"], json!({ "yes": 0.3, "no": 0.7 }));
    assert_eq!(jev::map_jev_answer(&yesno(), &json!({ "type": "probability", "probability": 0.5 })).unwrap().0, json!(true));
}

#[test]
fn choice_confidence_defaults_to_highest_probability() {
    let (value, _, confidence) = jev::map_jev_answer(
        &choice(),
        &json!({ "type": "choice", "choice": "tests", "probabilities": { "docs": 0.2, "tests": 0.8 } }),
    )
    .unwrap();
    assert_eq!(value, json!("tests"));
    assert_eq!(confidence, 0.8);
}

#[test]
fn rejects_unknown_choices_and_invalid_numerical_answers() {
    assert!(jev::map_jev_answer(&choice(), &json!({ "type": "choice", "choice": "feature" })).is_err());
    for probability in [-0.1, 1.1] {
        assert!(jev::map_jev_answer(&yesno(), &json!({ "type": "probability", "probability": probability })).is_err());
    }
    assert!(jev::map_jev_answer(&yesno(), &json!({ "type": "probability", "probability": "0.5" })).is_err());
    assert!(jev::map_jev_answer(&score(), &json!({ "type": "score", "score": "0.7" })).is_err());
}

#[tokio::test]
async fn computes_usage_cost_only_when_both_prices_are_set() {
    let host = FakeHost::ok(choice_fixture());
    let both = jev_config(JEV, Some(2.0), Some(5.0));
    let c = clock(0.0, 0.0);
    let answer = ask(&host, &both, "s", &choice(), 1000.0, &c).await.unwrap();
    assert_eq!(answer["costUsd"], json!(js_number((100.0 * 2.0 + 20.0 * 5.0) / 1_000_000.0)));

    let zeros = jev_config(JEV, Some(0.0), Some(0.0));
    let answer = ask(&host, &zeros, "s", &choice(), 1000.0, &c).await.unwrap();
    assert_eq!(answer["costUsd"], json!(0));

    let in_only = jev_config(JEV, Some(2.0), None);
    let answer = ask(&host, &in_only, "s", &choice(), 1000.0, &c).await.unwrap();
    assert!(answer.get("costUsd").is_none());

    let out_only = jev_config(JEV, None, Some(5.0));
    let answer = ask(&host, &out_only, "s", &choice(), 1000.0, &c).await.unwrap();
    assert!(answer.get("costUsd").is_none());
}

#[tokio::test]
async fn does_not_invent_cost_when_usage_is_absent() {
    let host = FakeHost::ok(json!({ "answers": choice_fixture()["answers"].clone() }));
    let cfg = jev_config(JEV, Some(2.0), Some(5.0));
    let c = clock(0.0, 0.0);
    let answer = ask(&host, &cfg, "s", &choice(), 1000.0, &c).await.unwrap();
    assert!(answer.get("costUsd").is_none());
}

#[tokio::test]
async fn missing_key_rejects_before_sending_a_request() {
    let mut host = FakeHost::ok(choice_fixture());
    host.present = false;
    let cfg = jev_config(JEV, None, None);
    let c = clock(0.0, 0.0);
    let error = ask(&host, &cfg, "s", &choice(), 1000.0, &c).await.unwrap_err();
    assert!(error.message.contains("Missing Jev API key"));
    assert!(error.message.contains("TYPESAFE_API_KEY"));
    assert!(host.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn missing_answer_id_rejects() {
    let host = FakeHost::ok(json!({ "answers": {} }));
    let cfg = jev_config(JEV, None, None);
    let c = clock(0.0, 0.0);
    let error = ask(&host, &cfg, "s", &choice(), 1000.0, &c).await.unwrap_err();
    assert_eq!(error.code, "internal");
    assert_eq!(error.message, "Missing Jev answer");
    assert!(!error.message.contains("TYPESAFE_API_KEY"));
}

#[tokio::test]
async fn ordinary_authenticated_http_error_remains_status_only() {
    // TS: classify-jev.test.ts:196.
    let mut host = FakeHost::ok(Value::Null);
    host.status = 401;
    host.response = json!("private upstream detail");
    let cfg = jev_config(JEV, None, None);
    let c = clock(0.0, 0.0);
    let error = ask(&host, &cfg, "s", &choice(), 1000.0, &c).await.unwrap_err();
    assert_eq!(error.code, "internal");
    assert_eq!(error.message, "Jev HTTP 401");
    assert!(!error.message.contains("private upstream detail"));
}

#[tokio::test]
async fn malformed_usage_preserves_a_valid_answer_without_cost() {
    // TS: classify-jev.test.ts:177.
    for usage in [
        json!("bad"),
        json!([]),
        json!({}),
        json!({ "input_tokens": "100", "output_tokens": 20 }),
        json!({ "input_tokens": 100, "output_tokens": -1 }),
        json!({ "input_tokens": Value::Null, "output_tokens": 20 }),
    ] {
        let host = FakeHost::ok(json!({ "answers": choice_fixture()["answers"].clone(), "usage": usage.clone() }));
        let cfg = jev_config(JEV, Some(2.0), Some(5.0));
        let c = clock(0.0, 0.0);
        let answer = ask(&host, &cfg, "s", &choice(), 1000.0, &c).await.unwrap();
        assert_eq!(answer["value"], json!("docs"));
        assert_eq!(answer["confidence"], json!(0.9));
        assert!(answer.get("costUsd").is_none(), "usage {usage}");
    }
}

#[tokio::test]
async fn parser_errors_never_echo_question_identifiers_containing_the_key() {
    // TS: classify-jev.test.ts:168.
    let host = FakeHost::ok(json!({ "answers": {} }));
    let cfg = jev_config(JEV, None, None);
    let c = clock(0.0, 0.0);
    let mut id_question = choice();
    let error = {
        match &mut id_question {
            Question::Choice { id, .. } => *id = "secret-secret".into(),
            _ => unreachable!(),
        };
        ask(&host, &cfg, "s", &id_question, 1000.0, &c).await.unwrap_err()
    };
    assert_eq!(error.message, "Missing Jev answer");
    assert!(!error.message.contains("secret"));
}