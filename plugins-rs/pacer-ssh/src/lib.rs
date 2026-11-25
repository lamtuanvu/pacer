//! `pacer-bundled-ssh`: the bundled SSH lookglass provider (M3 C11), a
//! one-to-one port of `plugins/pacer-ssh` to Rust.
//!
//! Registers the seven `hostRunner.*` points against a shared session
//! registry, all issuing a single exact `capability.process.spawn` (or
//! `stageBundle`, or the owned duplex stream) per host-issued operation.

mod argv;
mod handlers;
mod payload;
mod scripts;
mod session_stream;

use pacer_plugin::{Manifest, Plugin, TS_SDK_FEATURES};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// The manifest JSON, byte-equal to the TypeScript runtime manifest.
pub const MANIFEST: &str = include_str!("../manifest.json");

pub fn manifest() -> Manifest {
    match serde_json::from_str(MANIFEST) {
        Ok(value) => Manifest(value),
        Err(error) => {
            panic!("plugins-rs/pacer-ssh/manifest.json must be valid JSON: {error}")
        }
    }
}

/// The bundled plugin: serves the seven `hostRunner.*` points.
pub fn plugin() -> Plugin {
    let sessions: handlers::Sessions = Arc::new(Mutex::new(HashMap::new()));
    Plugin::new(manifest())
        .features(TS_SDK_FEATURES.to_vec())
        .handle("hostRunner.check", {
            move |params, ctx| async move { handlers::check(&params, &ctx).await }
        })
        .handle("hostRunner.open", {
            let sessions = sessions.clone();
            move |params, ctx| {
                let sessions = sessions.clone();
                async move { handlers::open(&params, &ctx, &sessions).await }
            }
        })
        .handle("hostRunner.run", {
            let sessions = sessions.clone();
            move |params, ctx| {
                let sessions = sessions.clone();
                async move { handlers::run(&params, &ctx, &sessions).await }
            }
        })
        .handle("hostRunner.fetch", {
            let sessions = sessions.clone();
            move |params, ctx| {
                let sessions = sessions.clone();
                async move { handlers::fetch(&params, &ctx, &sessions).await }
            }
        })
        .handle("hostRunner.upload", {
            let sessions = sessions.clone();
            move |params, ctx| {
                let sessions = sessions.clone();
                async move { handlers::upload(&params, &ctx, &sessions).await }
            }
        })
        .handle("hostRunner.stream", {
            let sessions = sessions.clone();
            move |params, ctx| {
                let sessions = sessions.clone();
                async move { handlers::stream(&params, &ctx, &sessions).await }
            }
        })
        .handle("hostRunner.close", {
            let sessions = sessions.clone();
            move |params, _ctx| {
                let sessions = sessions.clone();
                async move { handlers::close(&params, &sessions).await }
            }
        })
}