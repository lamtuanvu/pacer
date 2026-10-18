use crate::{logic, tray_model::TrayModel, Shell};
use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde_json::Value;
use std::{path::PathBuf, sync::atomic::Ordering, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::process::Command;

pub struct Cli {
    pub binary: PathBuf,
    pub path: String,
    pub pacer_home: PathBuf,
}
impl Cli {
    pub async fn login_path() -> String {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(target_os = "macos") {
                "/bin/zsh"
            } else {
                "/bin/sh"
            }
            .into()
        });
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let begin = format!("__PACER_PATH_BEGIN_{}_{nonce}__", std::process::id());
        let end = format!("__PACER_PATH_END_{}_{nonce}__", std::process::id());
        let script = format!("printf '%s%s%s' '{begin}' \"$PATH\" '{end}'");
        let mut command = Command::new(shell);
        command.args(["-l", "-c", &script]).kill_on_drop(true);
        tokio::time::timeout(Duration::from_secs(5), command.output())
            .await
            .ok()
            .and_then(Result::ok)
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|output| logic::shell_path(&output, &begin, &end).map(str::to_owned))
            .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
    }
    pub fn find(path: &str) -> Option<Self> {
        let home = PathBuf::from(std::env::var_os("HOME")?);
        let binary = logic::candidates(path, &home).into_iter().find(|p| {
            use std::os::unix::fs::PermissionsExt;
            p.metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })?;
        // GUI launches lack a useful PATH; keep the discovered CLI's directory available too.
        let system_path = if cfg!(target_os = "macos") {
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        } else {
            "/usr/local/bin:/usr/bin:/bin"
        };
        let path = format!("{}:{path}:{system_path}", binary.parent()?.display());
        let pacer_home = std::env::var_os("PACER_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".pacer"));
        Some(Self {
            binary,
            path,
            pacer_home,
        })
    }
    pub async fn run(&self, args: &[&str]) -> Result<String, String> {
        let mut command = Command::new(&self.binary);
        command
            .args(args)
            .env("PATH", &self.path)
            .env("PACER_HOME", &self.pacer_home)
            .kill_on_drop(true);
        let out = tokio::time::timeout(Duration::from_secs(45), command.output())
            .await
            .map_err(|_| "CLI timed out")?
            .map_err(|_| "Unable to run pacer")?;
        if !out.status.success() {
            return Err("pacer command failed".into());
        }
        String::from_utf8(out.stdout).map_err(|_| "Invalid CLI output".into())
    }
    pub async fn auth(&self) -> Result<Url, String> {
        logic::auth_url(&self.run(&["open", "--print"]).await?)
    }
}

#[derive(Clone)]
pub struct Session {
    pub client: Client,
    pub origin: String,
}
impl Session {
    pub async fn connect(cli: &Cli, auth: &Url) -> Result<Self, String> {
        // Use exactly the home passed to CLI discovery, including PACER_HOME overrides.
        let token = std::fs::read_to_string(cli.pacer_home.join("token"))
            .map_err(|_| "Unable to read service token")?;
        Self::exchange(auth, token).await
    }
    async fn exchange(auth: &Url, token: String) -> Result<Self, String> {
        let origin = logic::local_origin(auth).ok_or("Invalid origin")?;
        let client = Client::builder()
            .cookie_store(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .user_agent(concat!("pacer-desktop/", env!("CARGO_PKG_VERSION")))
            .default_headers({
                let mut h = reqwest::header::HeaderMap::new();
                h.insert(
                    "X-Pacer-Client",
                    reqwest::header::HeaderValue::from_static(concat!(
                        "desktop/",
                        env!("CARGO_PKG_VERSION")
                    )),
                );
                h
            })
            .build()
            .map_err(|_| "Unable to create client")?;
        let session = Self { client, origin };
        if token.trim().is_empty() {
            return Err("Missing service token".into());
        }
        // Bearer authorization belongs exclusively to this request, never to default headers.
        let mut authorization =
            reqwest::header::HeaderValue::from_str(&format!("Bearer {}", token.trim()))
                .map_err(|_| "Invalid service token")?;
        authorization.set_sensitive(true);
        drop(token);
        let response = session
            .client
            .post(format!("{}/v2/session/exchange", session.origin))
            .header(reqwest::header::AUTHORIZATION, authorization)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| "Session exchange failed")?;
        if response.status() != reqwest::StatusCode::NO_CONTENT {
            return Err("Session exchange failed".into());
        }
        logic::check_hello(&session.json("/v2/hello").await?).map_err(str::to_owned)?;
        Ok(session)
    }
    pub async fn op(&self, op: &str, params: &Value) -> Result<Value, String> {
        if crate::actions::dispatch(&serde_json::json!({"op":op,"params":params})).is_none()
            || op == "ui.open"
        {
            return Err("Invalid operation".into());
        }
        self.client
            .post(format!("{}/v2/ops/{op}", self.origin))
            .header("Origin", &self.origin)
            // Cookie writes must say exactly "app" (the service's CSRF check); reads keep the desktop label.
            .header("X-Pacer-Client", "app")
            .json(params)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| "Operation failed")?
            .error_for_status()
            .map_err(|_| "Operation failed")?
            .json::<Value>()
            .await
            .map(|v| v["result"].clone())
            .map_err(|_| "Invalid service response".into())
    }
    pub async fn json(&self, path: &str) -> Result<Value, String> {
        self.client
            .get(format!("{}{path}", self.origin))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| "stopped")?
            .error_for_status()
            .map_err(|_| "stopped")?
            .json()
            .await
            .map_err(|_| "Invalid service response".into())
    }
}

