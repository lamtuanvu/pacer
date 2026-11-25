//! `pacer-assistant`: answer an OpenAI-compatible endpoint chat turn (M3 C4).
//!
//! The single `assistant.respond` point maps a turn's messages, tools and
//! limits onto an OpenAI-compatible `chat/completions` request, hands the key
//! (resolved through `capability.secrets.resolve`) to the endpoint as a Bearer
//! header, and maps the reply — including tool calls and usage — back into a
//! pacer `RespondResult`. Builds on `pacer-plugin` and `reqwest`.

mod chat;
mod respond;

pub use chat::{chat_request, chat_result};
pub use respond::{ChatTransport, ReqwestTransport, TransportError, plugin_with, respond};

use std::sync::Arc;

use pacer_plugin::{Manifest, Plugin};

/// The manifest JSON, byte-equal to the TypeScript runtime manifest
/// (test/plugin-parity/manifests.test.ts).
pub const MANIFEST: &str = include_str!("../manifest.json");

pub fn manifest() -> Manifest {
    match serde_json::from_str(MANIFEST) {
        Ok(value) => Manifest(value),
        Err(error) => {
            panic!("plugins-rs/pacer-assistant/manifest.json must be valid JSON: {error}")
        }
    }
}

/// The native bundled plugin: serves `assistant.respond` with the TS SDK's
/// feature set and the real `ReqwestTransport`.
pub fn plugin() -> Plugin {
    respond::plugin_with(Arc::new(ReqwestTransport))
}
