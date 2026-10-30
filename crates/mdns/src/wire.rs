//! DNS message encoding and strict decoding for mDNS (RFC 1035, RFC 6762). Decoding follows
//! compression pointers but bounds everything: packet size, records per section, name length and
//! pointer chains. Encoding never compresses.
use std::{fmt, net::Ipv4Addr};

pub const MAX_PACKET: usize = 9000;
pub const MAX_RECORDS: usize = 64;
pub const MAX_NAME: usize = 255;
const MAX_LABEL: usize = 63;
const MAX_JUMPS: usize = 32;

pub const TYPE_A: u16 = 1;
pub const TYPE_PTR: u16 = 12;
pub const TYPE_TXT: u16 = 16;
pub const TYPE_SRV: u16 = 33;
pub const TYPE_ANY: u16 = 255;
pub const CLASS_IN: u16 = 1;
/// The top class bit: cache-flush on records, unicast-response on questions (RFC 6762 §10.2, §5.4).
const CLASS_TOP: u16 = 0x8000;
const FLAG_RESPONSE: u16 = 0x8000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireError {
    TooLarge,
    Truncated,
    TooManyRecords,
    PointerLoop,
    NameTooLong,
    BadLabel,
    BadRecord,
    TrailingBytes,
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "malformed DNS message: {self:?}")
    }
}

impl std::error::Error for WireError {}

/// A domain name as UTF-8 labels, without the root label. Compared without ASCII case.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Name(Vec<String>);

impl Name {
    /// Parses a dotted name; the trailing dot is optional.
    pub fn parse(dotted: &str) -> Result<Name, WireError> {
        let trimmed = dotted.strip_suffix('.').unwrap_or(dotted);
        let labels: Vec<String> = trimmed.split('.').map(str::to_string).collect();
        Name::from_labels(labels)
    }

    pub fn from_labels(labels: Vec<String>) -> Result<Name, WireError> {
        if labels.iter().any(|l| l.is_empty() || l.len() > MAX_LABEL) {
            return Err(WireError::BadLabel);
        }
        let name = Name(labels);
        if name.wire_len() > MAX_NAME {
            return Err(WireError::NameTooLong);
        }
        Ok(name)
    }

    pub fn labels(&self) -> &[String] {
        &self.0
    }

    /// Equal without ASCII case.
    pub fn is(&self, other: &Name) -> bool {
        self.0.len() == other.0.len()
            && self
                .0
                .iter()
                .zip(&other.0)
                .all(|(a, b)| a.eq_ignore_ascii_case(b))
    }

    fn wire_len(&self) -> usize {
        self.0.iter().map(|l| l.len() + 1).sum::<usize>() + 1
    }
}

