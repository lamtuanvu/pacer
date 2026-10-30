#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_mdns::{
    Advert, Engine, Interface, MDNS_GROUP, MDNS_PORT, Resolved, Responder, Transport, on_link,
    valid_netmask,
    wire::{self, Message, RData, TYPE_A, TYPE_PTR, TYPE_SRV, TYPE_TXT},
};
use std::{
    collections::BTreeMap,
    io,
    net::{Ipv4Addr, SocketAddrV4},
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver, Sender},
    },
    time::{Duration, Instant},
};

const SUBNET_ADDR: Ipv4Addr = Ipv4Addr::new(192, 168, 1, 10);
const MASK: Ipv4Addr = Ipv4Addr::new(255, 255, 255, 0);

fn iface(addr: Ipv4Addr) -> Interface {
    Interface {
        name: "en0".into(),
        addr,
        mask: MASK,
    }
}

fn advert(instance: &str) -> Advert {
    Advert {
        instance: instance.into(),
        port: 9,
        txt: BTreeMap::from([
            ("id".to_string(), instance.to_string()),
            ("name".to_string(), "studio".to_string()),
        ]),
    }
}

fn from(ip: [u8; 4], port: u16) -> SocketAddrV4 {
    SocketAddrV4::new(Ipv4Addr::from(ip), port)
}

fn ptr_query() -> Vec<u8> {
    wire::encode(&pacer_mdns::browse_query()).unwrap()
}

#[test]
fn on_link_accepts_the_subnet_and_link_local_only() {
    for ip in [[192, 168, 1, 1], [192, 168, 1, 254], [169, 254, 3, 4]] {
        assert!(on_link(Ipv4Addr::from(ip), SUBNET_ADDR, MASK), "{ip:?}");
    }
    for ip in [
        [192, 168, 2, 1],
        [10, 0, 0, 1],
        [8, 8, 8, 8],
        [127, 0, 0, 1],
        [224, 0, 0, 251],
        [0, 0, 0, 0],
        [255, 255, 255, 255],
    ] {
        assert!(!on_link(Ipv4Addr::from(ip), SUBNET_ADDR, MASK), "{ip:?}");
    }
    assert!(on_link(
        Ipv4Addr::new(10, 1, 200, 3),
        Ipv4Addr::new(10, 1, 0, 2),
        Ipv4Addr::new(255, 255, 0, 0)
    ));
}

#[test]
fn only_contiguous_netmasks_are_valid() {
    assert!(valid_netmask(MASK));
    assert!(valid_netmask(Ipv4Addr::new(255, 255, 252, 0)));
    assert!(!valid_netmask(Ipv4Addr::new(255, 0, 255, 0)));
    assert!(!valid_netmask(Ipv4Addr::UNSPECIFIED));
    assert!(!valid_netmask(Ipv4Addr::BROADCAST));
}

#[test]
fn a_multicast_query_from_the_link_gets_a_full_answer() {
    let now = Instant::now();
    let mut engine = Engine::new(iface(SUBNET_ADDR));
    engine.set_advert(now, Some(advert("abc")));
    let out = engine.handle(
        now + Duration::from_secs(5),
        &ptr_query(),
        from([192, 168, 1, 20], 5353),
    );
    let reply = wire::decode(&out.reply.expect("answered")).unwrap();
    assert!(reply.is_response());
    assert_eq!(reply.answers.len(), 1);
    assert_eq!(reply.answers[0].rtype(), TYPE_PTR);
    assert_eq!(reply.answers[0].ttl, 4500);
    let types: Vec<u16> = reply.additionals.iter().map(|r| r.rtype()).collect();
    assert_eq!(types, vec![TYPE_SRV, TYPE_TXT, TYPE_A]);
    let a = &reply.additionals[2];
    assert_eq!(a.ttl, 120);
    assert_eq!(a.data, RData::A(SUBNET_ADDR));
    assert_eq!(a.name.to_string(), "abc.local.");
    assert!(
        matches!(&reply.additionals[0].data, RData::Srv { port: 9, target, .. } if target.to_string() == "abc.local.")
    );
    // SRV names a host, so it has the host TTL (RFC 6762 §10).
    assert_eq!(reply.additionals[0].ttl, 120);
    assert_eq!(reply.additionals[1].ttl, 4500);
}

