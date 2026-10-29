use reqwest::Url;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TakeoverDismissal {
    schema: u32,
    sha256: String,
    cdhash: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TakeoverAcknowledgement {
    schema: u32,
    transaction_id: String,
}

/// Reads a small private record without following a symlink at its name.
fn read_private_record(config: &Path, name: &str) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(config.join(name))
        .ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > 1024 {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(1025).read_to_end(&mut bytes).ok()?;
    (bytes.len() <= 1024).then_some(bytes)
}

fn write_private_record(config: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    use std::io::Write;
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(config).map_err(|e| e.to_string())?;
    let temp = config.join(format!(".{name}-{}-{}.tmp", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos()));
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temp).map_err(|e| e.to_string())?;
    let result = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temp, config.join(name))?;
        std::fs::File::open(config)?.sync_all()
    })();
    if result.is_err() { let _ = std::fs::remove_file(temp); }
    result.map_err(|e| e.to_string())
}

pub fn takeover_dismissed(config: &Path, identity: &pacer_desktop::ota::bootstrap_identity::LegacyExecutable) -> bool {
    let Some(bytes) = read_private_record(config, "takeover-dismissed.json") else { return false };
    let Ok(record) = serde_json::from_slice::<TakeoverDismissal>(&bytes) else { return false };
    record.schema == 1 && record.sha256 == identity.sha256 && record.cdhash == identity.cdhash
}

pub fn dismiss_takeover(config: &Path, identity: &pacer_desktop::ota::bootstrap_identity::LegacyExecutable) -> Result<(), String> {
    let bytes = serde_json::to_vec(&TakeoverDismissal { schema: 1, sha256: identity.sha256.clone(), cdhash: identity.cdhash.clone() }).map_err(|e| e.to_string())?;
    write_private_record(config, "takeover-dismissed.json", &bytes)
}

/// Whether the user already saw the restored outcome of this transaction.
pub fn takeover_acknowledged(config: &Path, transaction_id: &str) -> bool {
    read_private_record(config, "takeover-acknowledged.json")
        .and_then(|bytes| serde_json::from_slice::<TakeoverAcknowledgement>(&bytes).ok())
        .is_some_and(|record| record.schema == 1 && record.transaction_id == transaction_id)
}

pub fn acknowledge_takeover(config: &Path, transaction_id: &str) -> Result<(), String> {
    let bytes = serde_json::to_vec(&TakeoverAcknowledgement { schema: 1, transaction_id: transaction_id.into() }).map_err(|e| e.to_string())?;
    write_private_record(config, "takeover-acknowledged.json", &bytes)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchGate { Takeover, Version }
/// Detection runs before the version gate, because a takeover build commonly
/// reports another version; only a dismissal lets the version gate decide.
pub fn launch_gate(candidate: bool, dismissed: bool) -> LaunchGate {
    if candidate && !dismissed { LaunchGate::Takeover } else { LaunchGate::Version }
}

/// What the desktop does about unfinished takeover transactions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UnfinishedTakeoverNext {
    /// A recovery job or a running helper owns the transaction.
    Wait,
    /// No recovery job is loaded for this transaction, for example because
    /// the helper was killed before it armed one: run recovery once.
    Recover(String),
    /// Recovery cannot finish on its own.
    Failed(StuckTakeover),
}

/// Why an unfinished transaction needs attention.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StuckTakeover {
    /// This desktop's recovery run left it unfinished.
    Unrecovered,
    /// Its manifest or journal cannot be read or validated.
    Unreadable,
    /// Another app copy or an earlier boot started it, so this desktop does not
    /// run its recovery.
    NotThisApp,
}

/// `started_here` says whether a transaction's recorded origin is this
/// running app in this boot (see [`started_by_this_app`]).
pub fn unfinished_takeover_next(
    unfinished: &[pacer_desktop::ota::takeover::journal::UnfinishedTakeover],
    recovery_loaded: impl Fn(&str) -> bool,
    attempted: &std::collections::HashSet<String>,
    started_here: impl Fn(&pacer_desktop::ota::takeover::journal::TakeoverOrigin) -> bool,
) -> Option<UnfinishedTakeoverNext> {
    if unfinished.is_empty() {
        return None;
    }
    if unfinished.iter().any(|tx| !tx.readable) {
        return Some(UnfinishedTakeoverNext::Failed(StuckTakeover::Unreadable));
    }
    if let Some(tx) = unfinished.iter().find(|tx| !recovery_loaded(&tx.transaction_id)) {
        if !tx.origin.as_ref().is_some_and(&started_here) {
            return Some(UnfinishedTakeoverNext::Failed(StuckTakeover::NotThisApp));
        }
        if attempted.contains(&tx.transaction_id) {
            return Some(UnfinishedTakeoverNext::Failed(StuckTakeover::Unrecovered));
        }
        return Some(UnfinishedTakeoverNext::Recover(tx.transaction_id.clone()));
    }
    Some(UnfinishedTakeoverNext::Wait)
}

/// Whether a transaction was authorized from this running app bundle (its
/// bundled CLI, compared after resolving both paths) during the current boot.
/// Anything unknown is not this app.
pub fn started_by_this_app(
    recorded: &pacer_desktop::ota::takeover::journal::TakeoverOrigin,
    app_cli: Option<&Path>,
    boot_id: Option<&str>,
) -> bool {
    let (Some(app_cli), Some(boot_id)) = (app_cli, boot_id) else {
        return false;
    };
    match (recorded.bundled_cli.canonicalize(), app_cli.canonicalize()) {
        (Ok(recorded_cli), Ok(app_cli)) => recorded_cli == app_cli && recorded.boot_id == boot_id,
        _ => false,
    }
}

