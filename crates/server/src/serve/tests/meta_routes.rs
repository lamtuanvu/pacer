#![allow(clippy::unwrap_used)]
use super::*;
use axum::http::Method;
use http_body_util::BodyExt;
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use std::collections::HashMap;
use std::time::Duration;

const NOW: f64 = 1_000.0;

/// A booted public door on an ephemeral port over `home`. `forward_*` selects
/// which meta routes fall through to the (absent) core's proxy.
async fn listener(
    home: &std::path::Path,
    core: Arc<core_child::CoreChild>,
    forward_hello: bool,
    forward_snapshot: bool,
    forward_exchange: bool,
) -> (u16, tokio::task::JoinHandle<()>) {
    let socket = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let port = socket.local_addr().unwrap().port();
    let ctx = Ctx::with(home.into(), home.join("pacer"), Default::default(), NOW);
    let core_build = Arc::new(meta_routes::CoreBuild::from_core(&[], &HashMap::new()));
    let snapshot_cache = meta_routes::snapshot_cache(core.clone(), ctx.clone());
    let state = Arc::new(Listener {
        core,
        heartbeat: Arc::new(heartbeat::Heartbeat::new()),
        ctx,
        port,
        token: "test-token".into(),
        registry: service_registry(""),
        scoped_work: false,
        plugins: crate::native::plugins::Service::default(),
        forward_log_follow: false,
        forward_events: false,
        core_build,
        snapshot_cache,
        forward_hello,
        forward_snapshot,
        forward_session_exchange: forward_exchange,
    });
    let app = Router::new().fallback(any(handle)).with_state(state);
    let server = tokio::spawn(async move {
        axum::serve(socket, app).await.unwrap();
    });
    (port, server)
}

fn client() -> Client<HttpConnector, String> {
    Client::builder(TokioExecutor::new()).build_http()
}

fn request(
    port: u16,
    method: Method,
    path: &str,
    headers: &[(&str, &str)],
) -> hyper::Request<String> {
    let mut builder = hyper::Request::builder()
        .method(method)
        .uri(format!("http://127.0.0.1:{port}{path}"))
        .header("host", format!("127.0.0.1:{port}"));
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(String::new()).unwrap()
}

fn request_post(
    port: u16,
    path: &str,
    body: &str,
    headers: &[(&str, &str)],
) -> hyper::Request<String> {
    let mut builder = hyper::Request::builder()
        .method(Method::POST)
        .uri(format!("http://127.0.0.1:{port}{path}"))
        .header("host", format!("127.0.0.1:{port}"))
        .header("content-type", "application/json");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(body.to_owned()).unwrap()
}

async fn body_json(response: hyper::Response<hyper::body::Incoming>) -> serde_json::Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

async fn get_json(port: u16, path: &str, headers: &[(&str, &str)]) -> serde_json::Value {
    body_json(
        client()
            .request(request(port, Method::GET, path, headers))
            .await
            .unwrap(),
    )
    .await
}

