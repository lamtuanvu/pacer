//! `discoverModels`, a port of `plugins/pacer-endpoints/models.ts`. Credentials
//! remain host-owned; transport errors and bodies are never diagnostics. The
//! failure reason strings are verbatim from the TypeScript so the two doors
//! produce byte-identical transcripts.

use pacer_plugin::{Host, PluginError};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use std::time::Duration;
use url::Url;

const DEFAULT_TIMEOUT_MS: u64 = 10_000;

/// `discoverModels(host, input)` in models.ts:21.
pub async fn discover_models(host: &Host, input: &Value) -> Result<Value, PluginError> {
    let base_url = input.get("baseUrl").and_then(Value::as_str).unwrap_or_default();
    let key_ref = input.get("keyRef").and_then(non_null_str);
    let timeout_ms = input
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS);

    let probe = discover(host, base_url, key_ref, timeout_ms);
    match tokio::time::timeout(Duration::from_millis(timeout_ms), probe).await {
        Ok(result) => Ok(result),
        Err(_) => Ok(fail("timeout", "Model discovery timed out.")),
    }
}

fn non_null_str(value: &Value) -> Option<&str> {
    match value {
        Value::String(s) => Some(s),
        _ => None,
    }
}

fn fail(error: &str, detail: &str) -> Value {
    json!({ "listed": false, "error": error, "detail": detail })
}

async fn discover(
    host: &Host,
    base_url: &str,
    key_ref: Option<&str>,
    timeout_ms: u64,
) -> Value {
    let mut url = match Url::parse(base_url) {
        Ok(url) => url,
        Err(_) => return fail("invalid_url", "Check the URL and try again."),
    };
    // Reject non-http(s) schemes and embedded userinfo (models.ts:33-36).
    if !(url.scheme() == "http" || url.scheme() == "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return fail("invalid_url", "Check the URL and try again.");
    }
    let path = format!("{}/models", url.path().trim_end_matches('/'));
    url.set_path(&path);

    let mut request = Map::new();
    request.insert("url".into(), json!(url.to_string()));
    request.insert("method".into(), json!("GET"));
    request.insert("timeoutMs".into(), json!(timeout_ms));
    if let Some(k) = key_ref {
        request.insert("authorization".into(), json!({ "secretRef": k }));
    }

    let response = match host.http(Value::Object(request)).await {
        Ok(response) => response,
        Err(error) => {
            if error.code == "capability_denied"
                && error.reason.as_deref() == Some("credential_reflection")
            {
                return fail("invalid_response", "The endpoint returned an invalid model list.");
            }
            return fail("unreachable", "Endpoint unreachable. Check the URL and try again.");
        }
    };
    if response.status == 401 || response.status == 403 {
        return fail("refused", "The key was refused.");
    }
    if response.status == 404 {
        return fail("not_listed", "This endpoint doesn't list models. Enter model ids.");
    }
    if response.status < 200 || response.status >= 300 {
        return fail(
            "http_error",
            &format!("Model discovery failed (HTTP {}).", response.status),
        );
    }
    let body = response.body;
    // Response.json strips one initial UTF-8 BOM; host.http returns text.
    let stripped = body.strip_prefix('\u{feff}').unwrap_or(&body);
    let parsed: Value = match serde_json::from_str(stripped) {
        Ok(value) => value,
        Err(_) => return fail("invalid_response", "The endpoint returned an invalid model list."),
    };
    let entries = parsed
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| parsed.get("models").and_then(Value::as_array));
    let entries = match entries {
        Some(entries) => entries,
        None => return fail("not_listed", "This endpoint doesn't list models. Enter model ids."),
    };

    let models = build_models(entries);
    json!({ "listed": true, "models": models })
}

/// `positive(...values)` in models.ts:52: the first number that is a safe
/// integer and positive, if any.
fn positive(values: &[Option<&Value>]) -> Option<i64> {
    values.iter().find_map(|v| match v {
        Some(value) => {
            let n = value.as_i64()?;
            (n > 0).then_some(n)
        }
        None => None,
    })
}

/// Build the discovered-model list exactly as models.ts:54-64 does, skipping
/// entries without a unique non-blank id and keeping the first positive
/// context/output found in the documented field order.
fn build_models(entries: &[Value]) -> Vec<Value> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut models: Vec<Value> = Vec::new();
    for item in entries {
        let obj = match item.as_object() {
            Some(obj) => obj,
            None => continue,
        };
        let id = obj
            .get("id")
            .or_else(|| obj.get("model"))
            .or_else(|| obj.get("name"))
            .and_then(Value::as_str);
        let id = match id {
            Some(id) if !id.trim().is_empty() && !seen.contains(id) => id,
            _ => continue,
        };
        seen.insert(id.to_owned());

        let name = obj.get("display_name").or_else(|| obj.get("name"));
        let mut context_fields: Vec<Option<&Value>> = vec![
            obj.get("context_length"),
            obj.get("max_model_len"),
            obj.get("max_context_length"),
            obj.get("context_window"),
        ];
        if let Some(model_info) = obj.get("model_info").and_then(Value::as_object) {
            for (key, value) in model_info {
                if key.ends_with(".context_length") {
                    context_fields.push(Some(value));
                }
            }
        }
        let context = positive(&context_fields);
        let output = positive(&[
            obj.get("max_output_tokens"),
            obj.get("max_completion_tokens"),
            obj.get("output_length"),
        ]);
        let tools = obj.get("tools").and_then(Value::as_bool);

        let mut model = Map::new();
        model.insert("id".into(), json!(id));
        if let Some(name) = name.and_then(Value::as_str) {
            model.insert("name".into(), json!(name));
        }
        if let Some(context) = context {
            model.insert("context".into(), json!(context));
        }
        if let Some(output) = output {
            model.insert("output".into(), json!(output));
        }
        if let Some(tools) = tools {
            model.insert("tools".into(), json!(tools));
        }
        models.push(Value::Object(model));
    }
    models
}