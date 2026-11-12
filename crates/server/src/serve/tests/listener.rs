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
    let session = sessions::create(&ctx.at_now()).unwrap();
    let state = Arc::new(Listener {
        core: core.clone(),
        heartbeat: Arc::new(heartbeat::Heartbeat::new()),
        ctx,
        port,
        token: "token".into(),
        registry: service_registry(""),
        scoped_work: false,
        plugins: crate::native::plugins::Service::default(),
        forward_log_follow: false,
        forward_events: false,
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
    for headers in [
        format!("Cookie: other=1\r\nCookie: pacer_session={session}\r\n"),
        format!("Cookie: pacer_session={session}\r\nCookie: other=1\r\n"),
    ] {
        let response = request(port, "GET", "/app/", &headers).await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    }
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
    let first = request(port, "GET", "/app/app.js", bearer).await;
    let etag = first
        .lines()
        .find_map(|line| line.strip_prefix("etag: "))
        .unwrap();
    let repeated = format!("{bearer}If-None-Match: {etag}\r\nIf-None-Match: \"other\"\r\n");
    let response = request(port, "GET", "/app/app.js", &repeated).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    core.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn host_check_and_clean_bridge_to_core_and_setup_forwards_over_http() {
    // Admitted host.check and host.clean requests reach Core's whole-operation host effects
    // bridge; refusals and dry runs never reach Core; host.repo.setup is forwarded.
    let script = r#"const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const path=new URL(req.url).pathname;const body=await req.text();return Response.json({result:{path,body:body?JSON.parse(body):null}})}});console.log(JSON.stringify({internal:{port:server.port}}));"#;
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
    std::fs::create_dir_all(ctx.pacer_home.clone()).unwrap();
    std::fs::write(
        ctx.pacer_home.join("strategy.yaml"),
        "planner: claude-code\naccounts:\n  claude: {kind: claude}\nrunners:\n  claude-code: {}\nhosts:\n  dev:\n    ssh: dev.example.invalid\n",
    )
    .unwrap();
    let state = Arc::new(Listener {
        core: core.clone(),
        heartbeat: Arc::new(heartbeat::Heartbeat::new()),
        ctx,
        port,
        token: "token".into(),
        registry: service_registry(""),
        scoped_work: false,
        plugins: crate::native::plugins::Service::default(),
        forward_log_follow: false,
        forward_events: false,
    });
    let server = tokio::spawn(async move {
        axum::serve(
            socket,
            Router::new().fallback(any(handle)).with_state(state),
        )
        .await
        .unwrap();
    });
    let post = |op: &str, body: &str| {
        let headers = format!(
            "Authorization: Bearer token\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let path = format!("/v3/ops/{op}");
        async move { request(port, "POST", &path, &headers).await }
    };
    let setup = post("host.repo.setup", r#"{"alias":"dev"}"#).await;
    assert!(setup.starts_with("HTTP/1.1 200"), "{setup}");
    assert!(
        setup.contains(r#""path":"/v3/ops/host.repo.setup""#),
        "{setup}"
    );
    for op in ["host.check", "host.clean"] {
        let response = post(op, r#"{"alias":"dev"}"#).await;
        assert!(response.starts_with("HTTP/1.1 200"), "{op}: {response}");
        let bridged = format!(
            r#"{{"path":"/_internal/host-effects","body":{{"request":{{"kind":"{op}","params":{{"alias":"dev"}}}}}}}}"#
        );
        assert!(response.contains(&bridged), "{op}: {response}");
        let refused = post(op, r#"{"alias":"nosuchhost"}"#).await;
        assert!(
            refused.contains("unknown host nosuchhost"),
            "{op}: {refused}"
        );
        assert!(!refused.contains("\"path\""), "{op}: {refused}");
    }
    let dry = post("host.clean", r#"{"alias":"dev","dry_run":true}"#).await;
    assert!(dry.contains(r#"{"result":{"worktrees":[]}}"#), "{dry}");
    core.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn public_listener_forwards_to_available_core() {
    let script = r#"const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(req,s){const path=new URL(req.url).pathname;if(path.endsWith('/session')){if(s.upgrade(req,{data:req.headers.get('x-test')}))return;return new Response('upgrade required',{status:426})}return new Response('core:'+path,{status:path.includes('missing.js')?404:200})},websocket:{message(ws,message){ws.send(message === 'headers' ? ws.data : message)}}});console.log(JSON.stringify({internal:{port:server.port}}));"#;
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
        registry: service_registry(""),
        scoped_work: false,
        plugins: crate::native::plugins::Service::default(),
        forward_log_follow: false,
        forward_events: false,
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
    upgrade
        .headers_mut()
        .append("x-test", "first".parse().unwrap());
    upgrade
        .headers_mut()
        .append("x-test", "second".parse().unwrap());
    let (mut websocket, response) = tokio_tungstenite::connect_async(upgrade).await.unwrap();
    assert_eq!(response.status().as_u16(), 101);
    websocket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            "headers".into(),
        ))
        .await
        .unwrap();
    let headers = websocket.next().await.unwrap().unwrap();
    assert_eq!(headers.to_text().unwrap(), "first, second");
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
    let bytes = vec![0, 255, 27, 128];
    websocket
        .send(tokio_tungstenite::tungstenite::Message::Binary(
            bytes.clone().into(),
        ))
        .await
        .unwrap();
    let echoed = tokio::time::timeout(std::time::Duration::from_secs(2), websocket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(echoed.into_data().as_ref(), bytes.as_slice());
    websocket.close(None).await.unwrap();
    core.shutdown().await;
    server.abort();
}
