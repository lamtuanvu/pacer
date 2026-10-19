use crate::{logic, tray_model::TrayModel, Shell};
use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::process::Command;

fn pacer_home() -> PathBuf {
    std::env::var_os("PACER_HOME").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".pacer")
    })
}

fn same_path(a: &Path, b: &Path) -> bool {
    let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canonical(a) == canonical(b)
}

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
        let executable = std::env::current_exe().ok()?;
        let packaged = match pacer_desktop::packaging::packaged_cli(&executable) {
            Ok(packaged) => packaged,
            Err(error) => { desktop_log!("{error}"); return None; }
        };
        let binary = if let Some(binary) = packaged {
            binary
        } else {
            let mut candidates = Vec::new();
            if let Some(binary) = std::env::var_os("PACER_BIN") {
                candidates.push(PathBuf::from(binary));
            }
            candidates.extend(logic::candidates(path, &home));
            candidates.into_iter().find(|p| {
                use std::os::unix::fs::PermissionsExt;
                !same_path(p, &executable) && p.metadata()
                    .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            })?
        };
        // GUI launches lack a useful PATH; keep the discovered CLI's directory available too.
        let system_path = if cfg!(target_os = "macos") {
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        } else {
            "/usr/local/bin:/usr/bin:/bin"
        };
        let path = format!("{}:{path}:{system_path}", binary.parent()?.display());
        let pacer_home = pacer_home();
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
            return Err(format!("pacer {} failed ({})", args.join(" "), out.status));
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
            .post(format!("{}/v3/session/exchange", session.origin))
            .header(reqwest::header::AUTHORIZATION, authorization)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    "Session exchange timed out"
                } else if e.is_connect() {
                    "Unable to connect to the local service for session exchange"
                } else {
                    "Session exchange request failed"
                }
            })?;
        if response.status() != reqwest::StatusCode::NO_CONTENT {
            return Err(format!(
                "Session exchange failed (HTTP {})",
                response.status().as_u16()
            ));
        }
        logic::check_hello(&session.json("/v3/hello").await?).map_err(str::to_owned)?;
        Ok(session)
    }
    pub async fn op(&self, op: &str, params: &Value) -> Result<Value, String> {
        if crate::actions::dispatch(&serde_json::json!({"op":op,"params":params})).is_none()
            || op == "ui.open"
        {
            return Err("Invalid operation".into());
        }
        self.client
            .post(format!("{}/v3/ops/{op}", self.origin))
            .header("Origin", &self.origin)
            // Cookie writes must say exactly "app" (the service's CSRF check); reads keep the desktop label.
            .header("X-Pacer-Client", "app")
            .json(params)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| "Operation failed")?
            .error_for_status()
            .map_err(|e| logic::session_error(e.status().map(|status| status.as_u16())))?
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
            .map_err(|e| logic::session_error(e.status().map(|status| status.as_u16())))?
            .error_for_status()
            .map_err(|e| logic::session_error(e.status().map(|status| status.as_u16())))?
            .json()
            .await
            .map_err(|_| "Invalid service response".into())
    }
}

async fn wait_for_snapshot(app: &AppHandle, session: &Session) -> Result<Value, String> {
    let mut paused = false;
    loop {
        let snapshot = session.json("/v3/snapshot").await?;
        let waiting = logic::volume_waiting(&snapshot);
        *app.state::<Shell>().waiting.lock().unwrap() = waiting.clone();
        if waiting.is_some() || privacy_prompt() {
            if !paused {
                desktop_log!("pacer lifecycle: waiting for OS volume approval; restart suppressed");
            }
            paused = true;
            crate::diagnostic_recovery(app, &logic::diagnosis("permission", waiting));
            tokio::time::sleep(Duration::from_secs(1)).await;
        } else {
            if paused {
                desktop_log!(
                    "pacer lifecycle: OS volume wait cleared; authenticating automatically"
                );
                return Err("sessionExpired".into());
            }
            return Ok(snapshot);
        }
    }
}

