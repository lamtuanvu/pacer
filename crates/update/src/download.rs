//! Release downloads, ported from `src/update/fetch.ts` (`fetchBytes`, `fetchText`).
//!
//! The TypeScript module takes an injectable `FetchFn`; the same seam is exposed here
//! as [`Transport`] so redirect, cap and failure logic can be tested without a network.
//! Production downloads use `ureq` with manual redirects, exactly as `feed::fetch` did.
use crate::feed::{TIMED_OUT, failed, read_file};
use std::{
    io::Read,
    time::{Duration, Instant},
};

/// The 300 s `AbortSignal.timeout` of `releaseFetch` in `src/update/fetch.ts`.
pub const RELEASE_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_BYTES: u64 = 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

/// The parts of a response the downloader reads, mirroring the TS `Response` fields.
pub struct FetchResponse {
    pub status: u16,
    pub location: Option<String>,
    pub content_length: Option<u64>,
    pub body: Box<dyn Read>,
}

/// An injectable transport. `Ureq` is the production implementation; tests supply
/// scripted responses so the same redirect and byte-cap logic is exercised directly.
pub trait Transport {
    fn fetch(&self, url: &str, deadline: Instant) -> Result<FetchResponse, String>;
}

struct Ureq;

impl Transport for Ureq {
    fn fetch(&self, url: &str, deadline: Instant) -> Result<FetchResponse, String> {
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
        let response = agent.get(url).call().map_err(|e| transport(url, e))?;
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let status = response.status().as_u16();
        let location = header("location");
        let content_length = header("content-length")
            .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|v| v.parse::<u64>().ok());
        let (_parts, body) = response.into_parts();
        Ok(FetchResponse {
            status,
            location,
            content_length,
            body: Box::new(body.into_reader()),
        })
    }
}

/// Keep the messages `feed::fetch` recorded in `update-check.json`.
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

/// `fetchBytes`: manual redirects (HTTPS only, at most five) and a byte cap.
pub fn fetch_bytes(url: &str, max: u64, deadline: Instant) -> Result<Vec<u8>, String> {
    fetch_bytes_with(&Ureq, url, max, deadline)
}

/// The same downloader with an injected transport, mirroring the TS `fetchFn` seam.
pub fn fetch_bytes_with(
    transport: &dyn Transport,
    url: &str,
    max: u64,
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    // Bun's fetch answers 200 for a missing file:// path; read it directly instead.
    if url.starts_with("file://") {
        let bytes = read_file(url)?;
        return if bytes.len() as u64 > max {
            Err(failed(url, &format!("exceeds {max} byte limit")))
        } else {
            Ok(bytes)
        };
    }

    let mut current = url::Url::parse(url).map_err(|e| failed(url, &e.to_string()))?;
    for hops in 0.. {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| TIMED_OUT.to_owned())?;
        let _ = remaining; // the transport also enforces the deadline on its socket
        let response = transport.fetch(current.as_str(), deadline).map_err(|e| {
            if e.starts_with("download failed: ") || e == TIMED_OUT {
                e
            } else {
                failed(url, &e)
            }
        })?;
        let status = response.status;
        if (300..400).contains(&status) {
            let location = response
                .location
                .ok_or_else(|| failed(url, &format!("redirect HTTP {status} has no Location")))?;
            if hops >= MAX_REDIRECTS {
                return Err(failed(
                    url,
                    &format!("redirect limit ({MAX_REDIRECTS}) exceeded"),
                ));
            }
            let next = current
                .join(&location)
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
        if response.content_length.is_some_and(|n| n > max) {
            return Err(failed(url, &format!("exceeds {max} byte limit")));
        }
        let mut bytes = Vec::new();
        response
            .body
            .take(max + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| {
                if Instant::now() >= deadline {
                    TIMED_OUT.to_owned()
                } else {
                    failed(url, &e.to_string())
                }
            })?;
        if bytes.len() as u64 > max {
            return Err(failed(url, &format!("exceeds {max} byte limit")));
        }
        return Ok(bytes);
    }
    unreachable!("the redirect loop returns")
}

/// `fetchText`: a 1 MiB cap, decoded with replacement like `TextDecoder`.
pub fn fetch_text(url: &str, deadline: Instant) -> Result<String, String> {
    fetch_text_with(&Ureq, url, deadline)
}

/// `fetchText` over an injected transport, mirroring `fetchText(fetchFn, url)`.
pub fn fetch_text_with(
    transport: &dyn Transport,
    url: &str,
    deadline: Instant,
) -> Result<String, String> {
    let bytes = fetch_bytes_with(transport, url, MAX_BYTES, deadline)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
