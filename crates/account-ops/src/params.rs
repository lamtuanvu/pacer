//! The published account operation params. Rust accepts only inputs these
//! schemas accept; anything else forwards so TypeScript reports its own Zod text.
use crate::js::{account_name, utf16_len};
use serde_json::{Map, Value, json};

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// `params ?? {}` as an object.
pub(crate) fn object(params: &Value) -> Option<Map<String, Value>> {
    match params {
        Value::Null => Some(Map::new()),
        Value::Object(m) => Some(m.clone()),
        _ => None,
    }
}

/// `z.string().min(1).max(128)`
pub(crate) fn id(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| (1..=128).contains(&utf16_len(s)))
}

fn optional(p: &Map<String, Value>, key: &str, ok: impl Fn(&Value) -> bool) -> bool {
    p.get(key).is_none_or(ok)
}

fn positive_int(v: &Value) -> Option<i64> {
    v.as_f64()
        .filter(|n| n.fract() == 0.0 && *n > 0.0 && *n <= MAX_SAFE)
        .map(|n| n as i64)
}

/// `z.url()` refined to `^https?://`, for printable ASCII text only.
pub(crate) fn base_url(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| {
        s.bytes().all(|b| b.is_ascii_graphic())
            && (s.starts_with("http://") || s.starts_with("https://"))
            && url::Url::parse(s).is_ok()
    })
}

/// `z.array(endpointModel).min(1)`, in schema key order with integral numbers.
fn models(v: &Value) -> Option<Vec<Value>> {
    let list = v.as_array().filter(|l| !l.is_empty())?;
    list.iter()
        .map(|m| {
            let m = m.as_object()?;
            let id = m.get("id")?.as_str().filter(|s| !s.is_empty())?;
            let mut out = Map::new();
            out.insert("id".into(), json!(id));
            if let Some(name) = m.get("name") {
                out.insert("name".into(), json!(name.as_str()?));
            }
            out.insert("context".into(), json!(positive_int(m.get("context")?)?));
            out.insert("output".into(), json!(positive_int(m.get("output")?)?));
            out.insert("tools".into(), json!(m.get("tools")?.as_bool()?));
            Some(Value::Object(out))
        })
        .collect()
}

fn env_var(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        let b = s.as_bytes();
        !b.is_empty()
            && (b[0].is_ascii_alphabetic() || b[0] == b'_')
            && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
    })
}

fn key_source(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| ["keychain", "file", "env", "none"].contains(&s))
}

fn usage(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| ["quota", "metered", "unmetered"].contains(&s))
}

/// Parsed `endpointFields`; absent optional fields stay `None`.
#[derive(Debug, Default, Clone)]
pub(crate) struct Endpoint {
    pub name: String,
    pub base_url: Option<String>,
    pub key_source: Option<String>,
    pub env_var: Option<String>,
    pub models: Option<Vec<Value>>,
    pub usage: Option<String>,
    pub weekly_tokens: Option<i64>,
    pub quota_source: Option<String>,
    pub test: Option<bool>,
    pub key: bool,
}

fn endpoint(p: &Map<String, Value>, required: &[&str]) -> Option<Endpoint> {
    if required.iter().any(|k| !p.contains_key(*k)) {
        return None;
    }
    let text = |k: &str| p.get(k).and_then(Value::as_str).map(str::to_owned);
    let fine = optional(p, "base_url", |v| base_url(v).is_some())
        && optional(p, "key_source", key_source)
        && optional(p, "key", Value::is_string)
        && optional(p, "env_var", env_var)
        && optional(p, "models", |v| models(v).is_some())
        && optional(p, "usage", usage)
        && optional(p, "weekly_tokens", |v| positive_int(v).is_some())
        && optional(p, "quota_source", |v| {
            v.as_str().is_some_and(|s| !s.is_empty())
        })
        && optional(p, "test", Value::is_boolean);
    fine.then(|| Endpoint {
        name: text("name").unwrap_or_default(),
        base_url: text("base_url"),
        key_source: text("key_source"),
        env_var: text("env_var"),
        models: p.get("models").and_then(models),
        usage: text("usage"),
        weekly_tokens: p.get("weekly_tokens").and_then(positive_int),
        quota_source: text("quota_source"),
        test: p.get("test").and_then(Value::as_bool),
        key: p.contains_key("key"),
    })
}

/// `account.add` with `kind: endpoint` (not `source: opencode`).
pub(crate) fn add(params: &Value) -> Option<Endpoint> {
    let p = object(params)?;
    if p.get("kind") != Some(&json!("endpoint")) || p.contains_key("source") {
        return None;
    }
    id(p.get("name")?)?;
    endpoint(&p, &["base_url", "key_source", "models", "usage"])
}

/// `account.edit` (`endpointEdit`).
pub(crate) fn edit(params: &Value) -> Option<Endpoint> {
    let p = object(params)?;
    id(p.get("name")?)?;
    endpoint(&p, &[])
}

/// `account.adopt`: only `name`, `key_source`, `key` and `env_var` survive parsing.
pub(crate) fn adopt(params: &Value) -> Option<Endpoint> {
    let mut p = object(params)?;
    id(p.get("name")?)?;
    p.retain(|k, _| ["name", "key_source", "key", "env_var"].contains(&k.as_str()));
    endpoint(&p, &["key_source"])
}

/// `account.remove`: `{name, delete_home?}`.
pub(crate) fn remove(params: &Value) -> Option<(String, bool)> {
    let p = object(params)?;
    let name = id(p.get("name")?).filter(|n| account_name(n))?;
    let delete = match p.get("delete_home") {
        None => false,
        Some(v) => v.as_bool()?,
    };
    Some((name.to_owned(), delete))
}

/// `account.usage.check`: `{account, consent?}`.
pub(crate) fn usage_check(params: &Value) -> Option<(String, bool)> {
    let p = object(params)?;
    let account = id(p.get("account")?)?;
    let consent = match p.get("consent") {
        None => false,
        Some(v) => v.as_bool()?,
    };
    Some((account.to_owned(), consent))
}

/// `account.models` without a supplied key: `{name?, base_url?}`.
pub(crate) fn models_params(params: &Value) -> Option<(Option<String>, Option<String>)> {
    let p = object(params)?;
    if p.contains_key("key") {
        return None;
    }
    let name = match p.get("name") {
        None => None,
        Some(v) => Some(id(v)?.to_owned()),
    };
    let url = match p.get("base_url") {
        None => None,
        Some(v) => Some(base_url(v)?.to_owned()),
    };
    Some((name, url))
}

/// `account.test`: `{name}`.
pub(crate) fn test_params(params: &Value) -> Option<String> {
    let p = object(params)?;
    Some(id(p.get("name")?)?.to_owned())
}
