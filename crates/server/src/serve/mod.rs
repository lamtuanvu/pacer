//! Public listener authentication. Listener and core forwarding are wired separately.
pub mod app_assets;
pub mod auth;
pub mod core_child;
pub mod discovery;
#[cfg(test)]
#[path = "discovery_tests.rs"]
mod discovery_tests;
pub mod heartbeat;
#[cfg(test)]
#[path = "listener_tests.rs"]
mod listener_tests;
#[cfg(target_os = "macos")]
mod native_bootstrap;
#[cfg(target_os = "macos")]
pub mod native_bundle;
#[cfg(target_os = "macos")]
pub mod native_context;
#[cfg(target_os = "macos")]
mod native_helper;
#[cfg(target_os = "macos")]
mod native_helper_diagnostics;
#[cfg(target_os = "macos")]
pub mod native_listener;
#[cfg(target_os = "macos")]
pub mod native_trust;
pub mod proxy;
pub mod sessions;
pub mod ws;

use crate::native::{call_native, registry};
use axum::{
    Router,
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, Registry},
};
use serde_json::Value;
use std::{collections::HashMap, io, sync::Arc};
// Fetch Headers.get combines repeated values in arrival order with comma-space.
fn header_value(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    let values = headers.get_all(name);
    let mut iter = values.iter().peekable();
    iter.peek()?;
    let mut combined = Vec::new();
    for (index, value) in iter.enumerate() {
        if index > 0 {
            combined.extend_from_slice(b", ");
        }
        combined.extend_from_slice(value.as_bytes());
    }
    String::from_utf8(combined).ok()
}

