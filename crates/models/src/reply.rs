//! `availableModels` as the native door finishes it: the listing for model
//! checks (with discovery), the `executor.models.available` reply, and the
//! inputs TypeScript can produce byte for byte.
use crate::{
    Listing,
    available::{Cached, available_models, cache_file, compose, read_cache},
    discover::{discover, process},
};
use serde_json::Value;
use std::path::Path;

/// Values are held in `pacer-js-json`'s quoted form: caches are parsed with it
/// and listings are built in it. Echoing that form through the reply writer
/// preserves lone surrogates and signed Infinity exactly as TypeScript's
/// `JSON.stringify` writes them.
pub fn wire_value(value: &Value) -> Option<Value> {
    Some(value.clone())
}

/// `availableModels(ctx, runnerId)` for the model checks. Discovery runs with
/// the recorded Core environment, or the front door's own when no Core child
/// exists, so no listing stays with TypeScript for want of a process record.
pub async fn listing(home: &Path, now: f64, strategy: &Value, runner_id: &str) -> Listing {
    match available_models(home, now, strategy, runner_id) {
        Listing::NeedsDiscovery(discovery) => discover(home, discovery, &process()).await,
        other => other,
    }
}

/// The `executor.models.available` result for a runner the strategy declares:
/// a fresh cache exactly as TypeScript parsed it, else the composed or
/// discovered listing. `Err` is Bun's `TypeError` text for a catalog entry the
/// fact lookup throws on.
pub async fn available_reply(
    home: &Path,
    now: f64,
    strategy: &Value,
    runner_id: &str,
    refresh: bool,
) -> Result<Value, String> {
    if !refresh {
        match read_cache(&cache_file(home, runner_id), now) {
            Cached::Hit(value) => return Ok(value),
            Cached::Unsupported => {}
            Cached::Miss => {}
        }
    }
    match compose(now, strategy, runner_id) {
        Listing::Known(list) => Ok(wire_value(&list.to_json()).unwrap_or_default()),
        Listing::NeedsDiscovery(discovery) => match discover(home, discovery, &process()).await {
            Listing::Known(list) => Ok(wire_value(&list.to_json()).unwrap_or_default()),
            Listing::Failed(message) => Err(message),
            other => Err(format!("{:?}", other)),
        },
        Listing::Failed(message) => Err(message),
        other => Err(format!("{:?}", other)),
    }
}
