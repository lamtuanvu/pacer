//! Native `executor.setup.connect` and `executor.setup.models`
//! (`src/core/opencode-setup.ts`). Connect only names the OpenCode sign-in
//! command. Models reads the catalog cache, refreshing a stale one through
//! `pacer_models::catalog_fetch`, narrows a provider's models with `opencode
//! models`, and probes local servers through [`EndpointModels`] (the endpoint
//! plugin's `endpoint.models`).
#![allow(clippy::result_large_err)]
use icu_collator::CollatorBorrowed;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Map, Value, json};
use std::cmp::Ordering;

const GROUPS: &[&str] = &["signed_in", "local", "catalog"];
pub(crate) const CATALOG_MAX_AGE_S: f64 = 24.0 * 3600.0;

/// Keyless model discovery (`discoverEndpointModels` in
/// `src/plugins/endpoint-adapter.ts`). The server implements this over its
/// plugin/Core call bridge; the request carries a URL, never a credential.
pub trait EndpointModels: Send {
    /// `{"listed":bool,"models":[{"id":...}]}` in the endpoint plugin's shape.
    fn models(&mut self, base_url: &str, timeout_ms: u32) -> OpFuture<'_>;
}

pub(crate) fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

pub(crate) fn type_name(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

pub(crate) fn enforcement(ctx: &Ctx) -> Result<(), CoreError> {
    if ctx
        .env
        .get("PACER_ENFORCEMENT_TOKEN")
        .is_some_and(|token| !token.is_empty())
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial",
        ));
    }
    Ok(())
}

pub(crate) fn params_map(params: &Value) -> Result<Map<String, Value>, CoreError> {
    match params {
        Value::Null => Ok(Map::new()),
        Value::Object(map) => Ok(map.clone()),
        other => Err(invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(Some(other))
        ))),
    }
}

fn string<'a>(
    map: &'a Map<String, Value>,
    name: &str,
    issues: &mut Vec<String>,
) -> Option<&'a str> {
    let value = map.get(name);
    let text = value.and_then(Value::as_str);
    if text.is_none() {
        issues.push(format!(
            "{name}: Invalid input: expected string, received {}",
            type_name(value)
        ));
    }
    text
}

/// `/^[a-z0-9][a-z0-9._-]*$/`
fn provider_id(value: &str) -> bool {
    value
        .bytes()
        .next()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

fn finish(issues: Vec<String>) -> Result<(), CoreError> {
    if issues.is_empty() {
        Ok(())
    } else {
        Err(invalid(issues.join("; ")))
    }
}

pub fn executor_setup_connect(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        enforcement(ctx)?;
        let map = params_map(&params)?;
        let mut issues = Vec::new();
        let provider = string(&map, "provider", &mut issues);
        if provider.is_some_and(|p| !provider_id(p)) {
            issues.push(
                "provider: Invalid string: must match pattern /^[a-z0-9][a-z0-9._-]*$/".into(),
            );
        }
        if map.contains_key("key") && string(&map, "key", &mut issues) == Some("") {
            issues.push("key: Too small: expected string to have >=1 characters".into());
        }
        finish(issues)?;
        Ok(json!({
            "connected": false,
            "command": format!("opencode auth login --standalone {}", provider.unwrap_or_default()),
        }))
    })
}

/// `executor.setup.models` params, in Zod issue order.
fn models_params(params: &Value) -> Result<(String, String), CoreError> {
    let map = params_map(params)?;
    let mut issues = Vec::new();
    let provider = string(&map, "provider", &mut issues);
    if provider == Some("") {
        issues.push("provider: Too small: expected string to have >=1 characters".into());
    }
    let group = map.get("group").and_then(Value::as_str);
    if !group.is_some_and(|g| GROUPS.contains(&g)) {
        issues.push(
            "group: Invalid option: expected one of \"signed_in\"|\"local\"|\"catalog\"".into(),
        );
    }
    finish(issues)?;
    Ok((
        provider.unwrap_or_default().into(),
        group.unwrap_or_default().into(),
    ))
}