fn query(questions: &[(&str, u16)]) -> Vec<u8> {
    let mut q = pacer_mdns::browse_query();
    let template = q.questions[0].clone();
    q.questions = questions
        .iter()
        .map(|(name, qtype)| wire::Question {
            name: wire::Name::parse(name).unwrap(),
            qtype: *qtype,
            ..template.clone()
        })
        .collect();
    wire::encode(&q).unwrap()
}

#[test]
fn repeated_questions_yield_each_record_once() {
    let now = Instant::now() + Duration::from_secs(5);
    let mut engine = Engine::new(iface(SUBNET_ADDR));
    engine.set_advert(Instant::now(), Some(advert("abc")));
    let packet = query(&[
        ("_pacer._udp.local.", TYPE_PTR),
        ("abc._pacer._udp.local.", TYPE_SRV),
        ("_pacer._udp.local.", TYPE_PTR),
        ("abc._pacer._udp.local.", TYPE_SRV),
    ]);
    let reply = engine.handle(now, &packet, from([192, 168, 1, 20], 5353));
    let reply = wire::decode(&reply.reply.unwrap()).unwrap();
    let types: Vec<u16> = reply.answers.iter().map(|r| r.rtype()).collect();
    assert_eq!(types, vec![TYPE_PTR, TYPE_SRV]);
}

#[test]
fn the_once_a_second_limit_applies_per_record() {
    let t = Instant::now() + Duration::from_secs(5);
    let mut engine = Engine::new(iface(SUBNET_ADDR));
    engine.set_advert(Instant::now(), Some(advert("abc")));
    let link = from([192, 168, 1, 20], 5353);
    let a_query = query(&[("abc.local.", TYPE_A)]);
    assert!(engine.handle(t, &a_query, link).reply.is_some());
    // A just went out, so another A query within a second gets nothing...
    let soon = t + Duration::from_millis(200);
    assert!(engine.handle(soon, &a_query, link).reply.is_none());
    // ...but a browser's PTR query is still answered, without repeating A.
    let reply = engine.handle(soon, &ptr_query(), link).reply.unwrap();
    let reply = wire::decode(&reply).unwrap();
    assert_eq!(reply.answers[0].rtype(), TYPE_PTR);
    assert!(reply.additionals.iter().all(|r| r.rtype() != TYPE_A));
    // After a second every record may go out again.
    let later = t + Duration::from_millis(1300);
    assert!(engine.handle(later, &a_query, link).reply.is_some());
}

#[test]
fn legacy_unicast_and_off_link_queries_get_no_answer() {
    let now = Instant::now() + Duration::from_secs(5);
    let mut engine = Engine::new(iface(SUBNET_ADDR));
    engine.set_advert(Instant::now(), Some(advert("abc")));
    for src in [
        from([192, 168, 1, 20], 49152),
        from([192, 168, 1, 20], 53),
        from([10, 9, 8, 7], 5353),
        from([8, 8, 8, 8], 5353),
        from([192, 168, 2, 20], 5353),
    ] {
        assert!(
            engine.handle(now, &ptr_query(), src).reply.is_none(),
            "{src}"
        );
    }
}

#[test]
fn queries_for_other_names_or_without_an_advert_get_no_answer() {
    let now = Instant::now() + Duration::from_secs(5);
    let mut engine = Engine::new(iface(SUBNET_ADDR));
    let link = from([192, 168, 1, 20], 5353);
    assert!(engine.handle(now, &ptr_query(), link).reply.is_none());
    engine.set_advert(Instant::now(), Some(advert("abc")));
    let mut q = pacer_mdns::browse_query();
    q.questions[0].name = wire::Name::parse("_http._tcp.local.").unwrap();
    assert!(
        engine
            .handle(now, &wire::encode(&q).unwrap(), link)
            .reply
            .is_none()
    );
    // A direct A query for the host gets the address.
    q.questions[0].name = wire::Name::parse("ABC.local.").unwrap();
    q.questions[0].qtype = TYPE_A;
    let reply = engine
        .handle(now, &wire::encode(&q).unwrap(), link)
        .reply
        .unwrap();
    assert_eq!(
        wire::decode(&reply).unwrap().answers[0].data,
        RData::A(SUBNET_ADDR)
    );
}

