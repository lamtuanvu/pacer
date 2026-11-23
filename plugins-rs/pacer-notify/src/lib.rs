//! `pacer-notify`: deliver an OS notification through `notifier.deliver`.
//!
//! The host chooses the platform and pins the fixed command's executable; the
//! plugin builds a literal argv with no `which` or `PATH` lookup. Builds on
//! `pacer-plugin` only.

mod deliver;

pub use deliver::{argv, deliver};

use pacer_plugin::{Manifest, Plugin, TS_SDK_FEATURES};

/// The manifest JSON, byte-equal to the TypeScript runtime manifest
/// (test/plugin-parity/manifests.test.ts).
pub const MANIFEST: &str = include_str!("../manifest.json");

pub fn manifest() -> Manifest {
    match serde_json::from_str(MANIFEST) {
        Ok(value) => Manifest(value),
        Err(error) => panic!("plugins-rs/pacer-notify/manifest.json must be valid JSON: {error}"),
    }
}

/// The native bundled plugin: serves `notifier.deliver` with the TS SDK's feature set.
pub fn plugin() -> Plugin {
    Plugin::new(manifest())
        .features(TS_SDK_FEATURES.to_vec())
        .handle("notifier.deliver", deliver)
}
