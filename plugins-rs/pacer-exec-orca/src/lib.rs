//! `pacer-exec-orca`: a task-owned Orca terminal worker (M3 C5).
//!
//! Four `executor.*` points provision and supervise an Orca worker through
//! `capability.orca.*`, choosing a fallback only before a worker can exist and
//! looking an uncertain start up a bounded number of times. Builds on
//! `pacer-plugin` only.

mod input;
mod map;
mod run;

use std::sync::Arc;

use pacer_plugin::{Ctx, HandlerResult, Manifest, Plugin, PluginError, TS_SDK_FEATURES, js};
use serde_json::{Value, json};

pub use input::{Orca, RunInput, Task};
pub use map::{map_failed_start, map_wait};
pub use run::{Clock, TokioClock};

/// The manifest JSON, byte-equal to the TypeScript runtime manifest
/// (test/plugin-parity/manifests.test.ts).
pub const MANIFEST: &str = include_str!("../manifest.json");

pub fn manifest() -> Manifest {
    match serde_json::from_str(MANIFEST) {
        Ok(value) => Manifest(value),
        Err(error) => {
            panic!("plugins-rs/pacer-exec-orca/manifest.json must be valid JSON: {error}")
        }
    }
}

/// The native bundled plugin: serves the four `executor.*` points with the TS
/// SDK's feature set and the real tokio clock.
pub fn plugin() -> Plugin {
    plugin_with(Arc::new(run::TokioClock))
}

fn invalid() -> PluginError {
    PluginError::new("internal", "invalid params")
}

fn parse_owner(v: &Value) -> Option<(String, i64)> {
    let obj = v.as_object()?;
    if !input::keys_are_exactly(obj, &["taskId", "attempt"]) {
        return None;
    }
    let task_id = obj.get("taskId")?.as_str()?.to_owned();
    let attempt = js::safe_integer(obj.get("attempt")?)?;
    if attempt <= 0 {
        return None;
    }
    Some((task_id, attempt))
}

/// `executor.stop`: strict `{taskId, attempt, graceMs: 0..=25000}`.
fn parse_stop(v: &Value) -> Option<(String, i64)> {
    let obj = v.as_object()?;
    if !input::keys_are_exactly(obj, &["taskId", "attempt", "graceMs"]) {
        return None;
    }
    let task_id = obj.get("taskId")?.as_str()?.to_owned();
    let attempt = js::safe_integer(obj.get("attempt")?)?;
    if attempt <= 0 {
        return None;
    }
    let grace = js::safe_integer(obj.get("graceMs")?)?;
    if !(0..=25_000).contains(&grace) {
        return None;
    }
    Some((task_id, attempt))
}

async fn available(_params: &Value, ctx: &Ctx) -> HandlerResult {
    if ctx.cancel.is_cancelled() {
        return Err(PluginError::new(
            "plugin_unavailable",
            "availability check was cancelled",
        ));
    }
    let status = ctx.host.call("capability.orca.status", json!({})).await?;
    let ready = status
        .get("ready")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if ready {
        Ok(json!({ "available": true }))
    } else {
        let reason = status
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("the Orca runtime is not ready");
        Ok(json!({ "available": false, "reason": reason }))
    }
}

async fn stop(params: &Value, ctx: &Ctx) -> HandlerResult {
    let (task_id, attempt) = parse_stop(params).ok_or_else(invalid)?;
    if ctx.cancel.is_cancelled() {
        return Err(PluginError::new(
            "plugin_unavailable",
            "executor stop was cancelled",
        ));
    }
    // `graceMs` is validated but not forwarded; the host stop signals only the owner.
    ctx.host
        .call(
            "capability.orca.stop",
            json!({ "taskId": task_id, "attempt": attempt }),
        )
        .await
}

async fn session_state(params: &Value, ctx: &Ctx) -> HandlerResult {
    let (task_id, attempt) = parse_owner(params).ok_or_else(invalid)?;
    if ctx.cancel.is_cancelled() {
        return Err(PluginError::new(
            "plugin_unavailable",
            "executor inspection was cancelled",
        ));
    }
    let observed = ctx
        .host
        .call(
            "capability.orca.sessionState",
            json!({ "taskId": task_id, "attempt": attempt }),
        )
        .await?;
    Ok(json!({
        "state": observed.get("state").cloned().unwrap_or(Value::Null),
        "host": "orca",
        "handle": observed.get("handle").cloned().unwrap_or(Value::Null),
    }))
}

/// The bundled plugin with a caller-supplied clock (for harness tests).
pub fn plugin_with(clock: Arc<dyn Clock>) -> Plugin {
    Plugin::new(manifest())
        .features(TS_SDK_FEATURES.to_vec())
        .handle("executor.available", |params, ctx| async move {
            available(&params, &ctx).await
        })
        .handle("executor.run", {
            let clock = clock.clone();
            move |params, ctx| {
                let clock = clock.clone();
                async move {
                    let input = input::run_input(&params).ok_or_else(|| {
                        PluginError::new(
                            "invalid_input",
                            "an Orca terminal-worker attempt is required",
                        )
                    })?;
                    run::run_orca(input, &ctx, clock.as_ref()).await
                }
            }
        })
        .handle("executor.stop", |params, ctx| async move {
            stop(&params, &ctx).await
        })
        .handle("executor.sessionState", |params, ctx| async move {
            session_state(&params, &ctx).await
        })
}
