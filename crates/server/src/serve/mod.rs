//! Public listener authentication. Listener and core forwarding are wired separately.
pub mod auth;
pub mod core_child;
pub mod heartbeat;
#[cfg(target_os = "macos")]
pub mod native_bundle;
#[cfg(target_os = "macos")]
pub mod native_listener;
#[cfg(target_os = "macos")]
pub mod native_trust;
pub mod proxy;
pub mod sessions;
pub mod ws;

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use pacer_foundation::Ctx;
use std::{collections::HashMap, io, sync::Arc};
struct Listener {
    core: Arc<core_child::CoreChild>,
    heartbeat: Arc<heartbeat::Heartbeat>,
    ctx: Ctx,
    port: u16,
    token: String,
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
    let Some(target) = state.core.target().await else {
        return proxy::unavailable(req.uri().path().starts_with("/app/"));
    };
    let path = req.uri().path();
    if (path.starts_with("/v2/tasks/") || path.starts_with("/v3/tasks/"))
        && path.ends_with("/session")
        && req
            .headers()
            .get("upgrade")
            .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
    {
        return ws::bridge(req, target, auth).await;
    }
    proxy::forward(req, target, auth).await
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
) -> io::Result<()> {
    let mut ctx = Ctx::from_env();
    let token = auth::ensure_token(&ctx)?;
    // Requests clone the context; the listener needs only the pacer home.
    ctx.env.clear();
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let port = listener.local_addr()?.port();
    // The internal HTTP listener binds independently. Its desktop integration
    // still needs the actual public port, including explicit/ephemeral binds.
    env.insert("PACER_PORT".into(), port.to_string());
    if std::env::var("PACER_SERVE_ANNOUNCE").as_deref() == Ok("1") {
        println!("{}", serde_json::json!({"port":port}));
    }
    let core = Arc::new(core_child::CoreChild::spawn(core, env));
    let beats = Arc::new(heartbeat::Heartbeat::new());
    let probe = tokio::spawn(heartbeat::run(core.clone(), beats.clone()));
    let state = Arc::new(Listener {
        core,
        heartbeat: beats,
        ctx,
        port,
        token,
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
    shutdown_signal().await;
    let _ = stop.send(());
    // Stop long-lived SSE/WebSocket connections as well as accepting new ones.
    server.abort();
    let _ = server.await;
    probe.abort();
    state.core.shutdown().await;
    Ok(())
}
pub fn run_serve_blocking(core: Vec<String>, env: HashMap<String, String>, port: u16) -> i32 {
    let result = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .and_then(|runtime| runtime.block_on(run_serve(core, env, port)));
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("pacer: serve: {error}");
            1
        }
    }
}
