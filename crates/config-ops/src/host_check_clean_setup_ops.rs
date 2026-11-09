//! Native `host.check`, `host.clean`, `host.repo.setup` with their private
//! Core effects bridge (`/_internal/host-effects`, `_internal.host.effects`).
//! Rust owns validation, the check/setup/clean logic over injected snapshots,
//! and the result assembly. Core runs only effects that need its in-process
//! state: SSH execution via the plugin host, job orchestration for clone/identity,
//! and the transfer gate for clean.
//!
//! Until Core actually serves that bridge, every front-door call forwards these
//! ops to TypeScript (`host_stays_forwarded`): the bridge endpoints do not
//! exist yet, so the native path below stays dormant until they do.
//!
//! The bridge provides probe snapshots (from `pacer-lifecycle::hosts::probe`)
//! and task snapshots (from `pacer-store::tasks`). The native op composes these
//! into the input expected by `pacer-lifecycle::hosts::{check,setup,clean}`.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Value, json};

/// One Core effect per call; requests are `{"kind": ...}` objects.
pub trait HostEffects: Send {
    fn call(&mut self, request: Value) -> OpFuture<'_>;
}

/// Ops a front door dispatches through [`call`] with a Core host effects bridge.
pub fn uses_host_effects(op: &str) -> bool {
    matches!(op, "host.check" | "host.clean" | "host.repo.setup")
}

pub fn needs_host_effects_bridge(op: &str) -> bool {
    matches!(op, "host.check" | "host.clean" | "host.repo.setup")
}

/// Registry entry for ops that run only through [`call`].
pub fn host_effects_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "host effects bridge unavailable",
        ))
    })
}

/// Until Core has a real host effects bridge (`/_internal/host-effects`,
/// `_internal.host.effects`), host checks, cleans and repo setups stay on the
/// TypeScript path over both HTTP and stdio; TypeScript still owns the probe,
/// clone, identity and transfer effects.
pub fn host_stays_forwarded(_ctx: &Ctx, op: &str, _params: &Value) -> bool {
    matches!(op, "host.check" | "host.clean" | "host.repo.setup")
}

#[allow(dead_code)]
pub(crate) fn unavailable(message: &str) -> CoreError {
    CoreError::new(Code::Unavailable, message)
}

pub(crate) fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

pub(crate) fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub(crate) fn object(params: &Value) -> Result<&serde_json::Map<String, Value>, CoreError> {
    params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(params)
        ))
    })
}

/// Call the bridge for a `probe` effect (SSH probe of host).
async fn probe_host(effects: &mut dyn HostEffects, alias: &str) -> Result<Value, CoreError> {
    effects
        .call(json!({"kind": "probe", "alias": alias}))
        .await
        .map_err(|e| invalid(e.message))
}

/// Call the bridge for a `clone` effect (remote clone).
async fn clone_remote(
    effects: &mut dyn HostEffects,
    alias: &str,
    key: &str,
) -> Result<Value, CoreError> {
    effects
        .call(json!({"kind": "clone", "alias": alias, "key": key}))
        .await
        .map_err(|e| invalid(e.message))
}

/// Call the bridge for an `identity` effect (git identity setup).
async fn setup_identity(
    effects: &mut dyn HostEffects,
    alias: &str,
    key: &str,
) -> Result<Value, CoreError> {
    effects
        .call(json!({"kind": "identity", "alias": alias, "key": key}))
        .await
        .map_err(|e| invalid(e.message))
}

/// Call the bridge for a `transfer` effect (check if work was transferred).
async fn check_transfer(effects: &mut dyn HostEffects, task_id: &str) -> Result<Value, CoreError> {
    effects
        .call(json!({"kind": "transfer", "taskId": task_id}))
        .await
        .map_err(|e| invalid(e.message))
}

/// Native `host.check` — composes probe snapshots and runs the check logic.
pub async fn host_check(
    ctx: &Ctx,
    params: Value,
    effects: &mut dyn HostEffects,
) -> Result<Value, CoreError> {
    let map = object(&params)?;
    let alias = map
        .get("alias")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("alias: Required string"))?;
    if alias.is_empty() || alias.encode_utf16().count() > 128 {
        return Err(invalid("alias: expected 1..128 UTF-16 code units"));
    }
    // Build input for lifecycle::hosts::check by calling probe bridge
    let probe = probe_host(effects, alias).await?;
    let strategy = pacer_config::strategy::load_strategy(&ctx.pacer_home)
        .map_err(|e| invalid(e.to_string()))?;
    let host = strategy["hosts"][alias].clone();
    if host.is_null() {
        return Err(invalid(format!("unknown host {alias}")));
    }
    let _used_ssh = host["ssh"].as_str().unwrap_or("").to_owned();
    let input = json!({
        "alias": alias,
        "host": host,
        "probe": probe,
        "repo": map.get("repo").cloned().unwrap_or(Value::Bool(false)),
        "unavailable": probe.get("ok").and_then(Value::as_bool).map(|b| !b).unwrap_or(true),
        "hostFingerprint": probe.get("fingerprint").cloned(),
        "accountHomes": probe.get("accountHomes").cloned().unwrap_or_else(|| json!({})),
        "repoProbes": probe.get("repoProbes").cloned().unwrap_or_else(|| json!({})),
    });
    Ok(pacer_lifecycle::hosts::check(&input))
}

