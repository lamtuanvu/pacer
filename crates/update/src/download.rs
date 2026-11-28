//! Release downloads: `fetchBytes` and `fetchText` from `src/update/fetch.ts`.
//!
//! Every release download goes through one transport. The HTTP body of `feed::fetch`
//! lives here, with the byte cap as a parameter and manual redirects that only ever
//! follow `https://` targets without user info. The error strings are the ones the
//! TypeScript client stores and the feed tests already assert.
use crate::feed::{TIMED_OUT, failed, read_file};
use std::{
    io::Read,
    time::{Duration, Instant},
};

/// The 300-second deadline TypeScript gives a release download (`releaseFetch`).
pub const RELEASE_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_REDIRECTS: usize = 5;
const TEXT_MAX_BYTES: u64 = 1024 * 1024;

/// The subset of an HTTP response the downloader needs, mirroring the `Response`
/// that TypeScript's injectable `FetchFn` returns.
#[derive(Debug)]
pub struct Fetched {
    pub status: u16,
    pub location: Option<String>,
    pub content_length: Option<String>,
    pub body: Vec<u8>,
}

/// `fetchBytes` with an injected transport, like `fetchBytes(fetchFn, url)` in `fetch.ts`.
/// Network errors from `fetch` are already formatted by [`transport`]; every error this
/// function adds uses the `download failed: <url> (...)` envelope.
pub fn fetch_bytes_with(
    fetch: &dyn Fn(&str) -> Result<Fetched, String>,
    url: &str,
    max: u64,
) -> Result<Vec<u8>, String> {
    let mut current = url.to_owned();
    for hops in 0.. {
        let response = fetch(&current)?;
        if (300..400).contains(&response.status) {
            let Some(location) = response.location else {
                return Err(failed(
                    url,
                    &format!("redirect HTTP {} has no Location", response.status),
                ));
            };
            if hops >= MAX_REDIRECTS {
                return Err(failed(
                    url,
                    &format!("redirect limit ({MAX_REDIRECTS}) exceeded"),
                ));
            }
            let base = url::Url::parse(&current).map_err(|e| failed(url, &e.to_string()))?;
            let next = base
                .join(&location)
                .map_err(|e| failed(url, &e.to_string()))?;
            if next.scheme() != "https" || !next.username().is_empty() || next.password().is_some()
            {
                return Err(failed(
                    url,
                    "redirect must target https:// without user info",
                ));
            }
            current = next.into();
            continue;
        }
        if !(200..300).contains(&response.status) {
            return Err(failed(url, &format!("HTTP {}", response.status)));
        }
        let declared = response
            .content_length
            .as_deref()
            .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|v| v.parse::<f64>().ok());
        if declared.is_some_and(|n| n > max as f64) {
            return Err(failed(url, &format!("exceeds {max} byte limit")));
        }
        if response.body.len() as u64 > max {
            return Err(failed(url, &format!("exceeds {max} byte limit")));
        }
        return Ok(response.body);
    }
    unreachable!("the redirect loop returns")
}

/// `fetchBytes`: read `file://` paths directly (Bun answers 200 for a missing path),
/// otherwise download over the wire with the supplied cap and deadline.
pub fn fetch_bytes(url: &str, max: u64, deadline: Instant) -> Result<Vec<u8>, String> {
    if url.starts_with("file://") {
        let bytes = read_file(url)?;
        if bytes.len() as u64 > max {
            return Err(failed(url, &format!("exceeds {max} byte limit")));
        }
        return Ok(bytes);
    }
    let fetch = |current: &str| -> Result<Fetched, String> {
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
        let mut response = agent.get(current).call().map_err(|e| transport(url, e))?;
        let status = response.status().as_u16();
        let location = response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let content_length = response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let mut body = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(max + 1)
            .read_to_end(&mut body)
            .map_err(|e| {
                if Instant::now() >= deadline {
                    TIMED_OUT.to_owned()
                } else {
                    failed(url, &e.to_string())
                }
            })?;
        Ok(Fetched {
            status,
            location,
            content_length,
            body,
        })
    };
    fetch_bytes_with(&fetch, url, max)
}

/// `fetchText`: `fetchBytes` with the 1 MiB cap, decoded like `TextDecoder`.
pub fn fetch_text(url: &str, deadline: Instant) -> Result<String, String> {
    let bytes = fetch_bytes(url, TEXT_MAX_BYTES, deadline)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// `fetchText` with an injected transport, for the transcript tests.
pub fn fetch_text_with(
    fetch: &dyn Fn(&str) -> Result<Fetched, String>,
    url: &str,
) -> Result<String, String> {
    let bytes = fetch_bytes_with(fetch, url, TEXT_MAX_BYTES)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// ureq's error wording, kept identical to the feed's original `transport`.
pub fn transport(url: &str, error: ureq::Error) -> String {
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
