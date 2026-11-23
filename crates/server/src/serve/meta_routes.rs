//! Native meta routes for the front door: `/v3/hello`, `/v3/snapshot` and
//! `/v3/session/exchange`, plus the shared hello body and core build descriptor.
//!
//! These answer protocol-3 life-cycles directly so the core is not round-tripped
//! for them (the core stays authoritative for task grants and scoped sessions).
//! When `PACER_FORWARD_OPS` names one of the paired `http.*` escapes, or
//! `PACER_WORK_GRANT` is set, `route` falls through with `None` so the caller
//! forwards the request exactly as before.
use super::{core_child::CoreChild, read_cache::ReadCache, sessions};
use axum::{
    http::{Method, StatusCode, header::HeaderValue},
    response::{IntoResponse, Response},
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Value, json};
use std::{collections::HashMap, io, process::Stdio, sync::Arc};
use tokio::process::Command;

/// Generated from the TypeScript hello bodies; the parity test catches drift.
/// Two fields are never in the generated file. `pacer` changes with every
/// release, so it is package.json's version, which the TypeScript hello reports
/// too (`pkg.version`), even when the build was given another one. The v3
/// body's `coreBuild` describes the running core, so it comes from the core
/// itself, once per connection.
pub(crate) fn hello_body(version: u8, core_build: Option<&Value>) -> io::Result<Value> {
    let bodies: Value = serde_json::from_str(include_str!("../stdio_hello.json"))?;
    let Value::Object(fields) = &bodies[if version == 3 { "v3" } else { "v2" }] else {
        return Err(io::Error::other("stdio_hello.json has no hello body"));
    };
    let mut ordered = serde_json::Map::new();
    if let (3, Some(build)) = (version, core_build) {
        ordered.insert("coreBuild".into(), build.clone());
    }
    for (key, value) in fields {
        ordered.insert(key.clone(), value.clone());
        // TypeScript sends `pacer` right after the protocol versions.
        if key == if version == 3 { "previous" } else { "protocol" } {
            ordered.insert("pacer".into(), env!("PACER_PACKAGE_VERSION").into());
        }
    }
    Ok(Value::Object(ordered))
}

/// The core's build descriptor, read with `--pacer-component-descriptor` on
/// first use. Owning its program, prefix and environment lets both the stdio
/// proxy and the HTTP front door share it without borrow lifetimes.
pub(crate) struct CoreBuild {
    program: Option<String>,
    prefix: Vec<String>,
    env: HashMap<String, String>,
    value: tokio::sync::OnceCell<Option<Value>>,
}
impl CoreBuild {
    pub(crate) fn new(
        program: Option<String>,
        prefix: Vec<String>,
        env: HashMap<String, String>,
    ) -> Self {
        Self {
            program,
            prefix,
            env,
            value: tokio::sync::OnceCell::new(),
        }
    }
    /// The core measured this way is spawned by the caller, so empty argv and
    /// the current environment are the defaults a test fixture wants.
    pub(crate) fn from_core(core: &[String], env: &HashMap<String, String>) -> Self {
        let (program, prefix) = core
            .split_first()
            .map(|(program, prefix)| (Some(program.clone()), prefix.to_vec()))
            .unwrap_or((None, vec![]));
        Self::new(program, prefix, env.clone())
    }
    pub(crate) async fn get(&self) -> Option<&Value> {
        self.value
            .get_or_init(|| async {
                let Some(program) = &self.program else {
                    return None;
                };
                // A hung core must not hold hello and every request behind it.
                let output = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    Command::new(program)
                        .args(&self.prefix)
                        .arg("--pacer-component-descriptor")
                        .envs(&self.env)
                        .env_remove(crate::core_secrets::ANNOUNCE_ENV)
                        .stdin(Stdio::null())
                        .stderr(Stdio::inherit())
                        .kill_on_drop(true)
                        .output(),
                )
                .await;
                match output {
                    Ok(Ok(output)) if output.status.success() => {
                        serde_json::from_slice::<Value>(&output.stdout).ok()
                    }
                    _ => {
                        eprintln!("pacer: core build descriptor unavailable");
                        None
                    }
                }
            })
            .await
            .as_ref()
    }
}