struct Listener {
    core: Arc<core_child::CoreChild>,
    heartbeat: Arc<heartbeat::Heartbeat>,
    ctx: Ctx,
    port: u16,
    token: String,
    registry: Registry<'static>,
    scoped_work: bool,
}
async fn handle(State(state): State<Arc<Listener>>, req: Request<Body>) -> Response {
    // Session expiry is checked against the time of this request, never the start-up time.
    let ctx = state.ctx.at_now();
    let auth = match auth::classify(&req, state.port, &state.token, &ctx) {
        auth::Decision::Health => return state.heartbeat.response(),
        auth::Decision::Reject(response) => {
            if let Some(page) = response.extensions().get::<auth::AppPage>() {
                let Some(target) = state.core.target().await else {
                    return proxy::unavailable(true);
                };
                let message: String = page.message.bytes().map(|b| format!("%{b:02X}")).collect();
                let request = Request::builder()
                    .uri(format!(
                        "/_internal/app-page?status={}&message={message}",
                        response.status().as_u16()
                    ))
                    .body(Body::empty());
                return match request {
                    Ok(request) => proxy::forward(request, target, auth::AuthKind::Bearer).await,
                    Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                };
            }
            return response;
        }
        auth::Decision::AppAuth => auth::AuthKind::Bearer,
        auth::Decision::Forward { auth } => auth,
    };
    // The core remains authoritative for task grants and scoped work sessions.
    if !state.scoped_work
        && auth != auth::AuthKind::Task
        && req.method() == axum::http::Method::POST
        && let Some(name) = req.uri().path().strip_prefix("/v3/ops/")
        && let Some(op) = state.registry.get(name)
    {
        let max = 256 * 1024;
        if header_value(req.headers(), "content-length")
            .and_then(|v| v.parse::<usize>().ok())
            .is_some_and(|n| n > max)
        {
            return native_error(CoreError::new(Code::TooLarge, "body exceeds 256 KiB"));
        }
        let bytes = match axum::body::to_bytes(req.into_body(), max + 1).await {
            Ok(bytes) if bytes.len() <= max => bytes,
            _ => return native_error(CoreError::new(Code::TooLarge, "body exceeds 256 KiB")),
        };
        let params: Value = match serde_json::from_slice(&bytes) {
            Ok(params) => params,
            Err(_) => return native_error(CoreError::new(Code::InvalidInput, "body is not JSON")),
        };
        return match call_native(&ctx, op, params, None).await {
            Ok(result) => native_json(StatusCode::OK, serde_json::json!({"result":result})),
            Err(error) => native_error(error),
        };
    }
    if let Some(response) = app_assets::route(&req) {
        return response;
    }
    let Some(target) = state.core.target().await else {
        return proxy::unavailable(req.uri().path().starts_with("/app/"));
    };
    let path = req.uri().path();
    if (path.starts_with("/v2/tasks/") || path.starts_with("/v3/tasks/"))
        && path.ends_with("/session")
        && header_value(req.headers(), "upgrade")
            .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
    {
        return ws::bridge(req, target, auth).await;
    }
    proxy::forward(req, target, auth).await
}
fn native_error(error: CoreError) -> Response {
    let status =
        StatusCode::from_u16(error.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    native_json(status, error.body())
}
fn native_json(status: StatusCode, body: Value) -> Response {
    let mut response = (status, axum::Json(body)).into_response();
    response.headers_mut().insert(
        "content-type",
        axum::http::HeaderValue::from_static("application/json;charset=utf-8"),
    );
    response
}
async fn shutdown_signal() {
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term => {} }
}
pub async fn run_serve(
    core: Vec<String>,
    mut env: HashMap<String, String>,
    port: u16,
    _version: &str,
    _argv: Vec<String>,
) -> io::Result<()> {
    let mut ctx = Ctx::from_env();
    let scoped_work = env.contains_key("PACER_WORK_GRANT");
    let forward = env
        .get("PACER_FORWARD_OPS")
        .map(String::as_str)
        .unwrap_or("");
    if !forward.is_empty() {
        eprintln!("pacer: PACER_FORWARD_OPS={forward}");
    }
    let registry = registry(if scoped_work { "*" } else { forward });
    let token = auth::ensure_token(&ctx)?;
    // Requests clone the context; the listener needs only the pacer home.
    ctx.env.clear();
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let port = listener.local_addr()?.port();
    // The internal HTTP listener binds independently. Its desktop integration
    // still needs the actual public port, including explicit/ephemeral binds.
    env.insert("PACER_PORT".into(), port.to_string());
    // Runtime environment cannot turn a generic front door into a native owner.
    env.remove("PACER_INTERNAL_NATIVE_BOOTSTRAP");
    #[cfg(target_os = "macos")]
    let native =
        native_context::NativeContext::prepare(&ctx.pacer_home, port, &core, _version, &_argv)?;
    if std::env::var("PACER_SERVE_ANNOUNCE").as_deref() == Ok("1") {
        println!("{}", serde_json::json!({"port":port}));
    }
    #[cfg(target_os = "macos")]
    let core = Arc::new(match &native {
        Some(native) => core_child::CoreChild::spawn_native(core, env, native.clone()),
        None => core_child::CoreChild::spawn(core, env),
    });
    #[cfg(not(target_os = "macos"))]
    let core = Arc::new(core_child::CoreChild::spawn(core, env));
    let beats = Arc::new(heartbeat::Heartbeat::new());
    let probe = tokio::spawn(heartbeat::run(core.clone(), beats.clone()));
    let radio = discovery::Radio::spawn(
        core.clone(),
        discovery::RadioOptions {
            poll: std::time::Duration::from_secs(5),
            disabled: std::env::var("PACER_DISCOVERY").as_deref() == Ok("off"),
        },
    );
    let state = Arc::new(Listener {
        core,
        heartbeat: beats,
        ctx,
        port,
        token,
        registry,
        scoped_work,
    });
    let app = Router::new()
        .fallback(any(handle))
        .with_state(state.clone());
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });
    #[cfg(target_os = "macos")]
    let native_shutdown = async {
        match &native {
            Some(native) => native.shutdown_requested().await,
            None => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(target_os = "macos"))]
    let native_shutdown = std::future::pending::<()>();
    tokio::select! { _ = shutdown_signal() => {}, _ = native_shutdown => {} }
    let _ = stop.send(());
    // Stop long-lived SSE/WebSocket connections as well as accepting new ones.
    server.abort();
    let _ = server.await;
    probe.abort();
    // Withdraw the advert with goodbye packets before the core stops.
    radio.stop().await;
    state.core.shutdown().await;
    Ok(())
}
pub fn run_serve_blocking(
    core: Vec<String>,
    env: HashMap<String, String>,
    port: u16,
    version: &str,
    argv: Vec<String>,
) -> i32 {
    let result = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .and_then(|runtime| runtime.block_on(run_serve(core, env, port, version, argv)));
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("pacer: serve: {error}");
            1
        }
    }
}