/// A cached catalog model in the shape `parseCatalog` writes.
pub(crate) fn catalog_model(model: &Value) -> bool {
    let strings = |key: &str| {
        model[key]
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_string))
    };
    let nullable =
        |key: &str, check: fn(&Value) -> bool| model[key].is_null() || check(&model[key]);
    model["id"].is_string()
        && model["name"].is_string()
        && model["toolCall"].is_boolean()
        && strings("input")
        && strings("output")
        && ["context", "outputLimit", "costIn", "costOut"]
            .iter()
            .all(|key| model.get(*key).is_some() && nullable(key, Value::is_number))
        && model.get("release").is_some()
        && nullable("release", Value::is_string)
}

/// The provider's catalog models from a cache value, when well formed.
pub(crate) fn provider_models(cache: &Value, provider: &str) -> Option<Vec<Value>> {
    let models = cache["providers"]
        .get(provider)?
        .get("models")?
        .as_array()?;
    (!models.is_empty() && models.iter().all(catalog_model)).then(|| models.clone())
}

/// `opencode models <provider>` narrowed to this provider's ids, or `None` when
/// OpenCode cannot list models. Uses Core's recorded environment and directory.
async fn served_ids(ctx: &Ctx, provider: &str) -> Option<Vec<String>> {
    if crate::setup_effects::which(ctx, "opencode").is_none() {
        return None;
    }
    let process = pacer_models::CoreProcess {
        env: ctx
            .env
            .iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect(),
        cwd: ctx.home.clone(),
    };
    let stdout = pacer_models::run_models(&process, pacer_models::TIMEOUT).await?;
    let ids = pacer_models::model_ids(&stdout, provider);
    (!ids.is_empty()).then_some(ids)
}

fn opencode_quota_source(provider: &str) -> bool {
    matches!(
        provider,
        "coding-plan" | "byteplus-coding-plan" | "volcengine-coding-plan"
    )
}

/// `classify` for a non-local provider with a catalog entry.
pub(crate) fn classify(provider: &str, models: &[Value]) -> Value {
    if opencode_quota_source(provider) {
        return json!({"usage":"quota","quota_source":"arkcli","known":true});
    }
    if provider.ends_with("-coding-plan") {
        return json!({"usage":"quota","known":true});
    }
    let priced: Vec<_> = models
        .iter()
        .filter(|m| !m["costIn"].is_null() || !m["costOut"].is_null())
        .collect();
    let free = |v: &Value| v.as_f64().is_none_or(|n| n == 0.0);
    if priced.is_empty() {
        json!({"usage":"metered","known":false})
    } else if priced
        .iter()
        .all(|m| free(&m["costIn"]) && free(&m["costOut"]))
    {
        json!({"usage":"quota","known":true})
    } else {
        json!({"usage":"metered","known":true})
    }
}

fn usable(model: &Value) -> bool {
    let texts = |key: &str| model[key].as_array().cloned().unwrap_or_default();
    let output = texts("output");
    model["toolCall"] == true
        && texts("input").iter().any(|v| v == "text")
        && !output.is_empty()
        && output.iter().all(|v| v == "text")
}

fn choice(model: &Value) -> Value {
    let or = |key: &str, default: u32| match &model[key] {
        Value::Null => json!(default),
        value => value.clone(),
    };
    json!({"id":model["id"],"name":model["name"],"context":or("context", 128_000),"output":or("outputLimit", 16_000),"tools":true,"costIn":model["costIn"],"costOut":model["costOut"]})
}

/// `/(coder|codestral|devstral|code)/i`: every alternative contains "code".
fn coding(text: &str) -> bool {
    text.to_ascii_lowercase().contains("code")
}

fn recommend_choices(mut sorted: Vec<Value>, release: &Map<String, Value>) -> (Value, Vec<Value>) {
    let collator = CollatorBorrowed::new_root(Default::default());
    let score = |m: &Value| {
        let id = m["id"].as_str().unwrap_or_default();
        let name = m["name"].as_str().unwrap_or_default();
        (
            u8::from(coding(id) || coding(name)),
            m["context"].as_f64().unwrap_or_default(),
            release
                .get(id)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        )
    };
    sorted.sort_by(|a, b| {
        let ((ca, xa, ra), (cb, xb, rb)) = (score(a), score(b));
        cb.cmp(&ca)
            .then(xb.partial_cmp(&xa).unwrap_or(Ordering::Equal))
            .then_with(|| collator.compare(&rb, &ra))
            .then_with(|| {
                collator.compare(
                    a["id"].as_str().unwrap_or_default(),
                    b["id"].as_str().unwrap_or_default(),
                )
            })
    });
    if sorted.is_empty() {
        return (Value::Null, vec![]);
    }
    let pick = sorted.remove(0);
    (pick, sorted)
}

