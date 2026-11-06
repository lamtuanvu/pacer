//! Public listener authentication. Listener and core forwarding are wired separately.
pub mod app_assets;
pub mod auth;
pub mod core_child;
pub mod discovery;
#[cfg(test)]
#[path = "discovery_tests.rs"]
mod discovery_tests;
pub mod heartbeat;
mod js_trim;
#[cfg(test)]
#[path = "listener_tests.rs"]
mod listener_tests;
mod log_sse;
#[cfg(test)]
#[path = "log_sse_tests.rs"]
mod log_sse_tests;
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
pub mod native_host;
#[cfg(target_os = "macos")]
pub mod native_listener;
#[cfg(target_os = "macos")]
pub mod native_trust;
pub mod proxy;
pub mod sessions;
pub mod ws;

use crate::native::{call_native, service_registry};
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
// Bun's HTTP listener joins Cookie fields with semicolon-space; Fetch joins
// other repeated fields with comma-space, in arrival order.
fn header_value(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    let values = headers.get_all(name);
    let mut iter = values.iter().peekable();
    iter.peek()?;
    let mut combined = Vec::new();
    for (index, value) in iter.enumerate() {
        if index > 0 {
            combined.extend_from_slice(if name.eq_ignore_ascii_case("cookie") {
                b"; "
            } else {
                b", "
            });
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
    plugins: crate::native::plugins::Service,
    forward_log_follow: bool,
}
async fn forward_plugin_read(
    state: &Listener,
    parts: axum::http::request::Parts,
    bytes: axum::body::Bytes,
    auth: auth::AuthKind,
) -> Response {
    let Some(target) = state.core.target().await else {
        return proxy::unavailable(false);
    };
    proxy::forward(Request::from_parts(parts, Body::from(bytes)), target, auth).await
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
        let (parts, body) = req.into_parts();
        let bytes = match axum::body::to_bytes(body, max + 1).await {
            Ok(bytes) if bytes.len() <= max => bytes,
            _ => return native_error(CoreError::new(Code::TooLarge, "body exceeds 256 KiB")),
        };
        let plugin = op.name.starts_with("plugin.");
        let decoded = if plugin {
            pacer_plugin_ops::json::parse_body(&bytes)
        } else {
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())
        };
        let params: Value = match decoded {
            Ok(params) => params,
            Err(error) if plugin && error == pacer_plugin_ops::json::NESTING_FALLBACK => {
                return forward_plugin_read(&state, parts, bytes, auth).await;
            }
            Err(_) => return native_error(CoreError::new(Code::InvalidInput, "body is not JSON")),
        };
        // Planner install and backend readiness remain on the TypeScript path.
        // mode.hold without until needs computeStatus for the planner reset window.
        if (op.name == "config.set" && crate::native::config_set_stays_forwarded(&params))
            || (op.name == "mode.hold" && crate::native::mode_hold_stays_forwarded(&params))
            || (op.name == "routing.route" && crate::native::routing_route_stays_forwarded(&params))
        {
            let Some(target) = state.core.target().await else {
                return proxy::unavailable(false);
            };
            return proxy::forward(Request::from_parts(parts, Body::from(bytes)), target, auth)
                .await;
        }
        let result = if op.name.starts_with("plugin.") {
            if std::env::var("PACER_DEBUG_NATIVE").as_deref() == Ok("1") {
                eprintln!("native {}", op.name);
            }
            // Reads, X3 mutations, and retired install share the HTTP plugin service.
            // Flag-on ProcessOwner (when present) starts children; Core supplies specs.
            let state = Arc::clone(&state);
            let name = op.name;
            match tokio::spawn(
                async move { state.plugins.call(&ctx, &state.core, name, params).await },
            )
            .await
            {
                Ok(result) => result,
                Err(e) => Err(CoreError::new(Code::Internal, e.to_string())),
            }
        } else {
            let mut request_ctx = ctx.clone();
            if op.name == "config.set" && auth == auth::AuthKind::Cookie {
                request_ctx
                    .env
                    .insert("PACER_TERMINAL_PRESETS_ONLY".into(), "1".into());
            }
            let endpoint_sync = state.core.target().await.map(|target| {
                Box::pin(crate::native::config_sync::http(Some(target), op.name))
                    as pacer_foundation::api::OpFuture<'_>
            });
            let broker_sync = if crate::native::needs_usage_broker(op.name) {
                state.core.target().await.map(|target| {
                    Box::pin(crate::native::status_sync::http(Some(target)))
                        as pacer_foundation::api::OpFuture<'_>
                })
            } else {
                None
            };
            let session_sync = if crate::native::needs_session_probe(op.name) {
                state.core.target().await.map(|target| {
                    Box::pin(crate::native::session_sync::http(Some(target)))
                        as pacer_foundation::api::OpFuture<'_>
                })
            } else {
                None
            };
            call_native(
                &request_ctx,
                op,
                params,
                None,
                endpoint_sync,
                broker_sync,
                session_sync,
            )
            .await
        };
        if plugin
            && crate::native::plugins::is_read(op.name)
            && result.as_ref().is_err_and(|error| {
                error.code == Code::Unavailable
                    && error.message == pacer_plugin_ops::json::NESTING_FALLBACK
            })
        {
            // Read envelopes may be replayed safely against the TS reference.
            // Mutations must not replay after a native prepare/effect path.
            return forward_plugin_read(&state, parts, bytes, auth).await;
        }
        return match result {
            Ok(result) if plugin => {
                plugin_json(StatusCode::OK, serde_json::json!({"result":result}))
            }
            Err(error) if plugin => plugin_json(
                StatusCode::from_u16(error.http_status())
                    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                error.body(),
            ),
            Ok(result) => native_json(StatusCode::OK, serde_json::json!({"result":result})),
            Err(error) => native_error(error),
        };
    }
    if !state.scoped_work
        && !state.forward_log_follow
        && auth != auth::AuthKind::Task
        && req.uri().path().starts_with("/v3/tasks/")
        && req.uri().path().ends_with("/log")
        && req.uri().query().is_some_and(|query| {
            form_urlencoded::parse(query.as_bytes())
                .find(|(key, _)| key == "follow")
                .is_some_and(|(_, value)| value == "1")
        })
    {
        if req.method() != axum::http::Method::GET {
            return native_json(
                StatusCode::METHOD_NOT_ALLOWED,
                CoreError::new(Code::InvalidInput, "method not allowed").body(),
            );
        }
        if let Some(id) = req
            .uri()
            .path()
            .strip_prefix("/v3/tasks/")
            .and_then(|p| p.strip_suffix("/log"))
            && !id.contains('/')
            && !id.is_empty()
        {
            if std::env::var("PACER_DEBUG_NATIVE").as_deref() == Ok("1") {
                eprintln!("native http.task_log_follow");
            }
            return log_sse::follow(ctx, id.to_owned(), state.core.clone()).await;
        }
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
fn plugin_json(status: StatusCode, body: Value) -> Response {
    json_headers((status, pacer_plugin_ops::settings::js_json(&body)).into_response())
}
fn native_json(status: StatusCode, body: Value) -> Response {
    json_headers((status, axum::Json(body)).into_response())
}
fn json_headers(mut response: Response) -> Response {
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
    let registry = service_registry(if scoped_work { "*" } else { forward });
    let forward_log_follow = forward.split(',').any(|name| {
        js_trim::js_trim(name) == "*" || js_trim::js_trim(name) == "http.task_log_follow"
    });
    let token = auth::ensure_token(&ctx)?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let port = listener.local_addr()?.port();
    // The internal HTTP listener binds independently. Its desktop integration
    // still needs the actual public port, including explicit/ephemeral binds.
    env.insert("PACER_PORT".into(), port.to_string());
    // Flag-on P4d-1/P4d-4 path: claim ProcessOwner + reverse bridge before Core
    // spawn so the child inherits PACER_HOST_SOCKET and HTTP plugin RPC can use
    // the same owner. Default (flags unset) is a no-op.
    let native_host = native_host::maybe_start(&ctx.pacer_home, &mut env)?;
    let plugins = match &native_host {
        Some(host) => crate::native::plugins::Service::with_native_owner(host.owner()),
        None => crate::native::plugins::Service::default(),
    };
    // Native operations and the core must observe the same configuration environment.
    ctx.env = env.clone();
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
        plugins,
        forward_log_follow,
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
    if let Some(native_host) = native_host {
        native_host.shutdown().await;
    }
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
