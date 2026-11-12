//! `availableModels` without the OpenCode probe: the listing cache, endpoint
//! connections and runners that have no listing source.
use pacer_js_json::quoted;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// OpenCode listings are cached for ten minutes; connection lists are read fresh.
pub const CACHE_TTL_S: f64 = 600.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelSource {
    Opencode,
    Connection,
    Discovery,
    None,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AvailableModel {
    pub id: String,
}

/// `models: None` means the runner's models are unknown, not that it has none.
#[derive(Clone, Debug, PartialEq)]
pub struct AvailableModels {
    pub runner: String,
    pub source: ModelSource,
    pub models: Option<Vec<AvailableModel>>,
    pub fetched_at: f64,
    pub note: Option<String>,
    pub provider: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Listing {
    Known(AvailableModels),
    /// An OpenCode provider without a fresh cache: TypeScript runs `opencode models`.
    NeedsDiscovery,
    /// A cache TypeScript serves whose values the native check cannot reproduce.
    Unsupported,
}

enum Cached {
    Hit(AvailableModels),
    Miss,
    Unsupported,
}

/// `cache/available-models/<sha256(runnerId)>.json` under the pacer home.
pub fn cache_file(home: &Path, runner_id: &str) -> PathBuf {
    let hash = Sha256::digest(runner_id.as_bytes());
    home.join("cache")
        .join("available-models")
        .join(format!("{hash:x}.json"))
}

/// A JavaScript string other than the quoted forms of signed Infinity.
fn js_string(value: &Value) -> bool {
    value.is_string() && quoted::number(value).is_none()
}

/// Text without quoted lone surrogates, which the native check would compare differently.
fn plain_text(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.contains('\u{fdd0}'))
}

/// `readCache`: a miss wherever TypeScript returns null. A hit whose model
/// entries are not objects with a string `id`, or whose note is not text,
/// makes TypeScript compare or format odd values, so it stays unsupported.
fn read_cache(path: &Path, now: f64) -> Cached {
    let Ok(meta) = fs::metadata(path) else {
        return Cached::Miss;
    };
    if meta.is_dir() {
        return Cached::Miss;
    }
    if !meta.is_file() {
        return Cached::Unsupported;
    }
    let Ok(bytes) = fs::read(path) else {
        return Cached::Miss;
    };
    let value = match quoted::parse_file(&bytes) {
        Ok(value) => value,
        Err(error) if error == quoted::NESTING_FALLBACK => return Cached::Unsupported,
        Err(_) => return Cached::Miss,
    };
    let Value::Object(v) = value else {
        return Cached::Miss;
    };
    let runner = v.get("runner").filter(|r| js_string(r));
    let fetched_at = v.get("fetchedAt").and_then(quoted::number);
    let (Some(runner), Some(fetched_at)) = (runner, fetched_at) else {
        return Cached::Miss;
    };
    // Only OpenCode listings are cached; any other source is never served.
    if v.get("source").and_then(Value::as_str) != Some("opencode") {
        return Cached::Miss;
    }
    let items = match v.get("models") {
        Some(Value::Null) => None,
        Some(Value::Array(items)) => Some(items),
        _ => return Cached::Miss,
    };
    if now - fetched_at >= CACHE_TTL_S {
        return Cached::Miss;
    }
    let mut models = None;
    if let Some(items) = items {
        let mut ids = Vec::with_capacity(items.len());
        for item in items {
            match item
                .as_object()
                .and_then(|m| m.get("id"))
                .and_then(plain_text)
            {
                Some(id) => ids.push(AvailableModel { id: id.to_owned() }),
                None => return Cached::Unsupported,
            }
        }
        models = Some(ids);
    }
    let note = match v.get("note") {
        None | Some(Value::Null) => None,
        Some(note) => match plain_text(note) {
            Some(text) => Some(text.to_owned()),
            None if models.is_some() => None,
            None => return Cached::Unsupported,
        },
    };
    Cached::Hit(AvailableModels {
        runner: runner.as_str().unwrap_or("").to_owned(),
        source: ModelSource::Opencode,
        models,
        fetched_at,
        note,
        provider: v.get("provider").and_then(plain_text).map(str::to_owned),
    })
}

/// `availableModels(ctx, runnerId)` for a loaded strategy. Only an OpenCode
/// listing is cached, and a fresh cache is served whatever the account is now.
pub fn available_models(home: &Path, now: f64, strategy: &Value, runner_id: &str) -> Listing {
    match read_cache(&cache_file(home, runner_id), now) {
        Cached::Hit(list) => return Listing::Known(list),
        Cached::Unsupported => return Listing::Unsupported,
        Cached::Miss => {}
    }
    let mut list = AvailableModels {
        runner: runner_id.to_owned(),
        source: ModelSource::None,
        models: None,
        fetched_at: now,
        note: None,
        provider: None,
    };
    let Some(runner) = strategy["runners"].get(runner_id) else {
        return Listing::Known(list);
    };
    let name = runner["account"].as_str().unwrap_or("");
    let Some(account) = strategy["accounts"].get(name) else {
        return Listing::Known(list);
    };
    let opencode = account["provider"]
        .as_str()
        .filter(|provider| account["source"] == "opencode" && !provider.is_empty());
    list.provider = Some(opencode.unwrap_or(name).to_owned());
    if opencode.is_some() {
        return Listing::NeedsDiscovery;
    }
    let Some(connection) = account.get("connection").filter(|c| c.is_object()) else {
        return Listing::Known(list);
    };
    list.source = ModelSource::Connection;
    let declared = connection["models"]
        .as_array()
        .map_or(&[][..], Vec::as_slice);
    if declared.is_empty() {
        let account_name = account["name"].as_str().unwrap_or(name);
        list.note = Some(format!("{account_name} declares no models"));
    } else {
        list.models = Some(
            declared
                .iter()
                .map(|model| AvailableModel {
                    id: format!("pacer-{name}/{}", model["id"].as_str().unwrap_or("")),
                })
                .collect(),
        );
    }
    Listing::Known(list)
}
