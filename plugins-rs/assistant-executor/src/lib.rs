//! `pacer-bundled-assistant-executor`: the assistant's executor backend, answering
//! a turn by running the host-issued ask-mode command and reading its result.
//! Port of `plugins/assistant-executor/index.ts`. Builds on `pacer-plugin` only.

mod claude;
mod js_string;
mod parse;
mod reply;

use pacer_plugin::{Manifest, Plugin, TS_SDK_FEATURES};

// Re-exported for integration tests (parse / claude / reply) parity coverage.
pub use claude::{
    claude_expect_from_command, claude_plugins_allowed, parse_claude_control_run, parse_claude_run,
    same_path, ClaudeInitExpect,
};
pub use parse::{parse_acp_run, parse_run};
pub use reply::{reply, AskCommand};

/// The manifest JSON, byte-equal to the TypeScript runtime manifest
/// (test/plugin-parity/manifests.test.ts).
pub const MANIFEST: &str = include_str!("../manifest.json");

pub fn manifest() -> Manifest {
    match serde_json::from_str(MANIFEST) {
        Ok(value) => Manifest(value),
        Err(error) => {
            panic!("plugins-rs/assistant-executor/manifest.json must be valid JSON: {error}")
        }
    }
}

/// The native bundled plugin: serves `assistant.reply` with the TS SDK's
/// feature set.
pub fn plugin() -> Plugin {
    Plugin::new(manifest())
        .features(TS_SDK_FEATURES.to_vec())
        .handle("assistant.reply", reply)
}