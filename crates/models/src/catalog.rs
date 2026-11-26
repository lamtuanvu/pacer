//! Catalog facts for discovered models: `readCachedCatalog(ctx)?.providers[provider]`
//! (`src/endpoints/catalog.ts`) and the `entry?.models.find(m => m.id === id)`
//! lookup in `opencodeModels`. The cache is read as `JSON.parse` left it.
use crate::{AvailableModel, available::PROTOTYPE_KEYS};
use pacer_js_json::quoted;
use serde_json::Value;
use std::{fs, path::Path};

/// Bun's `Error.message` for the fact lookup's three `TypeError` shapes.
pub(crate) const NO_MODELS: &str = "undefined is not an object (evaluating 'entry?.models.find')";
pub(crate) const NOT_FUNCTION: &str = "entry?.models.find is not a function. (In 'entry?.models.find((m) => m.id === id)', 'entry?.models.find' is undefined)";
pub(crate) const NULL_MODELS: &str = "null is not an object (evaluating 'entry?.models.find')";
pub(crate) const NULL_ITEM: &str = "null is not an object (evaluating 'm.id')";

/// The provider's catalog entry as the fact lookup sees it.
pub(crate) enum Entry {
    /// No catalog, or no entry: models carry no facts.
    Absent,
    Models(Vec<Value>),
    /// `entry?.models.find` throws a TypeError for every listed id.
    Throws(&'static str),
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
        // Bun parses deeper JSON than the native reader accepts; it finds no entry
        // in the shapes that matter here rather than throwing on the lookup.
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
        None if PROTOTYPE_KEYS.contains(&provider) => return Entry::Throws(NO_MODELS),
        None => return Entry::Absent,
    };
    match entry {
        Value::Object(fields) => match fields.get("models") {
            Some(Value::Array(items)) => Entry::Models(items.clone()),
            Some(Value::Null) => Entry::Throws(NULL_MODELS),
            Some(_) => Entry::Throws(NOT_FUNCTION),
            None => Entry::Throws(NO_MODELS),
        },
        // Optional chaining short-circuits a null entry to `undefined`.
        Value::Null => Entry::Absent,
        _ => Entry::Throws(NO_MODELS),
    }
}

/// The first catalog model whose `id` is `id`; `Err` is Bun's TypeError text
/// for a null entry visited before the match.
pub(crate) fn find<'a>(items: &'a [Value], id: &str) -> Result<Option<&'a Value>, &'static str> {
    let id = quoted::from_utf8(Value::String(id.to_owned()));
    for item in items {
        match item {
            Value::Null => return Err(NULL_ITEM),
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
