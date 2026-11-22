//! `pacer-agent-session`: plan native subagent sessions for codex, claude-code
//! and opencode (M3 C3).
//!
//! Five `agentSession.*` handlers: `delegationControl` and `capabilities`
//! inspect a probe result (actual `--help` option tokens), `attachment` and
//! `prepare` turn an attach + request into a native launch argv, and
//! `identity` returns the plan the host executes to obtain a session id. All
//! are synchronous in the TypeScript reference, so they are wrapped in
//! trivial async closures. Builds on `pacer-plugin` only.

mod capabilities;
mod identity;
mod opencode_report;
mod prepare;

pub use opencode_report::opencode_reporting_source;

use pacer_plugin::{Manifest, Plugin, TS_SDK_FEATURES};

/// The manifest JSON, byte-equal to the TypeScript runtime manifest
/// (test/plugin-parity/manifests.test.ts).
pub const MANIFEST: &str = include_str!("../manifest.json");

pub fn manifest() -> Manifest {
    match serde_json::from_str(MANIFEST) {
        Ok(value) => Manifest(value),
        Err(error) => {
            panic!("plugins-rs/pacer-agent-session/manifest.json must be valid JSON: {error}")
        }
    }
}

fn default_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// The native bundled plugin: serves the five `agentSession.*` points with
/// the TS SDK's feature set.
pub fn plugin() -> Plugin {
    Plugin::new(manifest())
        .features(TS_SDK_FEATURES.to_vec())
        .handle("agentSession.delegationControl", |input, _ctx| async move {
            Ok(capabilities::delegation_control(&input))
        })
        .handle("agentSession.capabilities", |input, _ctx| async move {
            Ok(capabilities::capabilities(&input))
        })
        .handle("agentSession.attachment", |input, _ctx| async move {
            Ok(prepare::attachment(&input))
        })
        .handle("agentSession.prepare", |input, _ctx| async move {
            prepare::prepare(&input)
        })
        .handle("agentSession.identity", |input, _ctx| async move {
            identity::identity(&input, &default_uuid)
        })
}
