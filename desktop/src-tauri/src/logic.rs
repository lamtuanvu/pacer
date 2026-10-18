use reqwest::Url;
use serde_json::Value;
use std::path::{Path, PathBuf};

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
    pub prompt: bool,
    pub seconds: u64,
    pub restart: bool,
    pub recover: bool,
    pub macos: bool,
    pub action_error: Option<String>,
}
/// No I/O: transport evidence takes precedence over service-manager evidence.
pub fn diagnose(health: HealthProbe, job: JobState, prompt: bool, seconds: u64) -> Diagnosis {
    let page = match health {
        HealthProbe::Refused => match job {
            JobState::NotLoaded => "not_installed",
            JobState::Stopped => "stopped",
            JobState::Running => "starting",
            JobState::Unknown => "unavailable",
        },
        HealthProbe::NoAnswer => "busy",
        HealthProbe::Starting => "starting",
        HealthProbe::Ready => "ready",
        HealthProbe::Invalid => "protocol",
        HealthProbe::Unreachable => "unavailable",
    };
    Diagnosis {
        page,
        prompt,
        seconds: if page == "busy" { seconds } else { 0 },
        restart: page == "busy" && seconds >= 30 && !prompt,
        recover: page == "ready",
        macos: cfg!(target_os = "macos"),
        action_error: None,
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
pub fn consent_window(owner: &str, title: &str) -> bool {
    let owner = owner.to_ascii_lowercase();
    let title = title.to_ascii_lowercase();
    [
        "usernotificationcenter",
        "notificationcenter",
        "coreauthui",
        "securityagent",
        "tccd",
    ]
    .iter()
    .any(|name| owner == *name)
        && title
            .split(|c: char| !c.is_alphanumeric())
            .any(|word| word == "pacer")
        && ["removable", "external", "files"]
            .iter()
            .any(|word| title.contains(word))
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
        _ => "stopped",
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
        || url.fragment().is_some()
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
        2 => Ok(()),
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
    }
    #[test]
    fn service_diagnosis_uses_transport_and_job_evidence() {
        use HealthProbe::*;
        assert_eq!(
            diagnose(Refused, JobState::NotLoaded, false, 0).page,
            "not_installed"
        );
        assert_eq!(
            diagnose(Refused, JobState::Stopped, false, 0).page,
            "stopped"
        );
        assert_eq!(
            diagnose(Refused, JobState::Running, false, 0).page,
            "starting"
        );
        assert_eq!(
            diagnose(Refused, JobState::Unknown, false, 0).page,
            "unavailable"
        );
        for prompt in [false, true] {
            let state = diagnose(NoAnswer, JobState::NotLoaded, prompt, 14);
            assert_eq!(state.page, "busy");
            assert_eq!(state.prompt, prompt);
            assert!(!state.restart);
            assert_eq!(state.seconds, 14);
            assert_eq!(
                diagnose(NoAnswer, JobState::Running, prompt, 30).restart,
                !prompt
            );
        }
        assert_eq!(
            diagnose(Starting, JobState::Unknown, false, 50).page,
            "starting"
        );
        let ready = diagnose(Ready, JobState::Unknown, false, 99);
        assert_eq!(ready.page, "ready");
        assert!(ready.recover);
        assert!(!ready.restart);
        assert_eq!(ready.seconds, 0);
        assert_eq!(
            diagnose(Invalid, JobState::Running, false, 0).page,
            "protocol"
        );
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
        assert_eq!(recovery_page(session_error(None)), "stopped");
        assert_eq!(recovery_page(session_error(Some(503))), "stopped");
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
    fn protocol_major_only() {
        assert!(check_hello(&json!({"protocol":"2.9.1"})).is_ok());
        assert_eq!(check_hello(&json!({"protocol":"1.5.0"})), Err("oldService"));
        assert_eq!(check_hello(&json!({"protocol":"3.0.0"})), Err("oldApp"));
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

}
