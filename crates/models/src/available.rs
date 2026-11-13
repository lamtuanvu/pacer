//! `availableModels` (`src/models/available.ts`): the listing cache, endpoint
//! connections, runners that have no listing source, and the listing an
//! OpenCode provider needs discovered (`discover`).
use pacer_js_json::{js_semantics::truthy, quoted};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// OpenCode listings are cached for ten minutes; connection lists are read fresh.
pub const CACHE_TTL_S: f64 = 600.0;

/// Names `strategy.accounts[name]` resolves through `Object.prototype` in TypeScript.
pub(crate) const PROTOTYPE_KEYS: [&str; 12] = [
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelSource {
    Opencode,
    Connection,
    Discovery,
    None,
}

impl ModelSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Opencode => "opencode",
            Self::Connection => "connection",
            Self::Discovery => "discovery",
            Self::None => "none",
        }
    }
}

/// One listed model. Facts are the JSON values TypeScript copies, in their
/// quoted (`pacer_js_json::quoted`) form; `None` is a fact JSON omits.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AvailableModel {
    pub id: String,
    pub name: Option<Value>,
    pub context: Option<Value>,
    pub output: Option<Value>,
    pub tools: Option<Value>,
    pub cost_in: Option<Value>,
    pub cost_out: Option<Value>,
    pub release: Option<Value>,
}

impl AvailableModel {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            ..Self::default()
        }
    }
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

/// A Rust string as a quoted JavaScript string value.
fn text(s: &str) -> Value {
    quoted::from_utf8(Value::String(s.to_owned()))
}

/// A JavaScript number as `JSON.stringify` writes it: integral values as integers.
pub(crate) fn js_number(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

impl AvailableModels {
    /// The object TypeScript returns, in its key order and quoted form.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("runner".into(), text(&self.runner));
        out.insert("source".into(), json!(self.source.as_str()));
        let models = self.models.as_ref().map(|models| {
            models
                .iter()
                .map(|m| {
                    let mut entry = Map::new();
                    entry.insert("id".into(), text(&m.id));
                    for (key, fact) in [
                        ("name", &m.name),
                        ("context", &m.context),
                        ("output", &m.output),
                        ("tools", &m.tools),
                        ("costIn", &m.cost_in),
                        ("costOut", &m.cost_out),
                        ("release", &m.release),
                    ] {
                        if let Some(fact) = fact {
                            entry.insert(key.into(), fact.clone());
                        }
                    }
                    Value::Object(entry)
                })
                .collect()
        });
        out.insert("models".into(), models.map_or(Value::Null, Value::Array));
        out.insert("fetchedAt".into(), js_number(self.fetched_at));
        if let Some(provider) = &self.provider {
            out.insert("provider".into(), text(provider));
        }
        if let Some(note) = &self.note {
            out.insert("note".into(), text(note));
        }
        Value::Object(out)
    }
}