#[test]
fn a_known_answer_suppresses_the_ptr() {
    let now = Instant::now() + Duration::from_secs(5);
    let mut engine = Engine::new(iface(SUBNET_ADDR));
    engine.set_advert(Instant::now(), Some(advert("abc")));
    let announce = wire::decode(&engine.goodbye().unwrap()).unwrap();
    let mut q = pacer_mdns::browse_query();
    let mut known = announce.answers[0].clone();
    known.ttl = 4000;
    q.answers.push(known);
    let link = from([192, 168, 1, 20], 5353);
    assert!(
        engine
            .handle(now, &wire::encode(&q).unwrap(), link)
            .reply
            .is_none()
    );
}

#[test]
fn malformed_and_oversized_packets_are_ignored() {
    let now = Instant::now();
    let mut engine = Engine::new(iface(SUBNET_ADDR));
    engine.set_advert(now, Some(advert("abc")));
    engine.set_browse(now, true);
    let link = from([192, 168, 1, 20], 5353);
    for bytes in [vec![], vec![0xff; 40], vec![0; 9001]] {
        let out = engine.handle(now, &bytes, link);
        assert!(out.reply.is_none() && out.resolved.is_empty());
    }
}

/// Packets each engine sent, for driving another engine.
fn announce_of(engine: &mut Engine, now: Instant) -> Vec<u8> {
    engine
        .poll(now)
        .into_iter()
        .next()
        .expect("an announcement")
}

#[test]
fn announcements_go_out_twice_a_second_apart_and_goodbye_zeroes_every_ttl() {
    let t0 = Instant::now();
    let mut engine = Engine::new(iface(SUBNET_ADDR));
    assert!(engine.set_advert(t0, Some(advert("abc"))).is_empty());
    let first = engine.poll(t0);
    assert_eq!(first.len(), 1);
    let msg = wire::decode(&first[0]).unwrap();
    assert_eq!(msg.answers.len(), 4);
    assert!(engine.poll(t0 + Duration::from_millis(500)).is_empty());
    assert_eq!(engine.next_deadline(), Some(t0 + Duration::from_secs(1)));
    assert_eq!(engine.poll(t0 + Duration::from_secs(1)).len(), 1);
    assert!(engine.poll(t0 + Duration::from_secs(10)).is_empty());
    // The same advert again changes nothing.
    assert!(engine.set_advert(t0, Some(advert("abc"))).is_empty());
    assert!(engine.poll(t0 + Duration::from_secs(11)).is_empty());
    // A new instance says goodbye to the old one, then announces twice.
    let t1 = t0 + Duration::from_secs(20);
    let bye = engine.set_advert(t1, Some(advert("xyz")));
    let bye = wire::decode(&bye[0]).unwrap();
    assert!(bye.answers.iter().all(|r| r.ttl == 0));
    assert_eq!(
        bye.answers[0].data,
        RData::Ptr(wire::Name::parse("abc._pacer._udp.local.").unwrap())
    );
    assert_eq!(engine.poll(t1).len(), 1);
    assert_eq!(engine.poll(t1 + Duration::from_secs(1)).len(), 1);
    // A changed TXT on the same instance re-announces without a goodbye.
    let mut renamed = advert("xyz");
    renamed.txt.insert("name".into(), "den".into());
    assert!(engine.set_advert(t1, Some(renamed)).is_empty());
    assert_eq!(engine.poll(t1 + Duration::from_secs(2)).len(), 1);
    // Removing the advert sends the goodbye and stops answering.
    let removed = engine.set_advert(t1, None);
    assert_eq!(removed.len(), 1);
    assert!(
        wire::decode(&removed[0])
            .unwrap()
            .answers
            .iter()
            .all(|r| r.ttl == 0)
    );
    assert!(engine.goodbye().is_none());
}

