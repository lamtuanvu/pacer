//! Native `executor.setup.connect` and `executor.setup.models`
//! (`src/core/opencode-setup.ts`). Connect only names the OpenCode sign-in
//! command. Models is native when a fresh cached catalog lists the provider's
//! models and OpenCode is not installed; a stale or missing catalog (network
//! fetch), a local model server (endpoint plugin), OpenCode model listing
//! (subprocess: the catalog is narrowed to the models OpenCode serves) and a
//! `base_url` (URL schema) forward to TypeScript.
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
            "command": format!("opencode auth login {}", provider.unwrap_or_default()),
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

/// The provider's cached catalog models when the cache is fresh and well formed.
fn cached_models(ctx: &Ctx, provider: &str) -> Option<Vec<Value>> {
    let cache: Value =
        pacer_foundation::fsutil::read_json(&ctx.pacer_home.join("cache").join("models.json"))?;
    let fetched = cache["fetchedAt"].as_f64()?;
    if !cache["providers"].is_object() || ctx.now - fetched >= CATALOG_MAX_AGE_S {
        return None;
    }
    let models = cache["providers"]
        .get(provider)?
        .get("models")?
        .as_array()?;
    (!models.is_empty() && models.iter().all(catalog_model)).then(|| models.clone())
}

/// Whether `opencode` is an executable on the context's PATH, as `ctx.which`.
fn opencode_installed(ctx: &Ctx) -> bool {
    use std::os::unix::fs::PermissionsExt;
    ctx.env.get("PATH").is_some_and(|path| {
        std::env::split_paths(path).any(|dir| {
            std::fs::metadata(dir.join("opencode"))
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
    })
}

/// Inputs whose models only TypeScript can list. Invalid params stay native.
pub fn executor_setup_models_stays_forwarded(ctx: &Ctx, params: &Value) -> bool {
    if params.get("base_url").is_some() {
        return true;
    }
    match models_params(params) {
        Err(_) => false,
        Ok((_, group)) if group == "local" => true,
        Ok((provider, _)) => opencode_installed(ctx) || cached_models(ctx, &provider).is_none(),
    }
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

/// `recommend(usable.map(toChoice), releases)`.
fn recommend(models: &[Value]) -> (Value, Vec<Value>) {
    let mut release = Map::new();
    for model in models.iter().filter(|m| usable(m)) {
        release.insert(
            model["id"].as_str().unwrap_or_default().into(),
            model["release"].clone(),
        );
    }
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
    let mut sorted: Vec<Value> = models.iter().filter(|m| usable(m)).map(choice).collect();
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

pub fn executor_setup_models(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        enforcement(ctx)?;
        let (provider, group) = models_params(&params)?;
        let models = (group != "local" && params.get("base_url").is_none())
            .then(|| cached_models(ctx, &provider))
            .flatten()
            .ok_or_else(|| {
                CoreError::new(
                    Code::Unavailable,
                    "executor.setup.models: these models need the forwarded operation",
                )
            })?;
        let (pick, rest) = recommend(&models);
        Ok(
            json!({"pick":pick,"rest":rest,"filtered":"catalog","usage":classify(&provider, &models)}),
        )
    })
}

#[cfg(test)]
mod tests;
