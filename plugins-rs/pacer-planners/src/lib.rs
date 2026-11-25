//! `pacer-bundled-planners`: the bundled planner installer (M3 C12b), a
//! one-to-one port of `plugins/pacer-planners` to Rust.
//!
//! Registers the six `planner.*` points. Files and effects are only prepared;
//! the host owns commit and recovery (as in the TypeScript plugin).

mod claude;
mod codex;
mod cursor;
mod handlers;
mod mcp;
mod opencode;
mod skill;
mod types;

use pacer_plugin::{Manifest, Plugin, TS_SDK_FEATURES};
use serde_json::Value;


/// The manifest JSON, byte-equal to the TypeScript runtime manifest.
pub const MANIFEST: &str = include_str!("../manifest.json");

pub fn manifest() -> Manifest {
    match serde_json::from_str(MANIFEST) {
        Ok(value) => Manifest(value),
        Err(error) => {
            panic!("plugins-rs/pacer-planners/manifest.json must be valid JSON: {error}")
        }
    }
}

/// The bundled plugin: serves the six `planner.*` points.
pub fn plugin() -> Plugin {
    Plugin::new(manifest())
        .features(TS_SDK_FEATURES.to_vec())
        .handle("planner.install", |params: Value, ctx| async move {
            handlers::prepare(params, &ctx).await
        })
        .handle("planner.plan", |params: Value, ctx| async move {
            handlers::prepare(params, &ctx).await
        })
        .handle("planner.detect", |params: Value, ctx| async move {
            handlers::detect(params, &ctx).await
        })
        .handle("planner.check", |params: Value, ctx| async move {
            handlers::check(params, &ctx).await
        })
        .handle("planner.preview", |params: Value, ctx| async move {
            handlers::preview(params, &ctx).await
        })
        .handle("planner.uninstall", |params: Value, ctx| async move {
            handlers::uninstall(params, &ctx).await
        })
}