#[test]
fn browse_queries_back_off_to_ten_minutes() {
    let t0 = Instant::now();
    let mut engine = Engine::new(iface(SUBNET_ADDR));
    engine.set_browse(t0, true);
    let mut sent_at = Vec::new();
    let mut t = t0;
    while t < t0 + Duration::from_secs(2400) {
        for packet in engine.poll(t) {
            let msg = wire::decode(&packet).unwrap();
            assert!(!msg.is_response());
            assert_eq!(msg.questions[0].qtype, TYPE_PTR);
            sent_at.push(t.duration_since(t0).as_secs());
        }
        t += Duration::from_secs(1);
    }
    assert_eq!(
        &sent_at[..12],
        &[0, 1, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 1623]
    );
    assert_eq!(sent_at[12] - sent_at[11], 600);
    engine.set_browse(t, false);
    assert!(engine.poll(t + Duration::from_secs(600)).is_empty());
}

#[test]
fn answers_resolve_on_link_only_and_never_our_own_instance() {
    let t0 = Instant::now();
    let mut a = Engine::new(iface(Ipv4Addr::new(192, 168, 1, 20)));
    a.set_advert(t0, Some(advert("peer")));
    let packet = announce_of(&mut a, t0);
    let mut b = Engine::new(iface(SUBNET_ADDR));
    b.set_advert(t0, Some(advert("self")));
    // Not browsing: nothing is resolved.
    assert!(
        b.handle(t0, &packet, from([192, 168, 1, 20], 5353))
            .resolved
            .is_empty()
    );
    b.set_browse(t0, true);
    let got = b
        .handle(t0, &packet, from([192, 168, 1, 20], 5353))
        .resolved;
    assert_eq!(
        got,
        vec![Resolved {
            instance: "peer".into(),
            txt: [("id", "peer"), ("name", "studio")]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            source: Ipv4Addr::new(192, 168, 1, 20),
        }]
    );
    // The same record again is not repeated.
    assert!(
        b.handle(t0, &packet, from([192, 168, 1, 20], 5353))
            .resolved
            .is_empty()
    );
    // Off-link sources and responses from a port other than 5353 are ignored.
    let mut c = Engine::new(iface(SUBNET_ADDR));
    c.set_browse(t0, true);
    assert!(
        c.handle(t0, &packet, from([10, 0, 0, 5], 5353))
            .resolved
            .is_empty()
    );
    assert!(
        c.handle(t0, &packet, from([192, 168, 1, 20], 40000))
            .resolved
            .is_empty()
    );
    assert_eq!(
        c.handle(t0, &packet, from([169, 254, 1, 1], 5353))
            .resolved
            .len(),
        1
    );
    // Our own instance is ignored.
    let mut own = Engine::new(iface(SUBNET_ADDR));
    own.set_advert(t0, Some(advert("peer")));
    own.set_browse(t0, true);
    assert!(
        own.handle(t0, &packet, from([192, 168, 1, 20], 5353))
            .resolved
            .is_empty()
    );
}

#[test]
fn a_goodbye_forgets_the_peer_so_it_resolves_again() {
    let t0 = Instant::now();
    let mut a = Engine::new(iface(Ipv4Addr::new(192, 168, 1, 20)));
    a.set_advert(t0, Some(advert("peer")));
    let hello = announce_of(&mut a, t0);
    let bye = a.goodbye().unwrap();
    let mut b = Engine::new(iface(SUBNET_ADDR));
    b.set_browse(t0, true);
    let src = from([192, 168, 1, 20], 5353);
    assert_eq!(b.handle(t0, &hello, src).resolved.len(), 1);
    assert!(b.handle(t0, &bye, src).resolved.is_empty());
    assert_eq!(b.handle(t0, &hello, src).resolved.len(), 1);
}

#[test]
fn a_peer_still_answering_is_reported_again_after_the_refresh_interval() {
    let t0 = Instant::now();
    let mut a = Engine::new(iface(Ipv4Addr::new(192, 168, 1, 20)));
    a.set_advert(t0, Some(advert("peer")));
    let hello = announce_of(&mut a, t0);
    let mut b = Engine::new(iface(SUBNET_ADDR));
    b.set_browse(t0, true);
    let src = from([192, 168, 1, 20], 5353);
    assert_eq!(b.handle(t0, &hello, src).resolved.len(), 1);
    let at = |s| t0 + Duration::from_secs(s);
    assert!(b.handle(at(60), &hello, src).resolved.is_empty());
    assert!(b.handle(at(299), &hello, src).resolved.is_empty());
    // Unchanged, but the last report is five minutes old: report it again.
    assert_eq!(b.handle(at(300), &hello, src).resolved.len(), 1);
    assert!(b.handle(at(400), &hello, src).resolved.is_empty());
    // Changed data is reported at once.
    let mut renamed = advert("peer");
    renamed.txt.insert("name".into(), "den".into());
    a.set_advert(at(401), Some(renamed));
    let changed = announce_of(&mut a, at(401));
    assert_eq!(b.handle(at(401), &changed, src).resolved.len(), 1);
}

