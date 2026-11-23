//! `pacer-endpoints`: managed endpoint connections for opencode, a Rust port of
//! `plugins/pacer-endpoints` (M3 C8). Serves `endpoint.test`,
//! `endpoint.models` and `endpoint.launchEnv` with the TS SDK's feature set.

mod launch_env;
mod models;
pub mod opencode_config;
mod path;
mod test_task;

use pacer_plugin::{Ctx, HandlerResult, Manifest, Plugin, TS_SDK_FEATURES};
use serde_json::Value;

pub use opencode_config::{EndpointAccount, EndpointModel, endpoint_key_env, render_opencode_config};

/// The `object_key_order` used to keep rendered `provider`/`models` records in
/// the exact key order `Object.fromEntries` produces in the TypeScript door.
pub use pacer_plugin::js::object_key_order;

/// The manifest JSON, byte-equal to the TypeScript runtime manifest
/// (test/plugin-parity/manifests.test.ts).
pub const MANIFEST: &str = include_str!("../manifest.json");

pub fn manifest() -> Manifest {
    match serde_json::from_str(MANIFEST) {
        Ok(value) => Manifest(value),
        Err(error) => panic!("plugins-rs/pacer-endpoints/manifest.json must be valid JSON: {error}"),
    }
}

/// The native bundled plugin: serves `endpoint.*` with the TS SDK's feature set.
pub fn plugin() -> Plugin {
    Plugin::new(manifest())
        .features(TS_SDK_FEATURES.to_vec())
        .handle("endpoint.test", endpoint_test)
        .handle("endpoint.models", endpoint_models)
        .handle("endpoint.launchEnv", endpoint_launch_env)
}

async fn endpoint_test(params: Value, ctx: Ctx) -> HandlerResult {
    test_task::test_task(&ctx.host, &params).await
}

async fn endpoint_models(params: Value, ctx: Ctx) -> HandlerResult {
    models::discover_models(&ctx.host, &params).await
}

async fn endpoint_launch_env(params: Value, ctx: Ctx) -> HandlerResult {
    launch_env::launch_env(&ctx.host, &params).await
}