/// An unanswerable recovery-job query (`None`: no release trust; `Err`:
/// launchd failed) counts as not loaded for recovery: a job that is in fact
/// running holds the transaction lock, so recovery waits for it.
pub fn recovery_job_loaded_for_recovery<E>(query: Option<Result<bool, E>>) -> bool {
    matches!(query, Some(Ok(true)))
}

/// For pruning the same query counts as loaded, so a job's program (the
/// transaction's helper copy) is never deleted while the job may exist.
pub fn recovery_job_loaded_for_pruning<E>(query: Option<Result<bool, E>>) -> bool {
    !matches!(query, Some(Ok(false)))
}

/// The public reason shown with a stuck transaction's recovery-failed page.
pub fn takeover_failure_reason(next: &UnfinishedTakeoverNext) -> Option<&'static str> {
    match next {
        UnfinishedTakeoverNext::Failed(StuckTakeover::Unreadable) => Some("journal:unreadable"),
        UnfinishedTakeoverNext::Failed(StuckTakeover::NotThisApp) => Some("journal:foreign"),
        _ => None,
    }
}

/// The bundled page takeover transactions hold before the desktop may install,
/// start, sign in to or otherwise act on the service. `latest` is the newest
/// finished transaction and whether its restored outcome was already shown.
pub fn takeover_gate(
    unfinished: Option<UnfinishedTakeoverNext>,
    latest: Option<(pacer_desktop::ota::takeover::journal::TakeoverState, bool)>,
) -> Option<&'static str> {
    use pacer_desktop::ota::takeover::journal::TakeoverState;
    match unfinished {
        Some(UnfinishedTakeoverNext::Failed { .. }) => return Some("takeoverFailed"),
        Some(_) => return Some("takeoverProgress"),
        None => {}
    }
    match latest {
        Some((TakeoverState::RecoveryFailed, _)) => Some("takeoverFailed"),
        Some((TakeoverState::Restored, false)) => Some("takeoverRestored"),
        _ => None,
    }
}

/// The offer's best-effort facts are read again on every pass, also while the
/// cached inspection is reused; a read that fails shows as unknown.
pub fn refresh_takeover_work(inspection: &mut Value, version: Option<&str>, tasks: Option<usize>, terminals: Option<usize>) {
    inspection["currentVersion"] = serde_json::json!(version);
    inspection["work"] = serde_json::json!({"tasks":tasks,"terminals":terminals});
}

/// Shown when the service was replaced but the terminal command was not
/// switched. The error itself goes only to the log.
pub const TAKEOVER_RELINK_FAILED: (&str, &str) = (
    "Terminal command not changed",
    "The app's service is running, but the terminal command still runs another build. To switch it, move ~/.local/bin/pacer aside and reopen pacer, which offers to recreate the command.",
);

/// What follows a takeover the helper did not commit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TakeoverFailureNext {
    /// A transaction started: show its journal's page now.
    Show(&'static str),
    /// Nothing changed: offer the choice again with an error.
    Reoffer,
}

pub fn takeover_failure_next(gate: Option<&'static str>) -> TakeoverFailureNext {
    gate.map_or(TakeoverFailureNext::Reoffer, TakeoverFailureNext::Show)
}

/// Pages that wait for the user's choice; the lifecycle reconnects slowly there.
pub fn waiting_for_choice(page: Option<&str>) -> bool {
    matches!(page, Some("outdatedService" | "unverifiedService" | "takeover" | "takeoverRestored" | "takeoverFailed"))
}

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceRelease {
    Matched,
    Older,
    Newer,
    Unknown,
}

pub fn service_release(app: &str, live_service: Option<&str>) -> ServiceRelease {
    let parse = |value: &str| {
        semver::Version::parse(value)
            .ok()
            .filter(|version| version.pre.is_empty() && version.build.is_empty())
    };
    match (parse(app), live_service.and_then(parse)) {
        (Some(app), Some(service)) if app == service => ServiceRelease::Matched,
        (Some(app), Some(service)) if service < app => ServiceRelease::Older,
        (Some(_), Some(_)) => ServiceRelease::Newer,
        _ => ServiceRelease::Unknown,
    }
}