#[test]
fn a_ten_minute_browse_refreshes_every_peer() {
    let t0 = Instant::now();
    let mut a = Engine::new(iface(Ipv4Addr::new(192, 168, 1, 20)));
    // Never polled, so A answers queries without announcing first.
    a.set_advert(t0, Some(advert("peer")));
    let mut b = Engine::new(iface(SUBNET_ADDR));
    b.set_browse(t0, true);
    let (ab, ba) = (from([192, 168, 1, 20], 5353), from([192, 168, 1, 10], 5353));
    let mut reports = Vec::new();
    let mut t = t0;
    while t < t0 + Duration::from_secs(3600) {
        for query in b.poll(t) {
            if let Some(reply) = a.handle(t, &query, ba).reply {
                for _ in b.handle(t, &reply, ab).resolved {
                    reports.push(t.duration_since(t0).as_secs());
                }
            }
        }
        t += Duration::from_secs(1);
    }
    assert_eq!(reports[0], 0);
    assert!(
        reports.windows(2).all(|w| w[1] - w[0] <= 600),
        "{reports:?}"
    );
    assert!(*reports.last().unwrap() >= 3000, "{reports:?}");
}

#[test]
fn a_non_utf8_txt_entry_drops_the_service() {
    let t0 = Instant::now();
    let mut a = Engine::new(iface(Ipv4Addr::new(192, 168, 1, 20)));
    a.set_advert(t0, Some(advert("peer")));
    let mut msg = wire::decode(&announce_of(&mut a, t0)).unwrap();
    for r in &mut msg.answers {
        if let RData::Txt(entries) = &mut r.data {
            entries.push(b"bad=\xff".to_vec());
        }
    }
    let mut b = Engine::new(iface(SUBNET_ADDR));
    b.set_browse(t0, true);
    let out = b.handle(
        t0,
        &wire::encode(&msg).unwrap(),
        from([192, 168, 1, 20], 5353),
    );
    assert!(out.resolved.is_empty());
}

/// An in-memory link: every packet a member sends reaches every other member, from its address.
#[derive(Clone, Default)]
struct Link(Arc<Mutex<Vec<Member>>>);

type Member = (Ipv4Addr, Sender<Packet>);

type Packet = (Vec<u8>, SocketAddrV4);

struct Port {
    addr: Ipv4Addr,
    link: Link,
    inbox: Receiver<Packet>,
}

impl Link {
    fn join(&self, addr: Ipv4Addr) -> Port {
        let (tx, rx) = mpsc::channel();
        self.0.lock().unwrap().push((addr, tx));
        Port {
            addr,
            link: self.clone(),
            inbox: rx,
        }
    }
}

impl Transport for Port {
    fn send(&self, packet: &[u8]) -> io::Result<()> {
        for (addr, tx) in self.link.0.lock().unwrap().iter() {
            if *addr != self.addr {
                let _ = tx.send((packet.to_vec(), SocketAddrV4::new(self.addr, MDNS_PORT)));
            }
        }
        Ok(())
    }
    fn recv(&self, buf: &mut [u8], timeout: Duration) -> io::Result<Option<(usize, SocketAddrV4)>> {
        match self.inbox.recv_timeout(timeout) {
            Ok((packet, src)) => {
                let n = packet.len().min(buf.len());
                buf[..n].copy_from_slice(&packet[..n]);
                Ok(Some((n, src)))
            }
            Err(_) => Ok(None),
        }
    }
}

