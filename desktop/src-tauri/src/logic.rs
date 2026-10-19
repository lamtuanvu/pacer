use reqwest::Url;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Identity read from disk once at startup, then compared without using NSBundle's cache.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq)]
pub struct BundleIdentity {
    pub executable_mtime: std::time::SystemTime,
    pub version: Option<String>,
}

#[cfg(any(target_os = "macos", test))]
pub fn bundle_identity(executable: &Path) -> std::io::Result<BundleIdentity> {
    let executable_mtime = std::fs::metadata(executable)?.modified()?;
    let contents = executable
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| std::io::Error::other("Missing bundle Contents directory"))?;
    let info =
        plist::Value::from_file(contents.join("Info.plist")).map_err(std::io::Error::other)?;
    let version = info
        .as_dictionary()
        .and_then(|info| info.get("CFBundleVersion"))
        .and_then(plist::Value::as_string)
        .map(str::to_owned);
    Ok(BundleIdentity {
        executable_mtime,
        version,
    })
}

/// Missing executable means replacement too; other read failures should be retried.
#[cfg(any(target_os = "macos", test))]
pub fn bundle_replaced(executable: &Path, started: &BundleIdentity) -> std::io::Result<bool> {
    match std::fs::metadata(executable) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error),
        Ok(metadata) if metadata.modified()? != started.executable_mtime => Ok(true),
        Ok(_) => Ok(bundle_identity(executable)? != *started),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum HealthProbe {
    Refused,
    NoAnswer,
    Starting,
    Ready,
    Invalid,
    Unreachable,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum JobState {
    NotLoaded,
    Stopped,
    Running,
    Unknown,
}
#[derive(Clone, Debug, serde::Serialize)]
pub struct Diagnosis {
    pub page: &'static str,
    pub path: Option<String>,
    pub error: Option<String>,
}
pub fn diagnosis(page: &'static str, path: Option<String>) -> Diagnosis {
    Diagnosis {
        page,
        path,
        error: None,
    }
}
/// Track an unavailable interval independently of individual retry attempts.
pub struct Startup {
    since: Option<std::time::Instant>,
    pub error: String,
}
impl Default for Startup {
    fn default() -> Self {
        Self {
            since: Some(std::time::Instant::now()),
            error: "Waiting for the local service to finish signing in".into(),
        }
    }
}
impl Startup {
    pub fn failed(&mut self, now: std::time::Instant, error: &str) {
        self.since.get_or_insert(now);
        self.error = error.into();
    }
    pub fn ready(&mut self) {
        self.since = None;
    }
    pub fn stuck(&self, now: std::time::Instant) -> bool {
        self.since.is_some_and(|since| {
            now.saturating_duration_since(since) >= std::time::Duration::from_secs(45)
        })
    }
    pub fn diagnosis(&self, now: std::time::Instant) -> Option<Diagnosis> {
        self.stuck(now).then(|| Diagnosis {
            page: "stuck",
            path: None,
            error: Some(self.error.clone()),
        })
    }
}

pub fn startup_error(error: &str) -> &str {
    match error {
        "sessionExpired" => "The desktop sign-in session expired or was rejected",
        "starting" => "The local service is still starting",
        "stopped" | "diagnose" => "The local service stopped answering",
        _ => error,
    }
}

/// Additive v2/v3 snapshot field `service.waiting { kind: "volume" | "folder", path, since }`:
/// a repo filesystem call has been outstanding for a second or more, usually behind a macOS
/// privacy prompt. Both kinds suppress restarts; unknown kinds are ignored.
pub fn volume_waiting(snapshot: &Value) -> Option<String> {
    let service = snapshot
        .get("snapshot")
        .unwrap_or(snapshot)
        .get("service")?;
    let waiting = service.get("waiting")?;
    matches!(waiting["kind"].as_str(), Some("volume" | "folder"))
        .then(|| waiting["path"].as_str().unwrap_or("").to_owned())
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RecoveryAction {
    Install,
    Start,
    Restart,
    Connect,
    Wait,
    Protocol,
}
/// Ordered manager actions; a failed install must not run the following start.
pub fn service_steps(action: RecoveryAction) -> &'static [&'static str] {
    match action {
        RecoveryAction::Install => &["install", "start"],
        RecoveryAction::Start => &["start"],
        RecoveryAction::Restart => &["restart"],
        _ => &[],
    }
}
/// One owner schedules lifecycle actions. Timestamps are monotonic elapsed seconds.
#[derive(Default)]
pub struct Lifecycle {
    hung_since: Option<u64>,
    next_action: u64,
    restart_delay: u64,
}
impl Lifecycle {
    pub fn step(
        &mut self,
        now: u64,
        health: HealthProbe,
        job: JobState,
        waiting: bool,
    ) -> RecoveryAction {
        use RecoveryAction::*;
        if waiting {
            self.hung_since = None;
            return if matches!(health, HealthProbe::Ready | HealthProbe::Starting) {
                Connect
            } else {
                Wait
            };
        }
        if health != HealthProbe::NoAnswer {
            self.hung_since = None;
        }
        match health {
            HealthProbe::Ready | HealthProbe::Starting => Connect,
            HealthProbe::Invalid => Protocol,
            HealthProbe::Refused if now >= self.next_action => {
                self.next_action = now.saturating_add(20);
                if job == JobState::NotLoaded {
                    Install
                } else {
                    Start
                }
            }
            HealthProbe::NoAnswer => {
                let since = *self.hung_since.get_or_insert(now);
                let delay = self.restart_delay.max(20);
                if now.saturating_sub(since) >= delay && now >= self.next_action {
                    self.hung_since = Some(now);
                    self.restart_delay = (delay * 2).min(80);
                    self.next_action = now.saturating_add(self.restart_delay);
                    Restart
                } else {
                    Wait
                }
            }
            _ => Wait,
        }
    }
    pub fn ready(&mut self) {
        *self = Self::default();
    }
}
pub fn health_probe(value: &Value) -> HealthProbe {
    if value["starting"] == true
        || value["service"]["starting"] == true
        || value["status"] == "starting"
    {
        HealthProbe::Starting
    } else if value["ok"] == true {
        HealthProbe::Ready
    } else {
        HealthProbe::Invalid
    }
}
pub fn approval_window(owner: &str, title: &str) -> Option<&'static str> {
    let owner = owner.to_ascii_lowercase();
    let title = title.to_ascii_lowercase();
    if ![
        "usernotificationcenter",
        "notificationcenter",
        "coreauthui",
        "securityagent",
        "tccd",
    ]
    .iter()
    .any(|name| owner == *name)
        || !title
            .split(|c: char| !c.is_alphanumeric())
            .any(|word| word == "pacer")
    {
        return None;
    }
    if ["removable", "external", "files", "folder", "volume"]
        .iter()
        .any(|word| title.contains(word))
    {
        Some("volume")
    } else if title.contains("notification") {
        Some("notifications")
    } else if title.contains("login") || title.contains("background") {
        Some("login")
    } else {
        None
    }
}
#[cfg(test)]
pub fn consent_window(owner: &str, title: &str) -> bool {
    approval_window(owner, title) == Some("volume")
}
pub fn launchctl_args(uid: u32, action: &str) -> Vec<String> {
    let target = format!("gui/{uid}/com.pacer.serve");
    match action {
        "print" => vec!["print".into(), target],
        "restart" => vec!["kickstart".into(), "-k".into(), target],
        _ => vec!["kickstart".into(), target],
    }
}

