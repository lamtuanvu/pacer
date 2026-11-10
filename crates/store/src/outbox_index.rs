//! Process-local offsets and discovery aggregates for the retained durable log.
use crate::outbox::parse_outbox_event;
use pacer_foundation::Ctx;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs::{File, Metadata},
    io::{self, Read, Seek, SeekFrom},
    os::unix::fs::MetadataExt,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

#[derive(Clone, PartialEq)]
struct Signature {
    device: u64,
    inode: u64,
    size: u64,
    modified: i128,
}
impl Signature {
    fn new(meta: &Metadata) -> Self {
        Self {
            device: meta.dev(),
            inode: meta.ino(),
            size: meta.len(),
            modified: meta.mtime() as i128 * 1_000_000_000 + meta.mtime_nsec() as i128,
        }
    }
    #[cfg(test)]
    fn with_metadata(self, meta: &Metadata) -> Self {
        Self::new(meta)
    }
}
#[derive(Default)]
struct Index {
    signature: Option<Signature>,
    rows: Vec<(f64, u64)>,
    first: Option<(u64, Vec<u8>)>,
    last: Option<(u64, Vec<u8>)>,
    open: HashSet<String>,
    at: HashMap<i64, usize>,
    complete: bool,
    nonmonotonic: bool,
}
fn bytes(file: &mut File, start: u64, end: u64) -> io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(start))?;
    let mut data = Vec::new();
    file.take(end.saturating_sub(start))
        .read_to_end(&mut data)?;
    Ok(data)
}
fn parse(line: &[u8]) -> Option<Value> {
    let raw: Value = serde_json::from_str(&String::from_utf8_lossy(line)).ok()?;
    if raw.get("seq")?.as_f64()? <= 0.0 {
        return None;
    }
    let envelope = parse_outbox_event(raw.get("envelope")?)?;
    let mut row = json!({"seq":raw["seq"],"envelope":envelope});
    if raw.get("at").is_some_and(Value::is_number) {
        row["at"] = raw["at"].clone();
    }
    Some(row)
}
impl Index {
    fn unchanged(&self, file: &mut File) -> io::Result<bool> {
        for (offset, line) in [&self.first, &self.last].into_iter().flatten() {
            if bytes(file, *offset, *offset + line.len() as u64)? != *line {
                return Ok(false);
            }
        }
        Ok(true)
    }
    fn refresh(&mut self, file: &mut File) -> io::Result<()> {
        let signature = Signature::new(&file.metadata()?);
        let same = self.signature.as_ref().is_some_and(|old| {
            old.device == signature.device
                && old.inode == signature.inode
                && old.size <= signature.size
                && (old.size != signature.size || old.modified == signature.modified)
        });
        if !same || !self.complete || !self.unchanged(file)? {
            *self = Self::default();
        }
        let start = self.signature.as_ref().map_or(0, |s| s.size);
        // Cap at the observed size: a racing append belongs to the next refresh.
        let data = bytes(file, start, signature.size)?;
        let mut offset = start;
        for line in data.split_inclusive(|b| *b == b'\n') {
            if self.first.is_none() {
                self.first = Some((offset, line.to_vec()));
            }
            self.last = Some((offset, line.to_vec()));
            if let Some(row) = parse(line) {
                let seq = row["seq"].as_f64().unwrap_or(0.0);
                if self.rows.last().is_some_and(|row| row.0 > seq) {
                    self.nonmonotonic = true;
                }
                self.rows.push((seq, offset));
                let env = &row["envelope"];
                let d = &env["data"];
                if env["type"] == "entity" {
                    if d["kind"] == "attention"
                        && let Some(id) = d["id"].as_str()
                        && (id.starts_with("discovery:") || id.starts_with("discovery-network:"))
                    {
                        if d["removed"] == true {
                            self.open.remove(id);
                        } else {
                            self.open.insert(id.to_owned());
                        }
                    }
                    if d["kind"] == "counts" {
                        self.at.insert(seq as i64, self.open.len());
                    }
                }
            }
            offset += line.len() as u64;
        }
        self.complete = signature.size == 0
            || data.last() == Some(&b'\n')
            || (data.is_empty() && self.complete);
        self.signature = Some(signature);
        Ok(())
    }
    fn oldest(&self) -> Option<f64> {
        self.rows.first().map(|r| r.0)
    }
    fn range(&self, since: f64) -> (u64, u64) {
        let end = self.signature.as_ref().map_or(0, |s| s.size);
        let row = if self.nonmonotonic {
            self.rows.iter().find(|r| r.0 > since)
        } else {
            self.rows.get(self.rows.partition_point(|r| r.0 <= since))
        };
        (row.map_or(end, |r| r.1), end)
    }
}
/// Replay metadata is copied while locked; range I/O and parsing happen unlocked.
pub struct OutboxReplay {
    pub entries: Vec<Value>,
    pub oldest: Option<f64>,
    pub discovery_at_counts: HashMap<i64, usize>,
}
pub fn read_outbox_replay(ctx: &Ctx, since: f64) -> io::Result<OutboxReplay> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Index>>> = OnceLock::new();
    let path = ctx.pacer_home.join("link/outbox.jsonl");
    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            CACHE
                .get_or_init(Default::default)
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&path);
            return Ok(OutboxReplay {
                entries: vec![],
                oldest: None,
                discovery_at_counts: HashMap::new(),
            });
        }
        Err(e) => return Err(e),
    };
    let (start, end, oldest, at) = {
        let mut cache = CACHE
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Bound homes retained by a long-lived multi-home caller.
        if cache.len() >= 64 && !cache.contains_key(&path) {
            cache.clear();
        }
        let index = cache.entry(path).or_default();
        if let Err(error) = index.refresh(&mut file) {
            *index = Index::default();
            return Err(error);
        }
        let (start, end) = index.range(since);
        let at = index
            .rows
            .iter()
            .rev()
            .take_while(|row| row.1 >= start)
            .filter_map(|row| {
                index
                    .at
                    .get(&(row.0 as i64))
                    .map(|count| (row.0 as i64, *count))
            })
            .collect();
        (start, end, index.oldest(), at)
    };
    let data = bytes(&mut file, start, end)?;
    let entries = data
        .split(|b| *b == b'\n')
        .filter_map(parse)
        .filter(|row| row["seq"].as_f64().is_some_and(|seq| seq > since))
        .collect();
    Ok(OutboxReplay {
        entries,
        oldest,
        discovery_at_counts: at,
    })
}
#[cfg(test)]
mod tests;