#[test]
fn two_responders_on_one_link_find_each_other_and_stop_with_a_goodbye() {
    let link = Link::default();
    let a_addr = Ipv4Addr::new(192, 168, 1, 20);
    let a = Responder::with_transport(iface(a_addr), link.join(a_addr));
    let b = Responder::with_transport(iface(SUBNET_ADDR), link.join(SUBNET_ADDR));
    let watcher = link.join(Ipv4Addr::new(192, 168, 1, 30));
    b.set_browse(true).unwrap();
    a.set_advert(Some(advert("peer"))).unwrap();
    let found = b
        .browse_events()
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    assert_eq!(found.instance, "peer");
    assert_eq!(found.source, a_addr);
    assert_eq!(found.txt["name"], "studio");
    assert!(a.set_advert(Some(advert("bad.name"))).is_err());
    a.shutdown();
    // The last packet from A is the goodbye.
    let mut last = None;
    while let Ok((packet, src)) = watcher.inbox.recv_timeout(Duration::from_millis(300)) {
        if *src.ip() == a_addr {
            last = Some(packet);
        }
    }
    let last: Message = wire::decode(&last.unwrap()).unwrap();
    assert!(last.is_response() && last.answers.iter().all(|r| r.ttl == 0));
    b.shutdown();
    assert_eq!(MDNS_GROUP, Ipv4Addr::new(224, 0, 0, 251));
}

/// Seconds after `t0` at which `engine` reported a peer from its cache, ticking once a second.
fn cached_reports(engine: &mut Engine, t0: Instant, from_s: u64, to_s: u64) -> Vec<u64> {
    let mut reports = Vec::new();
    for s in from_s..to_s {
        for resolved in engine.refresh(t0 + Duration::from_secs(s)) {
            assert_eq!(resolved.instance, "peer");
            reports.push(s);
        }
    }
    reports
}

#[test]
fn a_cached_peer_is_reported_every_five_minutes_until_its_ttl_expires() {
    // Only the first answer arrives; every later report comes from the cache.
    let t0 = Instant::now();
    let mut a = Engine::new(iface(Ipv4Addr::new(192, 168, 1, 20)));
    a.set_advert(t0, Some(advert("peer")));
    let hello = announce_of(&mut a, t0);
    let mut b = Engine::new(iface(SUBNET_ADDR));
    b.set_browse(t0, true);
    let src = from([192, 168, 1, 20], 5353);
    assert_eq!(b.handle(t0, &hello, src).resolved.len(), 1);
    let reports = cached_reports(&mut b, t0, 0, 6000);
    // PTR and TXT carry 4500 s; SRV's 120 s does not end the peer.
    let expected: Vec<u64> = (1..15).map(|n| n * 300).collect();
    assert_eq!(reports, expected);
    // Expired, so it is forgotten and the next answer reports it at once.
    let late = t0 + Duration::from_secs(6000);
    assert_eq!(b.handle(late, &hello, src).resolved.len(), 1);
}

#[test]
fn a_fresh_answer_extends_the_cached_peer() {
    let t0 = Instant::now();
    let mut a = Engine::new(iface(Ipv4Addr::new(192, 168, 1, 20)));
    a.set_advert(t0, Some(advert("peer")));
    let hello = announce_of(&mut a, t0);
    let mut b = Engine::new(iface(SUBNET_ADDR));
    b.set_browse(t0, true);
    let src = from([192, 168, 1, 20], 5353);
    assert_eq!(b.handle(t0, &hello, src).resolved.len(), 1);
    assert_eq!(cached_reports(&mut b, t0, 0, 4000).last(), Some(&3900));
    // Heard again unchanged at 4000 s: not reported, but the TTL now runs to 8500 s.
    let at = t0 + Duration::from_secs(4000);
    assert!(b.handle(at, &hello, src).resolved.is_empty());
    let reports = cached_reports(&mut b, t0, 4000, 9000);
    assert_eq!(reports.first(), Some(&4200));
    assert_eq!(reports.last(), Some(&8400));
}

