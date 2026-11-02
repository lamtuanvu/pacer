#![allow(clippy::unwrap_used)]
use super::*;
use axum::http::Method;
use http_body_util::BodyExt;
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use serde_json::json;
use std::{path::Path, time::Duration};

const ID: &str = "t-20261102-101125-16a9";

async fn listener(home: &Path, forwarded: bool) -> (u16, tokio::task::JoinHandle<()>) {
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
        registry: registry("*"),
        scoped_work: false,
        forward_log_follow: forwarded,
    });
    let app = Router::new().fallback(any(handle)).with_state(state);
    let task = tokio::spawn(async move {
        axum::serve(socket, app).await.unwrap();
    });
    (port, task)
}

fn request(port: u16, path: &str, method: Method, authorized: bool) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(format!("http://127.0.0.1:{port}{path}"));
    if authorized {
        builder = builder.header("authorization", "Bearer test-token");
    }
    builder.body(Body::empty()).unwrap()
}

fn client() -> Client<HttpConnector, Body> {
    Client::builder(TokioExecutor::new()).build_http()
}

fn task(home: &Path, run: &Path, state: &str) {
    std::fs::create_dir(run).unwrap();
    let mut store = pacer_store::TaskStore::open(home).unwrap();
    store.insert(&json!({"id":ID,"rev":1,"state":state,"createdAt":1000.0,"brief":{"repo":"/tmp/repo"},"attempts":[],"run":{"dir":run}}), 1000.0).unwrap();
}

#[tokio::test]
async fn authenticated_listener_dispatch_and_fallback() {
    let home = tempfile::tempdir().unwrap();
    let run = home.path().join("run");
    task(home.path(), &run, "done");
    std::fs::write(run.join("stdout"), "hello\n").unwrap();
    let (port, server) = listener(home.path(), false).await;
    let client = client();
    let path = format!("/v3/tasks/{ID}/log?follow=1");
    let unauth = client
        .request(request(port, &path, Method::GET, false))
        .await
        .unwrap();
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);
    let response = client
        .request(request(port, &path, Method::GET, true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let body = tokio::time::timeout(Duration::from_secs(4), response.into_body().collect())
        .await
        .unwrap()
        .unwrap()
        .to_bytes();
    let body = String::from_utf8(body.to_vec()).unwrap();
    assert!(body.starts_with(": connected\n\nevent: log\n"));
    assert!(body.ends_with("event: done\ndata: {}\n\n"));
    for (path, method, status) in [
        (
            format!("/v3/tasks/{ID}/log"),
            Method::GET,
            StatusCode::BAD_GATEWAY,
        ),
        (
            "/v3/events?since=0".into(),
            Method::GET,
            StatusCode::BAD_GATEWAY,
        ),
        (path.clone(), Method::POST, StatusCode::METHOD_NOT_ALLOWED),
        (
            "/v3/tasks/missing/log?follow=1".into(),
            Method::GET,
            StatusCode::NOT_FOUND,
        ),
    ] {
        let response = client
            .request(request(port, &path, method, true))
            .await
            .unwrap();
        assert_eq!(response.status(), status, "{path}");
    }
    server.abort();
    let (port, server) = listener(home.path(), true).await;
    let response = client
        .request(request(port, &path, Method::GET, true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    server.abort();
}

#[tokio::test]
async fn listener_appends_and_drains_bounded_chunks_before_done() {
    let home = tempfile::tempdir().unwrap();
    let run = home.path().join("run");
    task(home.path(), &run, "running");
    let (port, server) = listener(home.path(), false).await;
    let client = client();
    let path = format!("/v3/tasks/{ID}/log?follow=1");
    let response = client
        .request(request(port, &path, Method::GET, true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    let first = tokio::time::timeout(Duration::from_secs(2), body.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(first.into_data().unwrap(), ": connected\n\n");
    std::fs::write(run.join("stdout"), "a".repeat(256 * 1024 * 5)).unwrap();
    std::fs::write(run.join("exit"), "0").unwrap();
    let rest = tokio::time::timeout(Duration::from_secs(5), body.collect())
        .await
        .unwrap()
        .unwrap()
        .to_bytes();
    let rest = String::from_utf8(rest.to_vec()).unwrap();
    let frames: Vec<_> = rest
        .split("\n\n")
        .filter(|frame| !frame.is_empty())
        .collect();
    assert_eq!(frames.len(), 6);
    assert!(
        frames[..5]
            .iter()
            .all(|frame| frame.starts_with("event: log\n"))
    );
    assert_eq!(frames[5], "event: done\ndata: {}");
    server.abort();
}
