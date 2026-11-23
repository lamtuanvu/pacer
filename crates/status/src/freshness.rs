//! `markFreshness` and `staleAfterS` from `src/usage/freshness.ts`.

pub use crate::freshness_generated::*;

use serde_json::Value;

/// `staleAfterS` (freshness.ts:20-22): the staleness bound for a window.
pub fn stale_after_s(window: &Value) -> f64 {
    // Implemented in B12 task 5; skeleton placeholder.
    let _ = window;
    crate::freshness_generated::EVIDENCE_PRUNE_AFTER_S
}

/// `markFreshness` (freshness.ts:23-31); returns a new reading.
pub fn mark_freshness(reading: &Value, now: f64) -> Value {
    // Implemented in B12 task 5; skeleton placeholder.
    let _ = (reading, now);
    Value::Null
}
