//! The release feed's `latest.json`: `normalizeBase`, `fetchText` and `parseLatest` from
//! `src/update/`, under the three-second `checkForUpdate` deadline. Errors are the messages
//! TypeScript stores in `update-check.json`.
use crate::{check::is_version, js};
use pacer_foundation::js_semantics::js_trim;
use serde_json::Value;
use std::{
    io::Read,
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_millis(3000);
const MAX_BYTES: u64 = 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const TIMED_OUT: &str = "update check timed out";
const DEFAULT_URL: &str = "https://github.com/lamtuanvu/pacer/releases/latest/download/latest.json";

/// The latest released version, or the error message TypeScript would record.
pub(crate) fn latest(base: Option<&str>) -> Result<String, String> {
    let deadline = Instant::now() + TIMEOUT;
    let url = match base {
        Some(raw) => format!("{}/latest.json", normalize_base(raw)?),
        None => DEFAULT_URL.into(),
    };
    let bytes = if url.starts_with("file://") {
        read_file(&url)?
    } else {
        fetch(&url, deadline)?
    };
    if bytes.len() as u64 > MAX_BYTES {
        return Err(failed(&url, &format!("exceeds {MAX_BYTES} byte limit")));
    }
    if Instant::now() >= deadline {
        return Err(TIMED_OUT.into());
    }
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    parse_latest(&parse_json(text)?)
}

fn failed(url: &str, detail: &str) -> String {
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
fn read_file(url: &str) -> Result<Vec<u8>, String> {
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

/// `fetchBytes` over HTTP: manual redirects (HTTPS only, at most five), a 1 MiB cap.
fn fetch(url: &str, deadline: Instant) -> Result<Vec<u8>, String> {
    let mut current = url::Url::parse(url).map_err(|e| failed(url, &e.to_string()))?;
    for hops in 0.. {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| TIMED_OUT.to_owned())?;
        let agent = ureq::Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(remaining))
            .build()
            .new_agent();
        let mut response = agent
            .get(current.as_str())
            .call()
            .map_err(|e| transport(url, e))?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| failed(url, &format!("redirect HTTP {status} has no Location")))?;
            if hops >= MAX_REDIRECTS {
                return Err(failed(
                    url,
                    &format!("redirect limit ({MAX_REDIRECTS}) exceeded"),
                ));
            }
            let next = current
                .join(location)
                .map_err(|e| failed(url, &e.to_string()))?;
            if next.scheme() != "https" || !next.username().is_empty() || next.password().is_some()
            {
                return Err(failed(
                    url,
                    "redirect must target https:// without user info",
                ));
            }
            current = next;
            continue;
        }
        if !(200..300).contains(&status) {
            return Err(failed(url, &format!("HTTP {status}")));
        }
        let declared = response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
            .map(|v| v.parse::<f64>().unwrap_or(f64::INFINITY));
        if declared.is_some_and(|n| n > MAX_BYTES as f64) {
            return Err(failed(url, &format!("exceeds {MAX_BYTES} byte limit")));
        }
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| {
                if Instant::now() >= deadline {
                    TIMED_OUT.to_owned()
                } else {
                    failed(url, &e.to_string())
                }
            })?;
        return Ok(bytes);
    }
    unreachable!("the redirect loop returns")
}

fn transport(url: &str, error: ureq::Error) -> String {
    match &error {
        ureq::Error::Timeout(_) => TIMED_OUT.into(),
        ureq::Error::ConnectionFailed => failed(
            url,
            "Unable to connect. Is the computer able to access the url?",
        ),
        ureq::Error::Io(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => failed(
            url,
            "Unable to connect. Is the computer able to access the url?",
        ),
        _ => failed(url, &error.to_string()),
    }
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
