//! The LAN discovery radio (SEC-11, SEC-16): presence-only mDNS adverts and browsing. The core owns
//! every policy decision; the radio pulls its advert config and pushes bounded raw observations over
//! the private `/_internal/discovery/*` channel. mDNS runs on `pacer-mdns`, which answers and
//! accepts only on-link IPv4 traffic on the one interface. mDNS failures never stop `pacer serve`.
use super::core_child::CoreChild;
use axum::body::{Body, to_bytes};
use hyper::Request;
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use pacer_mdns::{Advert, Interface, Responder, valid_netmask};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    net::Ipv4Addr,
    sync::Arc,
    time::Duration,
};
use tokio::{sync::Mutex, task::JoinHandle};

const ID_LEN: usize = 26;
const IFACE_MAX: usize = 32;
const TXT_MAX: usize = 400;
const QUEUE_MAX: usize = 64;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub rev: u64,
    pub enabled: bool,
    pub listen: bool,
    /// The default route's interface with its IPv4 address and netmask (SEC-11): the only link the
    /// radio uses. None means no radio.
    pub iface: Option<Interface>,
    pub advertise: Option<Advert>,
}

/// An interface name such as `en0` or `wlp2s0`.
fn is_iface(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= IFACE_MAX
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:@-".contains(&b))
}

/// An IPv4 address the radio can serve a link from.
fn ipv4(raw: &Value, key: &str) -> Option<Ipv4Addr> {
    raw.get(key)?.as_str()?.parse().ok()
}

/// The interface name with its IPv4 address and netmask, all three valid, or None.
fn iface_from(raw: &Value) -> Option<Interface> {
    let name = raw.get("iface")?.as_str().filter(|i| is_iface(i))?;
    let addr = ipv4(raw, "ifaceAddr").filter(|a| {
        !(a.is_unspecified() || a.is_loopback() || a.is_multicast() || a.is_broadcast())
    })?;
    let mask = ipv4(raw, "ifaceMask").filter(|m| valid_netmask(*m))?;
    Some(Interface {
        name: name.to_string(),
        addr,
        mask,
    })
}

/// A per-network discovery id: 26 lowercase base32 characters.
fn is_id(s: &str) -> bool {
    s.len() == ID_LEN
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
}

/// The byte bound for each allowed TXT key; any other key is refused.
fn bound(key: &str) -> Option<usize> {
    match key {
        "id" => Some(ID_LEN),
        "name" => Some(64),
        "v" => Some(32),
        "h" => Some(200),
        _ => None,
    }
}

/// Wire size of a TXT record: a length byte, the key, `=` and the value per entry.
fn txt_size<'a>(entries: impl Iterator<Item = (&'a str, &'a str)>) -> usize {
    entries.map(|(k, v)| k.len() + v.len() + 2).sum()
}

fn bounded_txt(txt: &BTreeMap<String, String>) -> bool {
    txt.get("id").is_some_and(|id| is_id(id))
        && txt.get("name").is_some_and(|name| !name.is_empty())
        && txt
            .iter()
            .all(|(k, v)| bound(k).is_some_and(|max| v.len() <= max))
        && txt_size(txt.iter().map(|(k, v)| (k.as_str(), v.as_str()))) <= TXT_MAX
}

fn advert_from(raw: &Value) -> Option<Advert> {
    let instance = raw.get("instance")?.as_str()?;
    let port = u16::try_from(raw.get("port")?.as_u64()?).ok()?;
    let txt = raw
        .get("txt")?
        .as_object()?
        .iter()
        .map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
        .collect::<Option<BTreeMap<_, _>>>()?;
    (is_id(instance) && port != 0 && bounded_txt(&txt)).then(|| Advert {
        instance: instance.to_string(),
        port,
        txt,
    })
}