impl fmt::Display for Name {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for label in &self.0 {
            write!(f, "{label}.")?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Question {
    pub name: Name,
    pub qtype: u16,
    pub class: u16,
    /// The QU bit: the querier would accept a unicast reply. pacer always replies by multicast.
    pub unicast: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RData {
    A(Ipv4Addr),
    Ptr(Name),
    Srv {
        priority: u16,
        weight: u16,
        port: u16,
        target: Name,
    },
    /// Each entry is one character-string of at most 255 bytes.
    Txt(Vec<Vec<u8>>),
    Other {
        rtype: u16,
        data: Vec<u8>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub name: Name,
    pub class: u16,
    pub cache_flush: bool,
    pub ttl: u32,
    pub data: RData,
}

impl Record {
    pub fn rtype(&self) -> u16 {
        match &self.data {
            RData::A(_) => TYPE_A,
            RData::Ptr(_) => TYPE_PTR,
            RData::Srv { .. } => TYPE_SRV,
            RData::Txt(_) => TYPE_TXT,
            RData::Other { rtype, .. } => *rtype,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub id: u16,
    pub flags: u16,
    pub questions: Vec<Question>,
    pub answers: Vec<Record>,
    pub authorities: Vec<Record>,
    pub additionals: Vec<Record>,
}

impl Message {
    pub fn is_response(&self) -> bool {
        self.flags & FLAG_RESPONSE != 0
    }
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], WireError> {
        let end = self.pos.checked_add(n).ok_or(WireError::Truncated)?;
        let out = self.buf.get(self.pos..end).ok_or(WireError::Truncated)?;
        self.pos = end;
        Ok(out)
    }

    fn u16(&mut self) -> Result<u16, WireError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Result<u32, WireError> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn name(&mut self) -> Result<Name, WireError> {
        let (name, end) = read_name(self.buf, self.pos)?;
        self.pos = end;
        Ok(name)
    }

    fn question(&mut self) -> Result<Question, WireError> {
        let name = self.name()?;
        let qtype = self.u16()?;
        let class = self.u16()?;
        Ok(Question {
            name,
            qtype,
            class: class & !CLASS_TOP,
            unicast: class & CLASS_TOP != 0,
        })
    }

    fn record(&mut self) -> Result<Record, WireError> {
        let name = self.name()?;
        let rtype = self.u16()?;
        let class = self.u16()?;
        let ttl = self.u32()?;
        let len = usize::from(self.u16()?);
        let start = self.pos;
        let raw = self.take(len)?;
        let data = match rtype {
            TYPE_A => RData::A(Ipv4Addr::from(
                <[u8; 4]>::try_from(raw).map_err(|_| WireError::BadRecord)?,
            )),
            TYPE_PTR => RData::Ptr(name_exactly(self.buf, start, len)?),
            TYPE_SRV => {
                if len < 7 {
                    return Err(WireError::BadRecord);
                }
                let word = |i: usize| u16::from_be_bytes([raw[i], raw[i + 1]]);
                RData::Srv {
                    priority: word(0),
                    weight: word(2),
                    port: word(4),
                    target: name_exactly(self.buf, start + 6, len - 6)?,
                }
            }
            TYPE_TXT => RData::Txt(txt_entries(raw)?),
            _ => RData::Other {
                rtype,
                data: raw.to_vec(),
            },
        };
        Ok(Record {
            name,
            class: class & !CLASS_TOP,
            cache_flush: class & CLASS_TOP != 0,
            ttl,
            data,
        })
    }
}

/// A name that fills exactly `len` bytes of record data at `start`.
fn name_exactly(buf: &[u8], start: usize, len: usize) -> Result<Name, WireError> {
    let (name, end) = read_name(buf, start).map_err(|e| match e {
        WireError::Truncated => WireError::BadRecord,
        other => other,
    })?;
    if end != start + len {
        return Err(WireError::BadRecord);
    }
    Ok(name)
}

fn txt_entries(mut raw: &[u8]) -> Result<Vec<Vec<u8>>, WireError> {
    let mut out = Vec::new();
    while let Some((&len, rest)) = raw.split_first() {
        let entry = rest.get(..usize::from(len)).ok_or(WireError::BadRecord)?;
        out.push(entry.to_vec());
        raw = &rest[usize::from(len)..];
    }
    Ok(out)
}

/// Reads a possibly compressed name at `pos`; returns it and the offset just after it in place.
/// Each pointer must point before the segment it is read from, so a chain cannot loop.
fn read_name(buf: &[u8], mut pos: usize) -> Result<(Name, usize), WireError> {
    let mut labels = Vec::new();
    let mut wire_len = 1;
    let mut end = None;
    let mut segment = pos;
    let mut jumps = 0;
    loop {
        let len = *buf.get(pos).ok_or(WireError::Truncated)?;
        match len & 0xc0 {
            0x00 if len == 0 => {
                return Ok((Name(labels), end.unwrap_or(pos + 1)));
            }
            0x00 => {
                let n = usize::from(len);
                let label = buf.get(pos + 1..pos + 1 + n).ok_or(WireError::Truncated)?;
                wire_len += n + 1;
                if wire_len > MAX_NAME {
                    return Err(WireError::NameTooLong);
                }
                let label = std::str::from_utf8(label).map_err(|_| WireError::BadLabel)?;
                labels.push(label.to_string());
                pos += n + 1;
            }
            0xc0 => {
                let low = *buf.get(pos + 1).ok_or(WireError::Truncated)?;
                let target = usize::from(len & 0x3f) << 8 | usize::from(low);
                end.get_or_insert(pos + 2);
                jumps += 1;
                if target >= segment || jumps > MAX_JUMPS {
                    return Err(WireError::PointerLoop);
                }
                segment = target;
                pos = target;
            }
            _ => return Err(WireError::BadLabel),
        }
    }
}

pub fn decode(buf: &[u8]) -> Result<Message, WireError> {
    if buf.len() > MAX_PACKET {
        return Err(WireError::TooLarge);
    }
    let mut r = Reader { buf, pos: 0 };
    let id = r.u16()?;
    let flags = r.u16()?;
    let mut counts = [0usize; 4];
    for count in &mut counts {
        *count = usize::from(r.u16()?);
        if *count > MAX_RECORDS {
            return Err(WireError::TooManyRecords);
        }
    }
    let questions = (0..counts[0])
        .map(|_| r.question())
        .collect::<Result<_, _>>()?;
    let mut sections = [Vec::new(), Vec::new(), Vec::new()];
    for (section, &count) in sections.iter_mut().zip(&counts[1..]) {
        *section = (0..count).map(|_| r.record()).collect::<Result<_, _>>()?;
    }
    if r.pos != buf.len() {
        return Err(WireError::TrailingBytes);
    }
    let [answers, authorities, additionals] = sections;
    Ok(Message {
        id,
        flags,
        questions,
        answers,
        authorities,
        additionals,
    })
}

fn put_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn put_name(out: &mut Vec<u8>, name: &Name) -> Result<(), WireError> {
    if name.wire_len() > MAX_NAME {
        return Err(WireError::NameTooLong);
    }
    for label in &name.0 {
        let len = u8::try_from(label.len())
            .ok()
            .filter(|&l| l != 0 && usize::from(l) <= MAX_LABEL)
            .ok_or(WireError::BadLabel)?;
        out.push(len);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    Ok(())
}

fn put_record(out: &mut Vec<u8>, r: &Record) -> Result<(), WireError> {
    put_name(out, &r.name)?;
    put_u16(out, r.rtype());
    put_u16(out, r.class | if r.cache_flush { CLASS_TOP } else { 0 });
    out.extend_from_slice(&r.ttl.to_be_bytes());
    let mut data = Vec::new();
    match &r.data {
        RData::A(ip) => data.extend_from_slice(&ip.octets()),
        RData::Ptr(name) => put_name(&mut data, name)?,
        RData::Srv {
            priority,
            weight,
            port,
            target,
        } => {
            for v in [*priority, *weight, *port] {
                put_u16(&mut data, v);
            }
            put_name(&mut data, target)?;
        }
        RData::Txt(entries) => {
            for entry in entries {
                data.push(u8::try_from(entry.len()).map_err(|_| WireError::BadRecord)?);
                data.extend_from_slice(entry);
            }
        }
        RData::Other { data: raw, .. } => data.extend_from_slice(raw),
    }
    put_u16(
        out,
        u16::try_from(data.len()).map_err(|_| WireError::TooLarge)?,
    );
    out.extend_from_slice(&data);
    Ok(())
}

pub fn encode(msg: &Message) -> Result<Vec<u8>, WireError> {
    let counts = [
        msg.questions.len(),
        msg.answers.len(),
        msg.authorities.len(),
        msg.additionals.len(),
    ];
    let mut out = Vec::with_capacity(512);
    put_u16(&mut out, msg.id);
    put_u16(&mut out, msg.flags);
    for count in counts {
        if count > MAX_RECORDS {
            return Err(WireError::TooManyRecords);
        }
        put_u16(
            &mut out,
            u16::try_from(count).map_err(|_| WireError::TooManyRecords)?,
        );
    }
    for q in &msg.questions {
        put_name(&mut out, &q.name)?;
        put_u16(&mut out, q.qtype);
        put_u16(&mut out, q.class | if q.unicast { CLASS_TOP } else { 0 });
    }
    for r in msg
        .answers
        .iter()
        .chain(&msg.authorities)
        .chain(&msg.additionals)
    {
        put_record(&mut out, r)?;
    }
    if out.len() > MAX_PACKET {
        return Err(WireError::TooLarge);
    }
    Ok(out)
}
