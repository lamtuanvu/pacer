//! The LAN discovery radio (SEC-11, SEC-16): presence-only mDNS adverts and browsing. The core owns
//! every policy decision; the radio pulls its advert config and pushes bounded raw observations over
//! the private `/_internal/discovery/*` channel. mDNS failures never stop `pacer serve`.
use super::core_child::CoreChild;
use axum::body::{Body, to_bytes};
use hyper::Request;
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo, TxtProperties};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::Duration,
};
use tokio::{sync::Mutex, task::JoinHandle};

pub const SERVICE: &str = "_pacer._udp.local.";
const ID_LEN: usize = 26;
const TXT_MAX: usize = 400;
const QUEUE_MAX: usize = 64;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, PartialEq)]
pub struct Advert {
    pub instance: String,
    pub port: u16,
    pub txt: HashMap<String, String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub rev: u64,
    pub enabled: bool,
    pub listen: bool,
    pub advertise: Option<Advert>,
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

fn bounded_txt(txt: &HashMap<String, String>) -> bool {
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
        .collect::<Option<HashMap<_, _>>>()?;
    (is_id(instance) && port != 0 && bounded_txt(&txt)).then(|| Advert {
        instance: instance.to_string(),
        port,
        txt,
    })
}

/// Parses the core's radio config. An advert outside the hard bounds is dropped, never trimmed.
pub fn validate_config(raw: &Value) -> Option<Config> {
    let rev = raw.get("rev")?.as_u64()?;
    let enabled = raw.get("enabled")?.as_bool()?;
    let listen = raw.get("listen")?.as_bool()?;
    let advertise = raw.get("advertise").and_then(advert_from);
    Some(Config {
        rev,
        enabled,
        listen: enabled && listen,
        advertise: advertise.filter(|_| enabled),
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

/// TXT entries as strings; a value that is not UTF-8 drops the whole record.
fn props_of(txt: &TxtProperties) -> Option<HashMap<String, String>> {
    txt.iter()
        .map(|p| {
            let value = std::str::from_utf8(p.val().unwrap_or_default()).ok()?;
            Some((p.key().to_string(), value.to_string()))
        })
        .collect()
}

pub struct RadioOptions {
    pub poll: Duration,
    pub disabled: bool,
}

struct Mdns {
    daemon: ServiceDaemon,
    browse: Option<mdns_sd::Receiver<ServiceEvent>>,
    advertised: Option<String>,
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
    fn apply(&mut self, next: Config, refused: bool) {
        if refused && self.refused_rev != Some(next.rev) {
            eprintln!("pacer: discovery: advert outside the TXT bounds; not advertising");
            self.refused_rev = Some(next.rev);
        }
        if self.config.as_ref() == Some(&next) {
            return;
        }
        if !next.listen && next.advertise.is_none() {
            self.teardown();
            self.config = Some(next);
            return;
        }
        if self.mdns.is_none() {
            match ServiceDaemon::new() {
                Ok(daemon) => {
                    self.mdns = Some(Mdns {
                        daemon,
                        browse: None,
                        advertised: None,
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
        let previous = self.config.as_ref();
        if previous.is_none_or(|p| p.rev != next.rev || p.advertise != next.advertise) {
            if let Some(fullname) = mdns.advertised.take() {
                let _ = mdns.daemon.unregister(&fullname);
            }
            if let Some(advert) = &next.advertise {
                let host = format!("{}.local.", advert.instance);
                let info = ServiceInfo::new(
                    SERVICE,
                    &advert.instance,
                    &host,
                    "",
                    advert.port,
                    advert.txt.clone(),
                )
                .map(ServiceInfo::enable_addr_auto);
                match info {
                    Ok(info) => {
                        let fullname = info.get_fullname().to_string();
                        match mdns.daemon.register(info) {
                            Ok(()) => mdns.advertised = Some(fullname),
                            Err(error) => eprintln!("pacer: discovery: advertise: {error}"),
                        }
                    }
                    Err(error) => eprintln!("pacer: discovery: advertise: {error}"),
                }
            }
        }
        if next.listen && mdns.browse.is_none() {
            match mdns.daemon.browse(SERVICE) {
                Ok(receiver) => mdns.browse = Some(receiver),
                Err(error) => eprintln!("pacer: discovery: browse: {error}"),
            }
        } else if !next.listen && mdns.browse.take().is_some() {
            let _ = mdns.daemon.stop_browse(SERVICE);
        }
        self.config = Some(next);
    }

    /// Queues resolved services, keeping the newest `QUEUE_MAX`.
    fn drain(&mut self) {
        let Some(receiver) = self.mdns.as_ref().and_then(|m| m.browse.as_ref()) else {
            return;
        };
        while let Ok(event) = receiver.try_recv() {
            let ServiceEvent::ServiceResolved(service) = event else {
                continue;
            };
            let Some(observation) = props_of(service.get_properties())
                .as_ref()
                .and_then(observation_from)
            else {
                continue;
            };
            if self.queue.len() >= QUEUE_MAX {
                self.queue.pop_front();
            }
            self.queue.push_back(observation);
        }
    }

    /// Unregisters (goodbye packets) and shuts the daemon down; returns its exit status channel.
    fn teardown(&mut self) -> Option<mdns_sd::Receiver<mdns_sd::DaemonStatus>> {
        let mdns = self.mdns.take()?;
        if let Some(fullname) = mdns.advertised {
            let _ = mdns.daemon.unregister(&fullname);
        }
        if mdns.browse.is_some() {
            let _ = mdns.daemon.stop_browse(SERVICE);
        }
        mdns.daemon.shutdown().ok()
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
            let refused = config.enabled
                && config.advertise.is_none()
                && raw.get("advertise").is_some_and(|a| !a.is_null());
            state.apply(config, refused);
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

    /// Stops polling, withdraws the advert with goodbye packets and shuts the daemon down.
    pub async fn stop(self) {
        if let Some(task) = self.task {
            task.abort();
            let _ = task.await;
        }
        if let Some(status) = self.state.lock().await.teardown() {
            let _ = tokio::time::timeout(STOP_TIMEOUT, status.recv_async()).await;
        }
    }
}
