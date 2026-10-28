use crate::{link, logic, logic::same_path, profile, tray_model::TrayModel, Shell};
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
    std::env::var_os("PACER_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".pacer")
        })
}

fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The CLI packaged in this app bundle (`Contents/Resources/pacer`), only when the
/// complete signed OTA bundle layout validates.
pub(crate) fn bundled_binary() -> Option<PathBuf> {
    let current = std::env::current_exe().ok()?;
    match pacer_desktop::packaging::packaged_cli(&current) {
        Ok(path) => path.filter(|path| executable(path)),
        Err(error) => {
            desktop_log!("{error}");
            None
        }
    }
}

fn external_binary(path: &str, home: &Path, bundled: Option<&Path>) -> Option<PathBuf> {
    logic::candidates(path, home).into_iter().find(|candidate| {
        executable(candidate)
            && bundled.is_none_or(|bundled| {
                !same_path(candidate, bundled)
                    && !(candidate == &link::link_path(home)
                        && link::state(home, bundled) == link::LinkState::Ours)
            })
    })
}

fn install_binary(home: &Path, bundled: Option<&Path>, selected: &Path) -> Option<PathBuf> {
    if let Some(bundled) = bundled.filter(|bundled| same_path(selected, bundled)) {
        if link::state(home, bundled) == link::LinkState::Ours {
            return Some(link::link_path(home));
        }
        return Some(bundled.to_owned());
    }
    None
}

fn consent_choice(config: &Path) -> (bool, bool) {
    let file = config.join("consent.json");
    let keep = std::fs::read(&file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|record| record["keep"] == true);
    (file.exists(), keep)
}

#[cfg(target_os = "macos")]
async fn execute_takeover(app: &AppHandle, relink: bool) -> Result<String, String> {
    use base64::Engine;
    use sha2::Digest;
    let view = app.state::<Shell>().takeover.lock().unwrap().clone().ok_or("No service takeover was detected")?;
    let bundled = bundled_binary().ok_or("The bundled pacer command is missing")?;
    let user_home = required_home(std::env::var_os("HOME").as_deref())?;
    let trust = pacer_desktop::ota::trust::ReleaseTrust::configured().ok_or("Release trust unavailable")?;
    let registration = pacer_desktop::ota::control::observe_service_registration(
        &user_home, &view.candidate.home, view.candidate.port, &trust,
    ).map_err(|e| e.to_string())?.registration;
    if format!("{:x}", sha2::Sha256::digest(&registration)) != view.candidate.registration_sha256 { return Err("The service registration changed since inspection".into()) }
    let desktop = pacer_desktop::ota::native::process_details(std::process::id()).map_err(|e| e.to_string())?.ok_or("Desktop process identity is unavailable")?.identity;
    let authorized_at = pacer_desktop::ota::native::awake_now().map_err(|e| e.to_string())?;
    if desktop.boot_id != authorized_at.boot_id || view.candidate.process.boot_id != authorized_at.boot_id { return Err("Service process changed since inspection".into()) }
    let id = format!("desktop-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos());
    let manifest = pacer_desktop::ota::takeover::journal::TakeoverManifest {
        schema: 1, transaction_kind: "takeover".into(), transaction_id: id,
        candidate: view.candidate.clone(), desktop, bundled_cli: bundled.clone(),
        original_registration_b64: base64::engine::general_purpose::STANDARD.encode(registration), relink_terminal: relink, authorized_at,
    };
    let handle = app.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
        use std::os::fd::AsRawFd;
        use std::os::unix::net::UnixStream;
        use std::os::unix::process::CommandExt;
        let helper = bundled.parent().ok_or("Bundled helper directory missing")?.join("pacer-update-helper");
        let (mut parent, child) = UnixStream::pair().map_err(|e| e.to_string())?;
        parent.set_read_timeout(Some(std::time::Duration::from_secs(180))).map_err(|e| e.to_string())?;
        let child_fd = child.as_raw_fd();
        let mut command = std::process::Command::new(helper);
        command.arg("--ota-takeover");
        unsafe { command.pre_exec(move || {
            if libc::dup2(child_fd, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 { return Err(std::io::Error::last_os_error()) }
            Ok(())
        }); }
        let mut process = command.spawn().map_err(|e| e.to_string())?;
        drop(child);
        pacer_desktop::ota::control::write_frame(&mut parent, &manifest).map_err(|e| e.to_string())?;
        let mut final_state = None;
        while let Ok(progress) = pacer_desktop::ota::control::read_frame::<Value>(&mut parent) {
            let state = progress["state"].as_str().unwrap_or("").to_owned();
            crate::set_takeover_progress(&handle, progress);
            if matches!(state.as_str(), "committed" | "restored" | "recovery-failed") { final_state = Some(state); }
        }
        let status = process.wait().map_err(|e| e.to_string())?;
        final_state.ok_or_else(|| format!("Takeover helper stopped without a final state ({status})"))
    }).await.map_err(|e| e.to_string())??;
    if result == "committed" && relink {
        if let Err(error) = link::relink_after_takeover(&user_home, &bundled_binary().ok_or("Bundled command missing")?, &view.candidate.identity, std::time::SystemTime::now()) {
            crate::set_takeover_progress(app, serde_json::json!({"state":"committed","error":format!("The terminal command still runs the other build: {error}")}));
            desktop_log!("pacer lifecycle: takeover terminal relink failed: {error}");
            #[cfg(not(feature = "ota-fixture"))]
            {
                use tauri_plugin_notification::NotificationExt;
                let _ = app.notification().builder().title("Terminal command not changed")
                    .body(format!("The app's service is running, but the terminal command still runs the other build: {error}"))
                    .show();
            }
        }
    }
    Ok(result)
}

fn missing_link(home: &Path, bundled: Option<&Path>, config: &Path) -> bool {
    let (consented, keep) = consent_choice(config);
    logic::relink_needed(
        consented,
        keep,
        bundled.is_some(),
        bundled.is_some_and(|binary| link::state(home, binary) == link::LinkState::Missing),
    )
}

fn recreate_link(home: &Path, bundled: &Path, config: &Path) -> Result<(), String> {
    if !missing_link(home, Some(bundled), config) {
        return Err("The terminal link cannot be recreated without the app's setup consent and a missing link".into());
    }
    link::create(home, bundled, false)
}

// Inspect the loaded job, not a plist that may have changed since launchd loaded it.
#[cfg(test)]
fn loaded_job_matches(text: &str, binary: &Path, home: &Path, port: u16, default_home: &Path) -> bool {
    if logic::foreign_owner(
        &logic::launchd_environment(text),
        &default_home.to_string_lossy(),
        home,
        port,
    )
    .is_some()
    {
        return false;
    }
    let mut lines = text.lines().skip_while(|line| *line != "\targuments = {");
    lines.next();
    let Some(argument) = lines.next().map(str::trim).filter(|line| line.starts_with('/')) else {
        return false;
    };
    // Never treat two unresolved paths as proof of ownership.
    match (std::fs::canonicalize(argument), std::fs::canonicalize(binary)) {
        (Ok(job), Ok(cli)) => job == cli,
        _ => false,
    }
}