/// Parses the core's radio config. An advert outside the hard bounds is dropped, never trimmed.
/// Without a valid interface, IPv4 address and netmask the radio neither listens nor advertises.
pub fn validate_config(raw: &Value) -> Option<Config> {
    let rev = raw.get("rev")?.as_u64()?;
    let enabled = raw.get("enabled")?.as_bool()?;
    let listen = raw.get("listen")?.as_bool()?;
    let iface = iface_from(raw).filter(|_| enabled);
    let advertise = raw.get("advertise").and_then(advert_from);
    Some(Config {
        rev,
        enabled,
        listen: listen && iface.is_some(),
        advertise: advertise.filter(|_| iface.is_some()),
        iface,
    })
}

/// Keeps only the bounded `id`, `name`, `v` and `h` of a discovered TXT record; the core sanitizes them.
pub fn observation_from(props: &HashMap<String, String>) -> Option<Value> {
    let id = props.get("id").filter(|id| is_id(id))?;
    if txt_size(props.iter().map(|(k, v)| (k.as_str(), v.as_str()))) > TXT_MAX {
        return None;
    }
    let mut out = json!({"id": id});
    for key in ["name", "v", "h"] {
        let value = props.get(key).map_or("", String::as_str);
        if bound(key).is_none_or(|max| value.len() > max) {
            return None;
        }
        out[key] = json!(value);
    }
    Some(out)
}

/// What the radio does with its advert after a poll.
#[derive(Debug, PartialEq, Eq)]
pub enum AdvertAction {
    Keep,
    /// Publish the next advert; `pacer-mdns` says goodbye to a renamed one.
    Register,
    Unregister,
}

/// Decides from the effective advert alone. `rev` moves with every batch of observations, so it
/// must not cause goodbye packets and a re-announce, which mDNS answers with conflict suffixes.
pub fn advert_action(previous: Option<&Config>, advertised: bool, next: &Config) -> AdvertAction {
    let same = previous.is_some_and(|p| p.iface == next.iface && p.advertise == next.advertise);
    match (&next.advertise, advertised) {
        (None, true) => AdvertAction::Unregister,
        (None, false) => AdvertAction::Keep,
        (Some(_), true) if same => AdvertAction::Keep,
        (Some(_), _) => AdvertAction::Register,
    }
}

pub struct RadioOptions {
    pub poll: Duration,
    pub disabled: bool,
}

struct Mdns {
    responder: Responder,
    iface: Interface,
    advertised: bool,
    browsing: bool,
}

#[derive(Default)]
struct State {
    config: Option<Config>,
    mdns: Option<Mdns>,
    queue: VecDeque<Value>,
    mdns_warned: bool,
    refused_rev: Option<u64>,
}

impl State {
    async fn apply(&mut self, next: Config, refused: bool) {
        if refused && self.refused_rev != Some(next.rev) {
            eprintln!("pacer: discovery: advert outside the TXT bounds; not advertising");
            self.refused_rev = Some(next.rev);
        }
        if self.config.as_ref() == Some(&next) {
            return;
        }
        let Some(iface) = next
            .iface
            .clone()
            .filter(|_| next.listen || next.advertise.is_some())
        else {
            self.teardown().await;
            self.config = Some(next);
            return;
        };
        // A new interface or address gets a new responder: the old one says goodbye on its link.
        if self.mdns.as_ref().is_some_and(|m| m.iface != iface) {
            self.teardown().await;
            self.config = None;
        }
        if self.mdns.is_none() {
            match Responder::start(&iface.name, iface.addr, iface.mask) {
                Ok(responder) => {
                    self.mdns = Some(Mdns {
                        responder,
                        iface,
                        advertised: false,
                        browsing: false,
                    });
                }
                Err(error) => {
                    if !self.mdns_warned {
                        eprintln!("pacer: discovery: mDNS unavailable: {error}");
                        self.mdns_warned = true;
                    }
                    // Not stored, so the next poll tries again.
                    return;
                }
            }
        }
        let Some(mdns) = self.mdns.as_mut() else {
            return;
        };
        match advert_action(self.config.as_ref(), mdns.advertised, &next) {
            AdvertAction::Keep => {}
            AdvertAction::Register => {
                let result = mdns.responder.set_advert(next.advertise.clone());
                if let Err(error) = &result {
                    eprintln!("pacer: discovery: advertise: {error}");
                }
                mdns.advertised = result.is_ok();
            }
            AdvertAction::Unregister => {
                let _ = mdns.responder.set_advert(None);
                mdns.advertised = false;
            }
        }
        if next.listen != mdns.browsing {
            match mdns.responder.set_browse(next.listen) {
                Ok(()) => mdns.browsing = next.listen,
                Err(error) => eprintln!("pacer: discovery: browse: {error}"),
            }
        }
        self.config = Some(next);
    }