#[test]
fn a_goodbye_stops_cached_reports() {
    let t0 = Instant::now();
    let mut a = Engine::new(iface(Ipv4Addr::new(192, 168, 1, 20)));
    a.set_advert(t0, Some(advert("peer")));
    let hello = announce_of(&mut a, t0);
    let bye = a.goodbye().unwrap();
    let mut b = Engine::new(iface(SUBNET_ADDR));
    b.set_browse(t0, true);
    let src = from([192, 168, 1, 20], 5353);
    assert_eq!(b.handle(t0, &hello, src).resolved.len(), 1);
    assert_eq!(cached_reports(&mut b, t0, 0, 400), vec![300]);
    assert!(
        b.handle(t0 + Duration::from_secs(400), &bye, src)
            .resolved
            .is_empty()
    );
    assert!(cached_reports(&mut b, t0, 400, 5000).is_empty());
}

#[test]
fn changed_txt_is_reported_at_once_and_restarts_the_cached_interval() {
    let t0 = Instant::now();
    let mut a = Engine::new(iface(Ipv4Addr::new(192, 168, 1, 20)));
    a.set_advert(t0, Some(advert("peer")));
    let hello = announce_of(&mut a, t0);
    let mut b = Engine::new(iface(SUBNET_ADDR));
    b.set_browse(t0, true);
    let src = from([192, 168, 1, 20], 5353);
    assert_eq!(b.handle(t0, &hello, src).resolved.len(), 1);
    let mut renamed = advert("peer");
    renamed.txt.insert("name".into(), "den".into());
    let at = t0 + Duration::from_secs(100);
    a.set_advert(at, Some(renamed));
    let changed = announce_of(&mut a, at);
    let got = b.handle(at, &changed, src).resolved;
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].txt["name"], "den");
    let reports = cached_reports(&mut b, t0, 100, 700);
    assert_eq!(reports, vec![400]);
    let next = b.refresh(t0 + Duration::from_secs(700));
    assert_eq!(next[0].txt["name"], "den");
}

/// `hello` with every PTR and TXT TTL set to `ttl`.
fn with_service_ttl(hello: &[u8], ttl: u32) -> Vec<u8> {
    let mut msg = wire::decode(hello).unwrap();
    for r in msg.answers.iter_mut().chain(msg.additionals.iter_mut()) {
        if r.rtype() == TYPE_PTR || r.rtype() == TYPE_TXT {
            r.ttl = ttl;
        }
    }
    wire::encode(&msg).unwrap()
}

#[test]
fn a_huge_wire_ttl_is_capped_at_the_service_ttl() {
    let t0 = Instant::now();
    let mut a = Engine::new(iface(Ipv4Addr::new(192, 168, 1, 20)));
    a.set_advert(t0, Some(advert("peer")));
    let hello = with_service_ttl(&announce_of(&mut a, t0), u32::MAX);
    let mut b = Engine::new(iface(SUBNET_ADDR));
    b.set_browse(t0, true);
    let src = from([192, 168, 1, 20], 5353);
    assert_eq!(b.handle(t0, &hello, src).resolved.len(), 1);
    // Cached for SERVICE_TTL (4500 s), not 136 years.
    let reports = cached_reports(&mut b, t0, 0, 9000);
    assert_eq!(reports.last(), Some(&4200));
}

#[test]
fn a_zero_ptr_ttl_is_a_goodbye() {
    let t0 = Instant::now();
    let mut a = Engine::new(iface(Ipv4Addr::new(192, 168, 1, 20)));
    a.set_advert(t0, Some(advert("peer")));
    let hello = announce_of(&mut a, t0);
    let mut msg = wire::decode(&hello).unwrap();
    for r in msg.answers.iter_mut().filter(|r| r.rtype() == TYPE_PTR) {
        r.ttl = 0;
    }
    let ptr_gone = wire::encode(&msg).unwrap();
    let mut b = Engine::new(iface(SUBNET_ADDR));
    b.set_browse(t0, true);
    let src = from([192, 168, 1, 20], 5353);
    // Never reported, even when first heard: a zero PTR TTL is a goodbye.
    assert!(b.handle(t0, &ptr_gone, src).resolved.is_empty());
    assert_eq!(b.handle(t0, &hello, src).resolved.len(), 1);
    let at = t0 + Duration::from_secs(10);
    assert!(b.handle(at, &ptr_gone, src).resolved.is_empty());
    assert!(cached_reports(&mut b, t0, 10, 5000).is_empty());
}
