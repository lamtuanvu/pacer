//! The external `jev` classifier, a port of `plugins/pacer-classify/jev.ts`.
//!
//! Posts a structured request to `/v1/systemone`, maps the typed answer, and
//! computes a usage cost when both prices are configured and usage is present.

use super::http::{
    ClassifierHost, PostJsonError, Question, join_url, js_number, post_json,
};
use crate::config::JevConfig;
use pacer_plugin::{PluginError, js};
use serde_json::{Map, Value};

fn internal(message: impl Into<String>) -> PluginError {
    PluginError::new("internal", message)
}

/// `jevRequest` (jev.ts:4-9): the `/v1/systemone` body.
pub fn jev_request(state: &str, q: &Question, model: &str) -> Value {
    let criteria = match q {
        Question::Choice { criteria, .. } => Value::Object(criteria.clone()),
        Question::Score { min, max, .. } => {
            serde_json::json!({
                "min": format!("{} is the lowest score", js::number_string(*min)),
                "max": format!("{} is the highest score", js::number_string(*max)),
            })
        }
        Question::YesNo { .. } => {
            serde_json::json!({
                "yes": "The answer is yes",
                "no": "The answer is no",
            })
        }
    };
    let qtype = match q {
        Question::YesNo { .. } => "probability",
        other => other.kind(),
    };
    serde_json::json!({
        "state": state,
        "model": model,
        "questions": {
            q.id(): {
                "type": qtype,
                "instructions": q.instructions(),
                "criteria": criteria,
            }
        }
    })
}

fn record(v: &Value) -> Result<&Map<String, Value>, PluginError> {
    v.as_object().ok_or_else(|| internal("Invalid Jev answer object"))
}

fn number(v: &Value, name: &str) -> Result<f64, PluginError> {
    v.as_f64()
        .filter(|x| x.is_finite())
        .ok_or_else(|| internal(format!("Invalid Jev {name}")))
}

fn probability(v: &Value, name: &str) -> Result<f64, PluginError> {
    let n = number(v, name)?;
    if n < 0.0 || n > 1.0 {
        return Err(internal(format!("Invalid Jev {name}: expected [0,1]")));
    }
    Ok(n)
}

/// `mapJevAnswer` (jev.ts:27-45): map and clamp an answer object, returning
/// `(value, probabilities, confidence)`.
pub fn map_jev_answer(
    q: &Question,
    raw: &Value,
) -> Result<(Value, Option<Map<String, Value>>, f64), PluginError> {
    let answer = record(raw)?;
    let expected_type = match q {
        Question::YesNo { .. } => "probability",
        other => other.kind(),
    };
    if answer.get("type").and_then(Value::as_str) != Some(expected_type) {
        return Err(internal(format!("Invalid Jev answer type for {}", q.id())));
    }
    if q.kind() == "choice" {
        let choice = answer
            .get("choice")
            .and_then(Value::as_str)
            .ok_or_else(|| internal(format!("Invalid Jev choice for {}", q.id())))?;
        let criteria = match q {
            Question::Choice { criteria, .. } => criteria,
            _ => unreachable!(),
        };
        if !criteria.contains_key(choice) {
            return Err(internal(format!("Invalid Jev choice for {}", q.id())));
        }
        let mut probabilities = None;
        if answer.get("probabilities").is_some() {
            let probs = record(answer.get("probabilities").unwrap())?;
            let mut prob_values: Map<String, Value> = Map::new();
            for (k, v) in probs {
                prob_values.insert(k.clone(), js_number(probability(v, "choice probability")?));
            }
            probabilities = Some(prob_values);
        }
        let max_prob = probabilities
            .as_ref()
            .map(|p| p.values().filter_map(Value::as_f64).fold(0.0f64, f64::max))
            .unwrap_or(0.0);
        let confidence = confidence_or(answer, max_prob)?;
        return Ok((Value::String(choice.to_owned()), probabilities, confidence));
    }
    if q.kind() == "score" {
        let score = number(answer.get("score").unwrap_or(&Value::Null), "score")?;
        let (min, max) = match q {
            Question::Score { min, max, .. } => (*min, *max),
            _ => unreachable!(),
        };
        let clamped = score.max(min).min(max);
        let confidence = confidence_or(answer, 0.5)?;
        return Ok((js_number(clamped), None, confidence));
    }
    let p = probability(answer.get("probability").unwrap_or(&Value::Null), "probability")?;
    let yes = p >= 0.5;
    let probabilities = Map::from_iter([
        ("yes".into(), js_number(p)),
        ("no".into(), js_number(1.0 - p)),
    ]);
    let confidence = confidence_or(answer, p.max(1.0 - p))?;
    Ok((Value::Bool(yes), Some(probabilities), confidence))
}

fn confidence_or(answer: &Map<String, Value>, fallback: f64) -> Result<f64, PluginError> {
    match answer.get("confidence") {
        Some(Value::Null) | None => Ok(fallback),
        Some(value) => probability(value, "confidence"),
    }
}

/// `jevClassifier.ask` (jev.ts:56-91), with the request key or `Jev HTTP`
/// wrapping rules.
pub async fn ask_jev(
    host: &impl ClassifierHost,
    config: &JevConfig,
    state: &str,
    q: &Question,
    timeout_ms: f64,
    now: impl Fn() -> f64,
) -> Result<Value, PluginError> {
    if !host.present(&config.key_ref).await? {
        let key_name = config
            .key_ref
            .split_once(':')
            .map(|(_, name)| name)
            .unwrap_or(&config.key_ref);
        return Err(internal(format!("Missing Jev API key: {key_name}")));
    }
    let start = now();
    let raw = post_json(
        host,
        &join_url(&config.base_url, "/v1/systemone"),
        &jev_request(state, q, &config.model),
        timeout_ms,
        Some(&config.key_ref),
    )
    .await
    .map_err(|error| match error {
        PostJsonError::Http(httperror) => {
            internal(format!("Jev HTTP {}", httperror.status))
        }
        other => other.into_plugin(),
    })?;
    let response = record(&raw)?;
    let answers = record(response.get("answers").unwrap_or(&Value::Null))?;
    let answer_value = answers
        .get(q.id())
        .ok_or_else(|| internal("Missing Jev answer"))?;
    let (value, probabilities, confidence) = map_jev_answer(q, answer_value)?;
    let latency = now() - start;

    let mut cost = None;
    if let (Some(usd_in), Some(usd_out)) = (config.usd_per_mtok_in, config.usd_per_mtok_out) {
        if let Some(usage) = response.get("usage").and_then(Value::as_object) {
            let token = |key: &str| {
                usage
                    .get(key)
                    .and_then(js::finite_number)
                    .filter(|n| *n >= 0.0)
            };
            if let (Some(input), Some(output)) =
                (token("input_tokens"), token("output_tokens"))
            {
                cost = Some((input * usd_in + output * usd_out) / 1_000_000.0);
            }
        }
    }

    let mut object = Map::new();
    object.insert("value".into(), value);
    if let Some(probabilities) = probabilities {
        object.insert("probabilities".into(), Value::Object(probabilities));
    }
    object.insert("confidence".into(), js_number(confidence));
    object.insert("latencyMs".into(), js_number(latency));
    if let Some(cost) = cost {
        object.insert("costUsd".into(), js_number(cost));
    }
    Ok(Value::Object(object))
}