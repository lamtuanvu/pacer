//! Catalog refresh: `loadCatalog` and `writeCache` in `src/endpoints/catalog.ts`.
//! A fresh cache is local-only; a stale or missing one is fetched from
//! `PACER_CATALOG_URL` (default `https://models.dev/api.json`) with a 10 s
//! timeout and written back as `cache/models.json` (0600, temp file + rename).
//! A failed fetch leaves the stale cache, as TypeScript does.
use pacer_js_json::quoted;
use rand::random;
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

/// The published catalog endpoint.
pub const CATALOG_URL: &str = "https://models.dev/api.json";
/// `AbortSignal.timeout(10000)` in `loadCatalog`.
pub const TIMEOUT: Duration = Duration::from_secs(10);
/// `MAX_AGE_S` in catalog.ts.
pub const MAX_AGE_S: f64 = 24.0 * 3600.0;
/// Bound the response body before parsing it into memory.
const MAX_BYTES: u64 = 16 << 20;

/// `catalog_url(ctx)`: a fixture override, otherwise the compiled constant. The
/// value is read from the caller's environment, never from a request.
pub fn catalog_url(env: &HashMap<String, String>) -> String {
    env.get("PACER_CATALOG_URL")
        .filter(|url| !url.is_empty())
        .cloned()
        .unwrap_or_else(|| CATALOG_URL.into())
}

/// `cache/models.json` under the pacer home.
pub fn cache_file(home: &Path) -> PathBuf {
    home.join("cache").join("models.json")
}

/// `num` in catalog.ts: a finite non-negative number, where `0` is falsy for
/// limits (`num(...) || null`).
fn num(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
}
fn limit(value: Option<&Value>) -> Value {
    num(value)
        .filter(|n| *n != 0.0)
        .map(Value::from)
        .unwrap_or(Value::Null)
}
fn cost(value: Option<&Value>) -> Value {
    num(value).map(Value::from).unwrap_or(Value::Null)
}
fn strings(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item.is_string())
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}
/// `Object.entries` over a JSON object or array body.
fn entries(value: Option<&Value>) -> Vec<(String, &Value)> {
    match value {
        Some(Value::Object(fields)) => fields.iter().map(|(k, v)| (k.clone(), v)).collect(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        _ => Vec::new(),
    }
}
fn obj(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// `parseCatalog(raw)`: only plain data survives; keys are provider ids.
pub(crate) fn parse_catalog(raw: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, provider) in entries(Some(raw)) {
        let Some(fields) = provider.as_object() else {
            continue;
        };
        if obj(fields.get("models")).is_none() && !fields["models"].is_array() {
            continue;
        }
        let id = fields
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or(&key)
            .to_owned();
        let name = fields
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_owned();
        let mut models = Vec::new();
        for (mid, model) in entries(fields.get("models")) {
            let Some(model) = model.as_object() else {
                continue;
            };
            let modalities = obj(model.get("modalities"));
            let bounds = obj(model.get("limit"));
            let prices = obj(model.get("cost"));
            let mid = mid;
            let id = model
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or(&mid)
                .to_owned();
            let name = model
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&mid)
                .to_owned();
            models.push(json!({
                "id": id,
                "name": name,
                "toolCall": model.get("tool_call") == Some(&Value::Bool(true)),
                "input": strings(modalities.and_then(|m| m.get("input"))),
                "output": strings(modalities.and_then(|m| m.get("output"))),
                "context": limit(bounds.and_then(|b| b.get("context"))),
                "outputLimit": limit(bounds.and_then(|b| b.get("output"))),
                "costIn": cost(prices.and_then(|p| p.get("input"))),
                "costOut": cost(prices.and_then(|p| p.get("output"))),
                "release": model
                    .get("release_date")
                    .and_then(Value::as_str)
                    .map(Value::from)
                    .unwrap_or(Value::Null),
            }));
        }
        out.insert(
            id.clone(),
            json!({
                "id": id,
                "name": name,
                "env": strings(fields.get("env")),
                "api": fields
                    .get("api")
                    .and_then(Value::as_str)
                    .map(Value::from)
                    .unwrap_or(Value::Null),
                "models": models,
            }),
        );
    }
    out
}

/// A unique `<path>.<uuid>.tmp` name, as `randomUUID()` spells it.
fn temp_name(path: &Path) -> PathBuf {
    let b: [u8; 16] = random();
    let hex = |range: std::ops::Range<usize>| -> String {
        b[range].iter().map(|x| format!("{x:02x}")).collect()
    };
    let mut name = path.as_os_str().to_owned();
    name.push(format!(
        ".{}-{}-4{}-{:x}{}-{}.tmp",
        hex(0..4),
        hex(4..6),
        &hex(6..8)[1..],
        8 | (b[8] & 3),
        &hex(8..10)[2..],
        hex(10..16)
    ));
    PathBuf::from(name)
}

/// `writeCache`: best effort, `wx` temp file (0600) then rename in a 0700 dir.
fn write_cache(path: &Path, providers: &Map<String, Value>, now: f64) {
    let Some(dir) = path.parent() else {
        return;
    };
    if fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .is_err()
    {
        return;
    }
    let bytes = match serde_json::to_vec(&json!({"fetchedAt":now,"providers":providers})) {
        Ok(bytes) => bytes,
        Err(_) => return,
    };
    let temp = temp_name(path);
    let Ok(mut file) = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
    else {
        return;
    };
    let written = file.write_all(&bytes).is_ok();
    drop(file);
    if !written || fs::rename(&temp, path).is_err() {
        let _ = fs::remove_file(&temp);
    }
}

/// `readCachedCatalog`: the cache as JSON.parse left it, including a stale one.
pub fn read_cache(home: &Path) -> Option<Value> {
    let bytes = fs::read(cache_file(home)).ok()?;
    let value = quoted::parse_file(&bytes).ok()?;
    (value["fetchedAt"].as_f64().is_some() && value["providers"].is_object()).then_some(value)
}

pub fn fresh(cache: &Value, now: f64, max_age: f64) -> bool {
    cache["fetchedAt"]
        .as_f64()
        .is_some_and(|fetched| now - fetched < max_age)
}

fn fetch(url: &str) -> Option<Map<String, Value>> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .build()
        .new_agent();
    let mut response = agent.get(url).call().ok()?;
    if !response.status().is_success() {
        return None;
    }
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_BYTES {
        return None;
    }
    let parsed = quoted::parse_body(&bytes).ok()?;
    let providers = parse_catalog(&parsed);
    (!providers.is_empty()).then_some(providers)
}

/// `loadCatalog(ctx)`: a fresh cache answers locally; otherwise fetch, parse,
/// write the cache and return the new value, falling back to the stale cache.
pub async fn load(home: &Path, now: f64, env: &HashMap<String, String>) -> Option<Value> {
    let cached = read_cache(home);
    if cached
        .as_ref()
        .is_some_and(|value| fresh(value, now, MAX_AGE_S))
    {
        return cached;
    }
    let url = catalog_url(env);
    let providers = tokio::task::spawn_blocking(move || fetch(&url))
        .await
        .ok()
        .flatten();
    match providers {
        Some(providers) => {
            let value = json!({"fetchedAt":now,"providers":providers});
            write_cache(&cache_file(home), &providers, now);
            Some(value)
        }
        None => cached,
    }
}
