//! Effects a native `dispatch.refresh` cannot own: the full `computeStatus`
//! read and the plugin `observation.observe` calls (`src/dispatch/refresh.ts`,
//! `src/dispatch/observations.ts`, `src/dispatch/plugin-adapters.ts`).
//!
//! The server installs the implementations on both front doors; the dispatch
//! operation crate stays at layer 7 and never learns how a plugin is reached.
#![allow(clippy::result_large_err)]
use pacer_foundation::api::OpFuture;
use serde_json::Value;

/// What a running refresh needs from its host.
pub trait RefreshEffects: Send {
    /// `computeStatus({...ctx, now}, strategy)`: the full, uncached status read.
    fn status(&mut self) -> OpFuture<'_>;
    /// `pluginRegistry(ctx).call(id, "observation.observe", {scope, method})`.
    fn observe(&mut self, plugin: &str, input: Value) -> OpFuture<'_>;
    /// Enabled plugins whose manifest contributes `observation`, in registry order.
    fn observation_plugins(&self) -> Vec<String>;
}