fn write_consent(config: &Path, path: bool, keep: bool) -> Result<(), String> {
    use std::fs::{self, DirBuilder, OpenOptions};
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(config)
        .map_err(|e| e.to_string())?;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let now = std::time::SystemTime::now();
    let temp = config.join(format!(
        ".consent-{}-{}-{}.tmp",
        std::process::id(),
        now.duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    let record = serde_json::json!({ "at": plist::Date::from(now).to_xml_format(), "path": path, "keep": keep });
    let result = (|| {
        file.write_all(record.to_string().as_bytes())?;
        file.sync_all()?;
        fs::rename(&temp, config.join("consent.json"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|e: std::io::Error| e.to_string())
}

#[derive(Debug)]
enum SetupError {
    Existing(String),
    Failed(String),
}

fn required_home(home: Option<&std::ffi::OsStr>) -> Result<PathBuf, String> {
    home.filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".into())
}

fn editable_rc(home: &Path, shell: &str) -> Option<PathBuf> {
    let rc = profile::rc_file(home, shell)?;
    match std::fs::symlink_metadata(&rc) {
        Ok(metadata) => (metadata.is_file()
            && !metadata.permissions().readonly()
            && std::fs::OpenOptions::new().write(true).open(&rc).is_ok())
        .then_some(rc),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(rc),
        Err(_) => None,
    }
}

fn setup_files(
    home: &Path,
    bundled: &Path,
    config: &Path,
    rc: Option<&Path>,
    replace: bool,
) -> Result<(), SetupError> {
    link::create(home, bundled, replace).map_err(SetupError::Existing)?;
    if let Some(rc) = rc {
        if let profile::EditOutcome::Skipped(reason) = profile::apply(rc) {
            return Err(SetupError::Failed(format!(
                "Could not add pacer to PATH: {} is {reason}",
                rc.display()
            )));
        }
    }
    if replace {
        match std::fs::remove_file(config.join("cli-choice.json")) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(SetupError::Failed(error.to_string())),
        }
    }
    write_consent(config, rc.is_some(), false).map_err(SetupError::Failed)
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
    pub fn find(
        path: &str,
        bundled: Option<&Path>,
        external: Option<&Path>,
        consented: bool,
        keep: bool,
        remembered: bool,
    ) -> Option<Self> {
        let explicit = std::env::var_os("PACER_BIN")
            .map(PathBuf::from)
            .filter(|p| executable(p));
        let (binary, _) = logic::cli_choice(
            explicit.as_deref(),
            bundled,
            external,
            consented,
            keep,
            remembered,
        );
        Self::at(binary?, path)
    }
    fn at(binary: PathBuf, path: &str) -> Option<Self> {
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
        let home = required_home(std::env::var_os("HOME").as_deref())?;
        command
            .args(args)
            .env("PATH", &self.path)
            .env("PACER_HOME", &self.pacer_home)
            .kill_on_drop(true);
        if let Some(binary) = install_binary(&home, bundled_binary().as_deref(), &self.binary) {
            command.env("PACER_BIN", binary);
        }
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
    service_version: Option<String>,
}
async fn count_active_tasks(session: &Session) -> Option<usize> {
    let mut count = 0usize;
    let mut before: Option<String> = None;
    let mut seen = std::collections::HashSet::new();
    for _ in 0..100 {
        let mut params = serde_json::json!({"states":["running","queued"],"limit":200});
        if let Some(cursor) = &before { params["before"] = serde_json::json!(cursor); }
        let page = session.op("task.list", &params).await.ok()?;
        count = count.checked_add(page["tasks"].as_array()?.len())?;
        let Some(next) = page["next"].as_str() else { return Some(count) };
        if !seen.insert(next.to_owned()) { return None }
        before = Some(next.to_owned());
    }
    None
}
impl Session {
    pub fn service_version(&self) -> Option<&str> { self.service_version.as_deref() }
    #[cfg(test)]
    pub(crate) fn for_capture_test(client: Client, origin: String) -> Self {
        Self { client, origin, service_version: None }
    }
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
        let mut session = Self {
            client,
            origin,
            service_version: None,
        };
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
        let hello = session.json("/v3/hello").await?;
        logic::check_hello(&hello).map_err(str::to_owned)?;
        session.service_version = hello["pacer"].as_str().map(str::to_owned);
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

fn retry_native_connection<T>(
    mut connect: impl FnMut() -> Result<T, pacer_desktop::ota::OtaError>,
) -> Result<T, pacer_desktop::ota::OtaError> {
    for attempt in 0..3 {
        match connect() {
            Ok(value) => return Ok(value),
            Err(error) if attempt == 2 => return Err(error),
            Err(_) => std::thread::sleep(Duration::from_millis(250)),
        }
    }
    unreachable!()
}

type NativeSupervision = (PathBuf, PathBuf, u16, pacer_desktop::ota::trust::ReleaseTrust);

/// Closes an unpublished native connection if its session future is cancelled.
/// The blocking handshake owns this guard before handing its result to the runtime.
struct PendingConnection<T> {
    value: Option<T>,
    close: fn(&T),
}
impl<T> PendingConnection<T> {
    fn new(value: T, close: fn(&T)) -> Self {
        Self { value: Some(value), close }
    }
    fn publish(mut self) -> T {
        self.value.take().unwrap()
    }
}
impl<T> Drop for PendingConnection<T> {
    fn drop(&mut self) {
        if let Some(value) = &self.value {
            (self.close)(value);
        }
    }
}
impl<T> std::ops::Deref for PendingConnection<T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.value.as_ref().unwrap()
    }
}

/// One verified native connection attempt (bounded retries), off the async runtime.
async fn connect_native(
    handle: AppHandle,
    user_home: PathBuf,
    home: PathBuf,
    port: u16,
    trust: pacer_desktop::ota::trust::ReleaseTrust,
    ticket: Option<pacer_desktop::ota::control::LaunchTicket>,
    adoption: Option<pacer_desktop::ota::control::AdoptionReconnectPlan>,
) -> Result<
    Result<PendingConnection<std::sync::Arc<pacer_desktop::ota::control::NativeConnection>>, pacer_desktop::ota::OtaError>,
    String,
> {
    tauri::async_runtime::spawn_blocking(move || {
        let callback = std::sync::Arc::new(move |kind: &str| {
            let shell = handle.state::<Shell>();
            if kind == "maintenance" {
                shell.maintenance.store(true, Ordering::SeqCst);
                #[cfg(target_os = "macos")]
                shell.relaunch.lock().unwrap().take();
            }
            if kind == "resume" {
                shell.maintenance.store(false, Ordering::SeqCst);
                shell.adoption.lock().unwrap().take();
            }
            if kind == "adoption-reconnect" {
                shell.maintenance.store(true, Ordering::SeqCst);
                shell.expired.notify_one();
            }
            if kind == "shutdown" {
                handle.exit(0);
            }
        });
        retry_native_connection(|| {
            // Each attempt rechecks the registration and signed process;
            // no failed observation becomes authority for the next one.
            let registered = pacer_desktop::ota::control::inspect_registered_service(
                &user_home, &home, port, &trust,
            )?;
            pacer_desktop::ota::control::NativeConnection::connect_adoption(
                &registered.endpoint(),
                &trust,
                ticket.as_ref(),
                adoption.as_ref(),
                callback.clone(),
            )
            .map(|native| PendingConnection::new(native, |native| native.close()))
        })
    })
    .await
    .map_err(|_| "Native service verification failed".to_owned())
}

/// When should a signed-in ordinary launch try to restore native update authority?
/// Never during maintenance, an adoption hand-off, or a helper-launched release:
/// those flows own the connection and end the session instead.
pub(crate) fn native_reconnect_due(
    alive: Option<bool>,
    maintenance: bool,
    connection_maintenance: bool,
    reconnect_plan: bool,
    ticket: bool,
) -> bool {
    alive != Some(true) && !maintenance && !connection_maintenance && !reconnect_plan && !ticket
}

/// Restores native update authority that dropped (or was refused at sign-in) while
/// the web session stays connected. Backs off to 30 seconds; never ends the session.
async fn supervise_native(app: &AppHandle, supervision: Option<NativeSupervision>) {
    let Some((user_home, home, port, trust)) = supervision else {
        return std::future::pending().await;
    };
    let mut delay = Duration::from_secs(2);
    let mut reported = false;
    loop {
        tokio::time::sleep(delay).await;
        let shell = app.state::<Shell>();
        let current = shell.native.lock().unwrap().clone();
        let due = native_reconnect_due(
            current.as_ref().map(|native| native.alive()),
            shell.maintenance.load(Ordering::SeqCst),
            current.as_ref().is_some_and(|native| native.maintenance_active()),
            current.as_ref().is_some_and(|native| native.reconnect_plan().is_some())
                || shell.adoption.lock().unwrap().is_some(),
            shell.navigation.lock().unwrap().ticket().is_some(),
        );
        if !due {
            delay = Duration::from_secs(2);
            continue;
        }
        match connect_native(app.clone(), user_home.clone(), home.clone(), port, trust.clone(), None, None).await {
            Ok(Ok(native)) => {
                // An ordinary launch carries no readiness proof; the signed-in page already
                // completed its own check, so only acknowledge after startup is ready.
                let ready = shell.startup.lock().unwrap().is_ready();
                let acknowledged = !ready || {
                    let native = std::sync::Arc::clone(&native);
                    tauri::async_runtime::spawn_blocking(move || native.document_ready(None))
                        .await
                        .is_ok_and(|result| result.is_ok())
                };
                if acknowledged {
                    if let Some(previous) = shell.native.lock().unwrap().replace(native.publish()) {
                        previous.close();
                    }
                    *shell.native_update_error.lock().unwrap() = None;
                    desktop_log!("pacer lifecycle: native update authority restored");
                    reported = false;
                    delay = Duration::from_secs(2);
                    continue;
                }
                *shell.native_update_error.lock().unwrap() = Some(pacer_desktop::ota::OtaError::Unavailable);
                // Dropping the unpublished result closes it, including when this
                // future is cancelled during document_ready above.
            }
            Ok(Err(error)) => {
                *shell.native_update_error.lock().unwrap() = Some(error);
                if !reported {
                    desktop_log!("pacer lifecycle: native update authority unavailable; retrying: {error}");
                    reported = true;
                }
            }
            Err(_) => {
                *shell.native_update_error.lock().unwrap() = Some(pacer_desktop::ota::OtaError::Unavailable);
            }
        }
        delay = (delay * 2).min(Duration::from_secs(30));
    }
}

async fn connected(app: &AppHandle, cli: &Cli, first_run: &mut FirstRun) -> Result<(), String> {
    desktop_log!("pacer lifecycle: requesting desktop sign-in link");
    let web_auth = cli.auth().await?;
    desktop_log!("pacer lifecycle: exchanging local service session");
    let session = Session::connect(cli, &web_auth).await?;
    first_run.signed_in = true;
    if app.state::<Shell>().diagnosis.lock().unwrap().as_ref().is_some_and(|d| d.page == "restored")
        && app.state::<Shell>().takeover_progress.lock().unwrap().as_ref().is_some_and(|p| p["state"] == "restored") {
        return Err("restored".into());
    }
    if !app.state::<Shell>().maintenance.load(Ordering::SeqCst)
        && app.state::<Shell>().adoption.lock().unwrap().is_none()
        && std::env::var_os("PACER_BIN").is_none()
    {
        let candidate = (|| {
            let trust = pacer_desktop::ota::trust::ReleaseTrust::configured()?;
            let config = app.path().app_config_dir().ok()?;
            let home = required_home(std::env::var_os("HOME").as_deref()).ok()?;
            let bundled = bundled_binary()?;
            match pacer_desktop::ota::takeover::detect::detect_takeover(&config, &home, &cli.pacer_home, service_port(), &bundled, &trust) {
                Ok(value) => value.map(|candidate| (candidate, config, bundled)),
                Err(error) => { desktop_log!("pacer lifecycle: takeover inspection unavailable: {error}"); None }
            }
        })();
        if let Some((candidate, config, bundled)) = candidate {
            let task_count = tokio::time::timeout(Duration::from_secs(3), count_active_tasks(&session)).await.ok().flatten();
            let terminal_count = tokio::time::timeout(Duration::from_secs(2), session.op("terminal.list", &serde_json::json!({}))).await.ok().and_then(Result::ok)
                .and_then(|value| value.as_array().map(|rows| rows.iter().filter(|row| row["live"] == true).count()));
            let inspection = serde_json::json!({
                "currentPath":candidate.canonical_program,
                "currentVersion":session.service_version(),
                "replacementPath":bundled,
                "label":candidate.label,
                "port":candidate.port,
                "dataHome":candidate.home,
                "work":{"tasks":task_count,"terminals":terminal_count}
            });
            *app.state::<Shell>().takeover.lock().unwrap() = Some(crate::TakeoverView { candidate: candidate.clone(), inspection });
            if logic::launch_gate(true, logic::takeover_dismissed(&config, &candidate.identity), true) == logic::LaunchGate::Takeover {
                crate::recovery(app, "takeover");
                return Err("takeover".into());
            }
        } else {
            *app.state::<Shell>().takeover.lock().unwrap() = None;
        }
    }
    let accepted = app.state::<Shell>().old_service_ack.lock().unwrap().clone();
    let gate = logic::service_gate(
        env!("CARGO_PKG_VERSION"),
        session.service_version.as_deref(),
        accepted.as_deref(),
    );
    if gate != logic::ServiceGate::Open {
        let page = if gate == logic::ServiceGate::ExplainOlder {
            "outdatedService"
        } else {
            "unverifiedService"
        };
        let mut detail = logic::diagnosis(page, None);
        *app.state::<Shell>().pending_service_key.lock().unwrap() =
            Some(session.service_version.clone().unwrap_or_default());
        detail.installed = Some(logic::display_service_release(
            session.service_version.as_deref(),
        ));
        detail.version = Some(env!("CARGO_PKG_VERSION").into());
        crate::diagnostic_recovery(app, &detail);
        return Err(page.into());
    }
    if matches!(
        logic::service_release(env!("CARGO_PKG_VERSION"), session.service_version.as_deref()),
        logic::ServiceRelease::Matched | logic::ServiceRelease::Newer
    ) {
        *app.state::<Shell>().old_service_ack.lock().unwrap() = None;
        *app.state::<Shell>().pending_service_key.lock().unwrap() = None;
    }

    let snapshot = wait_for_snapshot(app, &session).await?;
    if snapshot["service"]["starting"] == true
        || snapshot["snapshot"]["service"]["starting"] == true
    {
        return Err("starting".into());
    }
    let registration = session.op("client.register", &serde_json::json!({"kind":"desktop","version":env!("CARGO_PKG_VERSION"),"notifier":true,"capture":true})).await?;
    let client_id = registration["client_id"]
        .as_str()
        .ok_or("Missing client id")?
        .to_owned();
    let seq = snapshot["seq"].as_u64().unwrap_or(0);
    if logic::local_origin(&web_auth).as_deref() != Some(&session.origin) {
        return Err("stopped".into());
    }
    // Native update authority for an ordinary launch is re-established if it drops.
    let mut supervision = None;
    if let Some(trust) = pacer_desktop::ota::trust::ReleaseTrust::configured() {
        let user_home = PathBuf::from(std::env::var_os("HOME").ok_or("Native user home missing")?);
        let home = cli.pacer_home.clone();
        let port = service_port();
        let handle = app.clone();
        let ticket = app
            .state::<Shell>()
            .navigation
            .lock()
            .unwrap()
            .ticket()
            .cloned();
        let adoption = app.state::<Shell>().adoption.lock().unwrap().clone();
        let maintenance_launch = ticket.is_some() || adoption.is_some();
        if !maintenance_launch {
            supervision = Some((user_home.clone(), home.clone(), port, trust.clone()));
        }
        let native = connect_native(
            handle,
            user_home.clone(),
            home.clone(),
            port,
            trust.clone(),
            ticket,
            adoption,
        )
        .await?;
        match native {
            Ok(native) => {
                *app.state::<Shell>().native_update_error.lock().unwrap() = None;
                #[cfg(feature = "ota-fixture")]
                if let Some(ticket) = app.state::<Shell>().navigation.lock().unwrap().ticket() {
                    if ticket.desktop_version == env!("CARGO_PKG_VERSION")
                        && pacer_desktop::ota::fixture_fault::consume(
                            pacer_desktop::ota::fixture_fault::Point::CandidateStartup,
                            &ticket.installation_id,
                            &ticket.transaction_id,
                        )
                        .map_err(|_| "Fixture startup fault verification failed")?
                    {
                        unsafe {
                            libc::_exit(86);
                        }
                    }
                }
                *app.state::<Shell>().native.lock().unwrap() = Some(native.publish());
            }
            Err(error) if maintenance_launch => {
                desktop_log!("pacer lifecycle: native maintenance verification failed: {error}");
                return Err("Native maintenance verification failed".into());
            }
            Err(error) => {
                *app.state::<Shell>().native_update_error.lock().unwrap() = Some(error);
                desktop_log!("pacer lifecycle: native update authority unavailable for this service: {error}");
            }
        }
    }
    #[cfg(feature = "ota-fixture")]
    {
        let tray_auth = cli.auth().await?;
        if !logic::fixture_tray_auth(&tray_auth, &session.origin) {
            return Err("Isolated tray service origin changed".into());
        }
        *app.state::<Shell>().fixture_tray_auth.lock().unwrap() = Some(tray_auth);
    }
    crate::activate(app, &session.origin, web_auth)?;
    *app.state::<Shell>().session.lock().unwrap() = Some(session.clone());
    crate::update_tray(app, TrayModel::from_snapshot(&snapshot));
    let shell = app.state::<Shell>();
    let result = tokio::select! {
        result = listen(app, &session, &client_id, seq) => result,
        result = heartbeat(app, &session, &client_id) => result,
        _ = async {
            if let Some(token) = registration["capture_worker"].as_str() {
                if crate::capture::worker(app, &session, &client_id, token).await.is_err() {
                    desktop_log!("Desktop capture observer disconnected; normal service session remains active");
                }
            }
            std::future::pending::<()>().await;
        } => unreachable!(),
        _ = supervise_native(app, supervision) => Err("stopped".into()),
        _ = shell.expired.notified() => Err(if shell.diagnosis.lock().unwrap().as_ref().is_some_and(|d| d.page == "takeover")
            || *shell.shell_action.lock().unwrap() == Some(logic::ShellAction::TakeoverOpen) { "takeover" } else { "sessionExpired" }.into()),
    };
    if let Some(native) = shell.native.lock().unwrap().take() {
        if let Some(plan) = native.reconnect_plan() {
            *shell.adoption.lock().unwrap() = Some(plan);
        }
        native.close();
    }
    shell.navigation.lock().unwrap().invalidate();
    result
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
async fn heartbeat(app: &AppHandle, session: &Session, client_id: &str) -> Result<(), String> {
    let mut missing_reported = false;
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        if !missing_reported {
            if let (Ok(home), Ok(config)) = (
                required_home(std::env::var_os("HOME").as_deref()),
                app.path().app_config_dir(),
            ) {
                if missing_link(&home, bundled_binary().as_deref(), &config) {
                    desktop_log!("pacer lifecycle: terminal command was removed; keeping the signed-in service connected");
                    missing_reported = true;
                }
            }
        }

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

#[derive(Default)]
struct FirstRun {
    error: Option<logic::Diagnosis>,
    error_since: Option<std::time::Instant>,
    decision: Option<logic::Onboarding>,
    version: Option<(PathBuf, Option<std::time::SystemTime>, Option<String>)>,
    reinstall: bool,
    signed_in: bool,
}

enum OnboardingGate {
    Wait,
    Ready(Option<Cli>),
}

impl FirstRun {
    fn clear_error(&mut self, now: std::time::Instant, action: bool) {
        if action
            || self.error_since.is_some_and(|since| {
                now.saturating_duration_since(since) >= Duration::from_secs(10)
            })
        {
            self.error = None;
            self.error_since = None;
        }
    }

    fn page(
        &mut self,
        decision: logic::Onboarding,
        page: &mut Option<logic::Onboarding>,
    ) -> logic::Onboarding {
        if self.decision != Some(decision) {
            *page = None;
            self.decision = Some(decision);
        }
        page.unwrap_or(decision)
    }

    async fn installed_version(&mut self, cli: &Cli) -> Option<String> {
        let modified = std::fs::metadata(&cli.binary)
            .ok()
            .and_then(|metadata| metadata.modified().ok());
        if let Some((path, mtime, version)) = &self.version {
            if path == &cli.binary && *mtime == modified {
                return version.clone();
            }
        }
        let version = cli
            .run(&["--version"])
            .await
            .ok()
            .map(|version| version.trim().to_owned());
        // A transient spawn/version error must be retried; only cache successful reads.
        self.version = version
            .as_ref()
            .map(|_| (cli.binary.clone(), modified, version.clone()));
        version
    }

    fn recovery_state(
        &self,
        health: logic::HealthProbe,
        job: logic::JobState,
    ) -> (logic::HealthProbe, logic::JobState) {
        if self.reinstall
            && matches!(
                job,
                logic::JobState::NotLoaded | logic::JobState::Stopped | logic::JobState::Running
            )
        {
            (logic::HealthProbe::Refused, logic::JobState::NotLoaded)
        } else if self.reinstall && job == logic::JobState::Unknown {
            // Keep polling ownership instead of entering a long-lived connection.
            (logic::HealthProbe::Unreachable, job)
        } else {
            (health, job)
        }
    }

    async fn prepare(
        &mut self,
        app: &AppHandle,
        path: &str,
        healthy: bool,
        blocked: bool,
    ) -> OnboardingGate {
        self.clear_error(std::time::Instant::now(), false);
        let home = match required_home(std::env::var_os("HOME").as_deref()) {
            Ok(home) => home,
            Err(error) => {
                self.fail(error);
                crate::diagnostic_recovery(app, self.error.as_ref().unwrap());
                return OnboardingGate::Wait;
            }
        };
        let bundled = bundled_binary();
        let config = match app.path().app_config_dir() {
            Ok(config) => config,
            Err(error) => {
                self.fail(error.to_string());
                crate::diagnostic_recovery(app, self.error.as_ref().unwrap());
                return OnboardingGate::Wait;
            }
        };
        let (consented, keep) = consent_choice(&config);
        let external = external_binary(path, &home, bundled.as_deref());
        let mut installed = None;
        let mut remembered = false;
        if let Some(cli) = external.clone().filter(|_| !consented || keep).and_then(|binary| Cli::at(binary, path)) {
            if let Some(version) = self.installed_version(&cli).await {
                remembered = link::remembered(&config, &cli.binary.to_string_lossy(), &version);
                installed = Some(version);
            }
        }
        if blocked {
            // Discovery can reconnect a healthy service while permission/ownership guidance
            // remains visible, but must not consume setup actions or write consent.
            return OnboardingGate::Ready(Cli::find(
                path,
                bundled.as_deref(),
                external.as_deref(),
                consented,
                keep,
                remembered,
            ));
        }
        let decision = if healthy {
            logic::Onboarding::Ready
        } else {
            logic::onboarding(
                consented && (!keep || remembered),
                external.as_ref().and_then(|p| p.to_str()),
                remembered,
                bundled.is_some(),
            )
        };
        // Clear a stale Welcome/Consent override before processing a new action.
        self.page(
            decision,
            &mut app.state::<Shell>().onboarding_page.lock().unwrap(),
        );
        let shell = std::env::var("SHELL").unwrap_or_default();
        let rc = editable_rc(&home, &shell);
        let pending = app.state::<Shell>().shell_action.lock().unwrap().take();
        if let Some(action) = pending {
            self.clear_error(std::time::Instant::now(), true);
            match action {
                logic::ShellAction::Begin => {
                    *app.state::<Shell>().onboarding_page.lock().unwrap() =
                        Some(logic::Onboarding::Consent);
                }
                logic::ShellAction::Download => crate::open_external(
                    &Url::parse("https://github.com/lamtuanvu/pacer/releases/latest").unwrap(),
                ),
                logic::ShellAction::Consent { .. } | logic::ShellAction::UseApp => {
                    let replace = action == logic::ShellAction::UseApp;
                    let rc = if matches!(action, logic::ShellAction::Consent { path: true }) {
                        rc.as_deref()
                    } else {
                        None
                    };
                    let result = bundled
                        .as_deref()
                        .ok_or_else(|| {
                            SetupError::Failed("The bundled pacer command is missing".into())
                        })
                        .and_then(|bundled| setup_files(&home, bundled, &config, rc, replace));
                    match result {
                        Ok(()) => {
                            *app.state::<Shell>().onboarding_page.lock().unwrap() = None;
                            app.state::<Shell>().startup.lock().unwrap().ready();
                            crate::recovery(app, "starting");
                            // The normal lifecycle owns retries and backoff after setup succeeds.
                            self.reinstall = replace;
                        }
                        Err(SetupError::Existing(error)) if !replace => {
                            *app.state::<Shell>().onboarding_page.lock().unwrap() =
                                Some(logic::Onboarding::Existing);
                            let mut detail = logic::diagnosis(
                                "existing",
                                external.as_ref().map(|p| p.to_string_lossy().into_owned()),
                            );
                            detail.error = Some(error);
                            detail.installed = installed.clone();
                            detail.version = Some(env!("CARGO_PKG_VERSION").into());
                            self.error = Some(detail);
                            self.error_since = Some(std::time::Instant::now());
                        }
                        Err(SetupError::Existing(error) | SetupError::Failed(error)) => {
                            self.fail(error)
                        }
                    }
                }
                logic::ShellAction::KeepMine => {
                    if let (Some(external), Some(version)) = (&external, &installed) {
                        let choice = link::KeepMine {
                            path: external.to_string_lossy().into_owned(),
                            version: version.clone(),
                        };
                        if let Err(error) = link::remember(&config, &choice)
                            .and_then(|_| write_consent(&config, false, true))
                        {
                            self.fail(error);
                        } else {
                            *app.state::<Shell>().onboarding_page.lock().unwrap() = None;
                        }
                    } else {
                        self.fail("Unable to read the installed pacer version".into());
                    }
                }
                logic::ShellAction::Relink => {
                    if let Err(error) = bundled
                        .as_deref()
                        .ok_or("The bundled pacer command is missing".to_owned())
                        .and_then(|bundled| recreate_link(&home, bundled, &config))
                    {
                        self.fail(error);
                    }
                }
                logic::ShellAction::ContinueOldService => {
                    let service_version = app
                        .state::<Shell>()
                        .diagnosis
                        .lock()
                        .unwrap()
                        .as_ref()
                        .filter(|d| matches!(d.page, "outdatedService" | "unverifiedService"))
                        .and_then(|_| {
                            app.state::<Shell>()
                                .pending_service_key
                                .lock()
                                .unwrap()
                                .clone()
                        });
                    *app.state::<Shell>().old_service_ack.lock().unwrap() = service_version;
                    *app.state::<Shell>().diagnosis.lock().unwrap() = None;
                }
                logic::ShellAction::TakeoverOpen => crate::recovery(app, "takeover"),
                logic::ShellAction::TakeoverDismiss => {
                    if let Some(view) = app.state::<Shell>().takeover.lock().unwrap().clone() {
                        if let Err(error) = logic::dismiss_takeover(&config, &view.candidate.identity) { self.fail(error); }
                        else {
                            *app.state::<Shell>().takeover_progress.lock().unwrap() = None;
                            crate::recovery(app, "starting");
                        }
                    }
                }
                logic::ShellAction::TakeoverConfirm { relink } => {
                    #[cfg(target_os = "macos")]
                    let result = execute_takeover(app, relink).await;
                    #[cfg(not(target_os = "macos"))]
                    let result: Result<String, String> = Err("Service takeover is only available on macOS".into());
                    match result.as_deref() {
                        Ok("committed") => {
                            *app.state::<Shell>().takeover.lock().unwrap() = None;
                            crate::recovery(app, "starting");
                        }
                        Ok("restored") => {
                            let mut detail = logic::diagnosis("restored", None);
                            detail.error = app.state::<Shell>().takeover_progress.lock().unwrap().as_ref().and_then(|p| p["error"].as_str().map(str::to_owned));
                            crate::diagnostic_recovery(app, &detail);
                        }
                        Ok("recovery-failed") => crate::recovery(app, "recoveryFailed"),
                        _ => crate::set_takeover_progress(app, serde_json::json!({"state":"error","error":result.err().unwrap_or("Unexpected takeover state".into())})),
                    }
                }
            }
            // Re-read consent and CLI preference after the action, before any service operation.
            if self.error.is_none() && action != logic::ShellAction::Begin {
                return OnboardingGate::Wait;
            }
        }
        if let Some(detail) = &self.error {
            crate::diagnostic_recovery(app, detail);
            return OnboardingGate::Wait;
        }
        let bundle_app = std::env::current_exe().ok().is_some_and(|exe| {
            exe.to_string_lossy().contains(".app/Contents/MacOS/")
        });
        let explicit_cli = std::env::var_os("PACER_BIN")
            .is_some_and(|binary| executable(Path::new(&binary)));
        if let Some(page) = logic::recovery_for(
            bundle_app,
            bundled.is_some(),
            external.is_some() || explicit_cli,
        ) {
            crate::diagnostic_recovery(app, &logic::diagnosis(page, None));
            return OnboardingGate::Wait;
        }
        if missing_link(&home, bundled.as_deref(), &config)
            && !self.signed_in
            && !app.state::<Shell>().relink_dismissed.load(Ordering::SeqCst)
        {
            crate::diagnostic_recovery(app, &logic::diagnosis("relink", None));
            return OnboardingGate::Wait;
        }
        if healthy && !consented {
            if let Err(error) = write_consent(&config, false, false) {
                self.fail(error);
                crate::diagnostic_recovery(app, self.error.as_ref().unwrap());
                return OnboardingGate::Wait;
            }
            *app.state::<Shell>().onboarding_page.lock().unwrap() = None;
        }
        let decision = self.page(
            decision,
            &mut app.state::<Shell>().onboarding_page.lock().unwrap(),
        );
        if decision != logic::Onboarding::Ready {
            let page = match decision {
                logic::Onboarding::Welcome => "welcome",
                logic::Onboarding::Consent => "consent",
                logic::Onboarding::Existing => "existing",
                logic::Onboarding::Ready => unreachable!(),
            };
            let mut detail = logic::diagnosis(
                page,
                external.as_ref().map(|p| p.to_string_lossy().into_owned()),
            );
            detail.rc =
                rc.map(|p| logic::display_home(&p.to_string_lossy(), &home.to_string_lossy()));
            detail.on_path = Some(profile::on_path(path, &home));
            detail.installed = installed;
            detail.version = Some(env!("CARGO_PKG_VERSION").into());
            crate::diagnostic_recovery(app, &detail);
            return OnboardingGate::Wait;
        }
        OnboardingGate::Ready(Cli::find(
            path,
            bundled.as_deref(),
            external.as_deref(),
            consented || healthy,
            keep,
            remembered,
        ))
    }

    fn fail(&mut self, error: String) {
        let mut detail = logic::diagnosis("stuck", None);
        detail.error = Some(error);
        self.error = Some(detail);
        self.error_since = Some(std::time::Instant::now());
    }
}

fn takeover_hold(app: &AppHandle) -> Option<&'static str> {
    let shell = app.state::<Shell>();
    let progress = shell.takeover_progress.lock().unwrap().as_ref().and_then(|p| p["state"].as_str().map(str::to_owned));
    let page = shell.diagnosis.lock().unwrap().as_ref().map(|d| d.page);
    logic::takeover_hold(progress.as_deref(), page)
}

pub async fn run(app: AppHandle) {
    if let Err(error) = required_home(std::env::var_os("HOME").as_deref()) {
        let mut detail = logic::diagnosis("stuck", None);
        detail.error = Some(error);
        crate::diagnostic_recovery(&app, &detail);
        return;
    }
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
    let mut first_run = FirstRun::default();
    loop {
        let waiting_for_service_choice = app
            .state::<Shell>()
            .diagnosis
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|d| matches!(d.page, "outdatedService" | "unverifiedService"))
            || takeover_hold(&app).is_some();
        let delay = logic::connection_retry_delay(
            attempts.delay(std::time::Instant::now()),
            waiting_for_service_choice,
        );
        let shell = app.state::<Shell>();
        tokio::select! {
            _ = tokio::time::sleep(delay) => {},
            _ = shell.wake.notified() => {},
        }
        attempts.started(std::time::Instant::now());
        let _ = tokio::time::timeout(Duration::ZERO, app.state::<Shell>().expired.notified()).await;
        if app.state::<Shell>().retry.swap(false, Ordering::SeqCst) {
            path = Cli::login_path().await;
        }
        let probe = health(&probe_client).await;
        // Preserve ownership for sustained failed probes, including stale heartbeats.
        let (job, owner) = if matches!(
            probe,
            logic::HealthProbe::Refused | logic::HealthProbe::NoAnswer
        ) || first_run.reinstall
        {
            job_state(&pacer_home(), service_port()).await
        } else {
            (logic::JobState::Unknown, None)
        };
        let waiting = app.state::<Shell>().waiting.lock().unwrap().clone();
        let prompt = privacy_prompt();
        let permission = waiting.is_some() || prompt;
        let cli = match first_run
            .prepare(
                &app,
                &path,
                probe == logic::HealthProbe::Ready,
                job == logic::JobState::Foreign || permission,
            )
            .await
        {
            OnboardingGate::Wait => {
                lifecycle.ready();
                continue;
            }
            OnboardingGate::Ready(cli) => cli,
        };
        if let Some(page) = takeover_hold(&app) {
            // A finished takeover keeps its outcome page; never re-detect and re-offer.
            if app.state::<Shell>().diagnosis.lock().unwrap().as_ref().is_none_or(|d| d.page != page) {
                crate::recovery(&app, page);
            }
            continue;
        }
        let (recovery_probe, recovery_job) = if permission {
            (probe, job)
        } else {
            first_run.recovery_state(probe, job)
        };
        let action = lifecycle.step(
            clock.elapsed().as_secs(),
            recovery_probe,
            recovery_job,
            permission,
        );
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
        let page = logic::shell_page(
            permission,
            action,
            probe,
            job,
            cli.is_some(),
            cfg!(target_os = "macos"),
        );
        let page = update_copy(
            &app,
            page,
            matches!(probe, logic::HealthProbe::Ready | logic::HealthProbe::Starting),
        );
        let detail = match (page, &owner) {
            ("permission", _) => logic::diagnosis(page, waiting),
            ("foreign", Some(owner)) => logic::foreign_diagnosis(
                owner,
                &pacer_home(),
                service_port(),
                &std::env::var("HOME").unwrap_or_default(),
            ),
            _ => logic::diagnosis(page, None),
        };
        let holding_version_page = page == "starting"
            && probe == logic::HealthProbe::Ready
            && app
                .state::<Shell>()
                .diagnosis
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|d| matches!(d.page, "outdatedService" | "unverifiedService" | "takeover" | "restored"));
        if !holding_version_page {
            crate::diagnostic_recovery(&app, &detail);
        }
        if matches!(page, "install" | "foreign") || (permission && cli.is_none()) {
            // Nothing this shell may do: no CLI to install with, or the job serves another pacer.
            continue;
        }
        match action {
            logic::RecoveryAction::Install
            | logic::RecoveryAction::Start
            | logic::RecoveryAction::Restart => {
                if app.state::<Shell>().maintenance.load(Ordering::SeqCst) {
                    continue;
                }
                if !app.path().app_config_dir().is_ok_and(|config| consent_choice(&config).0) {
                    desktop_log!("pacer lifecycle: waiting for setup consent before service changes");
                    continue;
                }
                let mut action_job = job;
                for name in logic::service_steps(action) {
                    if app.state::<Shell>().maintenance.load(Ordering::SeqCst) {
                        break;
                    }
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
                        first_run.reinstall = false;
                        action_job = logic::JobState::Stopped;
                    }
                }
            }
            logic::RecoveryAction::Connect => {
                if let Some(cli) = cli {
                    let result = tokio::select! {
                        result = connected(&app, &cli, &mut first_run) => result,
                        result = monitor_health(&probe_client) => result,
                    };
                    if let Err(error) = result {
                        if matches!(error.as_str(), "outdatedService" | "unverifiedService" | "takeover" | "restored") {
                            desktop_log!("pacer lifecycle: live service release needs user review; waiting for choice");
                            continue;
                        }
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
                        let page = update_copy(
                            &app,
                            logic::recovery_page(&error),
                            !matches!(error.as_str(), "stopped" | "diagnose"),
                        );
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
    #[test]
    fn cancelled_native_connect_closes_its_late_result() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (release, wait) = std::sync::mpsc::channel();
        let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = closed.clone();
        let task = runtime.spawn_blocking(move || {
            wait.recv().unwrap();
            PendingConnection::new(observed, |closed| closed.store(true, Ordering::SeqCst))
        });
        drop(task);
        release.send(()).unwrap();
        drop(runtime);
        assert!(closed.load(Ordering::SeqCst));
    }

    #[test]
    fn cancelled_native_readiness_closes_even_with_a_worker_reference() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let worker = closed.clone();
        let (ready, waiting) = std::sync::mpsc::channel();
        let task = runtime.spawn(async move {
            let _pending = PendingConnection::new(closed, |closed| {
                closed.store(true, Ordering::SeqCst)
            });
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        waiting.recv().unwrap();
        task.abort();
        assert!(runtime.block_on(task).unwrap_err().is_cancelled());
        assert!(worker.load(Ordering::SeqCst));
    }

    #[test]
    fn published_native_connection_stays_open_for_the_session() {
        let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let pending = PendingConnection::new(closed.clone(), |closed| {
            closed.store(true, Ordering::SeqCst)
        });
        let native = pending.publish();
        assert!(!native.load(Ordering::SeqCst));
    }

    #[test]
    fn native_authority_reconnects_only_for_an_ordinary_signed_in_launch() {
        use super::native_reconnect_due as due;
        // Dropped or never-established authority on an ordinary launch is restored.
        assert!(due(Some(false), false, false, false, false));
        assert!(due(None, false, false, false, false));
        // A live connection is left alone.
        assert!(!due(Some(true), false, false, false, false));
        // Maintenance, adoption hand-offs and helper-launched releases own the connection.
        assert!(!due(Some(false), true, false, false, false));
        assert!(!due(Some(false), false, true, false, false));
        assert!(!due(None, false, false, true, false));
        assert!(!due(None, false, false, false, true));
    }
    #[test]
    fn native_connection_retries_fresh_verification_and_remains_bounded() {
        let mut attempts = 0;
        let result = super::retry_native_connection(|| {
            attempts += 1;
            if attempts < 3 {
                Err(pacer_desktop::ota::OtaError::Unavailable)
            } else {
                Ok(7)
            }
        });
        assert_eq!(result.unwrap(), 7);
        assert_eq!(attempts, 3);
        attempts = 0;
        let result: Result<(), _> = super::retry_native_connection(|| {
            attempts += 1;
            Err(pacer_desktop::ota::OtaError::Identity)
        });
        assert!(result.is_err());
        assert_eq!(attempts, 3);
    }
    use super::*;
    use std::io::{Read, Write};
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "pacer-onboarding-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn version_recovery_matches_loaded_arguments_by_realpath_and_home_and_port() {
        let dir = TempDir::new();
        let binary = dir.0.join("pacer");
        let linked = dir.0.join("terminal-pacer");
        std::fs::write(&binary, "cli").unwrap();
        std::os::unix::fs::symlink(&binary, &linked).unwrap();
        let output = format!("job = {{\n\targuments = {{\n\t\t{}\n\t\tserve\n\t}}\n\tenvironment = {{\n\t\tPACER_HOME => {}\n\t\tPACER_PORT => 5321\n\t}}\n}}", linked.display(), dir.0.display());
        assert!(loaded_job_matches(&output, &binary, &dir.0, 5321, &dir.0));
        assert!(!loaded_job_matches(&output, &binary, &dir.0, 4317, &dir.0));
        assert!(!loaded_job_matches(&output, &binary, &dir.0.join("other"), 5321, &dir.0));
        let other = dir.0.join("other-cli");
        std::fs::write(&other, "cli").unwrap();
        assert!(!loaded_job_matches(&output, &other, &dir.0, 5321, &dir.0));
        assert!(!loaded_job_matches("", &binary, &dir.0, 5321, &dir.0));
        std::fs::remove_file(&binary).unwrap();
        assert!(!loaded_job_matches(&output, &linked, &dir.0, 5321, &dir.0));
    }

    #[test]
    fn relink_action_cannot_create_a_link_before_consent_or_after_keep_mine() {
        let dir = TempDir::new();
        let config = dir.0.join("config");
        let bundled = dir.0.join("pacer");
        std::fs::write(&bundled, "cli").unwrap();
        assert!(recreate_link(&dir.0, &bundled, &config).is_err());
        assert!(!link::link_path(&dir.0).exists());
        write_consent(&config, false, true).unwrap();
        assert!(recreate_link(&dir.0, &bundled, &config).is_err());
        write_consent(&config, false, false).unwrap();
        recreate_link(&dir.0, &bundled, &config).unwrap();
        assert_eq!(std::fs::read_link(link::link_path(&dir.0)).unwrap(), bundled);
    }

    #[test]
    fn first_run_error_clears_at_ten_seconds_or_next_action() {
        let now = std::time::Instant::now();
        let mut state = FirstRun::default();
        state.fail("temporary failure".into());
        state.error_since = Some(now);
        state.clear_error(now + Duration::from_secs(9), false);
        assert!(state.error.is_some());
        state.clear_error(now + Duration::from_secs(10), false);
        assert!(state.error.is_none());
        state.fail("retry failure".into());
        state.clear_error(now, true);
        assert!(state.error.is_none());
    }

    #[test]
    fn onboarding_override_is_cleared_when_the_decision_changes() {
        let mut state = FirstRun::default();
        let mut page = None;
        assert_eq!(
            state.page(logic::Onboarding::Welcome, &mut page),
            logic::Onboarding::Welcome
        );
        page = Some(logic::Onboarding::Consent);
        assert_eq!(
            state.page(logic::Onboarding::Welcome, &mut page),
            logic::Onboarding::Consent
        );
        assert_eq!(
            state.page(logic::Onboarding::Existing, &mut page),
            logic::Onboarding::Existing
        );
        assert_eq!(page, None);
        page = Some(logic::Onboarding::Existing);
        assert_eq!(
            state.page(logic::Onboarding::Ready, &mut page),
            logic::Onboarding::Ready
        );
        assert_eq!(page, None);
    }

    #[test]
    fn missing_home_does_not_become_a_relative_install_path() {
        assert_eq!(required_home(None), Err("HOME is not set".into()));
        assert_eq!(
            required_home(Some(std::ffi::OsStr::new(""))),
            Err("HOME is not set".into())
        );
    }

    #[test]
    fn consent_offers_only_editable_regular_or_missing_profiles() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = TempDir::new();
        let rc = dir.0.join(".zshrc");
        assert_eq!(editable_rc(&dir.0, "/bin/zsh"), Some(rc.clone()));
        std::fs::write(&rc, "original").unwrap();
        assert_eq!(editable_rc(&dir.0, "/bin/zsh"), Some(rc.clone()));
        std::fs::set_permissions(&rc, std::fs::Permissions::from_mode(0o444)).unwrap();
        assert_eq!(editable_rc(&dir.0, "/bin/zsh"), None);
        std::fs::remove_file(&rc).unwrap();
        symlink(dir.0.join("missing"), &rc).unwrap();
        assert_eq!(editable_rc(&dir.0, "/bin/zsh"), None);
        assert_eq!(editable_rc(&dir.0, "/bin/fish"), None);
    }

    #[tokio::test]
    async fn version_probe_is_cached_by_path_and_mtime() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new();
        let binary = dir.0.join("pacer");
        std::fs::write(
            &binary,
            "#!/bin/sh\necho probe >> \"$PACER_HOME/probes\"\necho 0.2.3\n",
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let cli = Cli {
            binary: binary.clone(),
            path: "/usr/bin:/bin".into(),
            pacer_home: dir.0.clone(),
        };
        let mut state = FirstRun::default();
        assert_eq!(
            state.installed_version(&cli).await.as_deref(),
            Some("0.2.3")
        );
        assert_eq!(
            state.installed_version(&cli).await.as_deref(),
            Some("0.2.3")
        );
        assert_eq!(
            std::fs::read_to_string(dir.0.join("probes")).unwrap(),
            "probe\n"
        );
        let modified = std::fs::metadata(&binary).unwrap().modified().unwrap();
        std::fs::File::open(&binary)
            .unwrap()
            .set_modified(modified + Duration::from_secs(2))
            .unwrap();
        state.installed_version(&cli).await;
        let other = dir.0.join("other");
        std::fs::copy(&binary, &other).unwrap();
        let other = Cli {
            binary: other,
            ..cli
        };
        state.installed_version(&other).await;
        assert_eq!(
            std::fs::read_to_string(dir.0.join("probes")).unwrap(),
            "probe\nprobe\nprobe\n"
        );
    }

    #[tokio::test]
    async fn a_failed_version_probe_can_recover_without_changing_the_binary() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new();
        let binary = dir.0.join("pacer");
        std::fs::write(
            &binary,
            "#!/bin/sh\nif [ -f \"$PACER_HOME/ready\" ]; then echo 0.2.3; else exit 1; fi\n",
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let cli = Cli {
            binary,
            path: "/usr/bin:/bin".into(),
            pacer_home: dir.0.clone(),
        };
        let mut state = FirstRun::default();
        assert_eq!(state.installed_version(&cli).await, None);
        std::fs::write(dir.0.join("ready"), "").unwrap();
        assert_eq!(
            state.installed_version(&cli).await.as_deref(),
            Some("0.2.3")
        );
    }

    #[test]
    fn use_app_reinstall_uses_normal_recovery_backoff_and_ownership_checks() {
        use logic::{HealthProbe, JobState, RecoveryAction};
        let mut first = FirstRun::default();
        first.reinstall = true;
        let mut lifecycle = logic::Lifecycle::default();
        let (probe, job) = first.recovery_state(HealthProbe::Ready, JobState::Running);
        assert_eq!(
            lifecycle.step(0, probe, job, false),
            RecoveryAction::Install
        );
        assert_eq!(lifecycle.step(1, probe, job, false), RecoveryAction::Wait);
        assert_eq!(
            lifecycle.step(30, probe, job, false),
            RecoveryAction::Install
        );
        assert_eq!(
            first.recovery_state(HealthProbe::Refused, JobState::Foreign),
            (HealthProbe::Refused, JobState::Foreign)
        );
        assert_eq!(
            first.recovery_state(HealthProbe::Ready, JobState::Unknown),
            (HealthProbe::Unreachable, JobState::Unknown)
        );
        first.reinstall = false;
        assert_eq!(
            first.recovery_state(HealthProbe::Ready, JobState::Running),
            (HealthProbe::Ready, JobState::Running)
        );
    }

    #[test]
    fn setup_records_consent_only_after_link_and_opt_in_profile_succeed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new();
        let bundled = dir.0.join("bundled");
        std::fs::write(&bundled, "cli").unwrap();
        let config = dir.0.join("config");
        let rc = dir.0.join(".zshrc");
        std::fs::write(&rc, "# custom\n").unwrap();
        setup_files(&dir.0, &bundled, &config, None, false).unwrap();
        assert_eq!(std::fs::read_to_string(&rc).unwrap(), "# custom\n");
        let record: Value =
            serde_json::from_slice(&std::fs::read(config.join("consent.json")).unwrap()).unwrap();
        assert_eq!(record["path"], false);
        assert_eq!(record["keep"], false);
        assert!(record["at"].as_str().unwrap().ends_with('Z'));
        assert_eq!(
            std::fs::metadata(config.join("consent.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&config).unwrap().permissions().mode() & 0o777,
            0o700
        );
        setup_files(&dir.0, &bundled, &config, Some(&rc), false).unwrap();
        let record: Value =
            serde_json::from_slice(&std::fs::read(config.join("consent.json")).unwrap()).unwrap();
        assert_eq!(record["path"], true);
        assert_eq!(
            std::fs::read_to_string(&rc).unwrap(),
            format!("# custom\n{}", profile::BLOCK)
        );
    }

    #[test]
    fn setup_refuses_foreign_link_and_failed_profile_without_recording_consent() {
        let dir = TempDir::new();
        let config = dir.0.join("config");
        let bundled = dir.0.join("bundled");
        std::fs::write(&bundled, "cli").unwrap();
        std::fs::create_dir_all(dir.0.join(".local/bin")).unwrap();
        std::fs::write(link::link_path(&dir.0), "existing").unwrap();
        assert!(matches!(
            setup_files(&dir.0, &bundled, &config, None, false),
            Err(SetupError::Existing(_))
        ));
        assert!(!config.join("consent.json").exists());
        assert!(matches!(
            setup_files(&dir.0, &bundled, &config, Some(&dir.0), true),
            Err(SetupError::Failed(_))
        ));
        assert!(!config.join("consent.json").exists());
        assert_eq!(
            std::fs::read_to_string(dir.0.join(".local/bin/pacer.pre-app")).unwrap(),
            "existing"
        );
    }

    #[test]
    fn use_app_replaces_the_remembered_keep_mine_choice() {
        let dir = TempDir::new();
        let config = dir.0.join("config");
        let bundled = dir.0.join("bundled");
        std::fs::write(&bundled, "cli").unwrap();
        link::remember(
            &config,
            &link::KeepMine {
                path: "/external/pacer".into(),
                version: "0.2.3".into(),
            },
        )
        .unwrap();
        setup_files(&dir.0, &bundled, &config, None, true).unwrap();
        assert!(!link::remembered(&config, "/external/pacer", "0.2.3"));
    }

    #[test]
    fn consent_replacement_is_atomic_and_keep_is_explicit() {
        let dir = TempDir::new();
        write_consent(&dir.0, false, true).unwrap();
        let old = dir.0.join("old");
        std::fs::hard_link(dir.0.join("consent.json"), &old).unwrap();
        write_consent(&dir.0, true, false).unwrap();
        let previous: Value = serde_json::from_slice(&std::fs::read(old).unwrap()).unwrap();
        let current: Value =
            serde_json::from_slice(&std::fs::read(dir.0.join("consent.json")).unwrap()).unwrap();
        assert_eq!(previous["keep"], true);
        assert_eq!(current["keep"], false);
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 2);
    }

    #[test]
    fn external_discovery_excludes_bundle_and_its_terminal_link() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new();
        let bin = dir.0.join("app");
        let external = dir.0.join("external");
        std::fs::create_dir(&bin).unwrap();
        std::fs::create_dir(&external).unwrap();
        for path in [bin.join("pacer"), external.join("pacer")] {
            std::fs::write(&path, "cli").unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let bundled = bin.join("pacer");
        link::create(&dir.0, &bundled, false).unwrap();
        let path = format!(
            "{}:{}:{}",
            bin.display(),
            dir.0.join(".local/bin").display(),
            external.display()
        );
        assert_eq!(
            external_binary(&path, &dir.0, Some(&bundled)),
            Some(external.join("pacer"))
        );
        assert_eq!(
            install_binary(&dir.0, Some(&bundled), &bundled),
            Some(link::link_path(&dir.0))
        );
        assert_eq!(
            install_binary(&dir.0, Some(&bundled), &external.join("pacer")),
            None
        );
    }

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

/// This desktop's installation as a native update manifest names it, when it runs from a bundle.
fn this_installation() -> Option<crate::update_journal::ThisInstallation> {
    let executable = std::env::current_exe().ok()?.canonicalize().ok()?;
    let app = executable.parent()?.parent()?.parent()?.to_path_buf();
    if app.extension().is_none_or(|extension| extension != "app")
        || executable.strip_prefix(&app).ok()? != Path::new("Contents/MacOS/pacer")
    {
        return None;
    }
    Some(crate::update_journal::ThisInstallation {
        home: pacer_home().canonicalize().ok()?,
        app,
        port: service_port(),
    })
}

/// Replace the generic starting page with bundled update copy. The journal check is
/// read-only, runs only while the service is not answering, and only selects copy.
fn update_copy(app: &AppHandle, page: &'static str, answering: bool) -> &'static str {
    if page != "starting" {
        return page;
    }
    let shell = app.state::<Shell>();
    let maintenance = shell.maintenance.load(Ordering::SeqCst);
    let ticket = shell.navigation.lock().unwrap().ticket().cloned();
    let installation = (ticket.is_some() || !answering)
        .then(this_installation)
        .flatten();
    let restoring = match (&ticket, &installation) {
        (Some(ticket), Some(installation)) => crate::update_journal::restoration_launch(
            installation,
            &ticket.installation_id,
            &ticket.transaction_id,
            env!("CARGO_PKG_VERSION"),
        ),
        _ => false,
    };
    let journal = if answering {
        None
    } else {
        installation
            .as_ref()
            .and_then(crate::update_journal::latest)
            .and_then(|latest| latest.copy(std::time::SystemTime::now()))
    };
    let selected = logic::update_page(page, maintenance, restoring, journal);
    if selected != page && shell.recovery.lock().unwrap().as_str() != selected {
        desktop_log!("pacer lifecycle: showing bundled update page {selected}");
    }
    selected
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
    // Include the body in the timeout; one slow reply never triggers a restart.
    match tokio::time::timeout(Duration::from_secs(2), async {
        let response = client
            .get(format!("http://127.0.0.1:{port}/health"))
            .send()
            .await?;
        let status = response.status().as_u16();
        if status == 503 {
            return Ok(logic::health_response(status, &Value::Null));
        }
        response.json::<Value>().await.map(|value| logic::health_response(status, &value))
    })
    .await
    {
        Ok(Ok(probe)) => probe,
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
fn launchctl_args(action: &str) -> Result<Vec<String>, String> {
    extern "C" {
        fn getuid() -> u32;
    }
    let uid = unsafe { getuid() };
    #[cfg(feature = "ota-fixture")]
    {
        let trust = pacer_desktop::ota::trust::ReleaseTrust::configured()
            .ok_or("Fixture trust unavailable")?;
        let policy = trust.fixture_policy().ok_or("Fixture policy unavailable")?;
        policy
            .validate_live()
            .map_err(|_| "Fixture lease unavailable")?;
        if !same_path(&pacer_home(), &policy.home) || service_port() != policy.port {
            return Err("Fixture service scope mismatch".into());
        }
        return Ok(logic::launchctl_args(uid, action)
            .into_iter()
            .map(|arg| arg.replace("com.pacer.serve", &policy.service_label))
            .collect());
    }
    #[cfg(not(feature = "ota-fixture"))]
    Ok(logic::launchctl_args(uid, action))
}
async fn job_state(home: &Path, port: u16) -> (logic::JobState, Option<logic::JobOwner>) {
    use logic::JobState;
    let default_home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".pacer");
    let owned = |env: &[(String, String)]| {
        logic::foreign_owner(env, &default_home.to_string_lossy(), home, port)
    };
    #[cfg(target_os = "macos")]
    {
        let args = match launchctl_args("print") {
            Ok(args) => args,
            Err(_) => return (JobState::Unknown, None),
        };
        match manager_output("/bin/launchctl", &args).await {
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
    #[cfg(target_os = "macos")]
    if let Some(trust) = pacer_desktop::ota::trust::ReleaseTrust::configured() {
        let cli = cli.ok_or("No located or bundled pacer CLI")?;
        let user_home = PathBuf::from(std::env::var_os("HOME").ok_or("Native user home missing")?);
        return pacer_desktop::ota::control::managed_service_action(&user_home, &cli.pacer_home, service_port(), action, &trust)
            .await.map_err(|_| "Unable to start this managed service safely; attached services require explicit adoption".into());
    }
    if action == "install" {
        if job == logic::JobState::Foreign {
            return Err("The pacer service belongs to another pacer folder".into());
        }
        let cli = cli.ok_or("No located or bundled pacer CLI")?;
        return cli.run(&["service", "install"]).await.map(|_| ());
    }
    #[cfg(target_os = "macos")]
    if !logic::may_manage_job(job, true) {
        return Err("Unable to confirm the pacer service".to_owned());
    }
    #[cfg(target_os = "macos")]
    let output = manager_output("/bin/launchctl", &launchctl_args(action)?).await?;
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
