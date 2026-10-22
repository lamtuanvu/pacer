use reqwest::Url;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub fn recovery_for(bundle_app: bool, bundled_cli: bool, external_cli: bool) -> Option<&'static str> {
    if bundled_cli || external_cli {
        None
    } else if bundle_app {
        Some("incomplete")
    } else {
        Some("install")
    }
}

pub fn relink_needed(consented: bool, keep: bool, bundled: bool, missing: bool) -> bool {
    consented && !keep && bundled && missing
}

pub fn dismiss_relink(url: &Url, current: Option<&Url>) -> bool {
    url.as_str() == "tauri://localhost/index.html?state=starting" && bundled_shell(current)
}

#[derive(Default)]
pub struct VersionRecovery {
    attempted: bool,
}
impl VersionRecovery {
    // Consume the attempt before spawning, including a failed restart or canceled connection.
    pub fn restart(
        &mut self,
        cli: Option<&str>,
        service: Option<&str>,
        consented: bool,
        owned: bool,
    ) -> bool {
        let versions_differ = match (cli, service) {
            (Some(cli), Some(service)) => {
                let cli = cli.trim();
                let cli = cli.strip_prefix("pacer ").unwrap_or(cli).trim();
                !cli.is_empty() && !service.trim().is_empty() && cli != service.trim()
            }
            _ => false,
        };
        if self.attempted || !consented || !owned || !versions_differ {
            return false;
        }
        self.attempted = true;
        true
    }
}

// Selection is kept pure so consent and explicit overrides can be tested together.
pub fn cli_choice(
    pacer_bin: Option<&Path>,
    bundled: Option<&Path>,
    external: Option<&Path>,
    consented: bool,
    keep: bool,
    remembered: bool,
) -> (Option<PathBuf>, Option<PathBuf>) {
    let selected = pacer_bin.or_else(|| {
        if keep || remembered {
            external
        } else if consented {
            bundled.or(external)
        } else {
            external
        }
    });
    let install = selected.filter(|selected| Some(*selected) == bundled);
    (
        selected.map(Path::to_path_buf),
        install.map(Path::to_path_buf),
    )
}

