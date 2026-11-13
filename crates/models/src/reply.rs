//! `availableModels` as the native door finishes it: the listing for model
//! checks (with discovery), the `executor.models.available` reply, and the
//! inputs only TypeScript can answer.
use crate::{
    Listing,
    available::{Cached, available_models, cache_file, compose, js_number, read_cache},
    catalog,
    discover::{core_process, discover},
};
use pacer_js_json::quoted;
use serde_json::{Map, Value};
use std::path::Path;

/// The Value whose serde_json text is `JSON.stringify` of a quoted value, when
/// one exists: integral numbers as integers and index keys first. Lone
/// surrogates, signed Infinity and number spellings serde writes differently
/// have none.
pub fn wire_value(value: &Value) -> Option<Value> {
    fn plain(value: &Value) -> Value {
        match value {
            Value::Number(n) => n.as_f64().map_or(Value::Number(n.clone()), js_number),
            Value::Array(items) => Value::Array(items.iter().map(plain).collect()),
            Value::Object(fields) => {
                let mut out = Map::new();
                for (key, item) in fields {
                    out.insert(key.clone(), plain(item));
                }
                let mut out = Value::Object(out);
                pacer_config::normalize_json(&mut out);
                out
            }
            other => other.clone(),
        }
    }
    let wire = plain(value);
    (serde_json::to_string(&wire).ok()? == quoted::stringify(value)).then_some(wire)
}

/// `availableModels(ctx, runnerId)` for the model checks: `NeedsDiscovery`
/// remains only when the front door has no core process to run OpenCode as.
pub async fn listing(home: &Path, now: f64, strategy: &Value, runner_id: &str) -> Listing {
    match available_models(home, now, strategy, runner_id) {
        Listing::NeedsDiscovery(discovery) => match core_process() {
            Some(process) => discover(home, discovery, &process).await,
            None => Listing::NeedsDiscovery(discovery),
        },
        other => other,
    }
}

/// Discovery the door cannot run as Core would, or whose catalog it cannot reproduce.
fn discovery_needs_core(home: &Path, provider: &str) -> bool {
    core_process().is_none() || catalog::needs_core(home, provider)
}

/// Whether [`listing`] could leave this runner's model check to TypeScript.
pub fn listing_needs_core(home: &Path, now: f64, strategy: &Value, runner_id: &str) -> bool {
    match available_models(home, now, strategy, runner_id) {
        Listing::Known(_) => false,
        Listing::NeedsDiscovery(discovery) => discovery_needs_core(home, &discovery.provider),
        Listing::Unsupported => true,
    }
}

/// The `executor.models.available` result for a runner the strategy declares:
/// a fresh cache exactly as TypeScript parsed it, else the composed or
/// discovered listing. `None` is a reply only TypeScript can produce.
pub async fn available_reply(
    home: &Path,
    now: f64,
    strategy: &Value,
    runner_id: &str,
    refresh: bool,
) -> Option<Value> {
    if !refresh {
        match read_cache(&cache_file(home, runner_id), now) {
            Cached::Hit(value) => return wire_value(&value),
            Cached::Unsupported => return None,
            Cached::Miss => {}
        }
    }
    let list = match compose(now, strategy, runner_id) {
        Listing::Known(list) => list,
        Listing::NeedsDiscovery(discovery) => {
            match discover(home, discovery, &*core_process()?).await {
                Listing::Known(list) => list,
                _ => return None,
            }
        }
        Listing::Unsupported => return None,
    };
    wire_value(&list.to_json())
}

/// Whether [`available_reply`] would return `None`, checked before any discovery runs.
pub fn available_needs_core(
    home: &Path,
    now: f64,
    strategy: &Value,
    runner_id: &str,
    refresh: bool,
) -> bool {
    if !refresh {
        match read_cache(&cache_file(home, runner_id), now) {
            Cached::Hit(value) => return wire_value(&value).is_none(),
            Cached::Unsupported => return true,
            Cached::Miss => {}
        }
    }
    match compose(now, strategy, runner_id) {
        Listing::Known(list) => wire_value(&list.to_json()).is_none(),
        Listing::NeedsDiscovery(discovery) => {
            discovery_needs_core(home, &discovery.provider)
                || wire_value(&discovery.base.to_json()).is_none()
        }
        Listing::Unsupported => true,
    }
}
