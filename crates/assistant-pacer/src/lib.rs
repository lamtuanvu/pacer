//! `assistant-pacer`: pacer's own assistant backend (plugin method `assistant.reply`).
//!
//! Built on `pacer-plugin` and `rig-core` (=0.22.0). Registers only the tools passed in each
//! call; each forwards to `capability.assistant.tool`. No MCP, no instruction files, no session.

mod budget;
mod budget_model;
mod delta;
mod http;
mod reply;
mod tools;

pub use reply::{plugin, reply};

use pacer_plugin::Manifest;

/// Manifest for the bundled native plugin. Single source of truth: `manifest.json` next to this crate
/// (also imported by `src/plugins/bundled.ts`).
pub fn manifest() -> Manifest {
    match serde_json::from_str(include_str!("../manifest.json")) {
        Ok(value) => Manifest(value),
        Err(error) => panic!("crates/assistant-pacer/manifest.json must be valid JSON: {error}"),
    }
}
