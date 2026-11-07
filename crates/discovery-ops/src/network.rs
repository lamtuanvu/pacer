//! The current-network probe (`src/discovery/network.ts`) and the radio
//! contact clock (`radioStatus` in `src/discovery/radio.ts`).
//!
//! Like the TypeScript module, the last network and recent sightings live in
//! process memory: an incomplete probe falls back to the last network with the
//! same router, interface and gateway, and only keys seen by this process in
//! the last 10 minutes may continue an entry with the same group (NS2).
use pacer_foundation::{ctx::unix_now, js_semantics::js_trim};
use regex::Regex;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{LazyLock, Mutex, MutexGuard},
    time::Duration,
};

/// A probed network: hashed key, label, default route interface, the group of
/// gateway IPv4 and SSID, the router identity kind, the gateway and the keys it
/// may continue.
#[derive(Clone, Debug, PartialEq)]
pub struct NetworkInfo {
    pub key: String,
    pub label: String,
    pub iface: String,
    pub group: Option<String>,
    pub kind: &'static str,
    pub gw: String,
    pub continues: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct Found {
    identity: String,
    iface: String,
    gw: String,
    ssid: Option<String>,
    incomplete: bool,
}

struct Sighting {
    key: String,
    group: Option<String>,
    kind: &'static str,
    at: f64,
}

#[derive(Default)]
struct Memory {
    last: Option<(Found, NetworkInfo)>,
    sightings: Vec<Sighting>,
    outputs: Option<HashMap<String, String>>,
    contact: Option<f64>,
}

static MEMORY: LazyLock<Mutex<Memory>> = LazyLock::new(Mutex::default);
const CONTINUE_S: f64 = 600.0;
const SIGHTINGS_MAX: usize = 16;
const RUN_TIMEOUT: Duration = Duration::from_secs(3);
const ROUTE: &str = "/sbin/route";
const ARP: &str = "/usr/sbin/arp";
const IPCONFIG: &str = "/usr/sbin/ipconfig";
const NETWORKSETUP: &str = "/usr/sbin/networksetup";
const LINUX_IP: [&str; 4] = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"];
const NMCLI: &str = "/usr/bin/nmcli";

fn memory() -> MutexGuard<'static, Memory> {
    MEMORY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap_or_else(|_| unreachable!("static pattern"))
}

static IFACE: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z0-9._:@-]{1,32}$"));
static MAC: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(?:[0-9a-f]{1,2}:){5}[0-9a-f]{1,2}"));
static GATEWAY4: LazyLock<Regex> = LazyLock::new(|| re(r"gateway:\s*([0-9.]+)"));
static GATEWAY: LazyLock<Regex> = LazyLock::new(|| re(r"gateway:\s*(\S+)"));
static INTERFACE: LazyLock<Regex> = LazyLock::new(|| re(r"interface:\s*(\S+)"));
static SSID: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^\s*SSID\s*:\s*(.+)$"));
static ADVERT: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?m)^\s*RouterAdvertisement\s*:\s*from\s+([^\s,]+)"));
static LINK_LOCAL: LazyLock<Regex> = LazyLock::new(|| re(r"^fe[89ab][0-9a-f]:"));
static BLOCKS: LazyLock<Regex> = LazyLock::new(|| re(r"\n\s*\n"));
static WIFI_PORT: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?m)^Hardware Port:\s*(?:Wi-Fi|AirPort)\s*$"));
static DEVICE: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^Device:\s*(\S+)"));
static LINUX_ROUTE: LazyLock<Regex> = LazyLock::new(|| re(r"default via ([0-9.]+) dev (\S+)"));
static LLADDR: LazyLock<Regex> = LazyLock::new(|| re(r"lladdr\s+(\S+)"));

fn capture<'a>(pattern: &Regex, text: Option<&'a str>, group: usize) -> Option<&'a str> {
    pattern
        .captures(text?)
        .and_then(|c| c.get(group))
        .map(|m| m.as_str())
}