    /// Queues resolved services, keeping the newest `QUEUE_MAX`. `pacer-mdns` already dropped
    /// anything not heard from the interface's link.
    fn drain(&mut self) {
        let Some(mdns) = self.mdns.as_ref().filter(|m| m.browsing) else {
            return;
        };
        while let Ok(resolved) = mdns.responder.browse_events().try_recv() {
            let Some(observation) = observation_from(&resolved.txt) else {
                continue;
            };
            if self.queue.len() >= QUEUE_MAX {
                self.queue.pop_front();
            }
            self.queue.push_back(observation);
        }
    }

    /// Withdraws the advert with goodbye packets and stops the responder thread.
    async fn teardown(&mut self) {
        let Some(mdns) = self.mdns.take() else {
            return;
        };
        let stop = tokio::task::spawn_blocking(move || mdns.responder.shutdown());
        let _ = tokio::time::timeout(STOP_TIMEOUT, stop).await;
    }
}

async fn post(
    client: &Client<HttpConnector, Body>,
    (port, token): &(u16, String),
    path: &str,
    body: Value,
) -> Option<Value> {
    let request = Request::post(format!("http://127.0.0.1:{port}{path}"))
        .header("host", format!("127.0.0.1:{port}"))
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .ok()?;
    let response = tokio::time::timeout(REQUEST_TIMEOUT, client.request(request))
        .await
        .ok()?
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = tokio::time::timeout(
        REQUEST_TIMEOUT,
        to_bytes(Body::new(response.into_body()), 64 * 1024),
    )
    .await
    .ok()?
    .ok()?;
    Some(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn run(core: Arc<CoreChild>, state: Arc<Mutex<State>>, poll: Duration) {
    let client: Client<HttpConnector, Body> = Client::builder(TokioExecutor::new()).build_http();
    loop {
        tokio::time::sleep(poll).await;
        let mut state = state.lock().await;
        state.drain();
        // The last config stays in effect while the core restarts.
        let Some(target) = core.target().await else {
            continue;
        };
        let raw = post(&client, &target, "/_internal/discovery/config", json!({})).await;
        if let Some(raw) = raw
            && let Some(config) = validate_config(&raw)
        {
            let refused = config.iface.is_some()
                && config.advertise.is_none()
                && raw.get("advertise").is_some_and(|a| !a.is_null());
            state.apply(config, refused).await;
        }
        state.drain();
        if state.queue.is_empty() {
            continue;
        }
        let batch: Vec<Value> = state.queue.iter().cloned().collect();
        let body = json!({"observations": batch});
        if post(&client, &target, "/_internal/discovery/observed", body)
            .await
            .is_some()
        {
            state.queue.clear();
        }
    }
}

pub struct Radio {
    task: Option<JoinHandle<()>>,
    state: Arc<Mutex<State>>,
}

impl Radio {
    pub fn spawn(core: Arc<CoreChild>, opts: RadioOptions) -> Radio {
        let state = Arc::new(Mutex::new(State::default()));
        let task = (!opts.disabled).then(|| tokio::spawn(run(core, state.clone(), opts.poll)));
        Radio { task, state }
    }

    /// Stops polling, withdraws the advert with goodbye packets and stops the responder.
    pub async fn stop(self) {
        if let Some(task) = self.task {
            task.abort();
            let _ = task.await;
        }
        self.state.lock().await.teardown().await;
    }
}
