//! Agent integrations: `agent.detect`.
//!
//! Interpreting an agent CLI (`planner.detect`) is the planner plugin's capability (ARCH-12),
//! so a fresh detection stays with the TypeScript plugin host. The host owns the PATH probe
//! and the hour-long detection cache (`detectAgents` in `src/install/detection.ts`); a cache
//! hit is answered here.
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;

#[cfg(test)]
mod tests;

/// `AGENT_BINS`, in declaration order.
const AGENT_BINS: [&[&str]; 4] = [
    &["claude"],
    &["codex"],
    &["cursor-agent", "cursor"],
    &["opencode"],
];
const CACHE_S: f64 = 3600.0;

/// A detection the cache cannot answer runs the planner plugin in TypeScript.
pub fn agent_detect_stays_forwarded(ctx: &Ctx, params: &Value) -> bool {
    if ctx
        .env
        .get("PACER_ENFORCEMENT_TOKEN")
        .is_some_and(|token| !token.is_empty())
    {
        return false;
    }
    match host_param(params) {
        Ok(host) => cached_rows(ctx, host.as_deref()).is_none(),
        Err(_) => false,
    }
}

pub fn agent_detect(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        if ctx
            .env
            .get("PACER_ENFORCEMENT_TOKEN")
            .is_some_and(|token| !token.is_empty())
        {
            return Err(CoreError::new(
                Code::NotAllowed,
                "Enforcement identity only reports a native child denial",
            ));
        }
        let host = host_param(&params)?;
        cached_rows(ctx, host.as_deref()).ok_or_else(|| {
            CoreError::new(
                Code::Unavailable,
                "agent detection cache changed during the request",
            )
            .hint("Retry agent.detect.")
        })
    })
}

fn received(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// `z.object({host: id.optional()})`, where `id` is a string of 1 to 128 UTF-16 units.
fn host_param(params: &Value) -> Result<Option<String>, CoreError> {
    let invalid = |message: String| CoreError::new(Code::InvalidInput, message);
    let map = match params {
        Value::Null => return Ok(None),
        Value::Object(map) => map,
        other => {
            return Err(invalid(format!(
                "params: Invalid input: expected object, received {}",
                received(other)
            )));
        }
    };
    match map.get("host") {
        None => Ok(None),
        Some(Value::String(host)) => match host.encode_utf16().count() {
            0 => Err(invalid(
                "host: Too small: expected string to have >=1 characters".into(),
            )),
            n if n > 128 => Err(invalid(
                "host: Too big: expected string to have <=128 characters".into(),
            )),
            _ => Ok(Some(host.clone())),
        },
        Some(other) => Err(invalid(format!(
            "host: Invalid input: expected string, received {}",
            received(other)
        ))),
    }
}

/// `Bun.which`: the first executable regular file named `name` in a `PATH` directory.
fn which(name: &str, path: &str) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    path.split(':')
        .filter(|dir| !dir.is_empty())
        .find_map(|dir| {
            let candidate = Path::new(dir).join(name);
            let meta = std::fs::metadata(&candidate).ok()?;
            (meta.is_file() && meta.permissions().mode() & 0o111 != 0)
                .then(|| candidate.to_string_lossy().into_owned())
        })
}

/// The cache key hashes `JSON.stringify([binaries, PATH, host])`, so a hit implies the same
/// binaries, `PATH` and host as the detection that wrote it. `ctx.which` searches the process
/// `PATH`; relative entries resolve against a working directory only TypeScript sees.
fn cached_rows(ctx: &Ctx, host: Option<&str>) -> Option<Value> {
    cached_rows_on(ctx, host, &std::env::var("PATH").unwrap_or_default())
}

fn cached_rows_on(ctx: &Ctx, host: Option<&str>, search: &str) -> Option<Value> {
    let path = ctx.env.get("PATH").map(String::as_str);
    if host.is_none()
        && search
            .split(':')
            .any(|dir| !dir.is_empty() && !dir.starts_with('/'))
    {
        return None;
    }
    let binaries: Vec<Value> = AGENT_BINS
        .iter()
        .map(|bins| {
            if host.is_some() {
                return Value::Null;
            }
            bins.iter()
                .find_map(|bin| which(bin, search).map(|found| json!({"name": bin, "path": found})))
                .unwrap_or(Value::Null)
        })
        .collect();
    let key = json!([binaries, path, host]).to_string();
    let file = ctx.pacer_home.join("cache").join(format!(
        "agent-detect-{}.json",
        hex::encode(Sha256::digest(key))
    ));
    let cached: Value = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    let age = ctx.now - cached.get("at")?.as_f64()?;
    if !(0.0..CACHE_S).contains(&age) {
        return None;
    }
    cached.get("rows").cloned()
}