/// Replaces the probe with fixed outputs keyed by the space-joined argv, and
/// forgets the last network and sightings.
#[doc(hidden)]
pub fn set_probe_outputs_for_tests(outputs: Option<HashMap<String, String>>) {
    let mut memory = memory();
    memory.outputs = outputs;
    memory.last = None;
    memory.sightings.clear();
}

/// The radio pulled its config; `discovery.list` reports it available for 30 s.
pub fn record_radio_contact() {
    memory().contact = Some(unix_now());
}

pub fn radio_available() -> bool {
    memory().contact.is_some_and(|at| unix_now() - at < 30.0)
}

/// SEC-5: argv only. Any failure, timeout or nonzero exit means "not found".
async fn out(argv: &[&str]) -> Option<String> {
    let fixed = memory()
        .outputs
        .as_ref()
        .map(|outputs| outputs.get(&argv.join(" ")).cloned());
    if let Some(fixed) = fixed {
        return fixed;
    }
    let child = tokio::process::Command::new(argv[0])
        .args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let output = tokio::time::timeout(RUN_TIMEOUT, child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn norm_mac(mac: &str) -> String {
    mac.to_lowercase()
        .split(':')
        .map(|part| format!("{part:0>2}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn link_local(addr: Option<&str>) -> Option<String> {
    let a = addr?.split('%').next()?.to_lowercase();
    (a.parse::<std::net::Ipv6Addr>().is_ok() && LINK_LOCAL.is_match(&a)).then_some(a)
}

fn default_router6(route: Option<&str>, iface: &str) -> Option<String> {
    let on = capture(&INTERFACE, route, 1);
    if on.is_none_or(|on| on == iface) {
        link_local(capture(&GATEWAY, route, 1))
    } else {
        None
    }
}

async fn wifi_port(iface: &str) -> bool {
    let Some(ports) = out(&[NETWORKSETUP, "-listallhardwareports"]).await else {
        return false;
    };
    BLOCKS
        .split(&ports)
        .any(|block| WIFI_PORT.is_match(block) && capture(&DEVICE, Some(block), 1) == Some(iface))
}

fn usable_ssid(ssid: Option<&str>) -> Option<String> {
    ssid.filter(|s| !s.is_empty() && *s != "<redacted>")
        .map(str::to_owned)
}

async fn darwin() -> Option<Found> {
    let route = out(&[ROUTE, "-n", "get", "default"]).await;
    let gw = capture(&GATEWAY4, route.as_deref(), 1)?.to_owned();
    let iface = capture(&INTERFACE, route.as_deref(), 1)?.to_owned();
    if !IFACE.is_match(&iface) {
        return None;
    }
    let route6 = out(&[ROUTE, "-n", "get", "-inet6", "default"]).await;
    let summary = out(&[IPCONFIG, "getsummary", &iface]).await;
    let ssid = capture(&SSID, summary.as_deref(), 1).map(js_trim);
    let ra = default_router6(route6.as_deref(), &iface)
        .or_else(|| link_local(capture(&ADVERT, summary.as_deref(), 1)));
    let mac = match ra {
        Some(_) => None,
        None => {
            let arp = out(&[ARP, "-n", &gw]).await;
            MAC.find(arp.as_deref().unwrap_or(""))
                .map(|m| m.as_str().to_owned())
        }
    };
    let identity = match (&ra, &mac) {
        (Some(ra), _) => format!("ra:{ra}"),
        (None, Some(mac)) => format!("mac:{}", norm_mac(mac)),
        (None, None) => return None,
    };
    let incomplete = summary.is_none() && wifi_port(&iface).await;
    Some(Found {
        identity,
        iface,
        gw,
        ssid: usable_ssid(ssid),
        incomplete,
    })
}

/// `nmcli -t` escapes `:` and `\` in values with a backslash (N6).
fn unescape(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match chars.peek() {
            Some(&next) if c == '\\' && !matches!(next, '\n' | '\r' | '\u{2028}' | '\u{2029}') => {
                out.push(next);
                chars.next();
            }
            _ => out.push(c),
        }
    }
    out
}

async fn linux() -> Option<Found> {
    let ip = LINUX_IP.into_iter().find(|p| Path::new(p).exists())?;
    let route = out(&[ip, "route", "show", "default"]).await;
    let gw = capture(&LINUX_ROUTE, route.as_deref(), 1)?.to_owned();
    let iface = capture(&LINUX_ROUTE, route.as_deref(), 2)?.to_owned();
    if !IFACE.is_match(&iface) {
        return None;
    }
    let neigh = out(&[ip, "neigh", "show", &gw]).await;
    let mac = capture(&LLADDR, neigh.as_deref(), 1).filter(|mac| MAC.is_match(mac))?;
    let mac = norm_mac(mac);
    let nmcli = out(&[NMCLI, "-t", "-f", "active,ssid", "dev", "wifi"]).await;
    let ssid = nmcli.as_deref().and_then(|text| {
        text.split('\n')
            .find_map(|line| line.strip_prefix("yes:"))
            .map(|value| js_trim(&unescape(value)).to_owned())
    });
    let ssid = ssid.filter(|s| !s.is_empty());
    let incomplete = ssid.is_none()
        && Path::new(NMCLI).exists()
        && Path::new(&format!("/sys/class/net/{iface}/wireless")).exists();
    Some(Found {
        identity: format!("mac:{mac}"),
        iface,
        gw,
        ssid,
        incomplete,
    })
}

fn digest(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))[..32].to_owned()
}

fn remember(memory: &mut Memory, found: Found, now: f64) -> NetworkInfo {
    let ssid = found.ssid.as_deref();
    let key = digest(&format!(
        "pacer-network/v2\0{}\0{}",
        found.identity,
        ssid.unwrap_or("")
    ));
    // Without an SSID many unrelated networks share a gateway address.
    let group = ssid.map(|ssid| digest(&format!("pacer-network-group/v1\0{}\0{ssid}", found.gw)));
    let kind = if found.identity.starts_with("ra:") {
        "ra"
    } else {
        "mac"
    };
    let mut continues: Vec<String> = Vec::new();
    if group.is_some() {
        for x in &memory.sightings {
            if x.key != key
                && x.group == group
                && x.kind == kind
                && x.at >= now - CONTINUE_S
                && !continues.contains(&x.key)
            {
                continues.push(x.key.clone());
            }
        }
    }
    memory.sightings.retain(|x| x.key != key);
    memory.sightings.push(Sighting {
        key: key.clone(),
        group: group.clone(),
        kind,
        at: now,
    });
    let excess = memory.sightings.len().saturating_sub(SIGHTINGS_MAX);
    memory.sightings.drain(..excess);
    let info = NetworkInfo {
        label: ssid.map_or_else(|| format!("Network {}", &key[..6]), str::to_owned),
        key,
        iface: found.iface.clone(),
        group,
        kind,
        gw: found.gw.clone(),
        continues,
    };
    memory.last = Some((found, info.clone()));
    info
}

/// `currentNetwork`: None when no default route interface, router
/// advertisement or gateway MAC is found, or the probe is incomplete and does
/// not match the last network.
pub async fn current_network() -> Option<NetworkInfo> {
    let found = if cfg!(target_os = "macos") {
        darwin().await
    } else if cfg!(target_os = "linux") {
        linux().await
    } else {
        None
    }?;
    let mut memory = memory();
    if found.incomplete {
        let (prev, info) = memory.last.as_ref()?;
        return (prev.identity == found.identity
            && prev.iface == found.iface
            && prev.gw == found.gw)
            .then(|| info.clone());
    }
    Some(remember(&mut memory, found, unix_now()))
}

#[cfg(test)]
pub(crate) static TEST_PROBE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
mod tests;
