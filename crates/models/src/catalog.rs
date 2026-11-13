//! Catalog facts for discovered models: `readCachedCatalog(ctx)?.providers[provider]`
//! (`src/endpoints/catalog.ts`) and the `entry?.models.find(m => m.id === id)`
//! lookup in `opencodeModels`. The cache is read as `JSON.parse` left it.
use crate::{AvailableModel, available::PROTOTYPE_KEYS};
use pacer_js_json::quoted;
use serde_json::Value;
use std::{fs, path::Path};

/// The provider's catalog entry as the fact lookup sees it.
pub(crate) enum Entry {
    /// No catalog, or no entry: models carry no facts.
    Absent,
    Models(Vec<Value>),
    /// `entry?.models.find` throws a TypeError for every listed id.
    Throws,
}

/// `cache/models.json` under the pacer home.
fn catalog_file(home: &Path) -> std::path::PathBuf {
    home.join("cache").join("models.json")
}

fn is_obj(value: &Value) -> bool {
    value.is_object()
}

pub(crate) fn entry(home: &Path, provider: &str) -> Entry {
    let Ok(bytes) = fs::read(catalog_file(home)) else {
        return Entry::Absent;
    };
    let catalog = match quoted::parse_file(&bytes) {
        Ok(value) => value,
        // Bun parses deeper JSON than the native reader accepts.
        Err(error) if error == quoted::NESTING_FALLBACK => return Entry::Throws,
        Err(_) => return Entry::Absent,
    };
    if !is_obj(&catalog)
        || quoted::number(&catalog["fetchedAt"]).is_none()
        || !is_obj(&catalog["providers"])
    {
        return Entry::Absent;
    }
    let key = quoted::from_utf8(Value::String(provider.to_owned()));
    let entry = match catalog["providers"].get(key.as_str().unwrap_or(provider)) {
        Some(entry) => entry,
        // `Object.prototype` members have no `models`.
        None if PROTOTYPE_KEYS.contains(&provider) => return Entry::Throws,
        None => return Entry::Absent,
    };
    match entry {
        Value::Null => Entry::Absent,
        Value::Object(fields) => match fields.get("models") {
            Some(Value::Array(items)) => Entry::Models(items.clone()),
            _ => Entry::Throws,
        },
        _ => Entry::Throws,
    }
}

/// The first catalog model whose `id` is `id`; `Err` is the TypeError of a
/// null entry visited before the match.
pub(crate) fn find<'a>(items: &'a [Value], id: &str) -> Result<Option<&'a Value>, ()> {
    let id = quoted::from_utf8(Value::String(id.to_owned()));
    for item in items {
        match item {
            Value::Null => return Err(()),
            Value::Object(fields) if fields.get("id") == Some(&id) => return Ok(Some(item)),
            _ => {}
        }
    }
    Ok(None)
}

/// `fact(entry, base)`: absent and null limits stay absent, costs keep null.
pub(crate) fn facts(entry: &Value, model: &mut AvailableModel) {
    let get = |key: &str| entry.get(key).cloned();
    let present = |key: &str| get(key).filter(|v| !v.is_null());
    model.name = get("name");
    model.context = present("context");
    model.output = present("outputLimit");
    model.tools = get("toolCall");
    model.cost_in = get("costIn");
    model.cost_out = get("costOut");
    model.release = present("release");
}

/// A catalog the native door cannot reproduce for this provider: a lookup
/// TypeScript may throw on (any null model entry), or facts whose JSON text
/// the native reply could not write as `JSON.stringify` does.
pub(crate) fn needs_core(home: &Path, provider: &str) -> bool {
    match entry(home, provider) {
        Entry::Absent => false,
        Entry::Throws => true,
        Entry::Models(items) => {
            items.iter().any(Value::is_null)
                || crate::reply::wire_value(&Value::Array(items)).is_none()
        }
    }
}