pub fn bundled_shell(current: Option<&Url>) -> bool {
    current.is_some_and(|url| {
        url.scheme() == "tauri"
            && url.host_str() == Some("localhost")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && matches!(url.path(), "/" | "/index.html")
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Onboarding {
    Welcome,
    Consent,
    Existing,
    Ready,
}

pub fn onboarding(
    consented: bool,
    external_cli: Option<&str>,
    keep_remembered: bool,
    bundled: bool,
) -> Onboarding {
    if bundled && !consented {
        match external_cli {
            None => Onboarding::Welcome,
            Some(_) if !keep_remembered => Onboarding::Existing,
            _ => Onboarding::Ready,
        }
    } else {
        Onboarding::Ready
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellAction {
    Begin,
    Consent { path: bool },
    UseApp,
    KeepMine,
    Relink,
    Download,
}

pub fn onboarding_back(url: &Url, current: Option<&Url>) -> bool {
    url.as_str() == "tauri://localhost/index.html?state=welcome" && bundled_shell(current)
}

pub fn shell_action_url(url: &Url) -> Option<ShellAction> {
    if url.scheme() != "tauri"
        || url.host_str() != Some("localhost")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    if url.path() == "/action/consent" {
        return match url.query() {
            Some("path=0") => Some(ShellAction::Consent { path: false }),
            Some("path=1") => Some(ShellAction::Consent { path: true }),
            _ => None,
        };
    }
    if url.query().is_some() {
        return None;
    }
    match url.path() {
        "/action/begin" => Some(ShellAction::Begin),
        "/action/use-app" => Some(ShellAction::UseApp),
        "/action/keep-mine" => Some(ShellAction::KeepMine),
        "/action/relink" => Some(ShellAction::Relink),
        "/action/download" => Some(ShellAction::Download),
        _ => None,
    }
}

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
    /// Loaded, but it serves another pacer home or port; never started or restarted.
    Foreign,
    Unknown,
}
#[derive(Clone, Debug, serde::Serialize)]
pub struct Diagnosis {
    pub page: &'static str,
    pub path: Option<String>,
    pub error: Option<String>,
    pub rc: Option<String>,
    #[serde(rename = "onPath")]
    pub on_path: Option<bool>,
    pub installed: Option<String>,
    pub version: Option<String>,
    pub port: Option<u16>,
    #[serde(rename = "appPort")]
    pub app_port: Option<u16>,
}
pub fn diagnosis(page: &'static str, path: Option<String>) -> Diagnosis {
    Diagnosis {
        page,
        path,
        error: None,
        rc: None,
        on_path: None,
        installed: None,
        version: None,
        port: None,
        app_port: None,
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
    pub fn is_ready(&self) -> bool {
        self.since.is_none()
    }
    pub fn stuck(&self, now: std::time::Instant) -> bool {
        self.since.is_some_and(|since| {
            now.saturating_duration_since(since) >= std::time::Duration::from_secs(45)
        })
    }
    pub fn diagnosis(&self, now: std::time::Instant) -> Option<Diagnosis> {
        self.stuck(now).then(|| Diagnosis {
            page: "stuck",
            error: Some(self.error.clone()),
            ..diagnosis("stuck", None)
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
    Foreign,
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
    failed_probes: u32,
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
            self.failed_probes = 0;
            return if matches!(health, HealthProbe::Ready | HealthProbe::Starting) {
                Connect
            } else {
                Wait
            };
        }
        if job == JobState::Foreign && matches!(health, HealthProbe::Refused | HealthProbe::NoAnswer) {
            self.hung_since = None;
            self.failed_probes = 0;
            return Foreign;
        }
        if !matches!(health, HealthProbe::NoAnswer | HealthProbe::Refused) {
            self.hung_since = None;
            self.failed_probes = 0;
        }
        match health {
            HealthProbe::Ready | HealthProbe::Starting => Connect,
            HealthProbe::Invalid => Protocol,
            HealthProbe::Refused | HealthProbe::NoAnswer if job == JobState::Running => {
                // Require sustained failure, whether the listener is absent,
                // unresponsive, or reports a stale backend heartbeat.
                let since = *self.hung_since.get_or_insert(now);
                self.failed_probes = self.failed_probes.saturating_add(1);
                let delay = self.restart_delay.max(30);
                if self.failed_probes >= 3 && now.saturating_sub(since) >= delay && now >= self.next_action {
                    self.hung_since = None;
                    self.failed_probes = 0;
                    self.restart_delay = (delay * 2).min(80);
                    self.next_action = now.saturating_add(self.restart_delay);
                    Restart
                } else {
                    Wait
                }
            }
            HealthProbe::Refused if now >= self.next_action => {
                self.next_action = now.saturating_add(20);
                if job == JobState::NotLoaded {
                    Install
                } else {
                    Start
                }
            }
            _ => Wait,
        }
    }
    pub fn ready(&mut self) {
        *self = Self::default();
    }
}
pub fn health_response(status: u16, value: &Value) -> HealthProbe {
    match status {
        200 => health_probe(value),
        503 => HealthProbe::NoAnswer,
        _ => HealthProbe::Invalid,
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

/// Whether the shell may start or restart the service manager's job. A job owned by another pacer is
/// never touched; on macOS an unconfirmed job is not either. On Linux, an unknown job falls back to
/// running `pacer serve` directly, which acts only on this shell's own home.
pub fn may_manage_job(job: JobState, macos: bool) -> bool {
    match job {
        JobState::Foreign => false,
        JobState::Unknown => !macos,
        _ => true,
    }
}

/// The job's own `environment = {` block from `launchctl print`. The inherited and
/// default blocks describe launchd itself, not the job.
pub fn launchd_environment(text: &str) -> Vec<(String, String)> {
    let mut vars = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        if !inside {
            inside = line == "\tenvironment = {";
            continue;
        }
        if line.trim() == "}" {
            break;
        }
        if let Some((key, value)) = line.trim().split_once(" => ") {
            vars.push((key.to_owned(), value.to_owned()));
        }
    }
    vars
}

/// `Environment=` from `systemctl --user show`; assignments with spaces are double-quoted.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn systemd_environment(text: &str) -> Vec<(String, String)> {
    let Some(line) = text.lines().find_map(|line| line.strip_prefix("Environment=")) else {
        return Vec::new();
    };
    let mut words = Vec::new();
    let mut word = String::new();
    let (mut quoted, mut escaped) = (false, false);
    for c in line.chars() {
        match c {
            _ if escaped => {
                word.push(c);
                escaped = false;
            }
            '\\' => escaped = true,
            '"' => quoted = !quoted,
            ' ' if !quoted => {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            }
            _ => word.push(c),
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
        .into_iter()
        .filter_map(|w| w.split_once('=').map(|(k, v)| (k.to_owned(), v.to_owned())))
        .collect()
}

/// The pacer home and port a service job serves. `src/service/index.ts` always records
/// PACER_HOME and records PACER_PORT only when it differs from the default.
pub fn job_owner(env: &[(String, String)], default_home: &str) -> (String, u16) {
    let get = |key: &str| env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
    let home = get("PACER_HOME").unwrap_or(default_home).to_owned();
    let port = get("PACER_PORT").and_then(|p| p.parse().ok()).unwrap_or(4317);
    (home, port)
}

pub fn same_path(a: &Path, b: &Path) -> bool {
    let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canonical(a) == canonical(b)
}

/// The pacer home and port a service job serves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobOwner {
    pub home: String,
    pub port: u16,
}

/// The job's owner when it serves another pacer than this shell: a different home, or the same
/// home on a different port. `None` when the job is this shell's own.
pub fn foreign_owner(env: &[(String, String)], default_home: &str, home: &Path, port: u16) -> Option<JobOwner> {
    let (owner, owner_port) = job_owner(env, default_home);
    (!same_path(Path::new(&owner), home) || owner_port != port).then_some(JobOwner {
        home: owner,
        port: owner_port,
    })
}

/// The "foreign" page names the other pacer's folder, plus both ports when only the port differs.
pub fn foreign_diagnosis(owner: &JobOwner, home: &Path, port: u16, user_home: &str) -> Diagnosis {
    let port_only = same_path(Path::new(&owner.home), home);
    Diagnosis {
        port: port_only.then_some(owner.port),
        app_port: port_only.then_some(port),
        ..diagnosis("foreign", Some(display_home(&owner.home, user_home)))
    }
}

/// The one page a lifecycle pass shows. It follows the state, not this pass's action, so the
/// window doesn't fall back to "starting" on the `Wait` passes between gated actions. On Linux an
/// unknown job (no usable systemctl) behind a refused or silent port is started with
/// `pacer serve`, so it needs a CLI too. Other probes keep their own pages.
pub fn shell_page(
    permission: bool,
    action: RecoveryAction,
    health: HealthProbe,
    job: JobState,
    cli_found: bool,
    macos: bool,
) -> &'static str {
    let unknown_linux_job = !macos
        && job == JobState::Unknown
        && matches!(health, HealthProbe::Refused | HealthProbe::NoAnswer);
    if permission {
        "permission"
    } else if action == RecoveryAction::Foreign {
        "foreign"
    } else if !cli_found
        && (job == JobState::NotLoaded
            || unknown_linux_job
            || matches!(action, RecoveryAction::Install | RecoveryAction::Connect))
    {
        "install"
    } else {
        "starting"
    }
}

/// A terminal native update journal that explains why the service is not answering.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JournalCopy {
    Restored,
    RecoveryFailed,
}

/// Bundled update explanation for a window that would otherwise say "Starting pacer…".
/// More specific guidance (permission, install, foreign, protocol pages) always wins.
/// The result only selects copy: it never grants authority or triggers an effect.
/// - `recoveryFailed`: the newest journal for this installation is recovery-failed.
/// - `rollingBack`: the helper launched this desktop as the old release to restore it.
/// - `restored`: the newest journal recently restored the previous version.
/// - `installing`: the service acknowledged maintenance (installation) for this desktop.
pub fn update_page(
    page: &'static str,
    maintenance: bool,
    restoring: bool,
    journal: Option<JournalCopy>,
) -> &'static str {
    if page != "starting" {
        return page;
    }
    match journal {
        Some(JournalCopy::RecoveryFailed) => "recoveryFailed",
        _ if restoring => "rollingBack",
        Some(JournalCopy::Restored) => "restored",
        None if maintenance => "installing",
        None => page,
    }
}

pub fn display_home(path: &str, home: &str) -> String {
    if home.is_empty() {
        return path.to_owned();
    }
    match path.strip_prefix(home) {
        Some("") => "~".to_owned(),
        Some(rest) if rest.starts_with('/') => format!("~{rest}"),
        _ => path.to_owned(),
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

/// Where the bundled recovery-failed page sends the user to report the problem.
pub const RECOVERY_REPORT_URL: &str = "https://github.com/lamtuanvu/pacer/issues";

#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    Allow,
    OpenExternal,
    Block,
}

/// Decide from the navigation target and the last completed page load. The
/// current page may be absent during startup; service sign-in must still work.
pub fn main_navigation(url: &Url, current: Option<&Url>, origin: Option<&str>) -> Navigation {
    let shell_page = |url: &Url| {
        url.scheme() == "tauri"
            && url.host_str() == Some("localhost")
            && matches!(url.path(), "/" | "/index.html")
    };
    if shell_page(url) || service_navigation(url, origin) {
        Navigation::Allow
    } else if (matches!(
        url.as_str(),
        "https://github.com/lamtuanvu/pacer/blob/main/docs/install.md" | RECOVERY_REPORT_URL
    ) && current.is_some_and(shell_page))
        || external_link(url, current, origin)
    {
        Navigation::OpenExternal
    } else {
        Navigation::Block
    }
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
    #[test]
    fn recovery_truth_table() {
        for app in [false, true] {
            for bundled in [false, true] {
                for external in [false, true] {
                    let expected = if bundled || external { None }
                        else if app { Some("incomplete") } else { Some("install") };
                    assert_eq!(recovery_for(app, bundled, external), expected);
                }
            }
        }
    }

    #[test]
    fn relink_requires_consent_and_a_missing_app_link() {
        for consent in [false, true] {
            for keep in [false, true] {
                for bundled in [false, true] {
                    for missing in [false, true] {
                        assert_eq!(relink_needed(consent, keep, bundled, missing),
                            consent && !keep && bundled && missing);
                    }
                }
            }
        }
    }

    #[test]
    fn relink_dismissal_is_only_from_the_local_shell() {
        let target = Url::parse("tauri://localhost/index.html?state=starting").unwrap();
        let shell = Url::parse("tauri://localhost/index.html?state=relink").unwrap();
        let remote = Url::parse("http://127.0.0.1:4317/app/").unwrap();
        assert!(dismiss_relink(&target, Some(&shell)));
        assert!(!dismiss_relink(&target, Some(&remote)));
        assert!(!dismiss_relink(&target, None));
        assert!(!dismiss_relink(&shell, Some(&shell)));
    }

    #[test]
    fn version_recovery_requires_known_different_versions_consent_and_ownership_once() {
        for (cli, service, consent, owned, expected) in [
            (Some("0.2.3"), Some("0.2.2"), true, true, true),
            (Some("0.2.3\n"), Some("0.2.3"), true, true, false),
            (Some("pacer 0.2.3\n"), Some("0.2.3"), true, true, false),
            (Some("pacer 0.2.3\n"), Some("0.2.2"), true, true, true),
            (Some("0.2.3"), Some("0.2.2"), false, true, false),
            (Some("0.2.3"), Some("0.2.2"), true, false, false),
            (None, Some("0.2.2"), true, true, false),
            (Some("0.2.3"), None, true, true, false),
            (Some(""), Some("0.2.2"), true, true, false),
        ] {
            let mut recovery = VersionRecovery::default();
            assert_eq!(recovery.restart(cli, service, consent, owned), expected);
            if expected { assert!(!recovery.restart(cli, service, consent, owned)); }
        }
        let mut recovery = VersionRecovery::default();
        assert!(!recovery.restart(Some("2"), Some("1"), true, false));
        assert!(recovery.restart(Some("2"), Some("1"), true, true));
    }

    #[test]
    fn cli_choice_truth_table_preserves_explicit_overrides_and_consent() {
        let b = Some(Path::new("/app/pacer"));
        let e = Some(Path::new("/external/pacer"));
        let p = Some(Path::new("/override/pacer"));
        for (explicit, bundle, external, consent, keep, remembered, cli, env) in [
            (p, b, e, true, false, false, p, None),
            (p, b, e, false, false, false, p, None),
            (p, b, e, true, true, true, p, None),
            (b, b, e, true, false, false, b, b),
            (None, b, e, false, false, false, e, None),
            (None, b, None, false, false, false, None, None),
            (None, b, e, true, false, false, b, b),
            (None, b, None, true, false, false, b, b),
            (None, b, e, true, false, true, e, None),
            (None, b, e, false, false, true, e, None),
            (None, b, e, true, true, true, e, None),
            (None, b, e, true, true, false, e, None),
            (None, b, None, true, true, false, None, None),
            (None, None, e, false, false, false, e, None),
            (None, None, e, true, false, false, e, None),
            (None, None, None, false, false, false, None, None),
        ] {
            assert_eq!(
                cli_choice(explicit, bundle, external, consent, keep, remembered),
                (cli.map(Path::to_path_buf), env.map(Path::to_path_buf)),
                "explicit={explicit:?} consent={consent} keep={keep} remembered={remembered}"
            );
        }
    }

    #[test]
    fn bundled_shell_rejects_remote_pages_and_other_authorities() {
        assert!(!bundled_shell(None));
        for raw in [
            "tauri://localhost/",
            "tauri://localhost/index.html?state=consent",
        ] {
            assert!(bundled_shell(Some(&Url::parse(raw).unwrap())));
        }
        for raw in [
            "http://127.0.0.1:4317/app/",
            "tauri://other/",
            "tauri://localhost/action/begin",
            "tauri://user@localhost/",
            "tauri://localhost:123/index.html",
        ] {
            assert!(!bundled_shell(Some(&Url::parse(raw).unwrap())), "{raw}");
        }
    }

    #[test]
    fn onboarding_back_requires_a_bundled_source_and_exact_welcome_target() {
        let target = Url::parse("tauri://localhost/index.html?state=welcome").unwrap();
        let shell = Url::parse("tauri://localhost/index.html?state=consent").unwrap();
        assert!(onboarding_back(&target, Some(&shell)));
        assert!(!onboarding_back(&target, None));
        assert!(!onboarding_back(
            &target,
            Some(&Url::parse("http://127.0.0.1:4317/app/").unwrap())
        ));
        assert!(!onboarding_back(
            &Url::parse("tauri://localhost/index.html?state=consent").unwrap(),
            Some(&shell)
        ));
    }

    #[test]
    fn onboarding_requires_consent_only_for_a_new_bundled_install() {
        use Onboarding::*;
        for (consented, external, remembered, bundled, expected) in [
            (false, None, false, false, Ready),
            (false, None, true, false, Ready),
            (false, Some("/other/pacer"), false, false, Ready),
            (false, Some("/other/pacer"), true, false, Ready),
            (true, None, false, false, Ready),
            (true, None, true, false, Ready),
            (true, Some("/other/pacer"), false, false, Ready),
            (true, Some("/other/pacer"), true, false, Ready),
            (false, None, false, true, Welcome),
            (false, None, true, true, Welcome),
            (false, Some("/other/pacer"), false, true, Existing),
            (false, Some("/other/pacer"), true, true, Ready),
            (true, None, false, true, Ready),
            (true, None, true, true, Ready),
            (true, Some("/other/pacer"), false, true, Ready),
            (true, Some("/other/pacer"), true, true, Ready),
        ] {
            assert_eq!(
                onboarding(consented, external, remembered, bundled),
                expected
            );
        }
    }

    #[test]
    fn update_pages_replace_only_the_generic_starting_page() {
        use JournalCopy::*;
        assert_eq!(update_page("starting", false, false, None), "starting");
        assert_eq!(update_page("starting", true, false, None), "installing");
        assert_eq!(update_page("starting", true, true, None), "rollingBack");
        assert_eq!(update_page("starting", false, false, Some(Restored)), "restored");
        // A recent restoration outranks a stale maintenance flag; a rollback launch outranks both.
        assert_eq!(update_page("starting", true, false, Some(Restored)), "restored");
        assert_eq!(update_page("starting", true, true, Some(Restored)), "rollingBack");
        assert_eq!(
            update_page("starting", true, true, Some(RecoveryFailed)),
            "recoveryFailed"
        );
        for page in ["permission", "foreign", "install", "oldService", "oldApp", "protocol"] {
            assert_eq!(update_page(page, true, true, Some(RecoveryFailed)), page);
        }
    }

    #[test]
    fn recovery_report_link_opens_only_from_the_bundled_shell() {
        let shell = Url::parse("tauri://localhost/index.html?state=recoveryFailed").unwrap();
        let service = Url::parse("http://127.0.0.1:7432/app/").unwrap();
        let report = Url::parse(RECOVERY_REPORT_URL).unwrap();
        let origin = Some("http://127.0.0.1:7432");
        assert_eq!(
            main_navigation(&report, Some(&shell), origin),
            Navigation::OpenExternal
        );
        assert_eq!(main_navigation(&report, None, origin), Navigation::Block);
        for raw in [
            "https://github.com/lamtuanvu/pacer/issues/evil",
            "https://github.com/lamtuanvu/pacer/issues?x=1",
            "http://github.com/lamtuanvu/pacer/issues",
        ] {
            assert_eq!(
                main_navigation(&Url::parse(raw).unwrap(), Some(&shell), origin),
                Navigation::Block,
                "{raw}"
            );
        }
        // From the service app, normal external-link rules still apply.
        assert_eq!(
            main_navigation(&report, Some(&service), origin),
            Navigation::OpenExternal
        );
    }

    #[test]
    fn shell_actions_accept_only_exact_local_sentinels() {
        use ShellAction::*;
        for (suffix, expected) in [
            ("begin", Begin),
            ("consent?path=0", Consent { path: false }),
            ("consent?path=1", Consent { path: true }),
            ("use-app", UseApp),
            ("keep-mine", KeepMine),
            ("relink", Relink),
            ("download", Download),
        ] {
            assert_eq!(
                shell_action_url(
                    &Url::parse(&format!("tauri://localhost/action/{suffix}")).unwrap()
                ),
                Some(expected)
            );
        }
        for url in [
            "https://localhost/action/begin",
            "tauri://other/action/begin",
            "tauri://localhost/action/consent?path=2",
            "tauri://localhost/action/consent",
            "tauri://localhost/action/consent?path=1&path=0",
            "tauri://localhost/action/consent?path=1&extra=1",
            "tauri://localhost/action/unknown",
            "tauri://localhost/action/begin?extra=1",
            "tauri://localhost/action/begin#fragment",
            "tauri://user@localhost/action/begin",
            "tauri://localhost:123/action/begin",
            "tauri://localhost/action/begin/",
        ] {
            assert_eq!(shell_action_url(&Url::parse(url).unwrap()), None, "{url}");
        }
    }

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
        assert_eq!(refused, Wait);
        assert_eq!(service_steps(refused), &[] as &[&str]);
        assert_eq!(state.step(23, Ready, JobState::Running, false), Connect);
    }
    #[test]
    fn stale_heartbeat_obeys_failure_window_and_recovery() {
        use HealthProbe::*;
        use RecoveryAction::*;
        let stale = health_response(503, &json!({"ok":false,"backendLagS":46}));
        assert_eq!(stale, NoAnswer);
        assert_eq!(health_response(200, &json!({"ok":true})), Ready);
        let mut state = Lifecycle::default();
        assert_eq!(state.step(0, stale, JobState::Running, false), Wait);
        assert_eq!(state.step(29, Ready, JobState::Running, false), Connect);
        assert_eq!(state.step(30, stale, JobState::Running, false), Wait);
        assert_eq!(state.step(59, NoAnswer, JobState::Running, false), Wait);
        assert_eq!(state.step(60, stale, JobState::Running, false), Restart);
    }
    #[test]
    fn unanswered_service_requires_sustained_failure() {
        let mut state = Lifecycle::default();
        for now in [0, 20, 29] {
            assert_eq!(state.step(now, HealthProbe::NoAnswer, JobState::Running, false), RecoveryAction::Wait);
        }
        assert_eq!(state.step(30, HealthProbe::NoAnswer, JobState::Running, false), RecoveryAction::Restart);
    }
    #[test]
    fn restart_requires_three_failures_over_thirty_seconds() {
        use HealthProbe::*;
        use RecoveryAction::*;
        let mut state = Lifecycle::default();
        assert_eq!(state.step(0, Refused, JobState::Running, false), Wait);
        assert_eq!(state.step(29, Refused, JobState::Running, false), Wait);
        assert_eq!(state.step(30, Refused, JobState::Running, false), Restart);
        // Backoff and a new sustained failure interval apply after a restart.
        assert_eq!(state.step(31, Refused, JobState::Running, false), Wait);
        assert_eq!(state.step(60, Refused, JobState::Running, false), Wait);
        assert_eq!(state.step(91, Refused, JobState::Running, false), Restart);
    }
    #[test]
    fn successful_health_resets_the_continuous_failure_window() {
        use HealthProbe::*;
        use RecoveryAction::*;
        let mut state = Lifecycle::default();
        assert_eq!(state.step(0, Refused, JobState::Running, false), Wait);
        assert_eq!(state.step(20, Refused, JobState::Running, false), Wait);
        assert_eq!(state.step(29, Ready, JobState::Running, false), Connect);
        assert_eq!(state.step(30, Refused, JobState::Running, false), Wait);
        assert_eq!(state.step(59, Refused, JobState::Running, false), Wait);
        assert_eq!(state.step(60, Refused, JobState::Running, false), Restart);
        // Sparse probes must not turn one or two failures into a restart.
        state.ready();
        assert_eq!(state.step(100, Refused, JobState::Running, false), Wait);
        assert_eq!(state.step(200, Refused, JobState::Running, false), Wait);
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
    fn navigation_with_missing_current_url_allows_signin_and_blocks_external_links() {
        let origin = Some("http://127.0.0.1:7432");
        for raw in [
            "tauri://localhost/index.html",
            "http://127.0.0.1:7432/app/auth?code=test",
            "http://127.0.0.1:7432/app/#/settings",
        ] {
            assert_eq!(
                main_navigation(&Url::parse(raw).unwrap(), None, origin),
                Navigation::Allow
            );
        }
        for raw in [
            "https://example.com/",
            "https://github.com/lamtuanvu/pacer/blob/main/docs/install.md",
            "http://127.0.0.1:7433/app/auth?code=test",
            "http://127.0.0.1:7432/v3/hello",
            "file:///tmp/index.html",
        ] {
            assert_eq!(
                main_navigation(&Url::parse(raw).unwrap(), None, origin),
                Navigation::Block
            );
        }
        assert_eq!(
            main_navigation(
                &Url::parse("http://127.0.0.1:7432/app/auth?code=test").unwrap(),
                None,
                None
            ),
            Navigation::Block
        );
    }

    #[test]
    fn navigation_preserves_source_checks_for_external_links() {
        let origin = Some("http://127.0.0.1:7432");
        let shell = Url::parse("tauri://localhost/index.html").unwrap();
        let service = Url::parse("http://127.0.0.1:7432/app/").unwrap();
        let install =
            Url::parse("https://github.com/lamtuanvu/pacer/blob/main/docs/install.md").unwrap();
        let external = Url::parse("https://example.com/").unwrap();
        assert_eq!(
            main_navigation(&install, Some(&shell), origin),
            Navigation::OpenExternal
        );
        assert_eq!(
            main_navigation(&external, Some(&shell), origin),
            Navigation::Block
        );
        assert_eq!(
            main_navigation(&external, Some(&service), origin),
            Navigation::OpenExternal
        );
        assert_eq!(
            main_navigation(&external, Some(&service), None),
            Navigation::Block
        );
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
    #[test]
    fn launchd_environment_reads_only_the_job_block() {
        let text = "gui/501/com.pacer.serve = {\n\tinherited environment = {\n\t\tSSH_AUTH_SOCK => /tmp/x\n\t}\n\tdefault environment = {\n\t\tPATH => /usr/bin\n\t}\n\tenvironment = {\n\t\tPACER_HOME => /Users/u/.pacer\n\t\tPACER_PORT => 5000\n\t\tHOME => /Users/u\n\t}\n\tstate = running\n}\n";
        assert_eq!(
            launchd_environment(text),
            vec![
                ("PACER_HOME".to_owned(), "/Users/u/.pacer".to_owned()),
                ("PACER_PORT".to_owned(), "5000".to_owned()),
                ("HOME".to_owned(), "/Users/u".to_owned()),
            ]
        );
        assert!(launchd_environment("state = running\n").is_empty());
    }
    #[test]
    fn systemd_environment_handles_quoted_assignments() {
        let text = "LoadState=loaded\nEnvironment=HOME=/home/u \"PATH=/a b:/usr/bin\" PACER_HOME=/home/u/.pacer\nActiveState=active\n";
        assert_eq!(
            systemd_environment(text),
            vec![
                ("HOME".to_owned(), "/home/u".to_owned()),
                ("PATH".to_owned(), "/a b:/usr/bin".to_owned()),
                ("PACER_HOME".to_owned(), "/home/u/.pacer".to_owned()),
            ]
        );
        assert!(systemd_environment("LoadState=loaded\n").is_empty());
    }
    #[test]
    fn job_owner_defaults_to_the_standard_home_and_port() {
        let env = vec![("HOME".to_owned(), "/Users/u".to_owned())];
        assert_eq!(job_owner(&env, "/Users/u/.pacer"), ("/Users/u/.pacer".to_owned(), 4317));
        let env = vec![
            ("PACER_HOME".to_owned(), "/tmp/other".to_owned()),
            ("PACER_PORT".to_owned(), "5000".to_owned()),
        ];
        assert_eq!(job_owner(&env, "/Users/u/.pacer"), ("/tmp/other".to_owned(), 5000));
        let env = vec![("PACER_PORT".to_owned(), "not-a-port".to_owned())];
        assert_eq!(job_owner(&env, "/Users/u/.pacer").1, 4317);
    }
    #[test]
    fn a_job_is_foreign_when_its_home_or_port_differs() {
        let env = |home: &str, port: Option<&str>| {
            let mut env = vec![("PACER_HOME".to_owned(), home.to_owned())];
            env.extend(port.map(|port| ("PACER_PORT".to_owned(), port.to_owned())));
            env
        };
        let ours = Path::new("/Users/u/.pacer");
        assert_eq!(foreign_owner(&env("/Users/u/.pacer", None), "/Users/u/.pacer", ours, 4317), None);
        assert_eq!(foreign_owner(&[], "/Users/u/.pacer", ours, 4317), None);
        assert_eq!(
            foreign_owner(&env("/Users/u/work", None), "/Users/u/.pacer", ours, 4317),
            Some(JobOwner { home: "/Users/u/work".to_owned(), port: 4317 })
        );
        // Same home, different port: still another pacer.
        assert_eq!(
            foreign_owner(&env("/Users/u/.pacer", Some("5000")), "/Users/u/.pacer", ours, 4317),
            Some(JobOwner { home: "/Users/u/.pacer".to_owned(), port: 5000 })
        );
        assert_eq!(foreign_owner(&env("/Users/u/.pacer", Some("5000")), "/Users/u/.pacer", ours, 5000), None);
    }
    #[test]
    fn a_symlinked_home_is_the_same_pacer() {
        let root = std::env::temp_dir().join(format!("pacer-foreign-{}", std::process::id()));
        let real = root.join("real");
        let link = root.join("link");
        std::fs::create_dir_all(&real).unwrap();
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let env = vec![("PACER_HOME".to_owned(), link.to_string_lossy().into_owned())];
        assert_eq!(foreign_owner(&env, "/unused", &real, 4317), None);
        // Port-only detection still works through the symlink.
        let owner = JobOwner { home: link.to_string_lossy().into_owned(), port: 5000 };
        assert_eq!(foreign_diagnosis(&owner, &real, 4317, "").port, Some(5000));
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn foreign_page_names_the_port_only_when_the_folder_matches() {
        let ours = Path::new("/Users/u/.pacer");
        let other_port = JobOwner { home: "/Users/u/.pacer".to_owned(), port: 5000 };
        let detail = foreign_diagnosis(&other_port, ours, 4317, "/Users/u");
        assert_eq!(detail.page, "foreign");
        assert_eq!(detail.path.as_deref(), Some("~/.pacer"));
        assert_eq!((detail.port, detail.app_port), (Some(5000), Some(4317)));
        let other_home = JobOwner { home: "/Users/u/work".to_owned(), port: 5000 };
        let detail = foreign_diagnosis(&other_home, ours, 4317, "/Users/u");
        assert_eq!(detail.path.as_deref(), Some("~/work"));
        assert_eq!((detail.port, detail.app_port), (None, None));
    }
    #[test]
    fn unconfirmed_or_foreign_jobs_are_not_managed() {
        assert!(!may_manage_job(JobState::Foreign, true));
        assert!(!may_manage_job(JobState::Foreign, false));
        assert!(!may_manage_job(JobState::Unknown, true));
        assert!(may_manage_job(JobState::Unknown, false));
        for job in [JobState::NotLoaded, JobState::Stopped, JobState::Running] {
            assert!(may_manage_job(job, true));
            assert!(may_manage_job(job, false));
        }
    }
    #[test]
    fn foreign_job_is_never_started_or_restarted() {
        use HealthProbe::*;
        use RecoveryAction::*;
        let mut state = Lifecycle::default();
        assert_eq!(state.step(0, Refused, JobState::Foreign, false), RecoveryAction::Foreign);
        for now in [20, 40, 60, 80, 140, 220] {
            assert_eq!(state.step(now, NoAnswer, JobState::Foreign, false), RecoveryAction::Foreign, "{now}");
            assert_eq!(state.step(now, Refused, JobState::Foreign, false), RecoveryAction::Foreign, "{now}");
        }
        // A healthy service on this shell's own port is still used.
        assert_eq!(state.step(300, Ready, JobState::Foreign, false), Connect);
        // Once the job is ours again, normal recovery resumes.
        assert_eq!(state.step(301, Refused, JobState::Stopped, false), Start);
    }
    #[test]
    fn one_page_per_pass_explains_a_missing_cli() {
        use RecoveryAction::*;
        let none = JobState::NotLoaded;
        for macos in [true, false] {
            assert_eq!(shell_page(false, Install, HealthProbe::Refused, none, false, macos), "install");
            // The Wait passes between gated installs keep the page.
            assert_eq!(shell_page(false, Wait, HealthProbe::Refused, none, false, macos), "install");
            assert_eq!(shell_page(false, Connect, HealthProbe::Ready, JobState::Unknown, false, macos), "install");
            assert_eq!(shell_page(false, Install, HealthProbe::Refused, none, true, macos), "starting");
            assert_eq!(shell_page(false, Connect, HealthProbe::Ready, JobState::Unknown, true, macos), "starting");
            assert_eq!(shell_page(false, Start, HealthProbe::Refused, JobState::Unknown, true, macos), "starting");
            assert_eq!(shell_page(false, Wait, HealthProbe::Refused, JobState::Running, false, macos), "starting");
            assert_eq!(shell_page(false, Start, HealthProbe::Refused, JobState::Stopped, false, macos), "starting");
            assert_eq!(shell_page(false, RecoveryAction::Foreign, HealthProbe::Refused, JobState::Foreign, true, macos), "foreign");
            assert_eq!(shell_page(true, Install, HealthProbe::Refused, none, false, macos), "permission");
            assert_eq!(shell_page(true, RecoveryAction::Foreign, HealthProbe::Refused, JobState::Foreign, false, macos), "permission");
        }
        // macOS never starts an unconfirmed job, so the page stays "starting" until the job is known.
        assert_eq!(shell_page(false, Start, HealthProbe::Refused, JobState::Unknown, false, true), "starting");
        // Linux would start `pacer serve` for an unknown job, which needs a CLI.
        assert_eq!(shell_page(false, Start, HealthProbe::Refused, JobState::Unknown, false, false), "install");
        assert_eq!(shell_page(false, Wait, HealthProbe::Refused, JobState::Unknown, false, false), "install");
        assert_eq!(shell_page(false, Wait, HealthProbe::NoAnswer, JobState::Unknown, false, false), "install");
        // The job isn't queried for other probes; their pages stay (protocol, unreachable).
        assert_eq!(shell_page(false, Protocol, HealthProbe::Invalid, JobState::Unknown, false, false), "starting");
        assert_eq!(shell_page(false, Wait, HealthProbe::Unreachable, JobState::Unknown, false, false), "starting");
    }
    #[test]
    fn linux_without_systemd_or_cli_shows_install_instead_of_stuck() {
        let mut state = Lifecycle::default();
        for now in 0..70 {
            let action = state.step(now, HealthProbe::Refused, JobState::Unknown, false);
            assert_eq!(shell_page(false, action, HealthProbe::Refused, JobState::Unknown, false, false), "install", "{now}");
        }
    }
    #[test]
    fn missing_cli_page_holds_across_gated_install_passes() {
        let mut state = Lifecycle::default();
        for now in 0..70 {
            let action = state.step(now, HealthProbe::Refused, JobState::NotLoaded, false);
            assert_eq!(shell_page(false, action, HealthProbe::Refused, JobState::NotLoaded, false, true), "install", "{now}");
        }
    }
    #[test]
    fn display_home_abbreviates_only_the_home_prefix() {
        assert_eq!(display_home("/Users/u/.pacer", "/Users/u"), "~/.pacer");
        assert_eq!(display_home("/Users/u", "/Users/u"), "~");
        assert_eq!(display_home("/Users/user2/.pacer", "/Users/u"), "/Users/user2/.pacer");
        assert_eq!(display_home("/tmp/x", ""), "/tmp/x");
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

#[cfg(test)]
mod fixture_tray_tests {
    use super::*;
    #[test]
    fn isolated_tray_authenticates_its_own_store_through_only_the_exact_service() {
        let origin = "http://127.0.0.1:54321";
        for path in ["/app/auth?code=separate-once", "/app/", "/app/tray.html"] {
            assert!(fixture_tray_navigation(
                &Url::parse(&format!("{origin}{path}")).unwrap(),
                origin
            ));
        }
        for url in [
            "http://127.0.0.1:54322/app/tray.html",
            "https://example.com/app/auth?code=once",
            "http://127.0.0.1:54321/v3/snapshot",
            "http://127.0.0.1:54321/app/other.html",
            "tauri://localhost/index.html",
        ] {
            assert!(!fixture_tray_navigation(&Url::parse(url).unwrap(), origin));
        }
        let auth = Url::parse(&format!("{origin}/app/auth?code=separate-once")).unwrap();
        assert!(fixture_tray_auth(&auth, origin));
        assert!(!fixture_tray_auth(&auth, "http://127.0.0.1:54322"));
        assert!(!fixture_tray_auth(
            &Url::parse(&format!("{origin}/app/tray.html")).unwrap(),
            origin
        ));
        assert!(!fixture_tray_auth(
            &Url::parse(&format!("{origin}/app/auth")).unwrap(),
            origin
        ));
    }
}

// Fixture webviews deliberately have distinct nonpersistent stores. The tray
// needs its own one-use sign-in and a same-origin hop before loading its page.
#[cfg(any(test, feature = "ota-fixture"))]
pub fn fixture_tray_auth(url: &Url, origin: &str) -> bool {
    local_origin(url).as_deref() == Some(origin)
        && url.path() == "/app/auth"
        && url
            .query_pairs()
            .any(|(key, value)| key == "code" && !value.is_empty())
}
#[cfg(any(test, feature = "ota-fixture"))]
pub fn fixture_tray_navigation(url: &Url, origin: &str) -> bool {
    local_origin(url).as_deref() == Some(origin)
        && matches!(url.path(), "/app/auth" | "/app/" | "/app/tray.html")
}

/// Public connection diagnostics never confer native update authority or expose paths.
pub fn desktop_update_connection(
    configured: bool,
    alive: bool,
    error: Option<pacer_desktop::ota::OtaError>,
) -> serde_json::Value {
    let (state, reason) = if !configured {
        ("unsupported", None)
    } else if alive {
        ("available", None)
    } else if let Some(error) = error {
        ("unavailable", Some(if error == pacer_desktop::ota::OtaError::Identity { "service-identity" } else { "connection" }))
    } else {
        ("connecting", None)
    };
    serde_json::json!({ "state": state, "reason": reason })
}

#[cfg(test)]
mod desktop_connection_tests {
    use super::*;
    use pacer_desktop::ota::OtaError;
    #[test]
    fn connection_failure_is_not_an_up_to_date_or_manual_only_state() {
        assert_eq!(desktop_update_connection(true, false, Some(OtaError::Identity)), serde_json::json!({"state":"unavailable","reason":"service-identity"}));
        assert_eq!(desktop_update_connection(true, false, Some(OtaError::Io)), serde_json::json!({"state":"unavailable","reason":"connection"}));
    }
    #[test]
    fn live_authority_and_build_support_are_distinct_from_pending_connection() {
        assert_eq!(desktop_update_connection(false, false, None)["state"], "unsupported");
        assert_eq!(desktop_update_connection(true, false, None)["state"], "connecting");
        assert_eq!(desktop_update_connection(true, true, Some(OtaError::Identity)), serde_json::json!({"state":"available","reason":null}));
    }
}