async fn connected(app: &AppHandle, cli: &Cli) -> Result<(), String> {
    desktop_log!("pacer lifecycle: requesting desktop sign-in link");
    let web_auth = cli.auth().await?;
    desktop_log!("pacer lifecycle: exchanging local service session");
    let session = Session::connect(cli, &web_auth).await?;
    let snapshot = wait_for_snapshot(app, &session).await?;
    if snapshot["service"]["starting"] == true
        || snapshot["snapshot"]["service"]["starting"] == true
    {
        return Err("starting".into());
    }
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
    let shell = app.state::<Shell>();
    tokio::select! {
        result = listen(app, &session, &client_id, seq) => result,
        result = heartbeat(&session, &client_id) => result,
        _ = shell.expired.notified() => Err("sessionExpired".into()),
    }
}
async fn monitor_health(client: &Client) -> Result<(), String> {
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if !matches!(
            health(client).await,
            logic::HealthProbe::Ready | logic::HealthProbe::Starting
        ) {
            return Err("diagnose".into());
        }
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
                .get(format!("{}/v3/events?since={seq}", session.origin))
                .header("Accept", "text/event-stream")
                .send(),
        )
        .await
        .map_err(|_| "stopped")?
        .map_err(|e| logic::session_error(e.status().map(|status| status.as_u16())))?
        .error_for_status()
        .map_err(|e| logic::session_error(e.status().map(|status| status.as_u16())))?;
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
                let snapshot = wait_for_snapshot(app, session).await?;
                // A reset invalidates the old sequence space; the fresh snapshot owns the cursor.
                // Ordinary refreshes preserve the event cursor for alerts arriving during the GET.
                seq = logic::snapshot_seq(seq, &snapshot, reset);
                crate::update_tray(app, TrayModel::from_snapshot(&snapshot));
            }
        }
        {
            // Recheck version and session on reconnect, including service upgrades.
            logic::check_hello(&session.json("/v3/hello").await?).map_err(str::to_owned)?;
            // Check whether the cookie session is still valid before reconnecting.
            let snapshot = wait_for_snapshot(app, session).await?;
            crate::update_tray(app, TrayModel::from_snapshot(&snapshot));
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
}

pub async fn watch_startup(app: AppHandle) {
    let mut reported = false;
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let detail = app
            .state::<Shell>()
            .startup
            .lock()
            .unwrap()
            .diagnosis(std::time::Instant::now());
        if let Some(detail) = detail {
            if reported {
                continue;
            }
            let page = app
                .state::<Shell>()
                .diagnosis
                .lock()
                .unwrap()
                .as_ref()
                .map(|d| d.page);
            // Preserve more specific permission and installation guidance.
            if page.is_none() || matches!(page, Some("starting" | "stuck")) {
                if page != Some("stuck") {
                    desktop_log!(
                        "pacer lifecycle: sign-in stuck after 45 seconds: {}",
                        detail.error.as_deref().unwrap_or("unknown failure")
                    );
                }
                crate::diagnostic_recovery(&app, &detail);
                reported = true;
                // Wake a stream owner whose webview never completed sign-in.
                app.state::<Shell>().expired.notify_one();
            }
        } else {
            reported = false;
        }
    }
}

