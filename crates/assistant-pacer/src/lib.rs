//! `assistant-pacer`: pacer's own assistant backend (plugin method `assistant.reply`).
//!
//! Built on `pacer-plugin` and `rig-core` (=0.22.0). Registers only the tools passed in each
//! call; each forwards to `capability.assistant.tool`. No MCP, no instruction files, no session.

mod delta;
mod reply;
mod tools;

pub use reply::{plugin, reply};

use pacer_plugin::Manifest;
use serde_json::json;

/// Manifest for the bundled native plugin (wired by a later task).
pub fn manifest() -> Manifest {
    Manifest(json!({
        "id": "assistant-pacer",
        "version": "0.1.0",
        "publisher": "pacer",
        "host": ">=1.11.0",
        "contributes": { "assistant": { "backend": "pacer", "reply": true } },
        "capabilities": [
            { "name": "secrets.resolve", "scopes": ["endpoint"] },
            { "name": "net.http" },
            { "name": "assistant.tool" },
            { "name": "config.get" }
        ],
        "reentrant": true,
        "tier": "free"
    }))
}
