//! The responder and browser as a state machine over packets and time, with no sockets, so the
//! whole query and answer path is testable in memory.
use crate::{
    MDNS_PORT, on_link,
    service::{self, Advert, Heard, Resolved},
    wire,
};
use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddrV4},
    time::{Duration, Instant},
};

const ANNOUNCE_GAP: Duration = Duration::from_secs(1);
const ANNOUNCEMENTS: u8 = 2;
const BROWSE_FIRST: Duration = Duration::from_secs(1);
/// Browse queries back off to every 10 minutes; each one makes peers answer, which refreshes them.
const BROWSE_MAX: Duration = Duration::from_secs(600);
/// RFC 6762 §6: each record is multicast at most once per second.
const ANSWER_GAP: Duration = Duration::from_secs(1);
/// An unchanged peer is reported again once its last report is this old, so the core keeps seeing
/// peers that are still there. It is half the browse interval, so every browse answer counts.
const REFRESH: Duration = Duration::from_secs(300);
/// The most peers remembered for de-duplicating resolutions.
const KNOWN_MAX: usize = 256;

/// The interface the engine serves: its IPv4 address and netmask define the link.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Interface {
    pub name: String,
    pub addr: Ipv4Addr,
    pub mask: Ipv4Addr,
}

/// What a received packet produced.
#[derive(Debug, Default)]
pub struct Handled {
    /// A response to multicast to the group.
    pub reply: Option<Vec<u8>>,
    pub resolved: Vec<Resolved>,
}

pub struct Engine {
    iface: Interface,
    advert: Option<Advert>,
    /// When the next announcement is due and how many remain.
    announce: Option<(Instant, u8)>,
    /// When the next browse query is due and the interval after it.
    browse: Option<(Instant, Duration)>,
    /// When each of the advert's records (one per type) was last multicast.
    last_sent: HashMap<u16, Instant>,
    /// Peers reported, with when they were last reported.
    known: HashMap<String, (Resolved, Instant)>,
}

fn encoded(msg: Option<wire::Message>) -> Option<Vec<u8>> {
    wire::encode(&msg?).ok()
}

impl Engine {
    pub fn new(iface: Interface) -> Engine {
        Engine {
            iface,
            advert: None,
            announce: None,
            browse: None,
            last_sent: HashMap::new(),
            known: HashMap::new(),
        }
    }

    /// Replaces the advert. Returns the goodbye for an advert that is withdrawn or renamed; the
    /// new advert is announced twice, one second apart, from the next `poll`.
    pub fn set_advert(&mut self, now: Instant, next: Option<Advert>) -> Vec<Vec<u8>> {
        if self.advert == next {
            return Vec::new();
        }
        let renamed = match (&self.advert, &next) {
            (Some(old), Some(new)) => !old.instance.eq_ignore_ascii_case(&new.instance),
            (Some(_), None) => true,
            _ => false,
        };
        let out = if renamed { self.goodbye() } else { None };
        self.advert = next;
        self.announce = self.advert.as_ref().map(|_| (now, ANNOUNCEMENTS));
        out.into_iter().collect()
    }

    pub fn set_browse(&mut self, now: Instant, on: bool) {
        if !on {
            self.browse = None;
            self.known.clear();
        } else if self.browse.is_none() {
            self.browse = Some((now, BROWSE_FIRST));
        }
    }

    /// The goodbye for the current advert, if any.
    pub fn goodbye(&self) -> Option<Vec<u8>> {
        encoded(service::goodbye(self.advert.as_ref()?, self.iface.addr))
    }

    /// Announcements and browse queries due at `now`.
    pub fn poll(&mut self, now: Instant) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        if let Some((at, left)) = self.announce
            && now >= at
        {
            let announcement = self
                .advert
                .as_ref()
                .and_then(|a| service::announcement(a, self.iface.addr));
            if let Some(msg) = &announcement {
                self.mark_sent(now, msg);
            }
            out.extend(encoded(announcement));
            self.announce = (left > 1).then(|| (now + ANNOUNCE_GAP, left - 1));
        }
        if let Some((at, interval)) = self.browse
            && now >= at
        {
            out.extend(encoded(Some(service::browse_query())));
            self.browse = Some((now + interval, (interval * 2).min(BROWSE_MAX)));
        }
        out
    }

    fn recently_sent(&self, now: Instant, rtype: u16) -> bool {
        self.last_sent
            .get(&rtype)
            .is_some_and(|t| now.saturating_duration_since(*t) < ANSWER_GAP)
    }

    fn mark_sent(&mut self, now: Instant, msg: &wire::Message) {
        for r in msg.answers.iter().chain(&msg.additionals) {
            self.last_sent.insert(r.rtype(), now);
        }
    }

    /// The answer to a query without the records multicast within the last second.
    fn reply(&mut self, now: Instant, query: &wire::Message) -> Option<Vec<u8>> {
        let mut msg = service::answer(query, self.advert.as_ref()?, self.iface.addr)?;
        msg.answers.retain(|r| !self.recently_sent(now, r.rtype()));
        msg.additionals
            .retain(|r| !self.recently_sent(now, r.rtype()));
        if msg.answers.is_empty() {
            return None;
        }
        let packet = encoded(Some(msg.clone()))?;
        self.mark_sent(now, &msg);
        Some(packet)
    }

    pub fn next_deadline(&self) -> Option<Instant> {
        [self.announce.map(|a| a.0), self.browse.map(|b| b.0)]
            .into_iter()
            .flatten()
            .min()
    }

    /// Handles one packet. Only sources on the interface's link count. Queries are answered only
    /// from port 5353 (never legacy unicast) and only by multicast; responses count only from
    /// port 5353 (RFC 6762 §6) and only while browsing.
    pub fn handle(&mut self, now: Instant, packet: &[u8], src: SocketAddrV4) -> Handled {
        let mut out = Handled::default();
        if src.port() != MDNS_PORT || !on_link(*src.ip(), self.iface.addr, self.iface.mask) {
            return out;
        }
        let Ok(msg) = wire::decode(packet) else {
            return out;
        };
        if !msg.is_response() {
            out.reply = self.reply(now, &msg);
            return out;
        }
        if self.browse.is_none() {
            return out;
        }
        let own = self
            .advert
            .as_ref()
            .map(|a| a.instance.to_ascii_lowercase());
        for heard in service::heard(&msg, *src.ip()) {
            match heard {
                Heard::Gone(instance) => {
                    self.known.remove(&instance.to_ascii_lowercase());
                }
                Heard::Alive(resolved) => {
                    let key = resolved.instance.to_ascii_lowercase();
                    if own.as_ref() == Some(&key) {
                        continue;
                    }
                    let fresh = self.known.get(&key).is_some_and(|(r, at)| {
                        *r == resolved && now.saturating_duration_since(*at) < REFRESH
                    });
                    if fresh {
                        continue;
                    }
                    if self.known.len() >= KNOWN_MAX && !self.known.contains_key(&key) {
                        self.known.clear();
                    }
                    self.known.insert(key, (resolved.clone(), now));
                    out.resolved.push(resolved);
                }
            }
        }
        out
    }
}
