//! The `_pacer._udp.local.` records: what an advert publishes, which queries it answers and what a
//! response tells a browser.
use crate::wire::{
    CLASS_IN, Message, Name, Question, RData, Record, TYPE_A, TYPE_ANY, TYPE_PTR, TYPE_SRV,
    TYPE_TXT,
};
use std::{
    collections::{BTreeMap, HashMap},
    net::Ipv4Addr,
};

pub const SERVICE: &str = "_pacer._udp.local.";
/// RFC 6762 §10 defaults: 120 s for records that hold a host name or address (A, SRV), 4500 s for
/// the others.
pub const HOST_TTL: u32 = 120;
pub const SERVICE_TTL: u32 = 4500;
const FLAGS_RESPONSE: u16 = 0x8400;
const MAX_TXT_ENTRY: usize = 255;

/// What this machine publishes. `instance` is one DNS label and also names the host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Advert {
    pub instance: String,
    pub port: u16,
    pub txt: BTreeMap<String, String>,
}

impl Advert {
    /// An instance that is one label of letters, digits and `-`, and TXT entries that fit a
    /// character-string with a key that has no `=`.
    pub fn is_valid(&self) -> bool {
        (1..=63).contains(&self.instance.len())
            && self
                .instance
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && self.txt.iter().all(|(k, v)| {
                !k.is_empty() && !k.contains('=') && k.len() + v.len() < MAX_TXT_ENTRY
            })
    }
}

/// A pacer heard on the link.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub instance: String,
    pub txt: HashMap<String, String>,
    pub source: Ipv4Addr,
}

fn name(dotted: &str) -> Option<Name> {
    Name::parse(dotted).ok()
}

fn service_name() -> Option<Name> {
    name(SERVICE)
}

fn instance_name(instance: &str) -> Option<Name> {
    name(&format!("{instance}.{SERVICE}"))
}

fn host_name(instance: &str) -> Option<Name> {
    name(&format!("{instance}.local."))
}

fn record(name: Name, ttl: u32, data: RData) -> Record {
    Record {
        name,
        class: CLASS_IN,
        // PTR is a shared record; the others belong to this instance alone (RFC 6762 §10.2).
        cache_flush: !matches!(data, RData::Ptr(_)),
        ttl,
        data,
    }
}

/// PTR, SRV, TXT and A for the advert, with TTLs scaled to zero for a goodbye.
fn records(advert: &Advert, addr: Ipv4Addr, goodbye: bool) -> Option<[Record; 4]> {
    let ttl = |t| if goodbye { 0 } else { t };
    let instance = instance_name(&advert.instance)?;
    let host = host_name(&advert.instance)?;
    let txt = advert
        .txt
        .iter()
        .map(|(k, v)| format!("{k}={v}").into_bytes())
        .collect();
    Some([
        record(
            service_name()?,
            ttl(SERVICE_TTL),
            RData::Ptr(instance.clone()),
        ),
        record(
            instance.clone(),
            ttl(HOST_TTL),
            RData::Srv {
                priority: 0,
                weight: 0,
                port: advert.port,
                target: host.clone(),
            },
        ),
        record(instance, ttl(SERVICE_TTL), RData::Txt(txt)),
        record(host, ttl(HOST_TTL), RData::A(addr)),
    ])
}

fn response(answers: Vec<Record>, additionals: Vec<Record>) -> Message {
    Message {
        id: 0,
        flags: FLAGS_RESPONSE,
        questions: Vec::new(),
        answers,
        authorities: Vec::new(),
        additionals,
    }
}

/// An unsolicited response with every record (RFC 6762 §8.3).
pub fn announcement(advert: &Advert, addr: Ipv4Addr) -> Option<Message> {
    Some(response(records(advert, addr, false)?.to_vec(), Vec::new()))
}

/// Every record with TTL 0 (RFC 6762 §10.1).
pub fn goodbye(advert: &Advert, addr: Ipv4Addr) -> Option<Message> {
    Some(response(records(advert, addr, true)?.to_vec(), Vec::new()))
}