// Service installation: `service.install`.
//
// Native validation and manifest handling. The actual launchctl/systemctl
// execution goes through a Core effects bridge (`/_internal/service-effects`,
// `_internal.service.effects`) because it requires root/sudo on Linux and
// launchd bootstrap on macOS.

/// Core effects for service installation.
pub trait ServiceEffects: Send {
    fn call(&mut self, request: serde_json::Value) -> pacer_foundation::api::OpFuture<'_>;
}

/// Registry entry for service.install op.
pub fn service_install_stub(
    _: &pacer_foundation::Ctx,
    _: serde_json::Value,
) -> pacer_foundation::api::OpFuture<'_> {
    Box::pin(async move {
        Err(pacer_foundation::api::CoreError::new(
            pacer_foundation::api::Code::Unavailable,
            "service effects bridge unavailable",
        ))
    })
}

/// Inputs only TypeScript reproduces (needs sudo/root).
pub fn service_install_stays_forwarded(
    ctx: &pacer_foundation::Ctx,
    _params: &serde_json::Value,
) -> bool {
    if ctx
        .env
        .get("PACER_WORK_GRANT")
        .is_some_and(|grant| !grant.is_empty())
    {
        return true;
    }
    false
}

pub fn needs_service_effects_bridge(op: &str) -> bool {
    matches!(op, "service.install")
}

pub(crate) fn invalid(message: impl Into<String>) -> pacer_foundation::api::CoreError {
    pacer_foundation::api::CoreError::new(pacer_foundation::api::Code::InvalidInput, message)
}

pub(crate) fn object(
    params: &serde_json::Value,
) -> Result<&serde_json::Map<String, serde_json::Value>, pacer_foundation::api::CoreError> {
    params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            match params {
                serde_json::Value::Null => "null",
                serde_json::Value::Bool(_) => "boolean",
                serde_json::Value::Number(_) => "number",
                serde_json::Value::String(_) => "string",
                serde_json::Value::Array(_) => "array",
                serde_json::Value::Object(_) => "object",
            }
        ))
    })
}

/// Native `service.install` — validates params and calls install effect.
pub async fn service_install(
    ctx: &pacer_foundation::Ctx,
    params: serde_json::Value,
    effects: &mut dyn ServiceEffects,
) -> Result<serde_json::Value, pacer_foundation::api::CoreError> {
    let map = object(&params)?;
    let replace = map
        .get("replace")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let release_ownership = map
        .get("releaseOwnership")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let force = map
        .get("force")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    // Validate we're not in an executor session
    if ctx.env.get("PACER_ROLE").is_some_and(|r| r == "executor") {
        return Err(invalid(
            "pacer service: executor sessions cannot install the service",
        ));
    }

    // Build input for Core effect
    let input = serde_json::json!({
        "replace": replace,
        "releaseOwnership": release_ownership,
        "force": force,
        "argv": std::env::args().collect::<Vec<_>>(),
        "home": ctx.home.to_string_lossy(),
        "pacerHome": ctx.pacer_home.to_string_lossy(),
    });

    effects
        .call(serde_json::json!({"kind": "install", "input": input}))
        .await
}

/// Dispatch a service.install op through the effects bridge.
pub async fn call(
    ctx: &pacer_foundation::Ctx,
    op: &str,
    params: serde_json::Value,
    _app: bool,
    effects: &mut dyn ServiceEffects,
) -> Result<serde_json::Value, pacer_foundation::api::CoreError> {
    match op {
        "service.install" => service_install(ctx, params, effects).await,
        _ => Err(pacer_foundation::api::CoreError::new(
            pacer_foundation::api::Code::UnknownOp,
            "unknown operation",
        )),
    }
}
