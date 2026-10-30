#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_mdns::wire::{
    CLASS_IN, MAX_PACKET, MAX_RECORDS, Message, Name, Question, RData, Record, TYPE_PTR, TYPE_TXT,
    WireError, decode, encode,
};
use std::net::Ipv4Addr;

fn name(s: &str) -> Name {
    Name::parse(s).unwrap()
}

fn record(owner: &str, ttl: u32, data: RData) -> Record {
    Record {
        name: name(owner),
        class: CLASS_IN,
        cache_flush: !matches!(data, RData::Ptr(_)),
        ttl,
        data,
    }
}

fn sample() -> Message {
    Message {
        id: 0,
        flags: 0x8400,
        questions: vec![Question {
            name: name("_pacer._udp.local."),
            qtype: TYPE_PTR,
            class: CLASS_IN,
            unicast: true,
        }],
        answers: vec![record(
            "_pacer._udp.local.",
            4500,
            RData::Ptr(name("abc._pacer._udp.local.")),
        )],
        authorities: vec![],
        additionals: vec![
            record(
                "abc._pacer._udp.local.",
                4500,
                RData::Srv {
                    priority: 0,
                    weight: 0,
                    port: 9,
                    target: name("abc.local."),
                },
            ),
            record(
                "abc._pacer._udp.local.",
                4500,
                RData::Txt(vec![b"id=abc".to_vec(), b"name=studio".to_vec(), vec![]]),
            ),
            record("abc.local.", 120, RData::A(Ipv4Addr::new(192, 168, 1, 7))),
            record(
                "abc.local.",
                120,
                RData::Other {
                    rtype: 47,
                    data: vec![1, 2, 3],
                },
            ),
        ],
    }
}

#[test]
fn a_message_survives_an_encode_decode_round_trip() {
    let msg = sample();
    let bytes = encode(&msg).unwrap();
    assert_eq!(decode(&bytes).unwrap(), msg);
    assert!(decode(&bytes).unwrap().is_response());
}

#[test]
fn an_empty_txt_record_round_trips() {
    let mut msg = sample();
    msg.additionals = vec![record("abc._pacer._udp.local.", 1, RData::Txt(vec![]))];
    assert_eq!(decode(&encode(&msg).unwrap()).unwrap(), msg);
}

#[test]
fn names_compare_without_case() {
    assert!(name("ABC._Pacer._udp.LOCAL.").is(&name("abc._pacer._udp.local")));
    assert!(!name("abc.local.").is(&name("abd.local.")));
    assert_eq!(name("a.b.local").to_string(), "a.b.local.");
    assert!(Name::parse("a..b").is_err());
    assert!(Name::parse(&"x".repeat(64)).is_err());
}

// A header with the given counts.
fn header(qd: u16, an: u16, ns: u16, ar: u16, flags: u16) -> Vec<u8> {
    let mut out = vec![0, 0];
    for v in [flags, qd, an, ns, ar] {
        out.extend_from_slice(&v.to_be_bytes());
    }
    out
}

/// A response with one record whose owner name is `owner` (raw wire bytes).
fn one_record(owner: &[u8], rtype: u16, rdata: &[u8]) -> Vec<u8> {
    let mut out = header(0, 1, 0, 0, 0x8400);
    out.extend_from_slice(owner);
    out.extend_from_slice(&rtype.to_be_bytes());
    out.extend_from_slice(&CLASS_IN.to_be_bytes());
    out.extend_from_slice(&120u32.to_be_bytes());
    out.extend_from_slice(&u16::try_from(rdata.len()).unwrap().to_be_bytes());
    out.extend_from_slice(rdata);
    out
}

#[test]
fn compressed_names_are_followed() {
    // Owner "abc.local." at offset 12; the PTR data points back at it.
    let owner = b"\x03abc\x05local\x00";
    let msg = decode(&one_record(owner, TYPE_PTR, &[0xc0, 12])).unwrap();
    assert_eq!(msg.answers[0].data, RData::Ptr(name("abc.local.")));
    // A label followed by a pointer to the tail.
    let msg = decode(&one_record(owner, TYPE_PTR, &[1, b'x', 0xc0, 16])).unwrap();
    assert_eq!(msg.answers[0].data, RData::Ptr(name("x.local.")));
}

