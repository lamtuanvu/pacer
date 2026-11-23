//! `pacer-bundled-exec-direct`: the exact direct process effect and the owned
//! and remote executor attempts (M3 C10).
//!
//! Four `executor.*` points issue an exact process (`capability.process.spawn`),
//! or provision and poll an owned wrapper on this host or a remote host, always
//! reporting against `backend: "direct"`. Task, attempt and run-directory
//! govern the capability calls; the committed work of an owned move is read back
//! and reported verbatim. Builds on `pacer-plugin` only.

mod clock;
mod effect;
mod input;
mod owned;
mod remote;

use std::sync::Arc;

use pacer_plugin::{Manifest, Plugin, PluginError, TS_SDK_FEATURES};

pub use clock::{Clock, FakeClock, TokioClock};

/// The manifest JSON, byte-equal to the TypeScript runtime manifest
/// (test/plugin-parity/manifests.test.ts).
pub const MANIFEST: &str = include_str!("../manifest.json");

pub fn manifest() -> Manifest {
    match serde_json::from_str(MANIFEST) {
        Ok(value) => Manifest(value),
        Err(error) => {
            panic!("plugins-rs/pacer-exec-direct/manifest.json must be valid JSON: {error}")
        }
    }
}

/// The bundled plugin: serves the four `executor.*` points with the TS SDK's
/// feature set and the real tokio clock.
pub fn plugin() -> Plugin {
    plugin_with(Arc::new(clock::TokioClock))
}

/// The bundled plugin with a caller-supplied clock (for harness tests).
pub fn plugin_with(clock: Arc<dyn Clock>) -> Plugin {
    Plugin::new(manifest())
        .features(TS_SDK_FEATURES.to_vec())
        .handle("executor.available", |_params, _ctx| async move {
            Ok(effect::available())
        })
        .handle("executor.run", {
            let clock = clock.clone();
            move |params, ctx| {
                let clock = clock.clone();
                async move {
                    match input::run_input(&params).ok_or_else(|| {
                        PluginError::new("invalid_input", "direct process effect is required")
                    })? {
                        input::RunInput::Remote(input) => {
                            remote::run_owned_remote(input, &ctx, clock.as_ref()).await
                        }
                        input::RunInput::Owned(input) => {
                            owned::run_owned(input, &ctx, clock.as_ref()).await
                        }
                        input::RunInput::Direct(input) => {
                            effect::run_direct(input, &ctx).await
                        }
                    }
                }
            }
        })
        .handle("executor.stop", |params, ctx| async move {
            effect::stop(&params, &ctx).await
        })
        .handle("executor.sessionState", |params, ctx| async move {
            effect::session_state(&params, &ctx).await
        })
}