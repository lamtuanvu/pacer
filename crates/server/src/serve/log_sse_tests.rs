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
    listener_with_core(
        home,
        forwarded,
        Arc::new(core_child::CoreChild::unavailable()),
    )
    .await
}
async fn compatibility_listener(home: &Path) -> (u16, tokio::task::JoinHandle<()>) {
    listener_with_core(home, false, test_core(home).await).await
}
async fn listener_with_core(
    home: &Path,
    forwarded: bool,
    core: Arc<core_child::CoreChild>,
) -> (u16, tokio::task::JoinHandle<()>) {
    let socket = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let port = socket.local_addr().unwrap().port();
    let ctx = Ctx::with(home.into(), home.into(), Default::default(), 1000.0);
    let state = Arc::new(Listener {
        core,
        heartbeat: Arc::new(heartbeat::Heartbeat::new()),
        ctx,
        port,
        token: "test-token".into(),
        registry: service_registry("*"),
        scoped_work: false,
        plugins: crate::native::plugins::Service::default(),
        forward_log_follow: forwarded,
    });
    let app = Router::new()
        .fallback(any(handle))
        .with_state(state.clone());
    struct StopCore(Arc<core_child::CoreChild>);
    impl Drop for StopCore {
        fn drop(&mut self) {
            let core = self.0.clone();
            tokio::spawn(async move {
                core.shutdown().await;
            });
        }
    }
    let guard = StopCore(state.core.clone());
    let task = tokio::spawn(async move {
        let _guard = guard;
        axum::serve(socket, app).await.unwrap();
    });
    (port, task)
}