#[test]
fn malformed_packets_are_rejected() {
    let owner = b"\x03abc\x05local\x00";
    let too_many = {
        let mut p = header(u16::try_from(MAX_RECORDS + 1).unwrap(), 0, 0, 0, 0);
        p.resize(512, 0);
        p
    };
    let long_name = {
        // 5 labels of 63 bytes: 320 bytes, above the 255-byte limit.
        let mut n = Vec::new();
        for _ in 0..5 {
            n.push(63);
            n.extend(std::iter::repeat_n(b'a', 63));
        }
        n.push(0);
        n
    };
    let pointer_chain_long = {
        // "aaaa…" (63) then a pointer back to itself after another label: grows past 255.
        let mut p = header(0, 1, 0, 0, 0x8400);
        p.push(63);
        p.extend(std::iter::repeat_n(b'a', 63));
        p.extend_from_slice(&[0xc0, 12]);
        p
    };
    let cases: Vec<(&str, Vec<u8>, WireError)> = vec![
        ("empty", vec![], WireError::Truncated),
        ("short header", vec![0; 11], WireError::Truncated),
        (
            "counts beyond the data",
            header(1, 0, 0, 0, 0),
            WireError::Truncated,
        ),
        ("too many records", too_many, WireError::TooManyRecords),
        (
            "pointer to itself",
            one_record(&[0xc0, 12], TYPE_PTR, &[]),
            WireError::PointerLoop,
        ),
        (
            "forward pointer",
            one_record(&[0xc0, 40], TYPE_PTR, &[]),
            WireError::PointerLoop,
        ),
        (
            "pointer loop through a label",
            pointer_chain_long,
            WireError::PointerLoop,
        ),
        (
            "reserved label type",
            one_record(&[0x40, 0], TYPE_PTR, &[]),
            WireError::BadLabel,
        ),
        (
            "name above 255 bytes",
            one_record(&long_name, TYPE_PTR, &[]),
            WireError::NameTooLong,
        ),
        (
            "label beyond the data",
            {
                let mut p = header(0, 1, 0, 0, 0x8400);
                p.extend_from_slice(&[9, b'a']);
                p
            },
            WireError::Truncated,
        ),
        (
            "non-UTF-8 label",
            one_record(&[1, 0xff, 0], TYPE_PTR, &[]),
            WireError::BadLabel,
        ),
        (
            "A record of 3 bytes",
            one_record(owner, 1, &[1, 2, 3]),
            WireError::BadRecord,
        ),
        (
            "PTR data longer than its name",
            one_record(owner, TYPE_PTR, &[0xc0, 12, 0]),
            WireError::BadRecord,
        ),
        (
            "TXT string beyond its record",
            one_record(owner, TYPE_TXT, &[5, b'a']),
            WireError::BadRecord,
        ),
        (
            "SRV without a target",
            one_record(owner, 33, &[0, 0, 0, 0, 0, 9]),
            WireError::BadRecord,
        ),
        (
            "trailing bytes",
            {
                let mut p = one_record(owner, TYPE_PTR, &[0xc0, 12]);
                p.push(0);
                p
            },
            WireError::TrailingBytes,
        ),
        ("oversized", vec![0; MAX_PACKET + 1], WireError::TooLarge),
    ];
    for (what, bytes, want) in cases {
        assert_eq!(decode(&bytes), Err(want), "{what}");
    }
}

#[test]
fn encoding_refuses_what_the_wire_cannot_carry() {
    let mut msg = sample();
    msg.additionals = vec![record("abc.local.", 1, RData::Txt(vec![vec![b'x'; 256]]))];
    assert_eq!(encode(&msg), Err(WireError::BadRecord));
    let mut msg = sample();
    msg.answers = vec![msg.answers[0].clone(); MAX_RECORDS + 1];
    assert_eq!(encode(&msg), Err(WireError::TooManyRecords));
    let mut msg = sample();
    msg.answers = (0..60)
        .map(|_| record("abc.local.", 1, RData::Txt(vec![vec![b'x'; 255]; 1])))
        .collect();
    assert_eq!(encode(&msg), Err(WireError::TooLarge));
    let long = vec!["a".repeat(63); 4].join(".");
    assert_eq!(Name::parse(&long), Err(WireError::NameTooLong));
}

/// xorshift64*: a fixed-seed generator so the fuzz run is reproducible.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn byte(&mut self) -> u8 {
        self.next().to_le_bytes()[0]
    }
}

#[test]
fn random_bytes_never_panic_the_parser() {
    let mut rng = Rng(0x5eed_1234_abcd_0001);
    let valid = encode(&sample()).unwrap();
    for i in 0..5000 {
        let bytes: Vec<u8> = if i % 2 == 0 {
            let len = usize::from(rng.byte()) * 4;
            (0..len).map(|_| rng.byte()).collect()
        } else {
            // Mutate a valid packet: flipped bytes and a random cut.
            let mut b = valid.clone();
            for _ in 0..(1 + rng.byte() % 8) {
                let at = usize::try_from(rng.next() % b.len() as u64).unwrap();
                b[at] = rng.byte();
            }
            let cut = usize::try_from(rng.next() % (b.len() as u64 + 1)).unwrap();
            b.truncate(cut.max(12));
            b
        };
        let _ = decode(&bytes);
    }
}