/// The PTR query a browser sends.
pub fn browse_query() -> Message {
    Message {
        id: 0,
        flags: 0,
        questions: service_name()
            .map(|name| Question {
                name,
                qtype: TYPE_PTR,
                class: CLASS_IN,
                unicast: false,
            })
            .into_iter()
            .collect(),
        answers: Vec::new(),
        authorities: Vec::new(),
        additionals: Vec::new(),
    }
}

fn wants(q: &Question, rtype: u16, name: &Name) -> bool {
    q.class == CLASS_IN && (q.qtype == rtype || q.qtype == TYPE_ANY) && q.name.is(name)
}

/// The answer to a query, or None when it asks nothing this advert holds. A PTR the querier
/// already knows with at least half its TTL left is not repeated (RFC 6762 §7.1).
pub fn answer(query: &Message, advert: &Advert, addr: Ipv4Addr) -> Option<Message> {
    let [ptr, srv, txt, a] = records(advert, addr, false)?;
    let known = query
        .answers
        .iter()
        .any(|k| k.name.is(&ptr.name) && k.data == ptr.data && k.ttl >= SERVICE_TTL / 2);
    let mut answers: Vec<Record> = Vec::new();
    for q in &query.questions {
        let wanted = [
            (wants(q, TYPE_PTR, &ptr.name) && !known, &ptr),
            (wants(q, TYPE_SRV, &srv.name), &srv),
            (wants(q, TYPE_TXT, &txt.name), &txt),
            (wants(q, TYPE_A, &a.name), &a),
        ];
        for (_, r) in wanted.into_iter().filter(|(w, _)| *w) {
            if !answers.contains(r) {
                answers.push(r.clone());
            }
        }
    }
    if answers.is_empty() {
        return None;
    }
    let additionals = [srv, txt, a]
        .into_iter()
        .filter(|r| !answers.contains(r))
        .collect();
    Some(response(answers, additionals))
}

/// The instance label of `<instance>._pacer._udp.local.`.
fn instance_of(owner: &Name) -> Option<&str> {
    let service = service_name()?;
    let (first, rest) = owner.labels().split_first()?;
    let rest_name = Name::from_labels(rest.to_vec()).ok()?;
    rest_name.is(&service).then_some(first.as_str())
}

/// TXT entries as `key=value`; the first of a repeated key wins (RFC 6763 §6.4). A value that is
/// not UTF-8 drops the record.
fn txt_map(entries: &[Vec<u8>]) -> Option<HashMap<String, String>> {
    let mut out = HashMap::new();
    for entry in entries.iter().filter(|e| !e.is_empty()) {
        let text = std::str::from_utf8(entry).ok()?;
        let (key, value) = text.split_once('=').unwrap_or((text, ""));
        if !key.is_empty() {
            out.entry(key.to_string())
                .or_insert_with(|| value.to_string());
        }
    }
    Some(out)
}

/// What one response says about pacer instances.
#[derive(Debug, PartialEq, Eq)]
pub enum Heard {
    /// A live instance and how long, in seconds, its PTR and TXT may be cached.
    Alive(Resolved, u32),
    Gone(String),
}

/// TXT records of `_pacer._udp.local.` instances in the answers and additionals. An instance is
/// cached for the shorter TTL of its TXT and of any PTR to it in the same response; SRV and A are
/// host records with short TTLs that a browser re-queries, so they do not end the instance.
pub fn heard(msg: &Message, source: Ipv4Addr) -> Vec<Heard> {
    let records = || {
        msg.answers
            .iter()
            .chain(&msg.additionals)
            .filter(|r| r.class == CLASS_IN)
    };
    let ptr_ttl = |instance: &Name| {
        records()
            .filter(|r| matches!(&r.data, RData::Ptr(target) if target.is(instance)))
            .map(|r| r.ttl)
            .min()
    };
    records()
        .filter_map(|r| {
            let RData::Txt(entries) = &r.data else {
                return None;
            };
            let instance = instance_of(&r.name)?.to_string();
            if r.ttl == 0 {
                return Some(Heard::Gone(instance));
            }
            let ttl = ptr_ttl(&r.name).map_or(r.ttl, |t| t.min(r.ttl));
            Some(Heard::Alive(
                Resolved {
                    instance,
                    txt: txt_map(entries)?,
                    source,
                },
                ttl,
            ))
        })
        .collect()
}