async fn test_core(home: &Path) -> Arc<core_child::CoreChild> {
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/task-log-core.ts");
    let bun = std::process::Command::new("which")
        .arg("bun")
        .output()
        .unwrap();
    let core = Arc::new(core_child::CoreChild::spawn(
        vec![
            String::from_utf8(bun.stdout).unwrap().trim().into(),
            fixture.to_string_lossy().into(),
        ],
        std::collections::HashMap::from([
            ("HOME".into(), home.to_string_lossy().into()),
            ("PACER_HOME".into(), home.to_string_lossy().into()),
            ("TMPDIR".into(), home.to_string_lossy().into()),
        ]),
    ));
    tokio::time::timeout(Duration::from_secs(10), async {
        while core.target().await.is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    core
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

#[tokio::test]
async fn followers_continue_reading_while_another_connection_writes() {
    let home = tempfile::tempdir().unwrap();
    let run = home.path().join("run");
    task(home.path(), &run, "running");
    let (port, server) = listener(home.path(), false).await;
    let path = format!("/v3/tasks/{ID}/log?follow=1");
    let client = client();
    let mut bodies = Vec::new();
    for _ in 0..2 {
        let response = client
            .request(request(port, &path, Method::GET, true))
            .await
            .unwrap();
        let mut body = response.into_body();
        body.frame().await.unwrap().unwrap();
        bodies.push(body);
    }
    let mut writer = pacer_store::TaskStore::open(home.path()).unwrap();
    writer
        .connection()
        .unwrap()
        .execute_batch("BEGIN IMMEDIATE")
        .unwrap();
    // A new native follower also reads through a held writer without an import.
    let response = tokio::time::timeout(
        Duration::from_secs(2),
        client.request(request(port, &path, Method::GET, true)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut initial = response.into_body();
    initial.frame().await.unwrap().unwrap();
    bodies.push(initial);
    std::fs::write(run.join("stdout"), "while locked").unwrap();
    for body in &mut bodies {
        let frame = tokio::time::timeout(Duration::from_secs(3), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&frame.into_data().unwrap()).contains("while locked"));
    }
    writer
        .connection()
        .unwrap()
        .execute_batch("ROLLBACK")
        .unwrap();
    server.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn listener_refuses_linked_database_without_modifying_target() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    for hard_link in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("target.db");
        std::fs::write(&target, b"sentinel").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::create_dir(home.path().join("state")).unwrap();
        let path = home.path().join("state/tasks.db");
        if hard_link {
            std::fs::hard_link(&target, path).unwrap();
        } else {
            symlink(&target, path).unwrap();
        }
        let (port, server) = listener(home.path(), false).await;
        let response = client()
            .request(request(
                port,
                &format!("/v3/tasks/{ID}/log?follow=1"),
                Method::GET,
                true,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o644
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"sentinel");
        server.abort();
    }
}

fn legacy_json(home: &Path, id: &str, rev: serde_json::Value, state: &str, run: &Path) {
    let file = home.join("tasks").join(format!("{id}.json"));
    let temp = file.with_extension("tmp");
    std::fs::write(&temp, serde_json::to_vec(&json!({"id":id,"rev":rev,"state":state,"createdAt":1000,"brief":{"repo":"/tmp/repo"},"attempts":[],"run":{"dir":run}})).unwrap()).unwrap();
    std::fs::rename(temp, file).unwrap();
}

fn ts_read(home: &Path, id: &str) -> serde_json::Value {
    let module = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/tasks/store.ts");
    let code = format!(
        "import {{ readTask }} from {}; console.log(JSON.stringify(readTask({{pacerHome:{}}}, {})))",
        serde_json::to_string(&module).unwrap(),
        serde_json::to_string(home).unwrap(),
        serde_json::to_string(id).unwrap()
    );
    let output = std::process::Command::new("bun")
        .args(["-e", &code])
        .env("HOME", home)
        .env("PACER_HOME", home)
        .env_remove("BUN_OPTIONS")
        .env_remove("NODE_OPTIONS")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[tokio::test]
async fn listener_merges_new_and_updated_legacy_json_like_typescript() {
    for existing in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let run = home.path().join("run");
        task(home.path(), &run, "running");
        let id = if existing {
            ID
        } else {
            "t-20261102-101125-16aa"
        };
        legacy_json(home.path(), id, json!(2.0), "done", &run);
        let (port, server) = compatibility_listener(home.path()).await;
        let response = client()
            .request(request(
                port,
                &format!("/v3/tasks/{id}/log?follow=1"),
                Method::GET,
                true,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = tokio::time::timeout(Duration::from_secs(3), response.into_body().collect())
            .await
            .unwrap()
            .unwrap()
            .to_bytes();
        assert!(String::from_utf8_lossy(&body).contains("event: done"));
        // The compatibility read must durably import into the shared database.
        let code = format!(
            "import {{ Database }} from 'bun:sqlite'; const db = new Database({}, {{readonly:true}}); console.log(JSON.stringify(db.query('SELECT rev FROM tasks WHERE id=?').get({})))",
            serde_json::to_string(&home.path().join("state/tasks.db")).unwrap(),
            serde_json::to_string(id).unwrap()
        );
        let output = std::process::Command::new("bun")
            .args(["-e", &code])
            .output()
            .unwrap();
        assert!(output.status.success());
        let row: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(row, json!({"rev":2}));
        assert_eq!(ts_read(home.path(), id)["state"], "done");
        server.abort();
    }
}

#[tokio::test]
async fn connected_listener_observes_legacy_update_and_database_replacement() {
    for replace_database in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let run = home.path().join("run");
        task(home.path(), &run, "running");
        let (port, server) = compatibility_listener(home.path()).await;
        let response = client()
            .request(request(
                port,
                &format!("/v3/tasks/{ID}/log?follow=1"),
                Method::GET,
                true,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut body = response.into_body();
        assert_eq!(
            body.frame().await.unwrap().unwrap().into_data().unwrap(),
            ": connected\n\n"
        );
        if replace_database {
            let replacement = tempfile::tempdir().unwrap();
            let replacement_run = replacement.path().join("run");
            task(replacement.path(), &replacement_run, "done");
            std::fs::rename(
                replacement.path().join("state/tasks.db"),
                home.path().join("state/tasks.db"),
            )
            .unwrap();
        } else {
            legacy_json(home.path(), ID, json!(2), "done", &run);
        }
        let rest = tokio::time::timeout(Duration::from_secs(3), body.collect())
            .await
            .unwrap()
            .unwrap()
            .to_bytes();
        assert_eq!(rest, "event: done\ndata: {}\n\n");
        assert_eq!(ts_read(home.path(), ID)["state"], "done");
        server.abort();
    }
}

#[path = "log_sse_compat_tests.rs"]
mod compatibility;
