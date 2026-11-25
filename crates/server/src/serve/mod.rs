//! Public listener authentication. Listener and core forwarding are wired separately.
pub mod app_assets;
pub mod auth;
pub mod core_child;
pub mod discovery;
#[cfg(test)]
#[path = "tests/discovery.rs"]
mod discovery_tests;
mod events_sse;
#[cfg(test)]
#[path = "tests/events_sse.rs"]
mod events_sse_tests;
pub mod heartbeat;
mod js_trim;
#[cfg(test)]
#[path = "tests/listener.rs"]
mod listener_tests;
mod log_sse;
#[cfg(test)]
#[path = "tests/log_sse.rs"]
mod log_sse_tests;
#[cfg(target_os = "macos")]
pub use pacer_desktop_native::native_context;
pub mod native_host;
#[cfg(target_os = "macos")]
pub use pacer_desktop_native::NativeContext;
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
#[cfg(target_os = "macos")]
use pacer_desktop_native::control::{ControlServer, Dispatch, Guard, Hello, Identity, Peer};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, Registry},
};
use serde_json::{Value, json};
use std::{collections::HashMap, io, sync::Arc, time::Duration};
#[cfg(target_os = "macos")]
use tokio::sync::mpsc;
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
    forward_events: bool,
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
        let ctx = if crate::native::msg_ops::is_msg_caller_op(op.name) {
            let human_session = auth == auth::AuthKind::Bearer
                && header_value(req.headers(), "x-pacer-session").is_some_and(|session| {
                    session.len() == 64
                        && session
                            .bytes()
                            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
                        && sessions::check(&ctx, &session).unwrap_or(false)
                });
            crate::native::msg_ops::with_http_caller(
                ctx,
                auth == auth::AuthKind::Cookie,
                human_session,
            )
        } else {
            ctx
        };
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
            Err(_)
                if crate::native::dispatch_lifecycle_sync::forwards_undecodable_body(op.name)
                    || crate::native::assistant_turn_sync::needs_bridge(op.name) =>
            {
                let Some(target) = state.core.target().await else {
                    return proxy::unavailable(false);
                };
                return proxy::forward(Request::from_parts(parts, Body::from(bytes)), target, auth)
                    .await;
            }
            Err(_) => return native_error(CoreError::new(Code::InvalidInput, "body is not JSON")),
        };
        // Changed-planner installs and Orca backend readiness remain on the TypeScript path.
        if (op.name == "config.set" && crate::native::config_set_stays_forwarded(&ctx, &params))
            || crate::native::status_residue_stays_forwarded(&ctx, op.name, &params)
            || (op.name == "repo.remove"
                && crate::native::repo_remove_stays_forwarded(&ctx, &params))
            || crate::native::project_messaging_stays_forwarded(&ctx, op.name, &params)
            || crate::native::msg_stays_forwarded(op.name, &ctx)
            || crate::native::msg_answer_stays_forwarded(op.name, &ctx, &params)
            || crate::native::repo_registry_stays_forwarded(&ctx, op.name, &params)
            || crate::native::discovery_stays_forwarded(&ctx, op.name, &params)
            || crate::native::desktop_reconcile_stays_forwarded(op.name)
            || crate::native::assistant_stays_forwarded(&ctx, op.name, &params)
            || crate::native::dependencies_waive_stays_forwarded(op.name, &params)
            || crate::native::insights_stays_forwarded(op.name, &params)
            || crate::native::planning_stays_forwarded(&ctx, op.name, &params)
            || crate::native::dispatch_lifecycle_stays_forwarded(&ctx, op.name, &params)
            || crate::native::job_strategy_setup_stays_forwarded(&ctx, op.name, &params)
            || crate::native::runner_attention_stays_forwarded(&ctx, op.name, &params)
            || crate::native::service_agent_stays_forwarded(&ctx, op.name, &params)
            || crate::native::account_stays_forwarded(&ctx, op.name, &params)
            || crate::native::host_stays_forwarded(&ctx, op.name, &params)
            || crate::native::strategy_settings_stays_forwarded(&ctx, op.name, &params)
            || crate::native::dispatch_preview_stays_forwarded(&ctx, op.name, &params)
            || crate::native::dispatch_enforcement_stays_forwarded(&ctx, op.name, &params)
            || crate::native::session_lifecycle_stays_forwarded(&ctx, op.name, &params)
            || crate::native::client_stays_forwarded(&ctx, op.name)
            || crate::native::terminal_stays_forwarded(&ctx, op.name, &params)
        {
            let Some(target) = state.core.target().await else {
                return proxy::unavailable(false);
            };
            return proxy::forward(Request::from_parts(parts, Body::from(bytes)), target, auth)
                .await;
        }
        if crate::native::task_delegation_ops::is_delegation_op(op.name) {
            use crate::native::task_delegation_ops::{Admission, admit};
            let reply = match admit(&ctx, op.name, &params) {
                Ok(Admission::Core) => {
                    let Some(target) = state.core.target().await else {
                        return proxy::unavailable(false);
                    };
                    return proxy::forward(
                        Request::from_parts(parts, Body::from(bytes)),
                        target,
                        auth,
                    )
                    .await;
                }
                Ok(Admission::Native(result)) => {
                    native_json(StatusCode::OK, serde_json::json!({"result":result}))
                }
                Err(error) => native_error(error),
            };
            crate::native::msg_write_sync::trace(op.name, None);
            return reply;
        }
        if crate::native::client_ops::is_client_op(op.name) {
            use crate::native::{client_control_sync::HttpBridge, client_ops};
            crate::native::msg_write_sync::trace(op.name, None);
            let target = state.core.target().await;
            if target.is_none() && client_ops::needs_core(op.name, &params) {
                return proxy::unavailable(false);
            }
            let mut bridge = HttpBridge {
                target: target.clone(),
            };
            let request_ctx = ctx.at_now();
            return match client_ops::call(&request_ctx, op.name, params, &mut bridge).await {
                Ok(result) => native_json(StatusCode::OK, serde_json::json!({"result":result})),
                Err(error) if error.message == client_ops::FORWARD_TO_CORE => {
                    let Some(target) = target else {
                        return proxy::unavailable(false);
                    };
                    proxy::forward(Request::from_parts(parts, Body::from(bytes)), target, auth)
                        .await
                }
                Err(error) => native_error(error),
            };
        }
        if crate::native::msg_writes::uses_bridge(op.name) {
            crate::native::msg_write_sync::trace(op.name, None);
            let mut bridge = crate::native::msg_write_sync::HttpBridge {
                target: state.core.target().await,
            };
            return match crate::native::msg_writes::call(&ctx, op.name, params, &mut bridge).await {
                Ok(result) => native_json(StatusCode::OK, serde_json::json!({"result":result})),
                Err(error)
                    if error.message == crate::native::msg_writes::FORWARD_DUPLICATE_ANSWER =>
                {
                    let Some(target) = state.core.target().await else {
                        return proxy::unavailable(false);
                    };
                    proxy::forward(Request::from_parts(parts, Body::from(bytes)), target, auth)
                        .await
                }
                Err(error) => native_error(error),
            };
        }
        if crate::native::session_lifecycle_ops::uses_admission(op.name) {
            use crate::native::session_lifecycle_ops::{Admission, admit, bridge_request};
            crate::native::msg_write_sync::trace(op.name, None);
            let result = match admit(&ctx, op.name, &params) {
                Ok(Admission::Native(reply)) => Ok(reply),
                Ok(Admission::Core) => {
                    let request = bridge_request(
                        op.name,
                        params,
                        header_value(&parts.headers, "x-pacer-client").as_deref(),
                        header_value(&parts.headers, "x-pacer-client-instance").as_deref(),
                    );
                    crate::native::core_bridge_sync::http(
                        state.core.target().await,
                        "session.lifecycle",
                        serde_json::json!({ "request": request }),
                    )
                    .await
                }
                Err(error) => Err(error),
            };
            return match result {
                Ok(result) => native_json(StatusCode::OK, serde_json::json!({"result":result})),
                Err(error) => native_error(error),
            };
        }
        if crate::native::assistant_turn_sync::needs_bridge(op.name) {
            crate::native::msg_write_sync::trace(op.name, None);
            let mut bridge = crate::native::assistant_turn_sync::HttpBridge {
                target: state.core.target().await,
            };
            let result =
                crate::native::assistant_turn_sync::call(&ctx, op.name, params, &mut bridge);
            return match result.await {
                Ok(result) => native_json(StatusCode::OK, serde_json::json!({"result":result})),
                Err(error) => native_error(error),
            };
        }
        if crate::native::task_send_ops::needs_task_send_bridge(op.name) {
            crate::native::msg_write_sync::trace(op.name, None);
            let by = crate::native::task_send_ops::caller_identity(
                &ctx,
                header_value(&parts.headers, "x-pacer-client").as_deref(),
                header_value(&parts.headers, "x-pacer-client-instance").as_deref(),
            );
            let mut bridge = crate::native::task_send_sync::HttpBridge {
                target: state.core.target().await,
            };
            return match crate::native::task_send_ops::task_send(&ctx, params, by, &mut bridge)
                .await
            {
                Ok(result) => native_json(StatusCode::OK, serde_json::json!({"result":result})),
                Err(error) => native_error(error),
            };
        }
        if crate::native::preview_ops::needs_dispatch_parts(op.name) {
            crate::native::msg_write_sync::trace(op.name, None);
            let mut bridge = crate::native::dispatch_preview_sync::HttpBridge {
                target: state.core.target().await,
            };
            let result =
                crate::native::preview_ops::dispatch_preview(&ctx, op.name, params, &mut bridge);
            return match result.await {
                Ok(result) => native_json(StatusCode::OK, serde_json::json!({"result":result})),
                Err(error) => native_error(error),
            };
        }
        if crate::native::enforcement_ops::needs_dispatch_parts(op.name) {
            crate::native::msg_write_sync::trace(op.name, None);
            let mut bridge = crate::native::dispatch_enforcement_sync::HttpBridge {
                target: state.core.target().await,
            };
            let result = match op.name {
                "dispatch.enforcement" => {
                    crate::native::enforcement_ops::dispatch_enforcement(&ctx, params, &mut bridge)
                }
                _ => crate::native::enforcement_ops::dispatch_enforcement_denied(
                    &ctx,
                    params,
                    &mut bridge,
                ),
            };
            return match result.await {
                Ok(result) => native_json(StatusCode::OK, serde_json::json!({"result":result})),
                Err(error) => native_error(error),
            };
        }
        if crate::native::terminal_ops::uses_bridge(op.name) {
            crate::native::msg_write_sync::trace(op.name, None);
            let mut bridge = crate::native::terminal_sync::HttpBridge {
                target: state.core.target().await,
            };
            let result = crate::native::terminal_ops::call(&ctx, op.name, params, &mut bridge);
            return match result.await {
                Ok(result) => native_json(StatusCode::OK, serde_json::json!({"result":result})),
                Err(error) => native_error(error),
            };
        }
        if pacer_config_ops::setup_effects::uses_effects(op.name) {
            crate::native::msg_write_sync::trace(op.name, None);
            let mut effects = crate::native::setup_effects_sync::HttpEffects {
                target: state.core.target().await,
            };
            let app = auth == auth::AuthKind::Cookie;
            let result =
                pacer_config_ops::setup_effects::call(&ctx, op.name, params, app, &mut effects);
            return match result.await {
                Ok(result) => native_json(StatusCode::OK, serde_json::json!({"result":result})),
                Err(error) => native_error(error),
            };
        }
        if crate::native::install_apply_sync::uses_effects(op.name) {
            crate::native::msg_write_sync::trace(op.name, None);
            let mut effects = crate::native::install_apply_sync::HttpEffects {
                target: state.core.target().await,
            };
            let result =
                crate::native::install_apply_sync::call(&ctx, op.name, params, &mut effects);
            return match result.await {
                Ok(result) => native_json(StatusCode::OK, serde_json::json!({"result":result})),
                Err(error) => native_error(error),
            };
        }
        if crate::native::handover_sync::uses_effects(op.name) {
            crate::native::msg_write_sync::trace(op.name, None);
            let mut effects = crate::native::handover_sync::HttpEffects {
                target: state.core.target().await,
            };
            let result = crate::native::handover_sync::call(&ctx, op.name, params, &mut effects);
            return match result.await {
                Ok(result) => native_json(StatusCode::OK, serde_json::json!({"result":result})),
                Err(error) => native_error(error),
            };
        }
        if crate::native::onboarding_sync::uses_effects(op.name) {
            crate::native::msg_write_sync::trace(op.name, None);
            let mut effects = crate::native::onboarding_sync::HttpEffects {
                target: state.core.target().await,
            };
            let result = crate::native::onboarding_sync::call(&ctx, op.name, params, &mut effects);
            return match result.await {
                Ok(result) => native_json(StatusCode::OK, serde_json::json!({"result":result})),
                Err(error) => native_error(error),
            };
        }
        if crate::native::agent_apply_sync::uses_effects(op.name) {
            crate::native::msg_write_sync::trace(op.name, None);
            let mut effects = crate::native::agent_apply_sync::HttpEffects {
                target: state.core.target().await,
            };
            let result = crate::native::agent_apply_sync::call(&ctx, op.name, params, &mut effects);
            return match result.await {
                Ok(result) => native_json(StatusCode::OK, serde_json::json!({"result":result})),
                Err(error) => native_error(error),
            };
        }
        if op.name == "task.wait" {
            let Some(id) = params
                .get("id")
                .and_then(serde_json::Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                return native_error(CoreError::new(
                    Code::InvalidInput,
                    "id: Invalid input: expected string, received undefined",
                ));
            };
            let core_target = state.core.target().await;
            match crate::native::task_wait_sync::http_probe(core_target.clone(), id).await {
                Ok(probe) if crate::native::task_wait_sync::task_wait_stays_forwarded(&probe) => {
                    let Some(target) = core_target else {
                        return proxy::unavailable(false);
                    };
                    return proxy::forward(
                        Request::from_parts(parts, Body::from(bytes)),
                        target,
                        auth,
                    )
                    .await;
                }
                Ok(_) => {}
                Err(error) => return native_error(error),
            }
        }
        let task_review_probe_cache = if op.name == "task.review" {
            if params
                .get("id")
                .and_then(serde_json::Value::as_str)
                .is_none_or(|id| id.is_empty())
            {
                return native_error(CoreError::new(
                    Code::InvalidInput,
                    "id: Invalid input: expected string, received undefined",
                ));
            };
            let core_target = state.core.target().await;
            match crate::native::task_review_sync::http_probe(core_target.clone(), &params).await {
                Ok(probe)
                    if crate::native::task_review_sync::task_review_stays_forwarded(&probe) =>
                {
                    let Some(target) = core_target else {
                        return proxy::unavailable(false);
                    };
                    return proxy::forward(
                        Request::from_parts(parts, Body::from(bytes)),
                        target,
                        auth,
                    )
                    .await;
                }
                Ok(probe) => Some(probe),
                Err(error) => return native_error(error),
            }
        } else {
            None
        };
        let task_stop_probe_cache = if op.name == "task.stop" {
            let Some(id) = params
                .get("id")
                .and_then(serde_json::Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                return native_error(CoreError::new(
                    Code::InvalidInput,
                    "id: Invalid input: expected string, received undefined",
                ));
            };
            let core_target = state.core.target().await;
            match crate::native::task_stop_sync::http_probe(core_target.clone(), id).await {
                Ok(probe) if crate::native::task_stop_sync::task_stop_stays_forwarded(&probe) => {
                    let Some(target) = core_target else {
                        return proxy::unavailable(false);
                    };
                    return proxy::forward(
                        Request::from_parts(parts, Body::from(bytes)),
                        target,
                        auth,
                    )
                    .await;
                }
                Ok(probe) => Some(probe),
                Err(error) => return native_error(error),
            }
        } else {
            None
        };
        let result = if op.name.starts_with("plugin.") {
            if std::env::var("PACER_DEBUG_NATIVE").as_deref() == Ok("1") {
                eprintln!("native {}", op.name);
            }
            // Reads, X3 mutations, and retired install share the HTTP plugin service.
            // Flag-on ProcessOwner (when present) starts children; Core supplies specs.
            let state = Arc::clone(&state);
            let name = op.name;
            match tokio::spawn(async move {
                let core = crate::native::plugins::http_link(&state.core);
                state.plugins.call(&ctx, core, name, params).await
            })
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
                let broker_params = crate::native::usage_broker_params(op.name, &params);
                state.core.target().await.map(|target| {
                    Box::pin(crate::native::status_sync::http(
                        Some(target),
                        broker_params,
                    )) as pacer_foundation::api::OpFuture<'_>
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
            let task_read_sync = if crate::native::needs_task_read_bridge(op.name) {
                let id = params
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                state.core.target().await.map(|target| {
                    let id = id.clone();
                    Box::pin(
                        async move { crate::native::task_read_sync::http(Some(target), &id).await },
                    ) as pacer_foundation::api::OpFuture<'_>
                })
            } else {
                None
            };
            let config_host_sync = if crate::native::needs_config_host_bridge(op.name) {
                state.core.target().await.map(|target| {
                    Box::pin(crate::native::config_host_sync::http(Some(target)))
                        as pacer_foundation::api::OpFuture<'_>
                })
            } else {
                None
            };
            let snapshot_sync = if crate::native::needs_snapshot_bridge(op.name) {
                state.core.target().await.map(|target| {
                    Box::pin(crate::native::snapshot_sync::http(Some(target)))
                        as pacer_foundation::api::OpFuture<'_>
                })
            } else {
                None
            };
            let task_clean_sync = if crate::native::needs_task_clean_bridge(op.name) {
                match crate::native::task_dismiss_ops::ids_from_params(&params) {
                    Ok(ids) => state.core.target().await.map(|target| {
                        Box::pin(async move {
                            crate::native::task_clean_sync::http(Some(target), &ids).await
                        }) as pacer_foundation::api::OpFuture<'_>
                    }),
                    Err(error) => return native_error(error),
                }
            } else {
                None
            };
            let host_read_sync = if crate::native::needs_host_read_injection(op.name) {
                let alias = if matches!(op.name, "host.get" | "host.set") {
                    params
                        .get("alias")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                } else {
                    None
                };
                state.core.target().await.map(|target| {
                    let alias = alias.clone();
                    Box::pin(async move {
                        crate::native::host_read_sync::http(Some(target), alias.as_deref()).await
                    }) as pacer_foundation::api::OpFuture<'_>
                })
            } else {
                None
            };
            let core_bridge_sync = if crate::native::needs_core_bridge(op.name) {
                match crate::native::p8_bridge_ops::bridge_params(op.name, &params) {
                    Ok(mut bridge_params) => {
                        if op.name == "setup.check"
                            && let serde_json::Value::Object(map) = &mut bridge_params
                        {
                            map.insert("snapshotProbe".into(), serde_json::json!(false));
                        }
                        if crate::native::setup_doctor_sync::routes(op.name) {
                            bridge_params =
                                crate::native::setup_doctor_sync::serve_body(bridge_params);
                        }
                        let op_name = op.name.to_owned();
                        state.core.target().await.map(|target| {
                            let bridge_params = bridge_params.clone();
                            Box::pin(async move {
                                crate::native::core_bridge_sync::http(
                                    Some(target),
                                    &op_name,
                                    bridge_params,
                                )
                                .await
                            }) as pacer_foundation::api::OpFuture<'_>
                        })
                    }
                    Err(error) => return native_error(error),
                }
            } else if crate::native::needs_account_list_bridge(op.name) {
                state.core.target().await.map(|target| {
                    Box::pin(crate::native::account_list_sync::http(Some(target)))
                        as pacer_foundation::api::OpFuture<'_>
                })
            } else if crate::native::needs_host_effects(op.name) {
                let request =
                    serde_json::json!({"request": {"kind": op.name, "params": params.clone()}});
                Some(Box::pin(crate::native::core_bridge_sync::http(
                    state.core.target().await,
                    "host.effects",
                    request,
                )) as pacer_foundation::api::OpFuture<'_>)
            } else {
                None
            };
            let task_stop_effects = if task_stop_probe_cache.is_some() {
                let id = params
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let before = task_stop_probe_cache
                    .as_ref()
                    .and_then(|probe| probe.get("beforeState"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
                state.core.target().await.map(|target| {
                    let id = id.clone();
                    let before = before.clone();
                    Box::pin(async move {
                        crate::native::task_stop_sync::http_effects(
                            Some(target),
                            &id,
                            before.as_deref(),
                        )
                        .await
                    }) as pacer_foundation::api::OpFuture<'_>
                })
            } else {
                None
            };
            let task_review_effects = if task_review_probe_cache.is_some() {
                let id = params
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let verdict = params
                    .get("verdict")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let kind = params
                    .get("kind")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
                let note = params
                    .get("note")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
                state.core.target().await.map(|target| {
                    let id = id.clone();
                    let verdict = verdict.clone();
                    let kind = kind.clone();
                    let note = note.clone();
                    Box::pin(async move {
                        crate::native::task_review_sync::http_effects(
                            Some(target),
                            &id,
                            &verdict,
                            kind.as_deref(),
                            note.as_deref(),
                        )
                        .await
                    }) as pacer_foundation::api::OpFuture<'_>
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
                task_read_sync,
                config_host_sync,
                snapshot_sync,
                task_clean_sync,
                host_read_sync,
                core_bridge_sync,
                task_stop_probe_cache,
                task_stop_effects,
                task_review_probe_cache,
                task_review_effects,
                None,
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
    let path = req.uri().path();
    if !state.scoped_work
        && !state.forward_events
        && auth != auth::AuthKind::Task
        && (path == "/v3/events" || path == "/v2/events")
    {
        if req.method() != axum::http::Method::GET {
            return native_json(
                StatusCode::METHOD_NOT_ALLOWED,
                CoreError::new(Code::InvalidInput, "method not allowed").body(),
            );
        }
        let protocol = if path == "/v3/events" { 3 } else { 2 };
        let last_event_id = header_value(req.headers(), "last-event-id");
        let since = req.uri().query().and_then(|query| {
            form_urlencoded::parse(query.as_bytes())
                .find(|(key, _)| key == "since")
                .map(|(_, value)| value.into_owned())
        });
        if std::env::var("PACER_DEBUG_NATIVE").as_deref() == Ok("1") {
            eprintln!("native http.events");
        }
        return events_sse::stream(
            ctx,
            protocol,
            last_event_id.as_deref(),
            since.as_deref(),
            250,
        )
        .await;
    }
    if let Some(response) = app_assets::route(&req) {
        return response;
    }
    let Some(target) = state.core.target().await else {
        return proxy::unavailable(path.starts_with("/app/"));
    };
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

/// In-process dispatch that runs each native control `op` through the front
/// door's router, carrying the desktop client identity the server's origin
/// check requires. The control socket never makes its own routing decisions.
#[cfg(target_os = "macos")]
struct NativeControlDispatch {
    state: Arc<Listener>,
    token: String,
}

/// Reproduces the desktop's app-identity origin check for a synthesized
/// control request (the same `callOp` path the desktop uses).
#[cfg(target_os = "macos")]
fn client_header(identity: &Identity) -> Option<String> {
    if identity.client_id.is_empty() {
        None
    } else {
        Some(identity.client_id.clone())
    }
}

#[cfg(target_os = "macos")]
impl Dispatch for NativeControlDispatch {
    async fn call_op(&self, identity: &Identity, op: &str, params: Value) -> Result<Value, Value> {
        let uri = format!("/v3/ops/{op}");
        let mut request = Request::builder()
            .method(axum::http::Method::POST)
            .uri(uri)
            .header("authorization", format!("Bearer {}", self.token))
            .header("x-pacer-client", "app")
            .header("content-type", "application/json");
        if let Some(instance) = client_header(identity) {
            request = request.header("x-pacer-client-instance", instance);
        }
        let request = match request
            .body(Body::from(serde_json::to_vec(&params).unwrap_or_default()))
        {
            Ok(request) => request,
            Err(_) => {
                return Err(
                    json!({"error": {"code": "internal_error", "message": "request synthesis failed"}}),
                );
            }
        };
        let response = handle(State(self.state.clone()), request).await;
        response_to_value(response).await
    }
    async fn subscribe(
        &self,
        _identity: &Identity,
        since: f64,
    ) -> Result<mpsc::Receiver<Value>, Value> {
        let (tx, rx) = mpsc::channel(64);
        let state = self.state.clone();
        tokio::spawn(async move {
            subscribe_poll(state, since, tx).await;
        });
        Ok(rx)
    }
}

/// Convert a front-door `Response` into the native control `op` result. A
/// success carries `result`; anything else is surfaced as an error body.
async fn response_to_value(response: Response) -> Result<Value, Value> {
    let (parts, body) = response.into_parts();
    let bytes = match axum::body::to_bytes(body, 4 * 1024 * 1024).await {
        Ok(bytes) if bytes.len() <= 4 * 1024 * 1024 => bytes,
        _ => {
            return Err(
                json!({"error": {"code": "internal_error", "message": "oversized response"}}),
            );
        }
    };
    let value: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(null));
    let status = parts.status;
    if status.is_success() && value.get("result").is_some() {
        Ok(value["result"].clone())
    } else if let Some(error) = value.get("error") {
        Err(error.clone())
    } else {
        Err(value)
    }
}

/// Poll the shared outbox read model at-or-after `since`, forwarding each
/// event batch to the control subscriber until the channel closes.
async fn subscribe_poll(state: Arc<Listener>, mut since: f64, tx: mpsc::Sender<Value>) {
    let ctx = state.ctx.clone();
    let zone = events_sse::local_zone(&ctx);
    let store = match tokio::task::spawn_blocking({
        let home = ctx.pacer_home.clone();
        move || pacer_store::TaskStore::open(&home)
    })
    .await
    {
        Ok(Ok(store)) => Arc::new(std::sync::Mutex::new(store)),
        _ => return,
    };
    loop {
        if tx.is_closed() {
            return;
        }
        let ctx = ctx.at_now();
        let polled = tokio::task::spawn_blocking({
            let ctx = ctx.clone();
            let store = store.clone();
            move || {
                let mut store = store.lock().unwrap_or_else(|error| error.into_inner());
                pacer_read_model::events::events_since(
                    &ctx,
                    since,
                    3,
                    &mut store,
                    zone,
                    &events_sse::pid_alive,
                )
                .map(|value| (since, value))
            }
        })
        .await;
        let batch = match polled {
            Ok(Ok((old, value))) => {
                since = value.get("last").and_then(Value::as_f64).unwrap_or(old);
                value
            }
            _ => return,
        };
        if let Some(events) = batch.get("events").and_then(Value::as_array) {
            for event in events {
                if tx.send(event.clone()).await.is_err() {
                    return;
                }
            }
        }
        if tx.is_closed() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
}

/// Verifies an accepted control peer before any session is created or any
/// frame is dispatched, reproducing the desktop's `verifyPeer` kernel
/// audit-token check: the peer must be a live process owned by this uid.
#[cfg(target_os = "macos")]
struct NativeControlGuard;

#[cfg(target_os = "macos")]
impl Guard for NativeControlGuard {
    async fn verify_peer(&self, peer: &Peer, hello: &Hello) -> Result<Identity, String> {
        let Some(audit) = peer.audit_token() else {
            return Err("peer token unavailable".to_owned());
        };
        // Darwin's struct local_peer: uid at offset 4, pid at offset 20.
        if audit.len() != 32 {
            return Err("peer token malformed".to_owned());
        }
        let pid = u32::from_le_bytes([audit[20], audit[21], audit[22], audit[23]]);
        let uid = u32::from_le_bytes([audit[4], audit[5], audit[6], audit[7]]);
        if pid == 0 {
            return Err("peer token has no pid".to_owned());
        }
        let Ok(details) = pacer_desktop_native::native_trust::process_details(pid) else {
            return Err("peer process unavailable".to_owned());
        };
        if details.uid != nix::unistd::getuid().as_raw() || uid != details.uid {
            return Err("peer uid mismatch".to_owned());
        }
        Ok(Identity {
            role: hello.role.clone(),
            client_id: hello.client_id.clone(),
            audit: Some(*audit),
        })
    }
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
    let forward_events = forward
        .split(',')
        .any(|name| js_trim::js_trim(name) == "*" || js_trim::js_trim(name) == "http.events");
    let token = auth::ensure_token(&ctx)?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let port = listener.local_addr()?.port();
    // The internal HTTP listener binds independently. Its desktop integration
    // still needs the actual public port, including explicit/ephemeral binds.
    env.insert("PACER_PORT".into(), port.to_string());
    // Flag-on P4d-1/P4d-4 path: claim ProcessOwner + reverse bridge before Core
    // spawn so the child inherits PACER_HOST_SOCKET and HTTP plugin RPC can use
    // the same owner. Default (flags unset) is a no-op.
    let native_host = native_host::maybe_start(&ctx.pacer_home, &mut env).await?;
    let plugins = match &native_host {
        Some(host) => crate::native::plugins::Service::with_native_owner(host.owner()),
        None => crate::native::plugins::Service::default(),
    };
    // Native operations and the core must observe the same configuration environment.
    ctx.env = env.clone();
    // Runtime environment cannot turn a generic front door into a native owner.
    env.remove("PACER_INTERNAL_NATIVE_BOOTSTRAP");
    // The owner's credential reaches the Core child alone, on its stdin.
    let owner_key = native_host.as_ref().map(native_host::Guard::owner_key);
    #[cfg(target_os = "macos")]
    let native =
        native_context::NativeContext::prepare(&ctx.pacer_home, port, &core, _version, &_argv)?;
    #[cfg(target_os = "macos")]
    let _native_socket_watch = native.as_ref().map(|native| native.spawn_socket_watch());
    if std::env::var("PACER_SERVE_ANNOUNCE").as_deref() == Ok("1") {
        println!("{}", serde_json::json!({"port":port}));
    }
    crate::core_process::record_serve(&env);
    #[cfg(target_os = "macos")]
    let core = Arc::new(match &native {
        Some(native) => core_child::CoreChild::spawn_native(core, env, owner_key, native.clone()),
        None => core_child::CoreChild::spawn(core, env, owner_key),
    });
    #[cfg(not(target_os = "macos"))]
    let core = Arc::new(core_child::CoreChild::spawn(core, env, owner_key));
    if let Some(host) = &native_host {
        let core = core.clone();
        let link = move || {
            let core = core.clone();
            async move { crate::native::plugins::http_link(&core).await }
        };
        tokio::spawn(crate::native::plugins::deliver_crashes(
            host.crash_reports(),
            link.clone(),
        ));
        tokio::spawn(crate::native::plugins::deliver_door_requests(
            host.door_requests(),
            link,
        ));
    }
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
        forward_events,
    });
    // The native desktop control socket serves directly on the published
    // listener (a duplicate; the original goes to Core) only when the
    // default-off flag is set. Default is a no-op and the P-byte handoff is
    // preserved untouched.
    #[cfg(target_os = "macos")]
    let native_control = if std::env::var("PACER_NATIVE_DESKTOP_CONTROL").as_deref() == Ok("1") {
        match &native {
            Some(native) => {
                let listener = native.control_listener();
                match listener {
                    Ok(listener) => {
                        let server = ControlServer::new(
                            listener,
                            "pacer".to_owned(),
                            _version.to_owned(),
                            port,
                            NativeControlDispatch {
                                state: state.clone(),
                                token: state.token.clone(),
                            },
                            NativeControlGuard,
                        );
                        Some(server.serve())
                    }
                    Err(error) => {
                        eprintln!("pacer: native control listener unavailable: {error}");
                        None
                    }
                }
            }
            None => None,
        }
    } else {
        None
    };
    #[cfg(not(target_os = "macos"))]
    let native_control: Option<tokio::task::JoinHandle<()>> = None;
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
    // Stop the native desktop control server (when the flag was on).
    if let Some(handle) = native_control {
        handle.abort();
        let _ = handle.await;
    }
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
            native_host::exit_code(&error)
        }
    }
}