/// `recommend(usable.map(toChoice), releases)`.
fn recommend(models: &[Value]) -> (Value, Vec<Value>) {
    let mut release = Map::new();
    for model in models.iter().filter(|m| usable(m)) {
        release.insert(
            model["id"].as_str().unwrap_or_default().into(),
            model["release"].clone(),
        );
    }
    recommend_choices(
        models.iter().filter(|m| usable(m)).map(choice).collect(),
        &release,
    )
}

/// `idChoice` in recommend.ts: an id without catalog facts keeps the defaults.
fn id_choice(id: &str) -> Value {
    json!({"id":id,"context":128_000,"output":16_000,"tools":true,"costIn":null,"costOut":null})
}

/// `NOT_CHAT` in recommend.ts.
fn chat_id(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    [
        "embed",
        "image",
        "tts",
        "whisper",
        "vision",
        "rerank",
        "moderation",
        "speech",
        "audio",
        "video",
    ]
    .iter()
    .any(|word| lower.contains(word))
}

pub fn executor_setup_models<'a>(
    ctx: &'a Ctx,
    params: Value,
    endpoints: &'a mut dyn EndpointModels,
) -> OpFuture<'a> {
    Box::pin(async move {
        enforcement(ctx)?;
        let (provider, group) = models_params(&params)?;
        let local = group == "local" || params.get("base_url").is_some();
        let mut cache = pacer_models::catalog_fetch::read_cache(&ctx.pacer_home);
        if cache
            .as_ref()
            .is_none_or(|c| !pacer_models::catalog_fetch::fresh(c, ctx.now, CATALOG_MAX_AGE_S))
        {
            cache = pacer_models::catalog_fetch::load(&ctx.pacer_home, ctx.now, &ctx.env).await;
        }
        let models = cache.as_ref().and_then(|c| provider_models(c, &provider));
        let usage = if local {
            json!({"usage":"unmetered","known":true})
        } else {
            classify(&provider, &models.clone().unwrap_or_default())
        };
        if local {
            let base_url = params
                .get("base_url")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let reply = endpoints.models(base_url, 3000).await?;
            let mut ids: Vec<Value> = if reply["listed"] == true {
                reply["models"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|m| m["id"].as_str())
                            .filter(|id| !chat_id(id))
                            .map(|id| id_choice(id))
                            .collect()
                    })
                    .unwrap_or_default()
            } else {
                vec![]
            };
            let (pick, rest) = recommend_choices(std::mem::take(&mut ids), &Map::new());
            return Ok(json!({"pick":pick,"rest":rest,"filtered":"ids","usage":usage}));
        }
        if let Some(models) = models {
            let served = served_ids(ctx, &provider).await;
            let live = match &served {
                Some(ids) if !ids.is_empty() => models
                    .iter()
                    .filter(|m| {
                        ids.iter()
                            .any(|id| id == m["id"].as_str().unwrap_or_default())
                    })
                    .cloned()
                    .collect::<Vec<_>>(),
                _ => models.clone(),
            };
            let live = if live.is_empty() {
                models.clone()
            } else {
                live
            };
            let (pick, rest) = recommend(&live);
            return Ok(json!({"pick":pick,"rest":rest,"filtered":"catalog","usage":usage}));
        }
        match served_ids(ctx, &provider).await {
            Some(ids) => {
                let choices: Vec<Value> = ids
                    .iter()
                    .map(String::as_str)
                    .filter(|id| !chat_id(id))
                    .map(id_choice)
                    .collect();
                let (pick, rest) = recommend_choices(choices, &Map::new());
                Ok(json!({"pick":pick,"rest":rest,"filtered":"ids","usage":usage}))
            }
            None => Ok(json!({"pick":null,"rest":[],"filtered":"ids","usage":usage,
                "note":format!("OpenCode could not list models for {provider}; enter a model id.")})),
        }
    })
}

#[cfg(test)]
mod tests;