/// Shared connection owner enforces a minimum gap even if focus/IPC floods retries.
#[derive(Default)]
pub struct Reconnect {
    next: Option<std::time::Instant>,
}
impl Reconnect {
    pub fn delay(&self, now: std::time::Instant) -> std::time::Duration {
        self.next.map_or(std::time::Duration::ZERO, |next| {
            next.saturating_duration_since(now)
        })
    }
    pub fn started(&mut self, now: std::time::Instant) {
        self.next = Some(now + std::time::Duration::from_secs(1));
    }
}

pub fn session_error(status: Option<u16>) -> &'static str {
    if status == Some(401) {
        "sessionExpired"
    } else {
        "stopped"
    }
}
pub fn recovery_page(error: &str) -> &'static str {
    match error {
        "oldService" => "oldService",
        "oldApp" => "oldApp",
        "protocol" => "protocol",
        "sessionExpired" => "starting",
        _ => "starting",
    }
}

/// Runtime IPC defense, in addition to the per-window remote capability grants.
pub fn command_authorized(label: &str, expected: &str, url: &Url, origin: Option<&str>) -> bool {
    label == expected
        && local_origin(url)
            .as_deref()
            .is_some_and(|o| Some(o) == origin)
}

pub fn tray_height(height: f64) -> Option<f64> {
    height.is_finite().then(|| height.clamp(120., 520.))
}

