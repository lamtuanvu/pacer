#![allow(clippy::unwrap_used)]
use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

async fn request(port: u16, method: &str, path: &str, headers: &str) -> String {
    let mut stream = tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    stream.write_all(format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n{headers}\r\n").as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).await.unwrap();
    String::from_utf8(bytes).unwrap()
}

#[tokio::test]
async fn public_listener_routes_static_and_forwards_fallbacks() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().join("pacer"),
        Default::default(),
        1_800_000_000.0,
    );
    let core = Arc::new(core_child::CoreChild::spawn(vec![], HashMap::new()));
    let socket = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let port = socket.local_addr().unwrap().port();
    let state = Arc::new(Listener {
        core: core.clone(),
        heartbeat: Arc::new(heartbeat::Heartbeat::new()),
        ctx,
        port,
        token: "token".into(),
        registry: registry(""),
        scoped_work: false,
    });
    let server = tokio::spawn(async move {
        axum::serve(
            socket,
            Router::new().fallback(any(handle)).with_state(state),
        )
        .await
        .unwrap();
    });
    let bearer = "Authorization: Bearer token\r\n";
    for (method, path, headers, status) in [
        ("GET", "/app/", bearer, "200"),
        ("HEAD", "/app/app.js", bearer, "200"),
        ("GET", "/app/app.js", bearer, "200"),
        ("GET", "/v3/hello", "", "401"),
        ("GET", "/app/auth", bearer, "502"),
        ("GET", "/app/missing.js", bearer, "502"),
        ("GET", "/app/missing.js/", bearer, "502"),
        ("GET", "/v3/attachments", bearer, "502"),
        (
            "GET",
            "/v3/tasks/one/session",
            "Authorization: Bearer token\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n",
            "502",
        ),
    ] {
        let response = request(port, method, path, headers).await;
        assert!(
            response.starts_with(&format!("HTTP/1.1 {status}")),
            "{method} {path}: {response}"
        );
        if status == "200" {
            assert!(
                response
                    .to_ascii_lowercase()
                    .contains("content-security-policy:"),
                "{method} {path}"
            );
        }
    }
    core.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn public_listener_forwards_to_available_core() {
    let script = r#"const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(req,s){const path=new URL(req.url).pathname;if(path.endsWith('/session')){if(s.upgrade(req))return;return new Response('upgrade required',{status:426})}return new Response('core:'+path,{status:path.includes('missing.js')?404:200})},websocket:{message(ws,message){ws.send(message)}}});console.log(JSON.stringify({internal:{port:server.port}}));"#;
    let bun = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join("bun"))
        .find(|path| path.is_file())
        .unwrap();
    let core = Arc::new(core_child::CoreChild::spawn(
        vec![
            bun.to_string_lossy().into_owned(),
            "-e".into(),
            script.into(),
        ],
        HashMap::new(),
    ));
    for _ in 0..100 {
        if core.target().await.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(core.target().await.is_some(), "fixture core did not start");
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().join("pacer"),
        Default::default(),
        1_800_000_000.0,
    );
    let socket = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let port = socket.local_addr().unwrap().port();
    let state = Arc::new(Listener {
        core: core.clone(),
        heartbeat: Arc::new(heartbeat::Heartbeat::new()),
        ctx,
        port,
        token: "token".into(),
        registry: registry(""),
        scoped_work: false,
    });
    let server = tokio::spawn(async move {
        axum::serve(
            socket,
            Router::new().fallback(any(handle)).with_state(state),
        )
        .await
        .unwrap();
    });
    for (path, status) in [
        ("/app/auth", "200"),
        ("/app/missing.js/", "404"),
        ("/v3/attachments", "200"),
    ] {
        let response = request(port, "GET", path, "Authorization: Bearer token\r\n").await;
        assert!(
            response.starts_with(&format!("HTTP/1.1 {status}")),
            "{path}: {response}"
        );
        assert!(
            response.contains(&format!("core:{path}")),
            "{path}: {response}"
        );
    }
    let mut upgrade = format!("ws://127.0.0.1:{port}/v3/tasks/one/session")
        .into_client_request()
        .unwrap();
    upgrade
        .headers_mut()
        .insert("authorization", "Bearer token".parse().unwrap());
    let (mut websocket, response) = tokio_tungstenite::connect_async(upgrade).await.unwrap();
    assert_eq!(response.status().as_u16(), 101);
    websocket
        .send(tokio_tungstenite::tungstenite::Message::Text("echo".into()))
        .await
        .unwrap();
    let echoed = tokio::time::timeout(std::time::Duration::from_secs(2), websocket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(echoed.to_text().unwrap(), "echo");
    websocket.close(None).await.unwrap();
    core.shutdown().await;
    server.abort();
}
