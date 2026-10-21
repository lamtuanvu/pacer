//! Streaming HTTP forwarding to the current core generation.
use super::auth::AuthKind;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
};
use http_body_util::BodyExt;
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};

/// One pooled client, so requests reuse loopback connections to the core.
fn client() -> &'static Client<HttpConnector, Body> {
    static CLIENT: std::sync::OnceLock<Client<HttpConnector, Body>> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| Client::builder(TokioExecutor::new()).build_http())
}
pub fn unavailable(app: bool) -> Response {
    if app {
        (
            StatusCode::BAD_GATEWAY,
            axum::response::Html("<!doctype html><p>pacer core is restarting\n</p>"),
        )
            .into_response()
    } else {
        (StatusCode::BAD_GATEWAY, "pacer core is restarting\n").into_response()
    }
}
pub fn headers(
    headers: &mut axum::http::HeaderMap,
    token: &str,
    auth: AuthKind,
) -> Result<(), axum::http::header::InvalidHeaderValue> {
    headers.remove("authorization");
    headers.remove("cookie");
    headers.insert("authorization", format!("Bearer {token}").parse()?);
    headers.insert(
        "x-pacer-auth",
        match auth {
            AuthKind::Bearer => "bearer",
            AuthKind::Cookie => "cookie",
        }
        .parse()?,
    );
    Ok(())
}
pub async fn forward(mut req: Request<Body>, target: (u16, String), auth: AuthKind) -> Response {
    let app = req.uri().path().starts_with("/app/");
    let path = req.uri().path();
    if req.method() == "POST" && (path.starts_with("/v2/ops/") || path.starts_with("/v3/ops/")) {
        let (parts, body) = req.into_parts();
        let body = match to_bytes(body, 256 * 1024).await {
            Ok(body) => body,
            Err(_) => return (StatusCode::PAYLOAD_TOO_LARGE, axum::Json(serde_json::json!({"error":{"code":"too_large","message":"body exceeds 256 KiB"}}))).into_response(),
        };
        req = Request::from_parts(parts, Body::from(body));
    }
    let uri = format!(
        "http://127.0.0.1:{}{}",
        target.0,
        req.uri().path_and_query().map_or("/", |p| p.as_str())
    );
    let Ok(uri) = uri.parse() else {
        return unavailable(app);
    };
    *req.uri_mut() = uri;
    if let Ok(host) = format!("127.0.0.1:{}", target.0).parse() {
        req.headers_mut().insert("host", host);
    }
    if headers(req.headers_mut(), &target.1, auth).is_err() {
        return unavailable(app);
    }
    match client().request(req).await {
        Ok(response) => {
            let (parts, body) = response.into_parts();
            Response::from_parts(parts, Body::from_stream(body.into_data_stream()))
        }
        Err(_) => unavailable(app),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn internal_credentials_replace_all_client_credentials() {
        let mut request = Request::builder()
            .header("authorization", "Bearer public")
            .header("cookie", "pacer_session=private")
            .header("x-pacer-auth", "forged")
            .header("origin", "http://localhost:4317")
            .body(())
            .unwrap();
        headers(request.headers_mut(), "internal", AuthKind::Cookie).unwrap();
        assert_eq!(request.headers()["authorization"], "Bearer internal");
        assert_eq!(request.headers()["x-pacer-auth"], "cookie");
        assert!(!request.headers().contains_key("cookie"));
        assert_eq!(request.headers()["origin"], "http://localhost:4317");
    }
    #[tokio::test]
    async fn oversized_operations_return_core_error_before_connecting() {
        let request = Request::builder()
            .method("POST")
            .uri("/v3/ops/version.get")
            .body(Body::from(vec![0; 300 * 1024]))
            .unwrap();
        let response = forward(request, (1, "secret".into()), AuthKind::Bearer).await;
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({"error":{"code":"too_large","message":"body exceeds 256 KiB"}})
        );
    }
}
