//! The external `ollama` classifier, a port of `plugins/pacer-classify/ollama.ts`.
//!
//! Posts an OpenAI-compatible structured request to `/chat/completions` and maps
//! the reply back, including a fenced-JSON fallback (`parse_local_answer`).

use super::http::{ClassifierHost, PostJsonError, Question, field_for, join_url, js_number, post_json};
use crate::config::OllamaConfig;
use pacer_plugin::{PluginError, js};
use regex::Regex;
use serde_json::{Value, json};

fn internal(message: impl Into<String>) -> PluginError {
    PluginError::new("internal", message)
}

/// `answerField` (ollama.ts:4-6) via the shared `field_for`.
fn answer_field(q: &Question) -> &'static str {
    field_for(q.kind())
}

/// `schemaFor` (ollama.ts:8-21): the structured JSON schema body.
pub fn schema_for(q: &Question) -> Value {
    let property = match q {
        Question::Choice { criteria, .. } => {
            let keys: Vec<Value> = criteria.keys().map(|k| json!(k)).collect();
            json!({ "type": "string", "enum": keys })
        }
        Question::Score { min, max, .. } => {
            json!({ "type": "number", "minimum": js_number(*min), "maximum": js_number(*max) })
        }
        Question::YesNo { .. } => json!({ "type": "boolean" }),
    };
    let field = answer_field(q);
    json!({
        "type": "object",
        "properties": {
            field: property,
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
        },
        "required": [field, "confidence"],
        "additionalProperties": false,
    })
}

/// `promptFor` (ollama.ts:23-30): the user prompt embedding `state`.
pub fn prompt_for(q: &Question, state: &str) -> String {
    let criteria = match q {
        Question::Choice { criteria, .. } => {
            format!("Criteria: {}", serde_json::to_string(criteria).unwrap_or_default())
        }
        Question::Score { min, max, .. } => {
            format!(
                "Score must be between {} and {}.",
                js::number_string(*min),
                js::number_string(*max)
            )
        }
        Question::YesNo { .. } => "Answer must be a boolean.".to_owned(),
    };
    format!(
        "{}\n{}\nReturn only JSON with {} and confidence (a number between 0 and 1).\nState:\n{}",
        q.instructions(),
        criteria,
        answer_field(q),
        state
    )
}

/// `parseLocalAnswer` (ollama.ts:32-53): parse and validate a raw completion,
/// returning `(value, confidence)`. Failures are plain `Error` -> `internal`.
pub fn parse_local_answer(q: &Question, content: &str) -> Result<(Value, f64), PluginError> {
    let trimmed = js::trim(content);
    let fenced = fence_regex().captures(trimmed);
    let raw: Value = match fenced {
        Some(captures) => {
            let inner = js::trim(&captures[1]);
            serde_json::from_str(inner)
                .map_err(|_| internal("Expected a JSON answer object"))?
        }
        None => serde_json::from_str(trimmed)
            .map_err(|_| internal("Expected a JSON answer object"))?,
    };
    let data = match raw.as_object() {
        Some(data) => data,
        None => return Err(internal("Expected a JSON answer object")),
    };
    let confidence = data
        .get("confidence")
        .and_then(js::finite_number)
        .filter(|c| (0.0..=1.0).contains(c))
        .ok_or_else(|| internal("Confidence must be a number between 0 and 1"))?;
    let field = answer_field(q);
    let value = data.get(field).cloned().ok_or_else(|| match q {
        Question::YesNo { .. } => internal("Answer must be a boolean"),
        Question::Score { .. } => internal("Score must be a number between 0 and 1"),
        Question::Choice { .. } => internal("Choice must be one of the criteria"),
    })?;
    match q {
        Question::Choice { criteria, .. } => {
            let Value::String(choice) = &value else {
                return Err(internal("Choice must be one of the criteria"));
            };
            if !criteria.contains_key(choice) {
                return Err(internal("Choice must be one of the criteria"));
            }
        }
        Question::Score { min, max, .. } => {
            let Some(n) = value.as_f64().filter(|n| n.is_finite()) else {
                return Err(internal(format!(
                    "Score must be a number between {} and {}",
                    js::number_string(*min),
                    js::number_string(*max)
                )));
            };
            if n < *min || n > *max {
                return Err(internal(format!(
                    "Score must be a number between {} and {}",
                    js::number_string(*min),
                    js::number_string(*max)
                )));
            }
        }
        Question::YesNo { .. } => {
            if !value.is_boolean() {
                return Err(internal("Answer must be a boolean"));
            }
        }
    }
    Ok((value, confidence))
}

static FENCE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

fn fence_regex() -> &'static Regex {
    FENCE.get_or_init(|| {
        Regex::new(r"(?is)^```(?:json)?\s*\n?(.*?)\n?```$").expect("valid fence regex")
    })
}

/// `ask_ollama` (ollama.ts:63-87): missing optional local credentials issue an
/// anonymous request; the reply is mapped with `parse_local_answer` and a zero
/// cost.
pub async fn ask_ollama(
    host: &impl ClassifierHost,
    config: &OllamaConfig,
    state: &str,
    q: &Question,
    timeout_ms: f64,
    now: impl Fn() -> f64,
) -> Result<Value, PluginError> {
    let key_ref = match &config.key_ref {
        Some(reference) if host.present(reference).await? => Some(reference.as_str()),
        _ => None,
    };
    let started = now();
    let request = json!({
        "model": config.model,
        "temperature": 0,
        "stream": false,
        "max_tokens": config.max_tokens,
        "messages": [{ "role": "user", "content": prompt_for(q, state) }],
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": q.id(), "schema": schema_for(q) },
        }
    });
    let raw = post_json(
        host,
        &join_url(&config.base_url, "/chat/completions"),
        &request,
        timeout_ms,
        key_ref,
    )
    .await
    .map_err(PostJsonError::into_plugin)?;
    let content = raw
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .ok_or_else(|| internal("Missing chat completion message content"))?;
    let (value, confidence) = parse_local_answer(q, content)?;
    let latency = now() - started;
    Ok(super::http::answer_body(
        value,
        confidence,
        latency,
        Some(js_number(0.0)),
        None,
    ))
}