pub fn service_navigation(url: &Url, origin: Option<&str>) -> bool {
    local_origin(url)
        .as_deref()
        .is_some_and(|o| Some(o) == origin)
        && matches!(url.path(), "/app" | "/app/" | "/app/auth")
}

pub fn external_link(url: &Url, current: Option<&Url>, origin: Option<&str>) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|host| {
            host != "localhost"
                && !host.ends_with(".localhost")
                && host
                    .parse::<std::net::IpAddr>()
                    .map_or(true, |ip| !ip.is_loopback())
                && host != "[::1]"
        })
        && current.is_some_and(|u| service_navigation(u, origin))
}

pub fn shell_path<'a>(output: &'a str, begin: &str, end: &str) -> Option<&'a str> {
    output
        .split_once(begin)?
        .1
        .split_once(end)
        .map(|(path, _)| path)
}

pub fn snapshot_seq(seq: u64, snapshot: &Value, reset: bool) -> u64 {
    if reset {
        snapshot["seq"].as_u64().unwrap_or(0)
    } else {
        seq
    }
}

pub fn candidates(path: &str, home: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::env::split_paths(path)
        .filter(|p| p.is_absolute())
        .map(|p| p.join("pacer"))
        .collect();
    paths.extend([
        home.join(".local/bin/pacer"),
        #[cfg(target_os = "macos")]
        PathBuf::from("/opt/homebrew/bin/pacer"),
        PathBuf::from("/usr/local/bin/pacer"),
        #[cfg(target_os = "linux")]
        PathBuf::from("/usr/bin/pacer"),
    ]);
    let mut unique = Vec::new();
    for p in paths {
        if !unique.contains(&p) {
            unique.push(p);
        }
    }
    unique
}

pub fn auth_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "Invalid sign-in URL")?;
    let codes: Vec<_> = url.query_pairs().collect();
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port_or_known_default().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/app/auth"
        // `pacer open --print` appends the app route to open (e.g. `#/` or `#/sessions/<id>`).
        || url.fragment().is_some_and(|f| !f.starts_with('/'))
        || codes.len() != 1
        || codes[0].0 != "code"
        || codes[0].1.is_empty()
    {
        return Err("Invalid local sign-in URL".into());
    }
    Ok(url)
}

pub fn local_origin(url: &Url) -> Option<String> {
    (url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| url.origin().ascii_serialization())
}

pub fn route(raw: &str) -> Option<String> {
    let value = raw.strip_prefix('#').unwrap_or(raw);
    let value = if value.starts_with("pacer://") {
        let url = Url::parse(value).ok()?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        format!("/{}{}", url.host_str()?, url.path())
    } else {
        value.to_owned()
    };
    if !value.starts_with('/') || value.starts_with("//") || value.contains(['?', '#', '\\']) {
        return None;
    }
    if value == "/" || value == "/overview" {
        return Some("#/".into());
    }
    let parts: Vec<_> = value.trim_matches('/').split('/').collect();
    if !matches!(parts[0], "review" | "sessions" | "settings")
        || parts.len() > 3
        || (parts.len() == 3 && (parts[0] != "settings" || parts[1] != "hosts"))
        || parts.iter().any(|p| {
            p.is_empty()
                || !p
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_".contains(c))
        })
    {
        return None;
    }
    Some(format!("#{}", value.trim_end_matches('/')))
}

pub fn check_hello(hello: &Value) -> Result<(), &'static str> {
    let version = hello["protocol"].as_str().ok_or("protocol")?;
    let mut parts = version.split('.');
    let major: u32 = parts
        .next()
        .and_then(|p| p.parse().ok())
        .ok_or("protocol")?;
    if parts.next().and_then(|p| p.parse::<u32>().ok()).is_none() {
        return Err("protocol");
    }
    match major {
        2 | 3 => Ok(()),
        0 | 1 => Err("oldService"),
        _ => Err("oldApp"),
    }
}