pub async fn run(app: AppHandle) {
    let mut path = Cli::login_path().await;
    let probe_client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("local health client");
    let clock = std::time::Instant::now();
    let mut lifecycle = logic::Lifecycle::default();
    let mut attempts = logic::Reconnect::default();
    let mut previous = String::new();
    loop {
        tokio::time::sleep(attempts.delay(std::time::Instant::now())).await;
        attempts.started(std::time::Instant::now());
        let _ = tokio::time::timeout(Duration::ZERO, app.state::<Shell>().expired.notified()).await;
        if app.state::<Shell>().retry.swap(false, Ordering::SeqCst) {
            path = Cli::login_path().await;
        }
        let cli = Cli::find(&path);
        let probe = health(&probe_client).await;
        // Restart is decided on NoAnswer, so ownership must be known there as well.
        let (job, owner) = if matches!(probe, logic::HealthProbe::Refused | logic::HealthProbe::NoAnswer) {
            job_state(&pacer_home(), service_port()).await
        } else {
            (logic::JobState::Unknown, None)
        };
        let waiting = app.state::<Shell>().waiting.lock().unwrap().clone();
        let prompt = privacy_prompt();
        let permission = waiting.is_some() || prompt;
        let action = lifecycle.step(clock.elapsed().as_secs(), probe, job, permission);
        let reason = format!(
            "{action:?}: health={probe:?}, job={job:?}, volume_wait={}, consent_window={prompt}",
            waiting.is_some()
        );
        if reason != previous
            || matches!(
                action,
                logic::RecoveryAction::Install
                    | logic::RecoveryAction::Start
                    | logic::RecoveryAction::Restart
            )
        {
            desktop_log!("pacer lifecycle: {reason}");
            previous = reason;
        }
        let page = logic::shell_page(permission, action, job, cli.is_some());
        let detail = match page {
            "permission" => waiting,
            "foreign" => owner.map(|owner| {
                logic::display_home(&owner, &std::env::var("HOME").unwrap_or_default())
            }),
            _ => None,
        };
        crate::diagnostic_recovery(&app, &logic::diagnosis(page, detail));
        if matches!(page, "install" | "foreign") {
            // Nothing this shell may do: no CLI to install with, or the job serves another pacer.
            continue;
        }
        match action {
            logic::RecoveryAction::Install
            | logic::RecoveryAction::Start
            | logic::RecoveryAction::Restart => {
                let mut action_job = job;
                for name in logic::service_steps(action) {
                    if let Err(error) = service_action(cli.as_ref(), name, action_job).await {
                        app.state::<Shell>().startup.lock().unwrap().failed(
                            std::time::Instant::now(),
                            &format!("Service {name} failed: {error}"),
                        );
                        desktop_log!("pacer lifecycle: automatic {name} failed: {error}; polling and retrying with backoff");
                        break;
                    }
                    desktop_log!("pacer lifecycle: automatic {name} succeeded");
                    if *name == "install" {
                        action_job = logic::JobState::Stopped;
                    }
                }
            }
            logic::RecoveryAction::Connect => {
                if let Some(cli) = cli {
                    let result = tokio::select! {
                        result = connected(&app, &cli) => result,
                        result = monitor_health(&probe_client) => result,
                    };
                    if let Err(error) = result {
                        app.state::<Shell>()
                            .startup
                            .lock()
                            .unwrap()
                            .failed(std::time::Instant::now(), logic::startup_error(&error));
                        desktop_log!(
                            "pacer lifecycle: connection ended ({error}); rechecking automatically"
                        );
                        if app.state::<Shell>().session.lock().unwrap().is_some() {
                            lifecycle.ready();
                        }
                        let page = logic::recovery_page(&error);
                        crate::diagnostic_recovery(&app, &logic::diagnosis(page, None));
                    }
                } else {
                    desktop_log!(
                        "pacer lifecycle: CLI unavailable for authentication; searching again"
                    );
                    // Guard only: shell_page already shows "install" and skips this pass when no CLI is found.
                    crate::recovery(&app, "install");
                }
            }
            logic::RecoveryAction::Protocol => crate::recovery(&app, "protocol"),
            logic::RecoveryAction::Wait => {
                app.state::<Shell>().startup.lock().unwrap().failed(std::time::Instant::now(), match probe {
                    logic::HealthProbe::NoAnswer => "The local service accepts connections but is not answering health checks",
                    logic::HealthProbe::Unreachable => "The local service cannot be reached",
                    _ => "Waiting for the local service to start",
                });
            }
            logic::RecoveryAction::Foreign => {}
        }
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
            for n in 0..4 {
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
                if request.starts_with("post /v3/ops/") {
                    assert!(request.contains("x-pacer-client: app\r\n"));
                } else {
                    assert!(request.contains(concat!(
                        "x-pacer-client: desktop/",
                        env!("CARGO_PKG_VERSION")
                    )));
                }
                assert!(request.contains(&format!("host: {address}")));
                let response = if n == 0 {
                    assert!(request.starts_with("post /v3/session/exchange "));
                    assert!(request.contains("authorization: bearer test-token"));
                    assert!(!request.contains("cookie:"));
                    "HTTP/1.1 204 No Content\r\nSet-Cookie: pacer_session=test-session; HttpOnly; SameSite=Strict; Path=/\r\nConnection: close\r\n\r\n".to_owned()
                } else {
                    assert!(!request.contains("authorization:"));
                    assert!(request.contains("cookie: pacer_session=test-session"));
                    if n == 1 {
                        assert!(request.starts_with("get /v3/hello "));
                    } else if n == 2 {
                        assert!(request.starts_with("post /v3/ops/client.register "));
                        assert!(request.contains(&format!("origin: http://{address}")));
                    } else {
                        assert!(request.starts_with("get /v3/snapshot "));
                    }
                    let body = if n == 1 {
                        r#"{"protocol":"3.0.0"}"#
                    } else if n == 2 {
                        r#"{"result":{"client_id":"test-client"}}"#
                    } else {
                        r#"{"protocol":"3.0.0","seq":1000000000003,"snapshot":{"service":{"waiting":{"kind":"folder","path":"/tmp/repo","since":1}}}}"#
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
        let snapshot = session.json("/v3/snapshot").await.unwrap();
        assert_eq!(snapshot["seq"], 1000000000003_u64);
        assert_eq!(
            logic::volume_waiting(&snapshot).as_deref(),
            Some("/tmp/repo")
        );
        worker.join().unwrap();
    }
}

fn service_port() -> u16 {
    std::env::var("PACER_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4317)
}
async fn health(client: &Client) -> logic::HealthProbe {
    use logic::HealthProbe;
    let port = service_port();
    match tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)),
    )
    .await
    {
        Ok(Ok(socket)) => drop(socket),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
            return HealthProbe::Refused
        }
        _ => return HealthProbe::Unreachable,
    }
    // The timeout includes the body: a connected but blocked process is busy, not stopped.
    match tokio::time::timeout(Duration::from_secs(2), async {
        let response = client
            .get(format!("http://127.0.0.1:{port}/health"))
            .send()
            .await?;
        response.json::<Value>().await
    })
    .await
    {
        Ok(Ok(value)) => logic::health_probe(&value),
        Ok(Err(e)) if e.is_decode() => HealthProbe::Invalid,
        _ => HealthProbe::NoAnswer,
    }
}
async fn manager_output(program: &str, args: &[String]) -> Result<std::process::Output, String> {
    let mut command = Command::new(program);
    command.args(args).kill_on_drop(true);
    tokio::time::timeout(Duration::from_secs(3), command.output())
        .await
        .map_err(|_| "Service manager timed out".to_owned())?
        .map_err(|_| "Unable to run service manager".to_owned())
}
#[cfg(target_os = "macos")]
fn launchctl_args(action: &str) -> Vec<String> {
    extern "C" {
        fn getuid() -> u32;
    }
    logic::launchctl_args(unsafe { getuid() }, action)
}
async fn job_state(home: &Path, port: u16) -> (logic::JobState, Option<String>) {
    use logic::JobState;
    let default_home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".pacer");
    let owned = |env: &[(String, String)]| -> Option<String> {
        let (owner, owner_port) = logic::job_owner(env, &default_home.to_string_lossy());
        (!same_path(Path::new(&owner), home) || owner_port != port).then_some(owner)
    };
    #[cfg(target_os = "macos")]
    {
        match manager_output("launchctl", &launchctl_args("print")).await {
            Ok(output) if output.status.success() => {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Some(owner) = owned(&logic::launchd_environment(&text)) {
                    (JobState::Foreign, Some(owner))
                } else if text.lines().any(|line| line.trim() == "state = running") {
                    (JobState::Running, None)
                } else {
                    (JobState::Stopped, None)
                }
            }
            Ok(_) => (JobState::NotLoaded, None),
            Err(_) => (JobState::Unknown, None),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let args = [
            "--user",
            "show",
            "pacer-serve.service",
            "--property=LoadState",
            "--property=ActiveState",
            "--property=Environment",
        ]
        .map(String::from);
        match manager_output("systemctl", &args).await {
            Ok(output) => {
                let text = String::from_utf8_lossy(&output.stdout);
                if text.lines().any(|line| line == "LoadState=not-found") {
                    (JobState::NotLoaded, None)
                } else if !output.status.success() {
                    (JobState::Unknown, None)
                } else if let Some(owner) = owned(&logic::systemd_environment(&text)) {
                    (JobState::Foreign, Some(owner))
                } else if text
                    .lines()
                    .any(|line| line == "ActiveState=active" || line == "ActiveState=activating")
                {
                    (JobState::Running, None)
                } else if text.lines().any(|line| line == "LoadState=loaded") {
                    (JobState::Stopped, None)
                } else {
                    (JobState::Unknown, None)
                }
            }
            Err(_) => (JobState::Unknown, None),
        }
    }
}
async fn service_action(
    cli: Option<&Cli>,
    action: &str,
    job: logic::JobState,
) -> Result<(), String> {
    if action == "install" {
        let cli = cli.ok_or("No located or bundled pacer CLI")?;
        return cli.run(&["service", "install"]).await.map(|_| ());
    }
    #[cfg(target_os = "macos")]
    if !logic::may_manage_job(job, true) {
        return Err("Unable to confirm the pacer service".to_owned());
    }
    #[cfg(target_os = "macos")]
    let output = manager_output("launchctl", &launchctl_args(action)).await?;
    #[cfg(not(target_os = "macos"))]
    let output = {
        let job = if job == logic::JobState::Unknown {
            job_state(&pacer_home(), service_port()).await.0
        } else {
            job
        };
        if !logic::may_manage_job(job, false) {
            return Err("The pacer service belongs to another pacer folder".to_owned());
        }
        if matches!(job, logic::JobState::NotLoaded | logic::JobState::Unknown) {
            if action == "restart" {
                return cli
                    .ok_or("Unable to find pacer")?
                    .run(&["service", "restart"])
                    .await
                    .map(|_| ());
            }
            let cli = cli.ok_or("Unable to find pacer")?;
            Command::new(&cli.binary)
                .arg("serve")
                .env("PATH", &cli.path)
                .env("PACER_HOME", &cli.pacer_home)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|_| "Unable to start pacer".to_owned())?;
            return Ok(());
        }
        manager_output(
            "systemctl",
            &[
                "--user".into(),
                if action == "restart" {
                    "restart"
                } else {
                    "start"
                }
                .into(),
                "pacer-serve.service".into(),
            ],
        )
        .await?
    };
    if output.status.success() {
        Ok(())
    } else {
        Err("Service manager action failed".into())
    }
}

