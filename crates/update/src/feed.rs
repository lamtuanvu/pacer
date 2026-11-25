//! The release feed's `latest.json`: `normalizeBase`, `fetchText` and `parseLatest` from
//! `src/update/`, under the three-second `checkForUpdate` deadline. Errors are the messages
//! TypeScript stores in `update-check.json`.
use crate::{
    check::{compare_versions, is_nightly_version, is_version},
    js,
};
use pacer_foundation::js_semantics::js_trim;
use serde_json::Value;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_millis(3000);
const MAX_BYTES: u64 = 1024 * 1024;
pub(crate) const TIMED_OUT: &str = "update check timed out";
const DEFAULT_URL: &str = "https://github.com/lamtuanvu/pacer/releases/latest/download/latest.json";
const NIGHTLY_URL: &str =
    "https://raw.githubusercontent.com/lamtuanvu/pacer/desktop-updates/cli-nightly.json";

/// The release channel (`UpdateChannel` in `src/update/channel.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Channel {
    Stable,
    Nightly,
}

impl Channel {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Nightly => "nightly",
        }
    }
}

/// The latest released version, or the error message TypeScript would record.
#[cfg(test)]
pub(crate) fn latest(base: Option<&str>) -> Result<String, String> {
    latest_for(base, Channel::Stable).map(|(version, _)| version)
}

/// `latestForChannel`: stable reads `latest.json`. Nightly also reads `cli-nightly.json` and takes
/// the newer; when one feed fails it uses the other and returns that feed's error beside it, and
/// when both fail the nightly feed's error is the result.
pub(crate) fn latest_for(
    base: Option<&str>,
    channel: Channel,
) -> Result<(String, Option<String>), String> {
    let deadline = Instant::now() + TIMEOUT;
    let base = base.map(normalize_base).transpose()?;
    let stable_url = base
        .as_ref()
        .map_or_else(|| DEFAULT_URL.into(), |b| format!("{b}/latest.json"));
    let stable = || read_feed(&stable_url, deadline).and_then(|v| parse_latest(&v));
    if channel == Channel::Stable {
        return stable().map(|version| (version, None));
    }
    let nightly_url = base
        .as_ref()
        .map_or_else(|| NIGHTLY_URL.into(), |b| format!("{b}/cli-nightly.json"));
    // Both feeds are read at once under the one deadline, like `Promise.allSettled`.
    let (s, n) = std::thread::scope(|scope| {
        let nightly =
            scope.spawn(|| read_feed(&nightly_url, deadline).and_then(|v| parse_cli_nightly(&v)));
        let s = stable();
        let n = nightly
            .join()
            .unwrap_or_else(|_| Err(failed(&nightly_url, "reader panicked")));
        (s, n)
    });
    match (s, n) {
        (Ok(s), Ok(n)) => Ok((if compare_versions(&n, &s) > 0 { n } else { s }, None)),
        (Ok(s), Err(error)) => Ok((s, Some(error))),
        (Err(error), Ok(n)) => Ok((n, Some(error))),
        (Err(_), Err(error)) => Err(error),
    }
}

/// `fetchText` then `JSON.parse` for one feed URL. The download itself (including
/// `file://` reads and the byte cap) is `download::fetch_bytes`.
fn read_feed(url: &str, deadline: Instant) -> Result<Value, String> {
    let bytes = crate::download::fetch_bytes(url, MAX_BYTES, deadline)?;
    if Instant::now() >= deadline {
        return Err(TIMED_OUT.into());
    }
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    parse_json(text)
}

pub(crate) fn failed(url: &str, detail: &str) -> String {
    format!("download failed: {url} ({detail})")
}

/// `normalizeBase`: HTTPS, file URLs or loopback HTTP, without credentials, query or fragment.
pub(crate) fn normalize_base(base: &str) -> Result<String, String> {
    let b = js_trim(base).trim_end_matches('/');
    let loopback = b.strip_prefix("http://").is_some_and(|rest| {
        ["127.0.0.1", "localhost", "[::1]"].iter().any(|host| {
            rest.strip_prefix(host).is_some_and(|rest| {
                let after_port = rest.strip_prefix(':').map_or(rest, |port| {
                    let digits = port.bytes().take_while(u8::is_ascii_digit).count();
                    if digits == 0 { rest } else { &port[digits..] }
                });
                after_port.is_empty() || after_port.starts_with('/')
            })
        })
    });
    let allowed = b.starts_with("https://") || b.starts_with("file://") || loopback;
    if !allowed || b.contains(['@', '?', '#']) {
        return Err(format!(
            "release base must start with https://, file://, or http://127.0.0.1 / http://localhost (got \"{base}\")"
        ));
    }
    Ok(b.to_owned())
}

/// `readFile(fileURLToPath(url))`, with Node's error wording.
pub(crate) fn read_file(url: &str) -> Result<Vec<u8>, String> {
    let parsed = url::Url::parse(url).map_err(|e| failed(url, &e.to_string()))?;
    let path = parsed.to_file_path().map_err(|()| {
        let platform = if cfg!(target_os = "macos") {
            "darwin"
        } else {
            std::env::consts::OS
        };
        failed(
            url,
            &format!("File URL host must be \"localhost\" or empty on {platform}"),
        )
    })?;
    std::fs::read(&path).map_err(|e| {
        let shown = path.display();
        let detail = match e.kind() {
            std::io::ErrorKind::NotFound => {
                format!("ENOENT: no such file or directory, open '{shown}'")
            }
            std::io::ErrorKind::PermissionDenied => {
                format!("EACCES: permission denied, open '{shown}'")
            }
            std::io::ErrorKind::IsADirectory => {
                "EISDIR: illegal operation on a directory, read".into()
            }
            _ => e.to_string(),
        };
        failed(url, &detail)
    })
}

/// `JSON.parse`, with JavaScriptCore's wording for the common failures.
fn parse_json(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|_| {
        let rest = text.trim_start_matches([' ', '\t', '\n', '\r']);
        match rest.chars().next() {
            None => "JSON Parse error: Unexpected EOF".into(),
            Some(c) if !"{[\"-0123456789tfn".contains(c) => {
                format!("JSON Parse error: Unrecognized token '{c}'")
            }
            Some(_) => "JSON Parse error: Unable to parse JSON string".into(),
        }
    })
}

/// `parseLatest`: a version string, with one leading `v` removed.
pub(crate) fn parse_latest(raw: &Value) -> Result<String, String> {
    let version = raw.as_object().and_then(|o| o.get("version"));
    let text = version
        .and_then(Value::as_str)
        .map_or("", |v| v.strip_prefix('v').unwrap_or(v));
    if is_version(text) {
        return Ok(text.to_owned());
    }
    Err(format!(
        "latest.json has no valid \"version\" (got {})",
        js::stringify(version.unwrap_or(&Value::Null))
    ))
}

/// `parseCliNightly`: like `parseLatest`, but only a nightly version is valid.
pub(crate) fn parse_cli_nightly(raw: &Value) -> Result<String, String> {
    let version = raw.as_object().and_then(|o| o.get("version"));
    let text = version
        .and_then(Value::as_str)
        .map_or("", |v| v.strip_prefix('v').unwrap_or(v));
    if is_nightly_version(text) {
        return Ok(text.to_owned());
    }
    Err(format!(
        "cli-nightly.json has no valid nightly \"version\" (got {})",
        js::stringify(version.unwrap_or(&Value::Null))
    ))
}
