//! Live status for the native cutover (B12): evidence reconcile/merge, usage
//! reads and refresh, and the usage store, ported one-to-one from the TypeScript
//! implementation (`src/usage` and `src/engine/evidence.ts`). Inputs and outputs
//! are `serde_json::Value` in the TypeScript JSON shapes.

pub mod evidence;
pub mod freshness;
mod freshness_generated;
pub mod trace;
pub mod usage_store;
