//! `pacer-remote-caller`: drive a remote host through `capability.hosts.*`.
//!
//! Five handlers open a remote host session (addressed by alias) and run one of
//! four fixed scripts (`PROBE`, `SET_IDENTITY`, `QUESTION`, `CODEX_USAGE`) or a
//! `fetch`, closing the session in every path exactly as the TypeScript
//! reference does. Builds on `pacer-plugin` only.

mod calls;

pub use calls::{fetch, identity, question_read, reachability, usage_read};

use pacer_plugin::{Manifest, Plugin, TS_SDK_FEATURES};

/// The manifest JSON, byte-equal to the TypeScript runtime manifest
/// (test/plugin-parity/manifests.test.ts).
pub const MANIFEST: &str = include_str!("../manifest.json");

pub fn manifest() -> Manifest {
    match serde_json::from_str(MANIFEST) {
        Ok(value) => Manifest(value),
        Err(error) => panic!("plugins-rs/pacer-remote-caller/manifest.json must be valid JSON: {error}"),
    }
}

/// The native bundled plugin: serves the five `remoteCaller.*` points with the
/// TS SDK's feature set.
pub fn plugin() -> Plugin {
    Plugin::new(manifest())
        .features(TS_SDK_FEATURES.to_vec())
        .handle("remoteCaller.reachability", reachability)
        .handle("remoteCaller.fetch", fetch)
        .handle("remoteCaller.identity", identity)
        .handle("remoteCaller.questionRead", question_read)
        .handle("remoteCaller.usageRead", usage_read)
}