#[cfg(not(target_os = "macos"))]
fn os_prompt() -> Option<&'static str> {
    None
}

#[cfg(target_os = "macos")]
fn os_prompt() -> Option<&'static str> {
    // Only window metadata, never pixels or AX/Screen Recording permissions.
    // An unrelated consent window must not be attributed to pacer. Redacted names
    // are inconclusive; only positive matches are shown as OS approval.
    use std::ffi::{c_char, c_void};
    type CF = *const c_void;
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(options: u32, relative_to: u32) -> CF;
        static kCGWindowOwnerName: CF;
        static kCGWindowName: CF;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(array: CF) -> isize;
        fn CFArrayGetValueAtIndex(array: CF, index: isize) -> CF;
        fn CFDictionaryGetValue(dictionary: CF, key: CF) -> CF;
        fn CFGetTypeID(value: CF) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFStringGetCString(string: CF, buffer: *mut c_char, size: isize, encoding: u32) -> bool;
        fn CFRelease(value: CF);
    }
    unsafe fn string(value: CF) -> String {
        if value.is_null() || CFGetTypeID(value) != CFStringGetTypeID() {
            return String::new();
        }
        let mut buffer = [0u8; 4096];
        if !CFStringGetCString(
            value,
            buffer.as_mut_ptr().cast(),
            buffer.len() as isize,
            0x08000100,
        ) {
            return String::new();
        }
        std::ffi::CStr::from_ptr(buffer.as_ptr().cast())
            .to_string_lossy()
            .into_owned()
    }
    unsafe {
        let windows = CGWindowListCopyWindowInfo(1 | 16, 0); // on-screen, exclude desktop
        if windows.is_null() {
            return None;
        }
        let mut detected = None;
        for index in 0..CFArrayGetCount(windows) {
            let window = CFArrayGetValueAtIndex(windows, index);
            let owner = string(CFDictionaryGetValue(window, kCGWindowOwnerName));
            let title = string(CFDictionaryGetValue(window, kCGWindowName));
            if let Some(kind) = logic::approval_window(&owner, &title) {
                detected = Some(kind);
                // Never overlook a volume dialog behind another approval window.
                if kind == "volume" {
                    break;
                }
            }
        }
        CFRelease(windows);
        detected
    }
}

