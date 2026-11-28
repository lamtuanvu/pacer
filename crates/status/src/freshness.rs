//! `markFreshness` and `staleAfterS` from `src/usage/freshness.ts`.

pub use crate::freshness_generated::*;

use serde_json::{Map, Value};

/// `staleAfterS` (freshness.ts:20-22): the staleness bound for a window.
pub fn stale_after_s(window: &Value) -> f64 {
    let length_s = window.get("lengthS").and_then(Value::as_f64).unwrap_or(0.0);
    if length_s <= crate::freshness_generated::WINDOW_CAP_SHORT_MAX_LENGTH_S {
        crate::freshness_generated::WINDOW_CAP_SHORT_S
    } else {
        crate::freshness_generated::WINDOW_CAP_LONG_S
    }
}

/// `markFreshness` (freshness.ts:23-31); returns a new reading.
pub fn mark_freshness(reading: &Value, now: f64) -> Value {
    let source = reading.get("source").and_then(Value::as_str).unwrap_or("");
    let contract = source == "reactive" || source == "unmetered";
    let stale = reading
        .get("stale")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    // capturedAt read of a finite number; null, missing and non-finite all count as stale,
    // matching `r.capturedAt === null || !Number.isFinite(r.capturedAt)`.
    let captured_finite = reading
        .get("capturedAt")
        .and_then(Value::as_f64)
        .filter(|f| f.is_finite());
    let windows: Vec<Value> = reading
        .get("windows")
        .and_then(Value::as_array)
        .map(|windows| {
            windows
                .iter()
                .map(|w| {
                    let resets_at = w.get("resetsAt").and_then(Value::as_f64);
                    let name = w.get("name").and_then(Value::as_str).unwrap_or("");
                    let window_stale = (resets_at.is_some_and(|t| t <= now))
                        || (!contract
                            && name != "limit"
                            && (stale
                                || !captured_finite
                                    .is_some_and(|c| c <= now && now - c < stale_after_s(w))));
                    let mut out: Map<String, Value> =
                        w.as_object().cloned().unwrap_or_else(Map::new);
                    out.insert("stale".to_string(), Value::Bool(window_stale));
                    Value::Object(out)
                })
                .collect()
        })
        .unwrap_or_default();
    let overall = if windows.is_empty() {
        stale
    } else {
        windows
            .iter()
            .any(|w| w.get("stale").and_then(Value::as_bool).unwrap_or(false))
    };
    let mut out: Map<String, Value> = reading.as_object().cloned().unwrap_or_else(Map::new);
    out.insert("windows".to_string(), Value::Array(windows));
    out.insert("stale".to_string(), Value::Bool(overall));
    Value::Object(out)
}
