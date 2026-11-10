#![allow(clippy::unwrap_used)]
use super::*;
use axum::http::Method;
use http_body_util::BodyExt;
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use pacer_store::append_outbox;
use serde_json::json;
use std::time::Duration;

async fn listener(home: &std::path::Path, forwarded: bool) -> (u16, tokio::task::JoinHandle<()>) {
    let socket = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let port = socket.local_addr().unwrap().port();
    let ctx = Ctx::with(home.into(), home.into(), Default::default(), 1000.0);
    let state = Arc::new(Listener {
        core: Arc::new(core_child::CoreChild::unavailable()),
        heartbeat: Arc::new(heartbeat::Heartbeat::new()),
        ctx,
        port,
        token: "test-token".into(),
        registry: service_registry("*"),
        scoped_work: false,
        plugins: crate::native::plugins::Service::default(),
        forward_log_follow: false,
        forward_events: forwarded,
    });
    let app = Router::new().fallback(any(handle)).with_state(state);
    let server = tokio::spawn(async move {
        axum::serve(socket, app).await.unwrap();
    });
    (port, server)
}

fn request(port: u16, path: &str, method: Method, auth: bool) -> hyper::Request<String> {
    let mut builder = hyper::Request::builder()
        .method(method)
        .uri(format!("http://127.0.0.1:{port}{path}"))
        .header("host", format!("127.0.0.1:{port}"));
    if auth {
        builder = builder.header("authorization", "Bearer test-token");
    }
    builder.body(String::new()).unwrap()
}

fn client() -> Client<HttpConnector, String> {
    Client::builder(TokioExecutor::new()).build_http()
}

#[tokio::test]
async fn native_events_stream_without_core_and_honors_forward_escape() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join("link")).unwrap();
    append_outbox(
        &Ctx::with(home.path().into(), home.path().into(), Default::default(), 1000.0),
        &[json!({"seq":1,"at":1000.0,"envelope":{"type":"config","data":{"area":"config","at":1000.0}}})],
    )
    .unwrap();
    let (port, server) = listener(home.path(), false).await;
    let client = client();
    let unauth = client
        .request(request(port, "/v3/events?since=0", Method::GET, false))
        .await
        .unwrap();
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);
    let response = client
        .request(request(port, "/v3/events?since=0", Method::GET, true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let mut body = response.into_body();
    let connected = tokio::time::timeout(Duration::from_secs(2), body.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(connected.into_data().unwrap(), ": connected\n\n");
    let events = tokio::time::timeout(Duration::from_secs(2), body.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let events = String::from_utf8(events.into_data().unwrap().to_vec()).unwrap();
    assert!(events.contains("event: config\n"));
    let invalid = client
        .request(request(port, "/v3/events?since=-1", Method::GET, true))
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    server.abort();

    let (port, server) = listener(home.path(), true).await;
    let response = client
        .request(request(port, "/v3/events?since=0", Method::GET, true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    server.abort();
}

#[tokio::test]
async fn default_event_tail_delivers_post_connect_external_append_within_750ms() {
    for version in [2, 3] {
        let home = tempfile::tempdir().unwrap();
        let (port, server) = listener(home.path(), false).await;
        let response = client()
            .request(request(
                port,
                &format!("/v{version}/events"),
                Method::GET,
                true,
            ))
            .await
            .unwrap();
        let mut body = response.into_body();
        let connected = body.frame().await.unwrap().unwrap().into_data().unwrap();
        assert_eq!(connected, ": connected\n\n");
        // Let the initial empty poll finish before bypassing the publisher wake.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let ctx = Ctx::with(
            home.path().into(),
            home.path().into(),
            Default::default(),
            1000.0,
        );
        append_outbox(
            &ctx,
            &[json!({"seq":1,"envelope":{"type":"config","data":{"area":"config","at":1000.0}}})],
        )
        .unwrap();
        let frame = tokio::time::timeout(Duration::from_millis(750), body.frame()).await;
        server.abort();
        assert!(frame.is_ok(), "default external event exceeded 750ms");
        let frame = frame.unwrap().unwrap().unwrap().into_data().unwrap();
        assert!(
            String::from_utf8(frame.to_vec())
                .unwrap()
                .contains("event: config")
        );
    }
}