/// The snapshot-probe parts used when the core has not announced a listener:
/// `parse_snapshot_parts` sees `statusError` and reports `service.starting`.
fn default_parts() -> Value {
    json!({
        "active": [],
        "revision": "",
        "alivePids": [],
        "setup": {"open": 0, "items": []},
        "policy": {},
        "machine": {"os": "unknown", "arch": "unknown"},
        "service": {"version": "0.0.0", "protocol": "3.0.0", "pid": 0, "startedAt": 0, "notifier": null},
        "desktopUpdates": [],
        "serviceInstalled": false,
        "canPair": false,
        "statusError": "status is warming up"
    })
}

/// The full `/v3/snapshot` wire built from the bridge parts (or, with no core,
/// from [`default_parts`]).
async fn build_snapshot(ctx: Ctx, target: Option<(u16, String)>) -> Result<Value, CoreError> {
    let parts = match target {
        Some(target) => crate::native::snapshot_sync::http(Some(target)).await?,
        None => default_parts(),
    };
    pacer_task_ops::snapshot_get_ops::snapshot_get(&ctx, json!({}), parts).await
}

fn build(core: Arc<CoreChild>, base: Ctx) -> Arc<dyn Fn() -> OpFuture<'static> + Send + Sync> {
    Arc::new(move || -> OpFuture<'static> {
        let core = core.clone();
        let base = base.clone();
        Box::pin(async move {
            let ctx = base.at_now();
            build_snapshot(ctx, core.target().await).await
        })
    })
}

/// The stale-while-revalidate snapshot cache the front door serves `/v3/snapshot` from.
pub(crate) fn snapshot_cache(core: Arc<CoreChild>, ctx: Ctx) -> Arc<ReadCache> {
    ReadCache::new(build(core, ctx), std::time::Duration::from_millis(1000))
}

fn x_pacer(response: &mut Response) {
    response
        .headers_mut()
        .insert("x-pacer", HeaderValue::from_static("1"));
}

fn no_store(response: &mut Response) {
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
}

async fn hello_route(core_build: &Arc<CoreBuild>) -> Response {
    match hello_body(3, core_build.get().await) {
        Ok(body) => {
            let mut response = super::native_json(StatusCode::OK, body);
            x_pacer(&mut response);
            response
        }
        Err(error) => super::native_error(CoreError::new(Code::Internal, error.to_string())),
    }
}

async fn snapshot_path(state: &Arc<super::Listener>) -> Response {
    match state.snapshot_cache.get().await {
        Ok(snapshot) => {
            let mut response = super::native_json(StatusCode::OK, snapshot);
            x_pacer(&mut response);
            response
        }
        Err(error) => super::native_error(error),
    }
}

fn session_exchange_path(ctx: &Ctx) -> Response {
    let value = match sessions::create(ctx) {
        Ok(value) => value,
        Err(error) => {
            return super::native_error(CoreError::new(Code::Internal, error.to_string()));
        }
    };
    let cookie = format!(
        "pacer_session={value}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}",
        sessions::SESSION_SECONDS as u64
    );
    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert("set-cookie", HeaderValue::from_str(&cookie).unwrap());
    no_store(&mut response);
    x_pacer(&mut response);
    response
}

fn method_not_allowed() -> Response {
    let mut response = super::native_json(
        StatusCode::METHOD_NOT_ALLOWED,
        CoreError::new(Code::InvalidInput, "method not allowed").body(),
    );
    x_pacer(&mut response);
    response
}

/// Dispatch the native meta routes. Returns `None` when a `forward_*` escape
/// is set, so the caller keeps forwarding the request to the core.
///
/// `path` and `method` are passed instead of the request so the future stays
/// `Send`: a `&Request<Body>` (whose body is a non-`Sync` `dyn HttpBody`)
/// cannot be held across the `.await`s below.
pub(super) async fn route(
    state: &Arc<super::Listener>,
    ctx: &Ctx,
    path: &str,
    method: &Method,
) -> Option<Response> {
    match path {
        "/v3/hello" => {
            if state.forward_hello {
                return None;
            }
            if *method != Method::GET {
                return Some(method_not_allowed());
            }
            Some(hello_route(&state.core_build).await)
        }
        "/v3/snapshot" => {
            if state.forward_snapshot {
                return None;
            }
            if *method != Method::GET {
                return Some(method_not_allowed());
            }
            Some(snapshot_path(state).await)
        }
        "/v3/session/exchange" => {
            if state.forward_session_exchange {
                return None;
            }
            if *method != Method::POST {
                return Some(method_not_allowed());
            }
            Some(session_exchange_path(ctx))
        }
        _ => None,
    }
}