fn privacy_prompt() -> bool {
    os_prompt() == Some("volume")
}

pub async fn monitor_approvals(app: AppHandle) {
    let mut previous = None;
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let prompt = os_prompt();
        if prompt != previous {
            desktop_log!("pacer approvals: visible OS dialog={prompt:?}");
            if prompt == Some("volume") {
                let path = app.state::<Shell>().waiting.lock().unwrap().clone();
                crate::diagnostic_recovery(&app, &logic::diagnosis("permission", path));
            } else if previous == Some("volume") {
                // Restore any ready webviews replaced while the OS dialog was open.
                app.state::<Shell>().expired.notify_one();
            }
            previous = prompt;
        }
        let message = match prompt {
            Some("notifications") => {
                "Allow pacer notifications in the macOS dialog to receive updates."
            }
            Some("login") => "Allow pacer in the macOS dialog to launch it at login.",
            _ => "",
        };
        let text = serde_json::to_string(message).unwrap();
        for label in ["main", "tray"] {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.eval(format!(r#"(() => {{
                    let banner = document.getElementById('pacer-os-approval');
                    if (!banner) {{ banner = document.createElement('p'); banner.id = 'pacer-os-approval';
                        banner.setAttribute('role', 'status'); document.body.prepend(banner); }}
                    banner.textContent = {text}; banner.hidden = !banner.textContent;
                }})()"#));
            }
        }
    }
}
