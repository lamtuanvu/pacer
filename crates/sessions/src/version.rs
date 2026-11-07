//! `session.version` validation and compatibility view from `src/session/protocol.ts`.
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const SESSION_PROTOCOL: [u64; 2] = [1, 2];
pub const SESSION_SUPPORT_MINORS: i64 = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessIdentity {
    pub pid: u64,
    #[serde(rename = "bootId")]
    pub boot_id: String,
    pub birth: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionVersion {
    pub pacer: String,
    pub versions: [u64; 2],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<ProcessIdentity>,
}

pub fn parse_versions(value: &serde_json::Value) -> Option<[u64; 2]> {
    let arr = value.as_array()?;
    if arr.len() != 2 {
        return None;
    }
    let min = positive_safe_integer(&arr[0])?;
    let max = positive_safe_integer(&arr[1])?;
    (min > 0 && min <= max).then_some([min, max])
}

pub fn negotiate(client: Option<[u64; 2]>, host: [u64; 2]) -> Option<u64> {
    let [min, max] = client.unwrap_or([1, 1]);
    let top = max.min(host[1]);
    (top >= min.max(host[0])).then_some(top)
}

pub fn read_session_version(dir: &Path) -> Option<SessionVersion> {
    let bytes = std::fs::read(dir.join("session.version")).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let pacer = value["pacer"].as_str()?;
    if pacer.is_empty() || pacer.encode_utf16().count() > 64 || parse_version(pacer).is_none() {
        return None;
    }
    let versions = parse_versions(&value["versions"])?;
    let identity = match value.get("identity") {
        None => None,
        Some(raw) => Some(ProcessIdentity {
            pid: positive_safe_integer(&raw["pid"])?,
            boot_id: raw["bootId"].as_str().filter(|s| !s.is_empty())?.to_owned(),
            birth: raw["birth"].as_str().filter(|s| !s.is_empty())?.to_owned(),
        }),
    };
    Some(SessionVersion {
        pacer: pacer.to_owned(),
        versions,
        identity,
    })
}

fn positive_safe_integer(value: &serde_json::Value) -> Option<u64> {
    let number = value.as_f64()?;
    (number.is_finite()
        && (1.0..=9_007_199_254_740_991.0).contains(&number)
        && number.fract() == 0.0)
        .then_some(number as u64)
}

pub fn host_supported(host: Option<&SessionVersion>, current: &str, service: [u64; 2]) -> bool {
    if negotiate(host.map(|h| h.versions), service).is_none() {
        return false;
    }
    let Some(host) = host else {
        return true;
    };
    let (Some(a), Some(b)) = (major_minor(&host.pacer), major_minor(current)) else {
        return true;
    };
    if a.0 == b.0 {
        b.1 - a.1 <= SESSION_SUPPORT_MINORS as f64
    } else {
        a.0 > b.0
    }
}

pub fn host_older(host: Option<&SessionVersion>, current: &str) -> bool {
    let Some(host) = host else {
        return true;
    };
    match (parse_version(&host.pacer), parse_version(current)) {
        (Some(a), Some(b)) => compare_versions(&a, &b).is_lt(),
        _ => true,
    }
}

fn major_minor(v: &str) -> Option<(f64, f64)> {
    let mut parts = v.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

struct ParsedVersion<'a> {
    core: [f64; 3],
    pre: Option<&'a str>,
}

// Mirrors src/update/version.ts: its prerelease grammar permits numeric leading zeroes.
fn parse_version(v: &str) -> Option<ParsedVersion<'_>> {
    let (before_build, build) = v.split_once('+').map_or((v, None), |(a, b)| (a, Some(b)));
    if build.is_some_and(|b| !identifiers(b)) {
        return None;
    }
    let (core, pre) = before_build
        .split_once('-')
        .map_or((before_build, None), |(a, b)| (a, Some(b)));
    if pre.is_some_and(|p| !identifiers(p)) {
        return None;
    }
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| !digits(p) || (p.len() > 1 && p.starts_with('0')))
    {
        return None;
    }
    Some(ParsedVersion {
        core: [
            parts[0].parse().ok()?,
            parts[1].parse().ok()?,
            parts[2].parse().ok()?,
        ],
        pre,
    })
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn identifiers(s: &str) -> bool {
    s.split('.').all(|part| {
        !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

fn compare_versions(a: &ParsedVersion<'_>, b: &ParsedVersion<'_>) -> std::cmp::Ordering {
    for (x, y) in a.core.iter().zip(b.core.iter()) {
        if let Some(order) = x.partial_cmp(y).filter(|order| !order.is_eq()) {
            return order;
        }
    }
    match (a.pre, b.pre) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(x), Some(y)) => {
            let mut xa = x.split('.');
            let mut ya = y.split('.');
            loop {
                match (xa.next(), ya.next()) {
                    (None, None) => return std::cmp::Ordering::Equal,
                    (None, Some(_)) => return std::cmp::Ordering::Less,
                    (Some(_), None) => return std::cmp::Ordering::Greater,
                    (Some(x), Some(y)) if x == y => {}
                    (Some(x), Some(y)) => {
                        let order = match (digits(x), digits(y)) {
                            (true, true) => x.parse::<f64>().ok().and_then(|a| {
                                y.parse::<f64>().ok().and_then(|b| a.partial_cmp(&b))
                            }),
                            (true, false) => Some(std::cmp::Ordering::Less),
                            (false, true) => Some(std::cmp::Ordering::Greater),
                            (false, false) => Some(x.cmp(y)),
                        };
                        if let Some(order) = order.filter(|order| !order.is_eq()) {
                            return order;
                        }
                    }
                }
            }
        }
    }
}