async fn connected(app: &AppHandle, cli: &Cli) -> Result<(), String> {
    let web_auth = cli.auth().await?;
    let session = Session::connect(cli, &web_auth).await?;
    let snapshot = session.json("/v2/snapshot").await?;
    let registration = session.op("client.register", &serde_json::json!({"kind":"desktop","version":env!("CARGO_PKG_VERSION"),"notifier":true})).await?;
    let client_id = registration["client_id"]
        .as_str()
        .ok_or("Missing client id")?
        .to_owned();
    let seq = snapshot["seq"].as_u64().unwrap_or(0);
    if logic::local_origin(&web_auth).as_deref() != Some(&session.origin) {
        return Err("stopped".into());
    }
    crate::activate(app, &session.origin, web_auth)?;
    *app.state::<Shell>().session.lock().unwrap() = Some(session.clone());
    crate::update_tray(app, TrayModel::from_snapshot(&snapshot));
    tokio::select! {
        result = listen(app, &session, &client_id, seq) => result,
        result = heartbeat(&session, &client_id) => result,
    }
}
async fn heartbeat(session: &Session, client_id: &str) -> Result<(), String> {
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        session
            .op(
                "client.heartbeat",
                &serde_json::json!({"client_id":client_id}),
            )
            .await?;
    }
}
async fn listen(
    app: &AppHandle,
    session: &Session,
    client_id: &str,
    mut seq: u64,
) -> Result<(), String> {
    // Exactly one owner of the native stream. Reconnect sequentially, never from window callbacks.
    loop {
        let response = tokio::time::timeout(
            Duration::from_secs(15),
            session
                .client
                .get(format!("{}/v2/events?since={seq}", session.origin))
                .header("Accept", "text/event-stream")
                .send(),
        )
        .await
        .map_err(|_| "stopped")?
        .map_err(|_| "stopped")?
        .error_for_status()
        .map_err(|_| "stopped")?;
        if !response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream"))
        {
            return Err("stopped".into());
        }
        let mut stream = response.bytes_stream();
        let mut parser = logic::Sse::default();
        loop {
            let chunk = match tokio::time::timeout(Duration::from_secs(45), stream.next()).await {
                Ok(Some(Ok(bytes))) => bytes,
                _ => break,
            };
            let events = parser.push(&chunk).map_err(str::to_owned)?;
            let reset = events.iter().any(|event| event.kind == "reset");
            let mut refresh = false;
            for event in events {
                if event.kind != "reset" && event.id.is_some_and(|id| id <= seq) {
                    continue;
                }
                if let Some(id) = event.id {
                    seq = id;
                }
                if event.kind == "notify" {
                    if let Ok(data) = serde_json::from_str::<Value>(&event.data) {
                        if let Some(notification) =
                            crate::notifications::from_event(&data, &client_id)
                        {
                            crate::notify(app, notification);
                        }
                    }
                }
                // Unknown minor-version events also invalidate the snapshot.
                refresh = true;
            }
            if refresh {
                let snapshot = session.json("/v2/snapshot").await?;
                // A reset invalidates the old sequence space; the fresh snapshot owns the cursor.
                // Ordinary refreshes preserve the event cursor for alerts arriving during the GET.
                seq = logic::snapshot_seq(seq, &snapshot, reset);
                crate::update_tray(app, TrayModel::from_snapshot(&snapshot));
            }
        }
        {
            // Recheck version and session on reconnect, including service upgrades.
            logic::check_hello(&session.json("/v2/hello").await?).map_err(str::to_owned)?;
            // Check whether the cookie session is still valid before reconnecting.
            let snapshot = session.json("/v2/snapshot").await?;
            crate::update_tray(app, TrayModel::from_snapshot(&snapshot));
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
}

pub async fn run(app: AppHandle) {
    let mut path = Cli::login_path().await;
    loop {
        if app.state::<Shell>().retry.swap(false, Ordering::SeqCst) {
            path = Cli::login_path().await;
        }
        if let Some(cli) = Cli::find(&path) {
            if app.state::<Shell>().start.swap(false, Ordering::SeqCst) {
                crate::recovery(&app, "starting");
                if cli.run(&["service", "install"]).await.is_err() {
                    crate::recovery(&app, "startFailed");
                    wait_retry(&app).await;
                    continue;
                }
            }
            if let Err(error) = connected(&app, &cli).await {
                let state = match error.as_str() {
                    "oldService" => "oldService",
                    "oldApp" => "oldApp",
                    "protocol" => "protocol",
                    _ => "stopped",
                };
                crate::recovery(&app, state);
            }
        } else {
            crate::recovery(&app, "install");
        }
        wait_retry(&app).await;
    }
}
async fn wait_retry(app: &AppHandle) {
    for _ in 0..10 {
        if app.state::<Shell>().retry.load(Ordering::SeqCst)
            || app.state::<Shell>().start.load(Ordering::SeqCst)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    #[tokio::test]
    #[ignore = "requires loopback socket access"]
    async fn bearer_is_only_used_for_post_exchange_then_memory_cookie() {
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            for n in 0..3 {
                let (mut connection, _) = server.accept().unwrap();
                connection
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buffer = [0; 1024];
                    let length = connection.read(&mut buffer).unwrap();
                    request.extend_from_slice(&buffer[..length]);
                    if length == 0 || request.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8(request).unwrap().to_lowercase();
                if request.starts_with("post /v2/ops/") {
                    assert!(request.contains("x-pacer-client: app\r\n"));
                } else {
                    assert!(request.contains(concat!(
                        "x-pacer-client: desktop/",
                        env!("CARGO_PKG_VERSION")
                    )));
                }
                assert!(request.contains(&format!("host: {address}")));
                let response = if n == 0 {
                    assert!(request.starts_with("post /v2/session/exchange "));
                    assert!(request.contains("authorization: bearer test-token"));
                    assert!(!request.contains("cookie:"));
                    "HTTP/1.1 204 No Content\r\nSet-Cookie: pacer_session=test-session; HttpOnly; SameSite=Strict; Path=/\r\nConnection: close\r\n\r\n".to_owned()
                } else {
                    assert!(!request.contains("authorization:"));
                    assert!(request.contains("cookie: pacer_session=test-session"));
                    if n == 1 {
                        assert!(request.starts_with("get /v2/hello "));
                    } else {
                        assert!(request.starts_with("post /v2/ops/client.register "));
                        assert!(request.contains(&format!("origin: http://{address}")));
                    }
                    let body = if n == 1 {
                        r#"{"protocol":"2.8.0"}"#
                    } else {
                        r#"{"result":{"client_id":"test-client"}}"#
                    };
                    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                };
                connection.write_all(response.as_bytes()).unwrap();
            }
        });
        let auth =
            logic::auth_url(&format!("http://{address}/app/auth?code=webview-only")).unwrap();
        let session = Session::exchange(&auth, "test-token".into()).await.unwrap();
        session.op("client.register", &serde_json::json!({"kind":"desktop","notifier":true,"version":env!("CARGO_PKG_VERSION")})).await.unwrap();
        worker.join().unwrap();
    }
}
