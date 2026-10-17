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
}
impl Cli {
    pub async fn login_path() -> String {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
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
            .unwrap_or_default()
    }
    pub fn find(path: &str) -> Option<Self> {
        let home = PathBuf::from(std::env::var_os("HOME")?);
        let binary = logic::candidates(path, &home).into_iter().find(|p| {
            use std::os::unix::fs::PermissionsExt;
            p.metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })?;
        // GUI launches lack a useful PATH; keep the discovered CLI's directory available too.
        let path = format!(
            "{}:{path}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
            binary.parent()?.display()
        );
        Some(Self { binary, path })
    }
    pub async fn run(&self, args: &[&str]) -> Result<String, String> {
        let mut command = Command::new(&self.binary);
        command
            .args(args)
            .env("PATH", &self.path)
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

pub struct Session {
    pub client: Client,
    pub origin: String,
}
impl Session {
    pub async fn connect(cli: &Cli) -> Result<Self, String> {
        Self::exchange(cli.auth().await?).await
    }
    async fn exchange(auth: Url) -> Result<Self, String> {
        let origin = logic::local_origin(&auth).ok_or("Invalid origin")?;
        let client = Client::builder()
            .cookie_store(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .user_agent("pacer-desktop/0.1")
            .default_headers({
                let mut h = reqwest::header::HeaderMap::new();
                h.insert(
                    "X-Pacer-Client",
                    reqwest::header::HeaderValue::from_static("app"),
                );
                h
            })
            .build()
            .map_err(|_| "Unable to create client")?;
        let session = Self { client, origin };
        // Probe before auth: older services may not implement the exchange at all.
        logic::check_hello(&session.json("/v2/hello").await?).map_err(str::to_owned)?;
        // The cookie jar is memory-only. Do not inspect any bearer token or service discovery secret.
        let response = session
            .client
            .get(auth)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| "stopped")?;
        if response.status() != reqwest::StatusCode::SEE_OTHER
            || response
                .headers()
                .get("location")
                .and_then(|h| h.to_str().ok())
                != Some("/app/")
        {
            return Err("stopped".into());
        }
        Ok(session)
    }
    async fn notification_level(&self) -> String {
        // Read-only op, transported as POST by v2. Cookie writes/ops require Origin and X-Pacer-Client.
        let response = self
            .client
            .post(format!("{}/v2/ops/notifications.get", self.origin))
            .header("Origin", &self.origin)
            .json(&serde_json::json!({}))
            .timeout(Duration::from_secs(15))
            .send()
            .await;
        if let Ok(response) = response {
            if let Ok(body) = response.json::<Value>().await {
                if let Some(level) = body["result"]["level"].as_str() {
                    return level.into();
                }
            }
        }
        "important".into()
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
    let session = Session::connect(cli).await?;
    let snapshot = session.json("/v2/snapshot").await?;
    let mut seq = snapshot["seq"].as_u64().unwrap_or(0);
    let web_auth = cli.auth().await?;
    if logic::local_origin(&web_auth).as_deref() != Some(&session.origin) {
        return Err("stopped".into());
    }
    crate::activate(app, &session.origin, web_auth)?;
    crate::update_tray(app, TrayModel::from_snapshot(&snapshot));
    let mut notification_level = session.notification_level().await;
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
            let mut config_changed = false;
            for event in events {
                if event.kind != "reset" && event.id.is_some_and(|id| id <= seq) {
                    continue;
                }
                if let Some(id) = event.id {
                    seq = id;
                }
                if event.kind == "config" {
                    config_changed = true;
                }
                if event.kind == "alert" {
                    if let Ok(data) = serde_json::from_str::<Value>(&event.data) {
                        crate::notify(app, &data, &notification_level);
                    }
                }
                // Unknown minor-version events also invalidate the snapshot.
                refresh = true;
            }
            if refresh {
                let snapshot = session.json("/v2/snapshot").await?;
                if config_changed {
                    notification_level = session.notification_level().await;
                }
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
    #[ignore = "requires loopback socket access; run with --include-ignored outside a restricted sandbox"]
    async fn old_service_is_reported_before_auth_exchange() {
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
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
            let request = String::from_utf8(request).unwrap();
            let body = r#"{"protocol":"1.5.0"}"#;
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            connection.write_all(response.as_bytes()).unwrap();
            assert!(request.starts_with("GET /v2/hello "));
        });
        let auth = logic::auth_url(&format!("http://{address}/app/auth?code=test-code")).unwrap();
        let error = Session::exchange(auth)
            .await
            .err()
            .expect("old service must fail");
        worker.join().unwrap();
        assert_eq!(error, "oldService");
    }
    #[tokio::test]
    #[ignore = "requires loopback socket access; run with --include-ignored outside a restricted sandbox"]
    async fn code_exchange_uses_cookie_without_bearer() {
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
                assert!(!request.contains("authorization:"));
                assert!(request.contains("x-pacer-client: app"));
                assert!(request.contains(&format!("host: {address}")));
                let response = if n == 1 {
                    assert!(request.starts_with("get /app/auth?code=test-code "));
                    "HTTP/1.1 303 See Other\r\nLocation: /app/\r\nSet-Cookie: pacer_session=test-session; HttpOnly; SameSite=Strict; Path=/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned()
                } else {
                    assert!(request.starts_with("get /v2/hello "));
                    if n == 2 {
                        assert!(request.contains("cookie: pacer_session=test-session"));
                    } else {
                        assert!(!request.contains("cookie:"));
                    }
                    let body = r#"{"protocol":"2.0.0"}"#;
                    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                };
                connection.write_all(response.as_bytes()).unwrap();
            }
        });
        let auth = logic::auth_url(&format!("http://{address}/app/auth?code=test-code")).unwrap();
        let session = Session::exchange(auth).await.unwrap();
        assert!(logic::check_hello(&session.json("/v2/hello").await.unwrap()).is_ok());
        worker.join().unwrap();
    }
}