#[tokio::test]
async fn hello_answers_without_core() {
    let home = tempfile::tempdir().unwrap();
    let (port, server) = listener(
        home.path(),
        Arc::new(core_child::CoreChild::unavailable()),
        false,
        false,
        false,
    )
    .await;
    let unauthorized = client()
        .request(request(port, Method::GET, "/v3/hello", &[]))
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    let response = client()
        .request(request(
            port,
            Method::GET,
            "/v3/hello",
            &[("authorization", "Bearer test-token")],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["x-pacer"], "1");
    let body = body_json(response).await;
    // No core: `pacer` is always present, `coreBuild` is omitted (parity with
    // native-stdio-request-id-parity), and the v3 projection is served.
    assert!(body.get("pacer").is_some());
    assert!(body.get("coreBuild").is_none());
    assert_eq!(body["protocol"], "3.0.0");
    server.abort();
}

#[tokio::test]
async fn snapshot_reports_starting_before_the_first_status() {
    let home = tempfile::tempdir().unwrap();
    let (port, server) = listener(
        home.path(),
        Arc::new(core_child::CoreChild::unavailable()),
        false,
        false,
        false,
    )
    .await;
    let response = client()
        .request(request(
            port,
            Method::GET,
            "/v3/snapshot",
            &[("authorization", "Bearer test-token")],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["x-pacer"], "1");
    let body = body_json(response).await;
    assert_eq!(body["protocol"], "3.0.0");
    // The core's first status is not in yet, so the wire must report starting.
    assert_eq!(body["snapshot"]["service"]["starting"], true);
    server.abort();
}

#[tokio::test]
async fn snapshot_serves_stale_within_one_second_and_rebuilds_after() {
    let home = tempfile::tempdir().unwrap();
    let (port, server) = listener(
        home.path(),
        Arc::new(core_child::CoreChild::unavailable()),
        false,
        false,
        false,
    )
    .await;
    let auth = &[("authorization", "Bearer test-token")];
    let first = get_json(port, "/v3/snapshot", auth).await;
    // Within the one-second max age a second read is satisfied from the cache
    // with the same sequence, without rebuilding.
    let warm = get_json(port, "/v3/snapshot", auth).await;
    assert_eq!(first["seq"], warm["seq"]);
    // Past the max age the door still answers from a fresh build.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let rebuilt = get_json(port, "/v3/snapshot", auth).await;
    assert_eq!(rebuilt["snapshot"]["service"]["starting"], true);
    server.abort();
}

#[tokio::test]
async fn session_exchange_sets_the_cookie_and_refuses_cookie_callers() {
    let home = tempfile::tempdir().unwrap();
    let (port, server) = listener(
        home.path(),
        Arc::new(core_child::CoreChild::unavailable()),
        false,
        false,
        false,
    )
    .await;
    let response = client()
        .request(request(
            port,
            Method::POST,
            "/v3/session/exchange",
            &[("authorization", "Bearer test-token")],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["x-pacer"], "1");
    let cookie = response.headers()["set-cookie"].to_str().unwrap();
    assert!(cookie.starts_with("pacer_session="), "{cookie}");
    assert!(cookie.contains("HttpOnly"), "{cookie}");
    assert!(cookie.contains("SameSite=Strict"), "{cookie}");
    assert!(cookie.contains("Path=/"), "{cookie}");
    // A GET is refused (POST only).
    let wrong_method = client()
        .request(request(
            port,
            Method::GET,
            "/v3/session/exchange",
            &[("authorization", "Bearer test-token")],
        ))
        .await
        .unwrap();
    assert_eq!(wrong_method.status(), StatusCode::METHOD_NOT_ALLOWED);
    server.abort();

    // A cookie caller holding a fresh session is still refused (auth.rs:213).
    let ctx = Ctx::with(
        home.path().into(),
        home.path().join("pacer"),
        Default::default(),
        NOW,
    );
    let session = sessions::create(&ctx.at_now()).unwrap();
    assert!(
        sessions::check(&ctx.at_now(), &session).unwrap(),
        "test session must validate before the HTTP round-trip"
    );
    let (port, server) = listener(
        home.path(),
        Arc::new(core_child::CoreChild::unavailable()),
        false,
        false,
        false,
    )
    .await;
    let response = client()
        .request(request(
            port,
            Method::POST,
            "/v3/session/exchange",
            &[("cookie", &format!("pacer_session={session}"))],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    server.abort();
}

#[tokio::test]
async fn mode_hold_refreshes_the_snapshot_cache() {
    let home = tempfile::tempdir().unwrap();
    let (port, server) = listener(
        home.path(),
        Arc::new(core_child::CoreChild::unavailable()),
        false,
        false,
        false,
    )
    .await;
    // Warm the snapshot cache so a later read would otherwise serve stale.
    let auth = &[("authorization", "Bearer test-token")];
    assert_eq!(
        get_json(port, "/v3/snapshot", auth).await["snapshot"]["service"]["starting"],
        true
    );
    // `mode.hold` writes state/mode-hold.json and must return ok for the door
    // to refresh the snapshot cache (mod.rs). A future `until` keeps it native.
    let until = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
        + 86_400.0) as u64;
    let response = client()
        .request(request_post(
            port,
            "/v3/ops/mode.hold",
            &serde_json::json!({"mode": "normal", "until": until}).to_string(),
            auth,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let result = body_json(response).await;
    assert_eq!(result["result"]["mode"], "normal");
    assert_eq!(result["result"]["until"], serde_json::json!(until));
    // The hold is on disk; a refreshed snapshot must still answer (with Core
    // unavailable the wire stays in the starting projection).
    assert!(
        home.path().join("pacer/state/mode-hold.json").is_file(),
        "mode.hold must write state/mode-hold.json"
    );
    let after = get_json(port, "/v3/snapshot", auth).await;
    assert_eq!(after["snapshot"]["service"]["starting"], true);
    server.abort();
}

#[tokio::test]
async fn forward_escapes_fall_through_to_the_proxy() {
    let home = tempfile::tempdir().unwrap();
    for (path, method) in [
        ("/v3/hello", Method::GET),
        ("/v3/snapshot", Method::GET),
        ("/v3/session/exchange", Method::POST),
    ] {
        let (port, server) = listener(
            home.path(),
            Arc::new(core_child::CoreChild::unavailable()),
            true,
            true,
            true,
        )
        .await;
        let response = client()
            .request(request(
                port,
                method,
                path,
                &[("authorization", "Bearer test-token")],
            ))
            .await
            .unwrap();
        // No core to forward to: the old behaviour (bad gateway) is preserved.
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY, "{path}");
        server.abort();
    }
}
