//! `session.version` validation and compatibility view from `src/session/protocol.ts`.
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const SESSION_PROTOCOL: [u64; 2] = [1, 1];
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
    if pacer.is_empty() || pacer.len() > 64 || !is_version(pacer) {
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
    ((1.0..=9_007_199_254_740_991.0).contains(&number) && number.fract() == 0.0)
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
        b.1 - a.1 <= SESSION_SUPPORT_MINORS
    } else {
        a.0 > b.0
    }
}

pub fn host_older(host: Option<&SessionVersion>, current: &str) -> bool {
    let Some(host) = host else {
        return true;
    };
    match (
        semver::Version::parse(&host.pacer),
        semver::Version::parse(current),
    ) {
        (Ok(a), Ok(b)) => a < b,
        _ => true,
    }
}

fn major_minor(v: &str) -> Option<(i64, i64)> {
    let mut parts = v.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

fn is_version(v: &str) -> bool {
    semver::Version::parse(v).is_ok()
}