/// Native `host.repo.setup` — runs clone/identity/check steps via bridge.
pub async fn host_repo_setup(
    ctx: &Ctx,
    params: Value,
    effects: &mut dyn HostEffects,
) -> Result<Value, CoreError> {
    let map = object(&params)?;
    let alias = map
        .get("alias")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("alias: Required string"))?;
    if alias.is_empty() || alias.encode_utf16().count() > 128 {
        return Err(invalid("alias: expected 1..128 UTF-16 code units"));
    }
    let options = map.get("options").cloned().unwrap_or(json!({}));
    let consent = options["consent"].as_bool().unwrap_or(false);
    if !consent {
        return Err(invalid("host repo setup requires consent: true"));
    }
    let strategy = pacer_config::strategy::load_strategy(&ctx.pacer_home)
        .map_err(|e| invalid(e.to_string()))?;
    let host = strategy["hosts"][alias].clone();
    if host.is_null() {
        return Err(invalid(format!("unknown host {alias}")));
    }
    let key = strategy["host"]["repos"]
        .as_object()
        .and_then(|m| m.keys().next().cloned())
        .ok_or_else(|| invalid(format!("repo not mapped on {alias}")))?;
    let _path = host["repos"][&key].as_str().unwrap_or("").to_owned();
    let _origin = strategy["hosts"][alias]["repos"][&key]
        .as_str()
        .unwrap_or("")
        .to_owned();
    let probe = probe_host(effects, alias).await?;
    let input = json!({
        "alias": alias,
        "host": host,
        "options": options,
        "probe": probe,
        "repoProbes": probe.get("repoProbes").cloned().unwrap_or_else(|| json!({})),
        "hostFingerprint": probe.get("fingerprint").cloned(),
        "caller": "pacer-remote-caller",
        "cloneCode": probe.get("cloneCode").cloned(),
        "identityCode": probe.get("identityCode").cloned(),
    });
    // If options.clone != false, call clone bridge
    if options["clone"] != false {
        let _ = clone_remote(effects, alias, &key).await?;
    }
    // If options.identity != false, call identity bridge
    if options["identity"] != false {
        let _ = setup_identity(effects, alias, &key).await?;
    }
    Ok(pacer_lifecycle::hosts::setup(&input))
}

/// Native `host.clean` — checks transfer gate and removes remote worktrees.
pub async fn host_clean(
    ctx: &Ctx,
    params: Value,
    effects: &mut dyn HostEffects,
) -> Result<Value, CoreError> {
    let map = object(&params)?;
    let alias = map
        .get("alias")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("alias: Required string"))?;
    if alias.is_empty() || alias.encode_utf16().count() > 128 {
        return Err(invalid("alias: expected 1..128 UTF-16 code units"));
    }
    let dry_run = map.get("dryRun").and_then(Value::as_bool).unwrap_or(false);
    let strategy = pacer_config::strategy::load_strategy(&ctx.pacer_home)
        .map_err(|e| invalid(e.to_string()))?;
    let host = strategy["hosts"][alias].clone();
    if host.is_null() {
        return Err(invalid(format!("unknown host {alias}")));
    }
    // Get tasks from store
    let mut store =
        pacer_store::TaskStore::open(&ctx.pacer_home).map_err(|e| invalid(e.to_string()))?;
    let tasks = store
        .list(&pacer_store::TaskFilter::default())
        .map_err(|e| invalid(e.to_string()))?;
    let _key = strategy["host"]["repos"]
        .as_object()
        .and_then(|m| m.keys().next().cloned());
    let probe = probe_host(effects, alias).await?;
    // Check transfer for each task
    let mut transferred = serde_json::Map::new();
    for t in &tasks {
        let run = &t["run"];
        if run["host"] == alias && run["mode"] == "new" {
            let id = t["id"].as_str().unwrap_or("");
            if !id.is_empty() {
                let transfer_result = check_transfer(effects, id).await?;
                transferred.insert(id.to_string(), transfer_result["ok"].clone());
            }
        }
    }
    let input = json!({
        "alias": alias,
        "host": host,
        "dryRun": dry_run,
        "tasks": tasks,
        "transferred": transferred,
        "cleanCodes": probe.get("cleanCodes").cloned().unwrap_or_else(|| json!({})),
    });
    Ok(pacer_lifecycle::hosts::clean(&input))
}

/// Dispatch a host check/clean/setup op through the effects bridge.
pub async fn call(
    ctx: &Ctx,
    op: &str,
    params: Value,
    _app: bool,
    effects: &mut dyn HostEffects,
) -> Result<Value, CoreError> {
    match op {
        "host.check" => host_check(ctx, params, effects).await,
        "host.clean" => host_clean(ctx, params, effects).await,
        "host.repo.setup" => host_repo_setup(ctx, params, effects).await,
        _ => Err(CoreError::new(Code::UnknownOp, "unknown operation")),
    }
}
