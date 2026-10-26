//! Called only after the public listener's authentication decision.
use crate::native::Dispatcher;
use axum::{
    body::{Body, Bytes, to_bytes},
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::{StreamExt, stream};
use pacer_foundation::{
    Ctx,
    api::error::{Code, CoreError},
};
use serde_json::{Value, json};

const MAX_DISCOVERY_BYTES: usize = 1024 * 1024;

fn response(status: u16, body: Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [
            ("content-type", "application/json;charset=utf-8"),
            ("x-pacer", "1"),
        ],
        body.to_string(),
    )
        .into_response()
}
fn error(error: CoreError) -> Response {
    response(error.http_status(), error.body())
}
/// Return the original request untouched when the core still owns it.
// Preserve the original request without boxing every forwarded HTTP call.
#[allow(clippy::result_large_err)]
pub async fn handle(
    req: Request<Body>,
    dispatcher: &Dispatcher,
    ctx: &Ctx,
    auth: super::auth::AuthKind,
) -> Result<Response, Request<Body>> {
    // The core still enforces task grants and the cookie session's restricted
    // operation set. Native selection is limited to the full bearer authority.
    if auth != super::auth::AuthKind::Bearer {
        return Err(req);
    }
    let Some(name) = req.uri().path().strip_prefix("/v3/ops/") else {
        return Err(req);
    };
    if !dispatcher.names().contains(&name) || dispatcher.needs_core_parser(ctx, name) {
        return Err(req);
    }
    let name = name.to_owned();
    if req.method() != "POST" {
        return Ok(response(
            405,
            json!({"error":{"code":"invalid_input","message":"method not allowed"}}),
        ));
    }
    if req
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<f64>().ok())
        .is_some_and(|v| v > 262144.0)
    {
        return Ok(error(CoreError::new(
            Code::TooLarge,
            "body exceeds 256 KiB",
        )));
    }
    let bytes = match to_bytes(req.into_body(), 256 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return Ok(error(CoreError::new(
                Code::TooLarge,
                "body exceeds 256 KiB",
            )));
        }
    };
    // TextDecoder in the core replaces malformed UTF-8 before JSON parsing.
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let params = match serde_json::from_str(text) {
        Ok(params) => params,
        Err(_) => {
            return Ok(error(CoreError::new(
                Code::InvalidInput,
                "body is not JSON",
            )));
        }
    };
    match dispatcher.call(ctx, &name, params).await {
        Some(Ok(value)) => Ok(response(200, json!({"result":value}))),
        Some(Err(value)) => Ok(error(value)),
        None => Ok(error(CoreError::new(
            Code::Internal,
            "native operation unavailable",
        ))),
    }
}
/// Merge discovery only for the selected synthetic/native surface; default
/// production forwarding keeps the core's original response bytes.
pub async fn decorate(
    response: Response,
    dispatcher: &Dispatcher,
    hello: bool,
    operation: bool,
) -> Response {
    if dispatcher.names().is_empty() || (!hello && !operation) {
        return response;
    }
    if !hello && response.status() != StatusCode::NOT_FOUND {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let mut source = body.into_data_stream();
    let mut captured: Vec<Result<Bytes, axum::Error>> = Vec::new();
    let mut size = 0usize;
    while let Some(frame) = source.next().await {
        match frame {
            Ok(bytes) => {
                size = size.saturating_add(bytes.len());
                captured.push(Ok(bytes));
                if size > MAX_DISCOVERY_BYTES {
                    return Response::from_parts(
                        parts,
                        Body::from_stream(stream::iter(captured).chain(source)),
                    );
                }
            }
            Err(error) => {
                captured.push(Err(error));
                return Response::from_parts(
                    parts,
                    Body::from_stream(stream::iter(captured).chain(source)),
                );
            }
        }
    }
    let bytes: Vec<u8> = captured
        .into_iter()
        .filter_map(Result::ok)
        .flat_map(|bytes| bytes.to_vec())
        .collect();
    if let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) {
        if hello {
            dispatcher.decorate_hello(&mut value);
        }
        if let Some(hint) = value.pointer_mut("/error/hint") {
            dispatcher.decorate_hint(hint);
        }
        parts.headers.remove("content-length");
        return Response::from_parts(parts, Body::from(value.to_string()));
    }
    Response::from_parts(parts, Body::from(bytes))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use axum::body::to_bytes;
    use serde_json::json;
    #[cfg(feature = "test-ops")]
    #[tokio::test]
    async fn unverified_task_grant_keeps_core_ownership() {
        let dispatcher = crate::native::Dispatcher::new("");
        let ctx = pacer_foundation::Ctx::from_env();
        let request = Request::builder()
            .method("POST")
            .uri("/v3/ops/test.echo")
            .body(Body::from("{}"))
            .unwrap();
        assert!(
            handle(
                request,
                &dispatcher,
                &ctx,
                crate::serve::auth::AuthKind::Task
            )
            .await
            .is_err()
        );
    }
    #[cfg(feature = "test-ops")]
    #[tokio::test]
    async fn cookie_session_keeps_core_operation_policy() {
        let dispatcher = crate::native::Dispatcher::new("");
        let ctx = pacer_foundation::Ctx::from_env();
        let request = Request::builder()
            .method("POST")
            .uri("/v3/ops/test.echo")
            .body(Body::from("{}"))
            .unwrap();
        assert!(
            handle(
                request,
                &dispatcher,
                &ctx,
                crate::serve::auth::AuthKind::Cookie
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn surrogate_bearing_settings_keep_http_request_with_core() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let settings = home.join("settings.json");
        let content = r#"{"0":"\ud83d","1":"\ude00","notifications":"important"}"#;
        std::fs::write(&settings, content).unwrap();
        let ctx = Ctx::with(
            dir.path().to_path_buf(),
            home,
            std::collections::HashMap::new(),
            0.0,
        );
        let dispatcher = crate::native::Dispatcher::new("");
        let request = Request::builder()
            .method("POST")
            .uri("/v3/ops/notifications.get")
            .body(Body::from("{}"))
            .unwrap();
        let returned = handle(
            request,
            &dispatcher,
            &ctx,
            crate::serve::auth::AuthKind::Bearer,
        )
        .await
        .err()
        .unwrap();
        assert_eq!(returned.uri().path(), "/v3/ops/notifications.get");
        assert_eq!(to_bytes(returned.into_body(), 8).await.unwrap(), "{}");
        assert_eq!(std::fs::read_to_string(settings).unwrap(), content);
    }
    #[cfg(feature = "test-ops")]
    #[tokio::test]
    async fn native_http_preserves_envelopes_and_body_limits() {
        let dispatcher = crate::native::Dispatcher::new("");
        let ctx = pacer_foundation::Ctx::from_env();
        for (body, status, expected) in [
            (
                b"{\"ok\":true}".to_vec(),
                200,
                json!({"result":{"ok":true}}),
            ),
            (b"\xef\xbb\xbf{}".to_vec(), 200, json!({"result":{}})),
            (
                b"{\"text\":\"\xff\"}".to_vec(),
                200,
                json!({"result":{"text":"\u{fffd}"}}),
            ),
            (
                b"invalid".to_vec(),
                400,
                json!({"error":{"code":"invalid_input","message":"body is not JSON"}}),
            ),
            (
                vec![0; 262145],
                413,
                json!({"error":{"code":"too_large","message":"body exceeds 256 KiB"}}),
            ),
        ] {
            let request = axum::http::Request::builder()
                .method("POST")
                .uri("/v3/ops/test.echo")
                .body(axum::body::Body::from(body))
                .unwrap();
            let response = handle(
                request,
                &dispatcher,
                &ctx,
                crate::serve::auth::AuthKind::Bearer,
            )
            .await
            .unwrap();
            assert_eq!(response.status().as_u16(), status);
            assert_eq!(response.headers()["x-pacer"], "1");
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(
                    &to_bytes(response.into_body(), usize::MAX).await.unwrap()
                )
                .unwrap(),
                expected
            );
        }
        let chunks = futures_util::stream::iter(
            [b"\xef".as_slice(), b"\xbb", b"\xbf{}"]
                .map(|chunk| Ok::<_, std::io::Error>(axum::body::Bytes::copy_from_slice(chunk))),
        );
        let request = Request::builder()
            .method("POST")
            .uri("/v3/ops/test.echo")
            .body(Body::from_stream(chunks))
            .unwrap();
        let response = handle(
            request,
            &dispatcher,
            &ctx,
            crate::serve::auth::AuthKind::Bearer,
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(
                &to_bytes(response.into_body(), usize::MAX).await.unwrap()
            )
            .unwrap(),
            json!({"result":{}})
        );
        for path in ["/v2/ops/test.echo", "/v3/ops/unmoved"] {
            let request = axum::http::Request::builder()
                .method("POST")
                .uri(path)
                .body(axum::body::Body::from("{}"))
                .unwrap();
            assert!(
                handle(
                    request,
                    &dispatcher,
                    &ctx,
                    crate::serve::auth::AuthKind::Bearer
                )
                .await
                .is_err()
            );
        }
    }
    #[tokio::test]
    async fn native_errors_project_all_fourteen_codes() {
        let dispatcher = crate::native::error_dispatcher();
        let ctx = pacer_foundation::Ctx::from_env();
        for (code, status) in [
            ("unknown_op", 404),
            ("unknown_task", 404),
            ("invalid_input", 400),
            ("unknown_executor", 404),
            ("conflict", 409),
            ("not_allowed", 403),
            ("not_found", 404),
            ("too_large", 413),
            ("internal", 500),
            ("plugin_timeout", 504),
            ("plugin_unavailable", 503),
            ("plugin_refused", 422),
            ("capability_denied", 403),
            ("unknown_plugin", 404),
        ] {
            let request = Request::builder()
                .method("POST")
                .uri("/v3/ops/test.error")
                .body(Body::from(json!(code).to_string()))
                .unwrap();
            let response = handle(
                request,
                &dispatcher,
                &ctx,
                crate::serve::auth::AuthKind::Bearer,
            )
            .await
            .unwrap();
            assert_eq!(response.status().as_u16(), status);
            let body: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            assert_eq!(
                body,
                json!({"error":{"code":code,"message":"message","hint":"retry","data":{"detail":true}}})
            );
        }
    }
    #[tokio::test]
    async fn discovery_decoration_preserves_large_forwarded_bodies() {
        let dispatcher = crate::native::Dispatcher::new("");
        let payload = "x".repeat(MAX_DISCOVERY_BYTES + 1);
        let original = Response::builder()
            .status(StatusCode::OK)
            .header("content-length", payload.len())
            .body(Body::from_stream(stream::iter([
                Ok::<_, std::io::Error>(Bytes::copy_from_slice(&payload.as_bytes()[..17])),
                Ok(Bytes::copy_from_slice(&payload.as_bytes()[17..])),
            ])))
            .unwrap();
        let decorated = decorate(original, &dispatcher, true, false).await;
        assert_eq!(decorated.status(), StatusCode::OK);
        assert_eq!(
            decorated.headers()["content-length"],
            payload.len().to_string()
        );
        assert_eq!(
            to_bytes(decorated.into_body(), MAX_DISCOVERY_BYTES + 2)
                .await
                .unwrap(),
            payload.as_bytes()
        );
    }
}