#[derive(Debug, Default, PartialEq)]
pub struct Event {
    pub id: Option<u64>,
    pub kind: String,
    pub data: String,
}
#[derive(Default)]
pub struct Sse {
    bytes: Vec<u8>,
    event: Event,
    skip_lf: bool,
}
impl Sse {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Event>, &'static str> {
        self.bytes.extend_from_slice(bytes);
        if self.bytes.len() + self.event.data.len() > 2 * 1024 * 1024 {
            return Err("Event too large");
        }
        let mut out = Vec::new();
        loop {
            if self.skip_lf && !self.bytes.is_empty() {
                if self.bytes[0] == b'\n' {
                    self.bytes.remove(0);
                }
                self.skip_lf = false;
            }
            let Some(end) = self.bytes.iter().position(|b| matches!(b, b'\n' | b'\r')) else {
                break;
            };
            self.skip_lf = self.bytes[end] == b'\r';
            let line: Vec<_> = self.bytes.drain(..=end).collect();
            let line = std::str::from_utf8(&line)
                .map_err(|_| "Invalid event encoding")?
                .trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                let mut event = std::mem::take(&mut self.event);
                if !event.data.is_empty() {
                    event.data.pop();
                    if event.kind.is_empty() {
                        event.kind = "message".into();
                    }
                    out.push(event);
                }
            } else if !line.starts_with(':') {
                let (key, value) = line.split_once(':').unwrap_or((line, ""));
                let value = value.strip_prefix(' ').unwrap_or(value);
                match key {
                    "id" => self.event.id = value.parse().ok(),
                    "event" => self.event.kind = value.to_owned(),
                    "data" => {
                        self.event.data.push_str(value);
                        self.event.data.push('\n');
                    }
                    _ => {}
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn bundle_replacement_detects_removed_executable_mtime_and_version() {
        use std::time::{Duration, SystemTime};
        let root = std::env::temp_dir().join(format!(
            "pacer-bundle-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let executable = root.join("pacer.app/Contents/MacOS/pacer");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        let info = root.join("pacer.app/Contents/Info.plist");
        let write_version = |version: &str| {
            std::fs::write(&info, format!(
                "<plist version=\"1.0\"><dict><key>CFBundleVersion</key><string>{version}</string></dict></plist>"
            )).unwrap();
        };
        write_version("1");
        std::fs::write(&executable, "old executable").unwrap();
        let started = bundle_identity(&executable).unwrap();
        assert!(!bundle_replaced(&executable, &started).unwrap());
        write_version("2");
        assert!(bundle_replaced(&executable, &started).unwrap());
        write_version("1");
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&executable)
            .unwrap();
        file.set_times(
            std::fs::FileTimes::new()
                .set_modified(started.executable_mtime + Duration::from_secs(10)),
        )
        .unwrap();
        assert!(bundle_replaced(&executable, &started).unwrap());
        std::fs::remove_file(&executable).unwrap();
        assert!(bundle_replaced(&executable, &started).unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn consent_detection_does_not_attribute_other_prompts_to_pacer() {
        assert!(consent_window(
            "UserNotificationCenter",
            "pacer would like to access files on a removable volume"
        ));
        assert!(!consent_window("UserNotificationCenter", ""));
        assert!(!consent_window(
            "UserNotificationCenter",
            "OtherApp would like to access files"
        ));
        assert!(!consent_window("Safari", "pacer external files"));
        assert!(!consent_window(
            "UserNotificationCenter",
            "pacer would like to access the microphone"
        ));
        assert_eq!(
            approval_window(
                "UserNotificationCenter",
                "pacer would like to send notifications"
            ),
            Some("notifications")
        );
        assert_eq!(
            approval_window("UserNotificationCenter", "Allow pacer at login"),
            Some("login")
        );
        assert_eq!(
            approval_window("UserNotificationCenter", "OtherApp notifications"),
            None
        );
    }
    #[test]
    fn automatic_lifecycle_transitions() {
        use HealthProbe::*;
        use RecoveryAction::*;
        let mut state = Lifecycle::default();
        let action = state.step(0, Refused, JobState::NotLoaded, false);
        assert_eq!(action, Install);
        assert_eq!(service_steps(action), &["install", "start"]);
        // A pending manager action is not duplicated on the next probe.
        assert_eq!(state.step(1, Refused, JobState::Stopped, false), Wait);
        assert_eq!(state.step(20, Refused, JobState::Stopped, false), Start);
        assert_eq!(state.step(21, Ready, JobState::Running, false), Connect);
        state.ready();
        let refused = state.step(22, Refused, JobState::Running, false);
        assert_eq!(refused, Start);
        assert_eq!(service_steps(refused), &["start"]);
        assert_eq!(state.step(23, Ready, JobState::Running, false), Connect);
    }
    #[test]
    fn hung_service_restarts_with_capped_backoff_until_ready() {
        use HealthProbe::*;
        use RecoveryAction::*;
        let mut state = Lifecycle::default();
        for (now, expected) in [
            (0, Wait),
            (19, Wait),
            (20, Restart),
            (59, Wait),
            (60, Restart),
            (139, Wait),
            (140, Restart),
            (219, Wait),
            (220, Restart),
        ] {
            assert_eq!(
                state.step(now, NoAnswer, JobState::Running, false),
                expected,
                "{now}"
            );
        }
        assert_eq!(state.step(221, Ready, JobState::Running, false), Connect);
        state.ready();
        assert_eq!(state.step(222, NoAnswer, JobState::Running, false), Wait);
        assert_eq!(state.step(242, NoAnswer, JobState::Running, false), Restart);
    }
    #[test]
    fn waiting_snapshot_and_consent_window_prevent_restart() {
        use HealthProbe::*;
        use RecoveryAction::*;
        let snapshot = json!({"service":{"waiting":{"kind":"volume","path":"/Volumes/Drive/repo","since":"now"}}});
        assert_eq!(
            volume_waiting(&snapshot).as_deref(),
            Some("/Volumes/Drive/repo")
        );
        assert_eq!(
            volume_waiting(&json!({"snapshot":snapshot})).as_deref(),
            Some("/Volumes/Drive/repo")
        );
        assert!(volume_waiting(&json!({"service": {}})).is_none());
        assert!(volume_waiting(&json!({"service": {"waiting": {"kind": "other"}}})).is_none());
        let mut state = Lifecycle::default();
        for now in [0, 20, 80, 1000] {
            assert_eq!(state.step(now, NoAnswer, JobState::Running, true), Wait);
        }
        assert_eq!(state.step(1001, Ready, JobState::Running, false), Connect);
        let prompt = consent_window(
            "UserNotificationCenter",
            "pacer access files on external drive",
        );
        assert!(prompt);
        assert_eq!(state.step(2000, NoAnswer, JobState::Running, prompt), Wait);
    }
    #[test]
    fn launchctl_commands_use_fixed_argument_vectors() {
        assert_eq!(
            launchctl_args(501, "print"),
            vec!["print", "gui/501/com.pacer.serve"]
        );
        assert_eq!(
            launchctl_args(501, "start"),
            vec!["kickstart", "gui/501/com.pacer.serve"]
        );
        assert_eq!(
            launchctl_args(501, "restart"),
            vec!["kickstart", "-k", "gui/501/com.pacer.serve"]
        );
    }
    #[test]
    fn health_reports_starting_before_ready() {
        assert_eq!(health_probe(&json!({"ok":true})), HealthProbe::Ready);
        for value in [
            json!({"ok":true,"starting":true}),
            json!({"service":{"starting":true}}),
            json!({"status":"starting"}),
        ] {
            assert_eq!(health_probe(&value), HealthProbe::Starting);
        }
        assert_eq!(health_probe(&json!({"ok":false})), HealthProbe::Invalid);
    }
    #[test]
    fn expired_session_reenters_sign_in_and_unreachable_service_uses_shell_page() {
        assert_eq!(session_error(Some(401)), "sessionExpired");
        assert_eq!(recovery_page(session_error(Some(401))), "starting");
        assert_eq!(recovery_page(session_error(None)), "starting");
        assert_eq!(recovery_page(session_error(Some(503))), "starting");
        assert_eq!(recovery_page("oldApp"), "oldApp");
    }
    #[test]
    fn retries_are_limited_even_when_focus_or_ipc_requests_more() {
        use std::time::{Duration, Instant};
        let now = Instant::now();
        let mut retry = Reconnect::default();
        assert_eq!(retry.delay(now), Duration::ZERO);
        retry.started(now);
        for _ in 0..100 {
            assert_eq!(retry.delay(now), Duration::from_secs(1));
        }
        assert_eq!(
            retry.delay(now + Duration::from_millis(500)),
            Duration::from_millis(500)
        );
        assert_eq!(retry.delay(now + Duration::from_secs(1)), Duration::ZERO);
    }
    #[test]
    fn tray_size_is_finite_and_clamped() {
        for (height, expected) in [
            (-1., 120.),
            (0., 120.),
            (120., 120.),
            (271.5, 271.5),
            (520., 520.),
            (9999., 520.),
        ] {
            assert_eq!(tray_height(height), Some(expected));
        }
        for height in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(tray_height(height), None);
        }
    }
    #[test]
    fn commands_require_the_designated_window_and_active_loopback_origin() {
        let origin = Some("http://127.0.0.1:7432");
        let url = Url::parse("http://127.0.0.1:7432/app/tray.html").unwrap();
        assert!(command_authorized("tray", "tray", &url, origin));
        assert!(!command_authorized("main", "tray", &url, origin));
        assert!(!command_authorized("tray", "main", &url, origin));
        assert!(!command_authorized("other", "tray", &url, origin));
        assert!(!command_authorized("tray", "tray", &url, None));
        for raw in [
            "http://127.0.0.1:7433/app/tray.html",
            "http://localhost:7432/app/tray.html",
            "https://127.0.0.1:7432/app/tray.html",
            "http://user@127.0.0.1:7432/app/tray.html",
            "tauri://localhost/index.html",
            "https://example.com/app/tray.html",
        ] {
            assert!(
                !command_authorized("tray", "tray", &Url::parse(raw).unwrap(), origin),
                "{raw}"
            );
        }
    }
    #[test]
    fn tray_routes_use_the_shared_route_validator() {
        for raw in [
            "/",
            "/overview",
            "#/review/t-123",
            "/sessions/t-123",
            "/settings/hosts/workstation",
        ] {
            let normalized = route(raw).expect("supported tray destination");
            assert_eq!(route(&normalized), Some(normalized));
        }
        for retired in [
            "tasks",
            "executors",
            "accounts",
            "strategy",
            "hosts",
            "setup",
        ] {
            assert!(route(&format!("/{retired}")).is_none());
            assert!(route(&format!("pacer://{retired}/id")).is_none());
        }
        assert_eq!(route("pacer://overview"), Some("#/".into()));
        for raw in [
            "javascript:alert(1)",
            "//evil.test",
            "/review/%2e%2e",
            "/review/../settings",
            "/app/tray.html",
            "/review/a?x=1",
        ] {
            assert!(route(raw).is_none(), "{raw}");
        }
    }
    #[test]
    fn service_navigation_is_restricted_to_app_on_active_origin() {
        let origin = Some("http://127.0.0.1:7432");
        for path in ["/app", "/app/", "/app/auth?code=x", "/app/#/settings"] {
            assert!(service_navigation(
                &Url::parse(&format!("{}{path}", origin.unwrap())).unwrap(),
                origin
            ));
        }
        for url in [
            "http://127.0.0.1:7433/app",
            "http://localhost:7432/app",
            "http://127.0.0.1:7432/v2/hello",
        ] {
            assert!(!service_navigation(&Url::parse(url).unwrap(), origin));
        }
    }
    #[test]
    fn external_https_requires_a_service_page_and_nonlocal_target() {
        let origin = Some("http://127.0.0.1:7432");
        let current = Url::parse("http://127.0.0.1:7432/app/").unwrap();
        assert!(external_link(
            &Url::parse("https://example.com/a?x=one%20two&y=2").unwrap(),
            Some(&current),
            origin
        ));
        for url in [
            "https://127.0.0.1/app",
            "https://localhost/app",
            "https://[::1]/app",
            "http://example.com",
            "file:///tmp/x",
        ] {
            assert!(!external_link(
                &Url::parse(url).unwrap(),
                Some(&current),
                origin
            ));
        }
        assert!(!external_link(
            &Url::parse("https://example.com").unwrap(),
            None,
            origin
        ));
        assert!(!external_link(
            &Url::parse("https://example.com").unwrap(),
            Some(&current),
            None
        ));
    }
    #[test]
    fn shell_path_excludes_profile_output() {
        assert_eq!(
            shell_path(
                "banner\nBEGIN-unique/custom/bin:/usr/binEND-unique\nlogout",
                "BEGIN-unique",
                "END-unique"
            ),
            Some("/custom/bin:/usr/bin")
        );
        assert_eq!(
            shell_path("banner /bad/bin", "BEGIN-unique", "END-unique"),
            None
        );
        assert_eq!(
            shell_path("BEGIN-unique/bad/bin", "BEGIN-unique", "END-unique"),
            None
        );
    }
    #[test]
    fn reset_replaces_stale_cursor_but_normal_refresh_preserves_alerts() {
        assert_eq!(snapshot_seq(900, &json!({"seq":3}), true), 3);
        assert_eq!(snapshot_seq(3, &json!({"seq":9}), false), 3);
        let mut parser = Sse::default();
        let events = parser
            .push(b"event: reset\ndata: {}\n\nid: 901\nevent: task\ndata: {}\n\n")
            .unwrap();
        let seq = snapshot_seq(
            901,
            &json!({"seq":4}),
            events.iter().any(|e| e.kind == "reset"),
        );
        assert!(5 > seq, "next event must not be skipped after reset");
    }
    #[test]
    fn search_order() {
        let home = Path::new("/home/test");
        assert_eq!(
            candidates("/custom/bin:/usr/local/bin:/custom/bin:relative", home),
            vec![
                PathBuf::from("/custom/bin/pacer"),
                PathBuf::from("/usr/local/bin/pacer"),
                home.join(".local/bin/pacer"),
                #[cfg(target_os = "macos")]
                PathBuf::from("/opt/homebrew/bin/pacer"),
                #[cfg(target_os = "linux")]
                PathBuf::from("/usr/bin/pacer"),
            ]
        );
    }
    #[test]
    fn links() {
        assert_eq!(route("#/"), Some("#/".into()));
        assert_eq!(
            route("pacer://settings/hosts/workstation"),
            Some("#/settings/hosts/workstation".into())
        );
        assert_eq!(
            route("pacer://review/t-0412"),
            Some("#/review/t-0412".into())
        );
        assert_eq!(
            route("pacer://sessions/t-0412"),
            Some("#/sessions/t-0412".into())
        );
        for bad in [
            "https://evil.test",
            "pacer://review/%2Fetc",
            "//evil.test",
            "pacer://user@review/id",
            "pacer://review/id?x=1",
            "#/review/..",
            "/review/x#y",
        ] {
            assert!(route(bad).is_none(), "{bad}");
        }
    }
    #[test]
    fn auth_is_loopback_only() {
        assert!(auth_url("http://127.0.0.1:7432/app/auth?code=abc").is_ok());
        // What `pacer open --print` prints: the app route rides in the fragment.
        assert!(auth_url("http://127.0.0.1:4317/app/auth?code=abc#/").is_ok());
        assert!(auth_url("http://127.0.0.1:4317/app/auth?code=abc#/sessions/t-1").is_ok());
        for bad in [
            "http://localhost:7432/app/auth?code=x",
            "https://127.0.0.1/app/auth?code=x",
            "http://127.0.0.1:7432/app/auth?code=x&code=y",
            "http://u@127.0.0.1/app/auth?code=x",
            "http://127.0.0.1/app/auth?code=x#y",
        ] {
            assert!(auth_url(bad).is_err());
        }
    }
    #[test]
    fn v3_snapshot_waiting_and_sequence() {
        for kind in ["volume", "folder"] {
            let snapshot = json!({
                "protocol": "3.0.0",
                "seq": 1000000000003_u64,
                "snapshot": {
                    "service": {"waiting": {"kind": kind, "path": "/tmp/repo", "since": 1}},
                    "future": true
                }
            });
            assert_eq!(volume_waiting(&snapshot).as_deref(), Some("/tmp/repo"));
            assert_eq!(snapshot_seq(900, &snapshot, true), 1000000000003);
            assert_eq!(snapshot_seq(1000000000002, &snapshot, false), 1000000000002);
        }
        assert!(volume_waiting(&json!({"protocol":"3.0.0","snapshot":{"service":{}}})).is_none());
    }
    #[test]
    fn protocol_major_only() {
        assert!(check_hello(&json!({"protocol":"2.9.1"})).is_ok());
        assert_eq!(check_hello(&json!({"protocol":"1.5.0"})), Err("oldService"));
        assert!(check_hello(&json!({"protocol":"3.0.0"})).is_ok());
        assert!(check_hello(&json!({"protocol":"3.9.1","future":true})).is_ok());
        assert_eq!(check_hello(&json!({"protocol":"4.0.0"})), Err("oldApp"));
        assert_eq!(check_hello(&json!({"protocol":"oops"})), Err("protocol"));
    }
    #[test]
    fn sse_cr_delimiters_and_split_crlf() {
        let mut s = Sse::default();
        assert!(s.push(b"event: task\r").unwrap().is_empty());
        let event = s.push(b"\ndata: {}\r\r").unwrap();
        assert_eq!(event.len(), 1);
        assert_eq!(event[0].kind, "task");
        assert!(s.push(b"\n").unwrap().is_empty());
    }
    #[test]
    fn fragmented_sse_and_comments() {
        let mut s = Sse::default();
        assert!(s
            .push(b": keepalive\r\nid: 42\r\nevent: alert\r\ndata: {\"title\":\"")
            .unwrap()
            .is_empty());
        assert!(s.push(&[0xc3]).unwrap().is_empty());
        let events = s
            .push(&[0xa9, b'"', b'}', b'\r', b'\n', b'\r', b'\n'])
            .unwrap();
        assert_eq!(
            events,
            vec![Event {
                id: Some(42),
                kind: "alert".into(),
                data: "{\"title\":\"é\"}".into()
            }]
        );
        assert_eq!(
            s.push(b"event: reset\ndata: one\ndata: two\n\n").unwrap()[0].data,
            "one\ntwo"
        );
    }

    #[test]
    fn waiting_on_a_volume_or_a_folder_both_ask_for_os_approval() {
        let volume = serde_json::json!({"snapshot":{"service":{"waiting":{"kind":"volume","path":"/Volumes/External","since":1}}}});
        let folder = serde_json::json!({"service":{"waiting":{"kind":"folder","path":"/Users/me/Projects/app","since":1}}});
        let other =
            serde_json::json!({"service":{"waiting":{"kind":"network","path":"/x","since":1}}});
        assert_eq!(
            volume_waiting(&volume).as_deref(),
            Some("/Volumes/External")
        );
        assert_eq!(
            volume_waiting(&folder).as_deref(),
            Some("/Users/me/Projects/app")
        );
        assert_eq!(volume_waiting(&other), None);
        assert_eq!(volume_waiting(&serde_json::json!({"service":{}})), None);
    }
}

#[cfg(test)]
mod startup_tests {
    use super::*;
    use std::time::{Duration, Instant};
    #[test]
    fn stuck_threshold_survives_retries_and_resets_only_when_ready() {
        let now = Instant::now();
        let mut startup = Startup {
            since: Some(now),
            error: String::new(),
        };
        startup.failed(
            now + Duration::from_secs(30),
            "Session exchange failed (HTTP 401)",
        );
        assert!(!startup.stuck(now + Duration::from_secs(44)));
        let detail = startup.diagnosis(now + Duration::from_secs(45)).unwrap();
        assert_eq!(detail.page, "stuck");
        assert_eq!(
            detail.error.as_deref(),
            Some("Session exchange failed (HTTP 401)")
        );
        assert!(startup.stuck(now + Duration::from_secs(3600)));
        startup.ready();
        assert!(!startup.stuck(now + Duration::from_secs(3600)));
        startup.failed(now + Duration::from_secs(3600), "Session expired");
        assert!(!startup.stuck(now + Duration::from_secs(3644)));
        assert!(startup.stuck(now + Duration::from_secs(3645)));
    }
}
