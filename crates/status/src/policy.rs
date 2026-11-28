//! Policy summary for the status document — `policySummary` (`src/plugins/policy.ts:78-81`).
//!
//! The status composes this once per call from the registry `entries` snapshot the
//! door already fetched, plus the strategy's `plugins.policy.mode`. No policy
//! evaluation, hashing or process start: this is cheap discovery only, matching
//! the TypeScript doc comment ("Cheap discovery only: no doctor, usage refresh,
//! handshake or process start.").

use pacer_config::strategy::load_strategy;
use pacer_foundation::Ctx;
use pacer_foundation::api::CoreError;
use pacer_plugin_ops::public::Entry;
use serde_json::{Value, json};

/// The plugin entry states that still contribute a policy to the status
/// (`PluginRegistry.policySnapshot`, `src/plugins/registry.ts`).
const POLICY_STATES: &[&str] = &["idle", "starting", "ready", "failing"];

/// `policySummary(ctx)`: `{mode, plugins}` where `mode` is the strategy's
/// `plugins.policy.mode` (default `open`) and `plugins` is the count of
/// policy entries in the eligible states.
pub fn policy_summary(ctx: &Ctx, entries: &[Entry]) -> Result<Value, CoreError> {
    let mode = policy_mode(ctx);
    let count = entries.iter().filter(|e| policy_entry(e)).count();
    Ok(json!({"mode": mode, "plugins": count}))
}

/// The `plugins.policy.mode` from the active strategy, `"open"` when the
/// strategy is missing or carries no `plugins` section (`EMPTY_PLUGINS`).
fn policy_mode(ctx: &Ctx) -> &'static str {
    match load_strategy(&ctx.pacer_home) {
        Ok(strategy) => match strategy
            .get("plugins")
            .and_then(|p| p.get("policy"))
            .and_then(|p| p.get("mode"))
            .and_then(Value::as_str)
        {
            Some("open") => "open",
            Some("closed") => "closed",
            _ => "open",
        },
        Err(_) => "open",
    }
}

/// A snapshot entry that contributes `policy`: its manifest declares the
/// contribution and its state is one of the eligible ones.
fn policy_entry(entry: &Entry) -> bool {
    POLICY_STATES.contains(&entry.state.as_str())
        && entry
            .manifest
            .as_ref()
            .and_then(|m| m.get("contributes"))
            .and_then(|c| c.get("policy"))
            .is_some()
}