/// An OpenCode provider without a fresh cache: the listing `opencode models`
/// would complete. `base` is the unknown listing TypeScript starts from.
#[derive(Clone, Debug, PartialEq)]
pub struct Discovery {
    pub base: AvailableModels,
    pub provider: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Listing {
    Known(AvailableModels),
    /// An OpenCode provider without a fresh cache: `discover` runs `opencode models`.
    NeedsDiscovery(Discovery),
    /// A state TypeScript serves whose values the native check cannot reproduce.
    Unsupported,
}

pub(crate) enum Cached {
    /// The cache object as `JSON.parse` returned it, which TypeScript serves as is.
    Hit(Value),
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

/// `readCache`: a miss wherever TypeScript returns null, else the parsed object.
pub(crate) fn read_cache(path: &Path, now: f64) -> Cached {
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
    let Value::Object(v) = &value else {
        return Cached::Miss;
    };
    let runner = v.get("runner").filter(|r| js_string(r));
    let fetched_at = v.get("fetchedAt").and_then(quoted::number);
    let (Some(_), Some(fetched_at)) = (runner, fetched_at) else {
        return Cached::Miss;
    };
    // Only OpenCode listings are cached; any other source is never served.
    if v.get("source").and_then(Value::as_str) != Some("opencode") {
        return Cached::Miss;
    }
    if !matches!(v.get("models"), Some(Value::Null | Value::Array(_))) {
        return Cached::Miss;
    }
    if now - fetched_at >= CACHE_TTL_S {
        return Cached::Miss;
    }
    Cached::Hit(value)
}

/// A served cache as a listing the model checks read. Model entries that are
/// not objects with a string `id`, or a note that is not text, make
/// TypeScript compare or format odd values, so the check stays unsupported.
fn listing_of(value: &Value) -> Option<AvailableModels> {
    let mut models = None;
    if let Some(items) = value["models"].as_array() {
        let mut ids = Vec::with_capacity(items.len());
        for item in items {
            let id = item.as_object().and_then(|m| m.get("id"));
            ids.push(AvailableModel::new(id.and_then(plain_text)?));
        }
        models = Some(ids);
    }
    let note = match value.get("note") {
        None | Some(Value::Null) => None,
        Some(note) => match plain_text(note) {
            Some(text) => Some(text.to_owned()),
            None if models.is_some() => None,
            None => return None,
        },
    };
    Some(AvailableModels {
        runner: value["runner"].as_str().unwrap_or("").to_owned(),
        source: ModelSource::Opencode,
        models,
        fetched_at: quoted::number(&value["fetchedAt"]).unwrap_or(0.0),
        note,
        provider: value
            .get("provider")
            .and_then(plain_text)
            .map(str::to_owned),
    })
}

/// `Date.now() / 1000` at millisecond resolution, as TypeScript stamps a listing.
fn stamp(now: f64) -> f64 {
    (now * 1000.0).floor() / 1000.0
}

/// The listing without the cache: the runner's account picks the source.
pub(crate) fn compose(now: f64, strategy: &Value, runner_id: &str) -> Listing {
    let mut list = AvailableModels {
        runner: runner_id.to_owned(),
        source: ModelSource::None,
        models: None,
        fetched_at: stamp(now),
        note: None,
        provider: None,
    };
    let Some(runner) = strategy["runners"].get(runner_id) else {
        return Listing::Known(list);
    };
    let name = runner["account"].as_str().unwrap_or("");
    let Some(account) = strategy["accounts"].get(name) else {
        if PROTOTYPE_KEYS.contains(&name) {
            return Listing::Unsupported;
        }
        return Listing::Known(list);
    };
    let opencode = account["provider"]
        .as_str()
        .filter(|provider| account["source"] == "opencode" && !provider.is_empty());
    list.provider = Some(opencode.unwrap_or(name).to_owned());
    if let Some(provider) = opencode {
        list.source = ModelSource::Opencode;
        return Listing::NeedsDiscovery(Discovery {
            base: list,
            provider: provider.to_owned(),
        });
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
                .map(|model| {
                    let fact = |key: &str| model.get(key).map(|v| quoted::from_utf8(v.clone()));
                    AvailableModel {
                        id: format!("pacer-{name}/{}", model["id"].as_str().unwrap_or("")),
                        name: fact("name").filter(truthy),
                        context: fact("context"),
                        output: fact("output"),
                        tools: fact("tools"),
                        ..AvailableModel::default()
                    }
                })
                .collect(),
        );
    }
    Listing::Known(list)
}

/// `availableModels(ctx, runnerId)` for a loaded strategy, up to discovery.
/// Only an OpenCode listing is cached, and a fresh cache is served whatever
/// the account is now.
pub fn available_models(home: &Path, now: f64, strategy: &Value, runner_id: &str) -> Listing {
    match read_cache(&cache_file(home, runner_id), now) {
        Cached::Hit(value) => listing_of(&value).map_or(Listing::Unsupported, Listing::Known),
        Cached::Unsupported => Listing::Unsupported,
        Cached::Miss => compose(now, strategy, runner_id),
    }
}