pub fn display_service_release(live_service: Option<&str>) -> String {
    live_service
        .filter(|value| value.len() <= 32)
        .and_then(|value| semver::Version::parse(value).ok())
        .filter(|version| version.pre.is_empty() && version.build.is_empty())
        .map(|version| version.to_string())
        .unwrap_or_else(|| "Unknown".into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceGate {
    Open,
    ExplainOlder,
    ExplainUnknown,
}

pub fn service_gate(app: &str, live_service: Option<&str>, accepted: Option<&str>) -> ServiceGate {
    match service_release(app, live_service) {
        ServiceRelease::Older if accepted != Some(live_service.unwrap_or("")) => {
            ServiceGate::ExplainOlder
        }
        ServiceRelease::Unknown if accepted != Some(live_service.unwrap_or("")) => {
            ServiceGate::ExplainUnknown
        }
        _ => ServiceGate::Open,
    }
}

/** The signed disposable fixture can queue the existing choice for one fixed release pair. */
#[cfg(any(test, feature = "ota-fixture"))]
pub fn fixture_continue_old_service(gate: ServiceGate, app: &str, live_service: Option<&str>, permitted: bool) -> bool {
    permitted && gate == ServiceGate::ExplainOlder && app == "0.2.4" && live_service == Some("0.2.3")
}

#[cfg(any(test, feature = "ota-fixture"))]
pub fn queue_fixture_old_service_choice(slot: &mut Option<ShellAction>) -> bool {
    if slot.is_some() { return false; }
    *slot = Some(ShellAction::ContinueOldService);
    true
}

pub fn connection_retry_delay(
    normal: std::time::Duration,
    waiting_for_service_choice: bool,
) -> std::time::Duration {
    if waiting_for_service_choice {
        normal.max(std::time::Duration::from_secs(30))
    } else {
        normal
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
    ContinueOldService,
    TakeoverDismiss,
    TakeoverConfirm { relink: bool },
}

/// A takeover token is 32 random bytes in lowercase hex.
fn valid_takeover_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The token a takeover sentinel carries; its format is checked by `shell_action_url`.
pub fn takeover_token(url: &Url) -> Option<String> {
    url.query_pairs().find(|(key, _)| key == "token").map(|(_, value)| value.into_owned())
}

/// The bundled pages that may carry a takeover token, and what each permits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TakeoverPage {
    /// The offer: confirm or dismiss.
    Offer,
    /// The restored outcome: continue with the current service only.
    Restored,
}

pub fn takeover_page(current: Option<&Url>) -> Option<TakeoverPage> {
    if !bundled_shell(current) {
        return None;
    }
    match current?.query() {
        Some("state=takeover") => Some(TakeoverPage::Offer),
        Some("state=takeoverRestored") => Some(TakeoverPage::Restored),
        _ => None,
    }
}

/// Authority of the main window's document. `current` is the last finished
/// load and is cleared when a new document starts loading, so a document in
/// flight never inherits the previous page's authority. A takeover token is
/// issued only to the bundled takeover page and is single use. It is bound to
/// the candidate the page shows: re-renders of the same candidate keep it, so
/// a click during a render is not lost, and a new candidate gets a new token.
#[derive(Default)]
pub struct MainPage {
    current: Option<Url>,
    takeover: Option<TakeoverToken>,
}
struct TakeoverToken {
    token: String,
    page: TakeoverPage,
    candidate: Option<String>,
}
impl MainPage {
    pub fn current(&self) -> Option<&Url> {
        self.current.as_ref()
    }
    /// A finished load of `url` becomes the current document.
    pub fn finished(&mut self, url: Url) {
        self.current = Some(url);
        self.takeover = None;
    }
    /// An allowed main-frame navigation to `url`. Any navigation ends the
    /// takeover token; only a same-document fragment change keeps `current`.
    pub fn navigating(&mut self, url: &Url) {
        self.takeover = None;
        let same_document = self.current.as_ref().is_some_and(|current| {
            let mut a = current.clone();
            let mut b = url.clone();
            a.set_fragment(None);
            b.set_fragment(None);
            a == b
        });
        if !same_document {
            self.current = None;
        }
    }
    /// A new document started loading.
    pub fn started(&mut self) {
        self.current = None;
        self.takeover = None;
    }
    /// The token to inject into the current bundled takeover page showing
    /// `candidate`: the unused token already issued for it, or `fresh`.
    pub fn issue_takeover_token(&mut self, candidate: Option<&str>, fresh: String) -> Option<String> {
        let Some(page) = takeover_page(self.current.as_ref()) else {
            self.takeover = None;
            return None;
        };
        if let Some(issued) = self.takeover.as_ref().filter(|t| t.page == page && t.candidate.as_deref() == candidate) {
            return Some(issued.token.clone());
        }
        self.takeover = None;
        if !valid_takeover_token(&fresh) {
            return None;
        }
        self.takeover = Some(TakeoverToken { token: fresh.clone(), page, candidate: candidate.map(str::to_owned) });
        Some(fresh)
    }
    pub fn revoke_takeover_token(&mut self) {
        self.takeover = None;
    }
    /// Consumes the token. Accepts `action` only when the sentinel carries the
    /// token issued to the current takeover page, that page permits it, and
    /// the shell still holds the candidate the token was issued for.
    pub fn authorize_takeover(&mut self, url: &Url, action: ShellAction, candidate: Option<&str>) -> bool {
        let Some(issued) = self.takeover.take() else { return false };
        let permitted = match action {
            ShellAction::TakeoverConfirm { .. } => issued.page == TakeoverPage::Offer,
            ShellAction::TakeoverDismiss => true,
            _ => false,
        };
        permitted
            && takeover_page(self.current.as_ref()) == Some(issued.page)
            && issued.candidate.as_deref() == candidate
            && takeover_token(url).is_some_and(|presented| presented == issued.token)
    }
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
    if matches!(url.path(), "/action/takeover-confirm" | "/action/takeover-dismiss") {
        let query = url.query()?;
        let (rest, token) = query.rsplit_once("token=")?;
        if !valid_takeover_token(token) {
            return None;
        }
        return match (url.path(), rest) {
            ("/action/takeover-confirm", "relink=0&") => Some(ShellAction::TakeoverConfirm { relink: false }),
            ("/action/takeover-confirm", "relink=1&") => Some(ShellAction::TakeoverConfirm { relink: true }),
            ("/action/takeover-dismiss", "") => Some(ShellAction::TakeoverDismiss),
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
        "/action/continue-old-service" => Some(ShellAction::ContinueOldService),
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
        "outdatedService" => "outdatedService",
        "unverifiedService" => "unverifiedService",
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
        "https://github.com/lamtuanvu/pacer/blob/main/docs/install.md"
            | "https://github.com/lamtuanvu/pacer/blob/main/docs/desktop-updates.md"
            | RECOVERY_REPORT_URL
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
    if value == "/needs-you" {
        return Some("#/needs-you".into());
    }
    let parts: Vec<_> = value.trim_matches('/').split('/').collect();
    if !matches!(parts[0], "review" | "sessions" | "settings" | "tasks")
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
    fn live_service_release_is_compared_with_desktop_release() {
        use ServiceRelease::*;
        assert_eq!(service_release("0.10.0", Some("0.10.0")), Matched);
        assert_eq!(service_release("0.10.0", Some("0.9.0")), Older);
        assert_eq!(service_release("0.10.0", Some("0.11.0")), Newer);
        assert_eq!(service_release("0.10.0", None), Unknown);
        assert_eq!(service_release("0.10.0", Some("broken")), Unknown);
        assert_eq!(service_release("0.10.0", Some("0.10.0-beta.1")), Unknown);
        assert_eq!(service_release("broken", Some("0.9.0")), Unknown);
        assert_eq!(display_service_release(Some("0.9.0")), "0.9.0");
        assert_eq!(display_service_release(None), "Unknown");
        assert_eq!(display_service_release(Some("0.9.0\nUpdate now")), "Unknown");
        assert_eq!(display_service_release(Some(&"9".repeat(200))), "Unknown");
    }

    #[test]
    fn live_service_gate_needs_ack_for_exact_release_and_rechecks_after_change() {
        use ServiceGate::*;
        assert_eq!(service_gate("0.10.0", Some("0.9.0"), None), ExplainOlder);
        assert_eq!(service_gate("0.10.0", Some("0.9.0"), Some("0.9.0")), Open);
        assert_eq!(service_gate("0.10.0", Some("0.8.0"), Some("0.9.0")), ExplainOlder);
        assert_eq!(service_gate("0.10.0", Some("0.10.0"), None), Open);
        assert_eq!(service_gate("0.10.0", Some("bad"), None), ExplainUnknown);
        assert_eq!(service_gate("0.10.0", Some("bad"), Some("bad")), Open);
        assert_eq!(service_gate("0.10.0", None, None), ExplainUnknown);
        assert_eq!(service_gate("0.10.0", None, Some("")), Open);
    }

    #[test]
    fn disposable_old_service_choice_is_one_exact_gate_and_release_pair() {
        use ServiceGate::*;
        assert!(fixture_continue_old_service(ExplainOlder, "0.2.4", Some("0.2.3"), true));
        for (gate, app, service, permitted) in [
            (ExplainOlder, "0.2.4", Some("0.2.3"), false),
            (ExplainOlder, "0.2.4", Some("0.2.2"), true),
            (ExplainOlder, "0.2.5", Some("0.2.3"), true),
            (ExplainUnknown, "0.2.4", Some("0.2.3"), true),
            (Open, "0.2.4", Some("0.2.3"), true),
        ] {
            assert!(!fixture_continue_old_service(gate, app, service, permitted));
        }
        let mut pending = Some(ShellAction::Download);
        assert!(!queue_fixture_old_service_choice(&mut pending));
        assert_eq!(pending, Some(ShellAction::Download));
        pending = None;
        assert!(queue_fixture_old_service_choice(&mut pending));
        assert_eq!(pending, Some(ShellAction::ContinueOldService));
    }

    #[test]
    fn mismatch_waits_between_auth_attempts_without_slowing_normal_reconnect() {
        let normal = std::time::Duration::from_secs(1);
        assert_eq!(connection_retry_delay(normal, false), normal);
        assert_eq!(connection_retry_delay(normal, true), std::time::Duration::from_secs(30));
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
    fn service_update_guide_opens_only_from_the_bundled_shell() {
        let shell = Url::parse("tauri://localhost/index.html?state=outdatedService").unwrap();
        let guide = Url::parse("https://github.com/lamtuanvu/pacer/blob/main/docs/desktop-updates.md").unwrap();
        assert_eq!(main_navigation(&guide, Some(&shell), None), Navigation::OpenExternal);
        assert_eq!(main_navigation(&guide, None, None), Navigation::Block);
        assert_eq!(main_navigation(
            &Url::parse("https://github.com/lamtuanvu/pacer/blob/main/docs/desktop-updates.md?other=1").unwrap(),
            Some(&shell), None,
        ), Navigation::Block);
    }

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const OTHER: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }
    fn confirm(token: &str) -> Url {
        url(&format!("tauri://localhost/action/takeover-confirm?relink=1&token={token}"))
    }
    fn dismiss(token: &str) -> Url {
        url(&format!("tauri://localhost/action/takeover-dismiss?token={token}"))
    }
    const CONFIRM: ShellAction = ShellAction::TakeoverConfirm { relink: true };
    const SEEN: Option<&str> = Some("candidate-a");
    const CHANGED: Option<&str> = Some("candidate-b");

    #[test]
    fn takeover_token_is_issued_only_to_the_bundled_takeover_page_and_used_once() {
        let mut page = MainPage::default();
        assert_eq!(page.issue_takeover_token(SEEN, TOKEN.into()), None);
        page.finished(url("http://127.0.0.1:4317/app/"));
        assert_eq!(page.issue_takeover_token(SEEN, TOKEN.into()), None);
        page.finished(url("tauri://localhost/index.html?state=starting"));
        assert_eq!(page.issue_takeover_token(SEEN, TOKEN.into()), None);
        page.finished(url("tauri://localhost/index.html?state=takeover"));
        assert_eq!(page.issue_takeover_token(SEEN, "short".into()), None);
        assert_eq!(page.issue_takeover_token(SEEN, TOKEN.into()).as_deref(), Some(TOKEN));
        // A missing or mismatched token is rejected and ends the token.
        assert!(!page.authorize_takeover(&url("tauri://localhost/action/takeover-confirm?relink=1"), CONFIRM, SEEN));
        assert!(!page.authorize_takeover(&confirm(TOKEN), CONFIRM, SEEN));
        page.issue_takeover_token(SEEN, TOKEN.into());
        assert!(!page.authorize_takeover(&confirm(OTHER), CONFIRM, SEEN));
        assert!(!page.authorize_takeover(&confirm(TOKEN), CONFIRM, SEEN));
        // The issued token is accepted once.
        page.issue_takeover_token(SEEN, TOKEN.into());
        assert!(page.authorize_takeover(&confirm(TOKEN), CONFIRM, SEEN));
        assert!(!page.authorize_takeover(&confirm(TOKEN), CONFIRM, SEEN));
        page.issue_takeover_token(SEEN, TOKEN.into());
        assert!(page.authorize_takeover(&dismiss(TOKEN), ShellAction::TakeoverDismiss, SEEN));
    }

    #[test]
    fn rerender_keeps_the_token_while_the_candidate_is_unchanged() {
        // A periodic re-render must not void a click carrying the token already on the page.
        let mut page = MainPage::default();
        page.finished(url("tauri://localhost/index.html?state=takeover"));
        assert_eq!(page.issue_takeover_token(SEEN, TOKEN.into()).as_deref(), Some(TOKEN));
        assert_eq!(page.issue_takeover_token(SEEN, OTHER.into()).as_deref(), Some(TOKEN));
        assert!(page.authorize_takeover(&confirm(TOKEN), CONFIRM, SEEN));
        // Once used, the next render issues a fresh token.
        assert_eq!(page.issue_takeover_token(SEEN, OTHER.into()).as_deref(), Some(OTHER));
    }

    #[test]
    fn a_new_candidate_gets_a_new_token_and_voids_the_old_one() {
        let mut page = MainPage::default();
        page.finished(url("tauri://localhost/index.html?state=takeover"));
        page.issue_takeover_token(SEEN, TOKEN.into());
        assert_eq!(page.issue_takeover_token(CHANGED, OTHER.into()).as_deref(), Some(OTHER));
        assert!(!page.authorize_takeover(&confirm(TOKEN), CONFIRM, CHANGED));
        // A token bound to the reviewed candidate is refused once the shell holds another one,
        // even before the page is re-rendered.
        page.issue_takeover_token(SEEN, TOKEN.into());
        assert!(!page.authorize_takeover(&confirm(TOKEN), CONFIRM, CHANGED));
        page.issue_takeover_token(SEEN, TOKEN.into());
        assert!(!page.authorize_takeover(&confirm(TOKEN), CONFIRM, None));
    }

    #[test]
    fn restored_page_token_permits_only_continuing() {
        let mut page = MainPage::default();
        page.finished(url("tauri://localhost/index.html?state=takeoverRestored"));
        page.issue_takeover_token(SEEN, TOKEN.into());
        assert!(!page.authorize_takeover(&confirm(TOKEN), CONFIRM, SEEN));
        page.issue_takeover_token(SEEN, TOKEN.into());
        assert!(page.authorize_takeover(&dismiss(TOKEN), ShellAction::TakeoverDismiss, SEEN));
    }

    #[test]
    fn service_navigation_after_the_takeover_page_cannot_confirm() {
        // The bundled offer finished loading and received its token.
        let mut page = MainPage::default();
        page.finished(url("tauri://localhost/index.html?state=takeover"));
        let token = page.issue_takeover_token(SEEN, TOKEN.into()).unwrap();
        // The lifecycle then navigates to the unverified service. Its document
        // runs a confirm before its own load finishes, even with a leaked token.
        let service = url("http://127.0.0.1:4317/app/auth?code=x");
        page.navigating(&service);
        assert_eq!(page.current(), None);
        assert!(!page.authorize_takeover(&confirm(&token), CONFIRM, SEEN));
        page.started();
        assert!(!page.authorize_takeover(&confirm(&token), CONFIRM, SEEN));
        // After the service page finishes, it cannot obtain a token either.
        page.finished(service);
        assert_eq!(page.issue_takeover_token(SEEN, OTHER.into()), None);
        assert!(!page.authorize_takeover(&confirm(&token), CONFIRM, SEEN));
        assert!(!page.authorize_takeover(&dismiss(&token), ShellAction::TakeoverDismiss, SEEN));
    }

    #[test]
    fn a_new_document_load_ends_the_takeover_authority() {
        let mut page = MainPage::default();
        page.finished(url("tauri://localhost/index.html?state=takeover"));
        page.issue_takeover_token(SEEN, TOKEN.into());
        page.started();
        assert_eq!(page.current(), None);
        assert!(!page.authorize_takeover(&confirm(TOKEN), CONFIRM, SEEN));
        // A fragment change keeps the document but still ends the token.
        page.finished(url("http://127.0.0.1:4317/app/#/tasks"));
        page.navigating(&url("http://127.0.0.1:4317/app/#/settings"));
        assert!(page.current().is_some());
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
            ("continue-old-service", ContinueOldService),
            (&*format!("takeover-dismiss?token={TOKEN}"), TakeoverDismiss),
            (&*format!("takeover-confirm?relink=0&token={TOKEN}"), TakeoverConfirm { relink: false }),
            (&*format!("takeover-confirm?relink=1&token={TOKEN}"), TakeoverConfirm { relink: true }),
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
            "tauri://localhost/action/takeover-confirm",
            "tauri://localhost/action/takeover-confirm?relink=0",
            "tauri://localhost/action/takeover-confirm?relink=2",
            "tauri://localhost/action/takeover-confirm?relink=1&extra=1",
            "tauri://localhost/action/takeover-dismiss",
            "tauri://localhost/action/takeover-open",
            "tauri://localhost/action/takeover-dismiss?token=abc",
            "tauri://localhost/action/takeover-dismiss?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "tauri://localhost/action/takeover-confirm?token=0000000000000000000000000000000000000000000000000000000000000000&relink=1",
            "tauri://localhost/action/takeover-confirm?relink=1&token=0000000000000000000000000000000000000000000000000000000000000000&token=0000000000000000000000000000000000000000000000000000000000000000",
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
            "/needs-you",
            "/tasks",
            "/tasks/t-20261026-143834-b2c1",
            "#/review/t-123",
            "/sessions/t-123",
            "/settings/hosts/workstation",
        ] {
            let normalized = route(raw).expect("supported tray destination");
            assert_eq!(route(&normalized), Some(normalized));
        }
        for retired in [
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
        assert_eq!(route("pacer://tasks/t-0412"), Some("#/tasks/t-0412".into()));
        for raw in [
            "javascript:alert(1)",
            "//evil.test",
            "/review/%2e%2e",
            "/review/../settings",
            "/app/tray.html",
            "/review/a?x=1",
            "/tasks/a/b",
            "/tasks/%2e%2e",
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
    takeover: bool,
    supports_takeover: bool,
) -> serde_json::Value {
    let (state, reason) = if !configured {
        ("unsupported", None)
    } else if alive {
        ("available", None)
    } else if let Some(error) = error {
        ("unavailable", Some(if error == pacer_desktop::ota::OtaError::Identity { if takeover && supports_takeover { "service-takeover" } else { "service-identity" } } else { "connection" }))
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
    fn each_offer_pass_replaces_the_work_counts_and_version() {
        let mut inspection = serde_json::json!({"label":"com.pacer.serve","currentVersion":"0.2.3","work":{"tasks":4,"terminals":1}});
        refresh_takeover_work(&mut inspection, Some("0.2.4"), Some(0), None);
        assert_eq!(inspection, serde_json::json!({"label":"com.pacer.serve","currentVersion":"0.2.4","work":{"tasks":0,"terminals":null}}));
    }
    #[test]
    fn relink_failure_notification_is_plain_and_names_a_next_step() {
        let (title, body) = TAKEOVER_RELINK_FAILED;
        assert_eq!(title, "Terminal command not changed");
        assert!(body.starts_with("The app's service is running, but the terminal command still runs another build."));
        assert!(body.contains("reopen pacer"));
        assert!(!body.contains('{') && !body.contains(':'));
    }
    #[test]
    fn connection_failure_is_not_an_up_to_date_or_manual_only_state() {
        assert_eq!(desktop_update_connection(true, false, Some(OtaError::Identity), false, true), serde_json::json!({"state":"unavailable","reason":"service-identity"}));
        assert_eq!(desktop_update_connection(true, false, Some(OtaError::Io), true, true), serde_json::json!({"state":"unavailable","reason":"connection"}));
        assert_eq!(desktop_update_connection(true, false, Some(OtaError::Identity), true, true)["reason"], "service-takeover");
        assert_eq!(desktop_update_connection(true, false, Some(OtaError::Identity), true, false)["reason"], "service-identity");
    }
    #[test]
    fn live_authority_and_build_support_are_distinct_from_pending_connection() {
        assert_eq!(desktop_update_connection(false, false, None, true, true)["state"], "unsupported");
        assert_eq!(desktop_update_connection(true, false, None, true, true)["state"], "connecting");
        assert_eq!(desktop_update_connection(true, true, Some(OtaError::Identity), true, true), serde_json::json!({"state":"available","reason":null}));
    }
    #[test]
    fn takeover_precedes_version_gate_unless_dismissed() {
        assert_eq!(launch_gate(true, false), LaunchGate::Takeover);
        assert_eq!(launch_gate(true, true), LaunchGate::Version);
        assert_eq!(launch_gate(false, false), LaunchGate::Version);
    }
    #[test]
    fn an_unfinished_takeover_blocks_service_actions_and_outcomes_are_held() {
        use pacer_desktop::ota::takeover::journal::TakeoverState::*;
        // Pending wins over any older outcome: the helper or recovery job owns the service.
        for latest in [None, Some((Committed, false)), Some((Restored, true)), Some((RecoveryFailed, false))] {
            assert_eq!(takeover_gate(Some(UnfinishedTakeoverNext::Wait), latest), Some("takeoverProgress"));
        }
        assert_eq!(takeover_gate(None, Some((RecoveryFailed, true))), Some("takeoverFailed"));
        assert_eq!(takeover_gate(None, Some((Restored, false))), Some("takeoverRestored"));
        // A restored outcome is shown once; a commit needs no page.
        assert_eq!(takeover_gate(None, Some((Restored, true))), None);
        assert_eq!(takeover_gate(None, Some((Committed, false))), None);
        assert_eq!(takeover_gate(None, None), None);
    }
    #[test]
    fn a_stuck_takeover_journal_is_recovered_once_then_reported() {
        use pacer_desktop::ota::takeover::journal::{TakeoverOrigin, UnfinishedTakeover};
        use std::collections::HashSet;
        let tx = |id: &str, readable: bool| UnfinishedTakeover {
            transaction_id: id.into(),
            readable,
            origin: readable.then(|| TakeoverOrigin { bundled_cli: format!("/app-{id}/pacer").into(), boot_id: "boot".into() }),
        };
        let ours = |_: &TakeoverOrigin| true;
        let none = HashSet::new();
        assert_eq!(unfinished_takeover_next(&[], |_| false, &none, ours), None);
        // A loaded recovery job owns the transaction.
        assert_eq!(unfinished_takeover_next(&[tx("tx-1", true)], |_| true, &none, ours), Some(UnfinishedTakeoverNext::Wait));
        // The helper was killed before it armed recovery: run recovery once.
        assert_eq!(unfinished_takeover_next(&[tx("tx-1", true)], |_| false, &none, ours), Some(UnfinishedTakeoverNext::Recover("tx-1".into())));
        let attempted: HashSet<String> = ["tx-1".to_string()].into();
        assert_eq!(unfinished_takeover_next(&[tx("tx-1", true)], |_| false, &attempted, ours), Some(UnfinishedTakeoverNext::Failed(StuckTakeover::Unrecovered)));
        assert_eq!(unfinished_takeover_next(&[tx("tx-1", true), tx("tx-2", true)], |id| id == "tx-1", &none, ours), Some(UnfinishedTakeoverNext::Recover("tx-2".into())));
        // A transaction another app copy or an earlier boot started is never recovered by this desktop.
        let foreign = |origin: &TakeoverOrigin| origin.bundled_cli != std::path::Path::new("/app-tx-2/pacer");
        assert_eq!(unfinished_takeover_next(&[tx("tx-1", true), tx("tx-2", true)], |id| id == "tx-1", &none, foreign), Some(UnfinishedTakeoverNext::Failed(StuckTakeover::NotThisApp)));
        // Its own recovery job may still finish it.
        assert_eq!(unfinished_takeover_next(&[tx("tx-2", true)], |_| true, &none, foreign), Some(UnfinishedTakeoverNext::Wait));
        // A damaged journal cannot be recovered or waited on.
        assert_eq!(unfinished_takeover_next(&[tx("tx-1", true), tx("tx-2", false)], |_| true, &none, ours), Some(UnfinishedTakeoverNext::Failed(StuckTakeover::Unreadable)));
        // Recovery in flight shows progress; a stuck journal shows the recovery-failed page.
        use pacer_desktop::ota::takeover::journal::TakeoverState::*;
        assert_eq!(takeover_gate(Some(UnfinishedTakeoverNext::Recover("tx-1".into())), None), Some("takeoverProgress"));
        for stuck in [StuckTakeover::Unrecovered, StuckTakeover::Unreadable, StuckTakeover::NotThisApp] {
            assert_eq!(takeover_gate(Some(UnfinishedTakeoverNext::Failed(stuck)), Some((Restored, false))), Some("takeoverFailed"));
        }
        assert_eq!(takeover_failure_reason(&UnfinishedTakeoverNext::Failed(StuckTakeover::Unreadable)), Some("journal:unreadable"));
        assert_eq!(takeover_failure_reason(&UnfinishedTakeoverNext::Failed(StuckTakeover::NotThisApp)), Some("journal:foreign"));
        assert_eq!(takeover_failure_reason(&UnfinishedTakeoverNext::Failed(StuckTakeover::Unrecovered)), None);
    }
    #[test]
    fn only_this_app_bundle_in_this_boot_recovers_a_stuck_takeover() {
        use pacer_desktop::ota::takeover::journal::TakeoverOrigin;
        let temp = tempfile::tempdir().unwrap();
        let cli = temp.path().join("pacer.app/Contents/Resources/pacer");
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(&cli, b"cli").unwrap();
        let other = temp.path().join("other.app/Contents/Resources/pacer");
        std::fs::create_dir_all(other.parent().unwrap()).unwrap();
        std::fs::write(&other, b"cli").unwrap();
        let recorded = TakeoverOrigin { bundled_cli: cli.clone(), boot_id: "boot-a".into() };
        assert!(started_by_this_app(&recorded, Some(&cli), Some("boot-a")));
        // The same file through a non-canonical path is the same app.
        let dotted = temp.path().join("pacer.app/Contents/../Contents/Resources/pacer");
        assert!(started_by_this_app(&TakeoverOrigin { bundled_cli: dotted, ..recorded.clone() }, Some(&cli), Some("boot-a")));
        // Another app copy, an earlier boot, or an unknown app or boot is not this app.
        assert!(!started_by_this_app(&recorded, Some(&other), Some("boot-a")));
        assert!(!started_by_this_app(&recorded, Some(&cli), Some("boot-b")));
        assert!(!started_by_this_app(&recorded, None, Some("boot-a")));
        assert!(!started_by_this_app(&recorded, Some(&cli), None));
        assert!(!started_by_this_app(&TakeoverOrigin { bundled_cli: temp.path().join("gone/pacer"), ..recorded.clone() }, Some(&cli), Some("boot-a")));
    }
    #[test]
    fn an_unanswerable_recovery_job_query_never_lets_pruning_remove_its_helper() {
        let failed: Option<Result<bool, ()>> = Some(Err(()));
        // Recovery treats an unknown job as absent; the transaction lock serializes a running one.
        assert!(!recovery_job_loaded_for_recovery(failed));
        assert!(!recovery_job_loaded_for_recovery::<()>(None));
        // Pruning treats it as loaded, so a job's program is never deleted.
        assert!(recovery_job_loaded_for_pruning(failed));
        assert!(recovery_job_loaded_for_pruning::<()>(None));
        for answer in [true, false] {
            assert_eq!(recovery_job_loaded_for_recovery(Some(Ok::<_, ()>(answer))), answer);
            assert_eq!(recovery_job_loaded_for_pruning(Some(Ok::<_, ()>(answer))), answer);
        }
    }
    #[test]
    fn a_failed_helper_shows_its_transaction_page_at_once() {
        use pacer_desktop::ota::takeover::journal::TakeoverState::*;
        // A helper that exits after the switch leaves a pending transaction: the
        // in-progress page replaces the offer now, not after the offer's slow hold.
        let next = takeover_failure_next(takeover_gate(Some(UnfinishedTakeoverNext::Wait), None));
        assert_eq!(next, TakeoverFailureNext::Show("takeoverProgress"));
        assert!(!waiting_for_choice(Some("takeoverProgress")));
        assert_eq!(takeover_failure_next(takeover_gate(None, Some((Restored, false)))), TakeoverFailureNext::Show("takeoverRestored"));
        assert_eq!(takeover_failure_next(takeover_gate(None, Some((RecoveryFailed, false)))), TakeoverFailureNext::Show("takeoverFailed"));
        // No transaction started, so nothing changed: offer the choice again.
        assert_eq!(takeover_failure_next(takeover_gate(None, None)), TakeoverFailureNext::Reoffer);
    }
    #[test]
    fn the_takeover_offer_waits_like_the_version_pages() {
        for page in ["takeover", "takeoverRestored", "takeoverFailed", "outdatedService", "unverifiedService"] {
            assert!(waiting_for_choice(Some(page)), "{page}");
            assert_eq!(connection_retry_delay(std::time::Duration::from_secs(1), waiting_for_choice(Some(page))), std::time::Duration::from_secs(30));
        }
        for page in [None, Some("starting"), Some("takeoverProgress"), Some("stuck")] {
            assert!(!waiting_for_choice(page), "{page:?}");
        }
    }
    #[test]
    fn restored_outcome_acknowledgement_is_per_transaction() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!takeover_acknowledged(dir.path(), "tx-one"));
        acknowledge_takeover(dir.path(), "tx-one").unwrap();
        assert!(takeover_acknowledged(dir.path(), "tx-one"));
        assert!(!takeover_acknowledged(dir.path(), "tx-two"));
    }
    #[test]
    fn dismissal_is_strict_and_bound_to_both_hashes() {
        let dir = tempfile::tempdir().unwrap();
        let mut identity = pacer_desktop::ota::bootstrap_identity::LegacyExecutable { device: "1".into(), inode: "2".into(), size: 3, modified_ns: "4".into(), changed_ns: "5".into(), sha256: "a".repeat(64), cdhash: "b".repeat(40) };
        assert!(!takeover_dismissed(dir.path(), &identity));
        dismiss_takeover(dir.path(), &identity).unwrap();
        assert!(takeover_dismissed(dir.path(), &identity));
        identity.cdhash = "c".repeat(40);
        assert!(!takeover_dismissed(dir.path(), &identity));
        identity.cdhash = "b".repeat(40);
        identity.sha256 = "c".repeat(64);
        assert!(!takeover_dismissed(dir.path(), &identity));
        std::fs::write(dir.path().join("takeover-dismissed.json"), format!(r#"{{"schema":1,"sha256":"{}","cdhash":"{}","extra":1}}"#, identity.sha256, identity.cdhash)).unwrap();
        assert!(!takeover_dismissed(dir.path(), &identity));
        // A symlink at the record's name is never followed, even to a valid record.
        let elsewhere = tempfile::tempdir().unwrap();
        dismiss_takeover(elsewhere.path(), &identity).unwrap();
        std::fs::remove_file(dir.path().join("takeover-dismissed.json")).unwrap();
        std::os::unix::fs::symlink(elsewhere.path().join("takeover-dismissed.json"), dir.path().join("takeover-dismissed.json")).unwrap();
        assert!(!takeover_dismissed(dir.path(), &identity));
        // Nor is a directory or another non-regular file.
        std::fs::remove_file(dir.path().join("takeover-dismissed.json")).unwrap();
        std::fs::create_dir(dir.path().join("takeover-dismissed.json")).unwrap();
        assert!(!takeover_dismissed(dir.path(), &identity));
    }
}
