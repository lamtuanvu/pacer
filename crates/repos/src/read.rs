//! The registry files as `src/core/repos.ts` reads them: `readJson` (`JSON.parse` of the lossy
//! UTF-8 text, `null` on any read or parse failure) and the object spread of `registry()` and
//! `aliases()`, kept in the quoted representation of `pacer-js-json`. `Registry::read` also
//! decides which registries TypeScript reads in ways this crate does not reproduce.
#[cfg(unix)]
use nix::fcntl::{FcntlArg, OFlag, fcntl};
use pacer_js_json::quoted;
use serde_json::{Map, Value};
use std::{
    fs,
    io::{ErrorKind, Read},
    path::Path,
};

/// Deepest node (root 0) a native registry read accepts.
const DEPTH: usize = 128;

/// Own properties of `Object.prototype` in Bun, which a missing registry key inherits.
const PROTOTYPE: [&str; 12] = [
    "toString",
    "toLocaleString",
    "valueOf",
    "hasOwnProperty",
    "propertyIsEnumerable",
    "isPrototypeOf",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
    "constructor",
];

/// Inputs whose TypeScript outcome is not reproduced: a lone UTF-16 surrogate, nesting deeper
/// than `DEPTH`, or a registry path that is not a regular file (reading a FIFO blocks) or whose
/// reads cannot be made blocking.
pub(crate) struct NeedsCore;

/// The regular file at `path`, open for blocking reads. It is opened `O_NONBLOCK` so a FIFO
/// cannot block the open, and the flag is cleared once `fstat` confirms a regular file, so a
/// filesystem that honors it cannot fail the read with `EAGAIN` and turn a readable registry
/// into `null`. `Ok(None)` is an open or `fstat` failure, which `readJson` reads as `null`.
fn open_regular(path: &Path) -> Result<Option<fs::File>, NeedsCore> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(OFlag::O_NONBLOCK.bits());
    }
    let Ok(file) = options.open(path) else {
        return Ok(None);
    };
    match file.metadata() {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err(NeedsCore),
        Err(_) => return Ok(None),
    }
    #[cfg(unix)]
    {
        let flags = fcntl(&file, FcntlArg::F_GETFL).map_err(|_| NeedsCore)?;
        let flags = OFlag::from_bits_retain(flags).difference(OFlag::O_NONBLOCK);
        fcntl(&file, FcntlArg::F_SETFL(flags)).map_err(|_| NeedsCore)?;
    }
    Ok(Some(file))
}

fn plain(value: &Value) -> bool {
    let lone = |text: &str| char::decode_utf16(quoted::utf16(text)).any(|c| c.is_err());
    let mut stack = vec![(value, 0)];
    while let Some((value, depth)) = stack.pop() {
        if depth > DEPTH {
            return false;
        }
        match value {
            Value::String(text) if lone(text) => return false,
            Value::Array(items) => stack.extend(items.iter().map(|item| (item, depth + 1))),
            Value::Object(map) => {
                for (key, item) in map {
                    if lone(key) {
                        return false;
                    }
                    stack.push((item, depth + 1));
                }
            }
            _ => {}
        }
    }
    true
}

/// `readJson(path)` in the quoted representation; `None` stands for its `null`. Symlinks are
/// followed, and an unreadable regular file reads as `null`, as does a directory when
/// `directory_reads_null` (a read-only caller; a write onto it fails with runtime text).
pub(crate) fn read_json(
    path: &Path,
    directory_reads_null: bool,
) -> Result<Option<Value>, NeedsCore> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(metadata) if metadata.is_dir() && directory_reads_null => return Ok(None),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        _ => return Err(NeedsCore),
    }
    let Some(mut file) = open_regular(path)? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return Ok(None);
    }
    match quoted::parse_file(&bytes) {
        Ok(value) if plain(&value) => Ok(Some(value)),
        Ok(_) => Err(NeedsCore),
        Err(error) if error == quoted::NESTING_FALLBACK => Err(NeedsCore),
        Err(_) => Ok(None),
    }
}

/// Integer-index keys, which JavaScript objects enumerate first.
pub(crate) fn index_key(key: &str) -> Option<u32> {
    key.parse::<u32>()
        .ok()
        .filter(|n| *n != u32::MAX && n.to_string() == key)
}

/// `{ ...(value ?? {}) }` in JavaScript own-key order: arrays and strings spread into index
/// keys, other primitives into nothing, and index keys come first in ascending order.
pub(crate) fn spread(value: Option<Value>) -> Map<String, Value> {
    let mut pairs: Vec<(String, Value)> = match value.filter(|value| !quoted::nonfinite(value)) {
        Some(Value::Object(map)) => map.into_iter().collect(),
        Some(Value::Array(items)) => items
            .into_iter()
            .enumerate()
            .map(|(i, item)| (i.to_string(), item))
            .collect(),
        Some(Value::String(text)) => quoted::utf16(&text)
            .into_iter()
            .enumerate()
            .map(|(i, unit)| (i.to_string(), Value::String(quoted::from_units(&[unit]))))
            .collect(),
        _ => Vec::new(),
    };
    pairs.sort_by_key(|(key, _)| index_key(key).map_or((1, 0), |n| (0, n)));
    pairs.into_iter().collect()
}

/// The text of a quoted string; lone surrogates never get here.
pub(crate) fn text(quoted: &str) -> String {
    String::from_utf16_lossy(&quoted::utf16(quoted))
}

/// The quoted form of Unicode text.
pub(crate) fn quote(text: &str) -> String {
    quoted::from_units(&text.encode_utf16().collect::<Vec<_>>())
}

/// A registry entry as `listRepos` and `labelsFor` read it.
pub(crate) struct Entry {
    /// The registry key (quoted) the entry is stored under.
    pub(crate) name: String,
    pub(crate) key: String,
    pub(crate) path: String,
    /// `Number(lastUsed)`, the sort key of `b.lastUsed - a.lastUsed`.
    pub(crate) last_used: f64,
}

impl Entry {
    /// `None` for entries TypeScript fails on with engine `TypeError` text (not an object, a
    /// `key` or `path` that is not a string, a `lastUsed` without a primitive value) and for
    /// relative paths, which it resolves against its own working directory.
    fn read(name: &str, value: &Value) -> Option<Self> {
        let field = |name: &str| value.get(name).and_then(Value::as_str);
        let path = field("path").filter(|path| path.starts_with('/'))?;
        let last_used = match value.get("lastUsed") {
            Some(last_used) => quoted::js_number(last_used)?,
            None => f64::NAN,
        };
        Some(Self {
            name: name.to_owned(),
            key: text(field("key")?),
            path: text(path),
            last_used,
        })
    }
}

/// Whether `entries.sort((a, b) => b.lastUsed - a.lastUsed)` has one outcome. A NaN
/// difference compares as equal, which is consistent only when every other key is equal too.
fn sorts_alike(entries: &[Entry]) -> bool {
    let mut numbers = entries.iter().map(|e| e.last_used).filter(|n| !n.is_nan());
    let first = numbers.next();
    entries.iter().all(|e| !e.last_used.is_nan()) || numbers.all(|n| Some(n) == first)
}

/// Sorts newest first like `b.lastUsed - a.lastUsed`, keeping the order where a NaN makes
/// every comparison equal.
pub(crate) fn newest_first(entries: &mut [&Entry]) {
    if entries.iter().all(|e| !e.last_used.is_nan()) {
        entries.sort_by(|a, b| {
            b.last_used
                .partial_cmp(&a.last_used)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
}

/// The spread registry and aliases.
pub(crate) struct Registry {
    pub(crate) reg: Map<String, Value>,
    pub(crate) aliases: Map<String, Value>,
    /// TypeScript reads these files in a way this crate does not reproduce.
    pub(crate) needs_core: bool,
}

impl Registry {
    /// Both files; a caller that `writes` the registry cannot reproduce a write onto a
    /// directory. Unreproduced content reads as `{}` with `needs_core` set.
    pub(crate) fn read(home: &Path, writes: bool) -> Self {
        let state = home.join("state");
        let mut needs_core = false;
        let mut file = |name: &str| match read_json(&state.join(name), !writes) {
            Ok(value) => spread(value),
            Err(NeedsCore) => {
                needs_core = true;
                Map::new()
            }
        };
        let reg = file("repos.json");
        let aliases = file("repo-paths.json");
        let mut registry = Self {
            reg,
            aliases,
            needs_core,
        };
        registry.needs_core |= !registry.reproduced();
        registry
    }

    fn reproduced(&self) -> bool {
        let entries: Option<Vec<Entry>> = self
            .reg
            .iter()
            .map(|(name, value)| Entry::read(name, value))
            .collect();
        let Some(entries) = entries else {
            return false;
        };
        // Only roots that can match an absolute path are looked up. A relative alias text
        // stays with TypeScript under maintainer decision Q4.
        sorts_alike(&entries)
            && self
                .aliases
                .iter()
                .filter(|(root, _)| root.starts_with('/'))
                .all(|(_, main)| match main {
                    Value::Null => true,
                    Value::String(text) if !text.starts_with('/') && !quoted::nonfinite(main) => {
                        false
                    }
                    main => quoted::js_string(main).is_some_and(|key| {
                        self.reg.contains_key(&key) || !PROTOTYPE.contains(&key.as_str())
                    }),
                })
    }

    /// The entries `listRepos` can read, in registry order; others are skipped.
    pub(crate) fn entries(&self) -> Vec<Entry> {
        self.reg
            .iter()
            .filter_map(|(name, value)| Entry::read(name, value))
            .collect()
    }

    /// `reg[aliases[root] ?? root]`, where a non-string alias names the registry key it
    /// converts to.
    fn lookup(&self, root: &str) -> Option<Entry> {
        let name = match self.aliases.get(root) {
            None | Some(Value::Null) => root.to_owned(),
            Some(main) => quoted::js_string(main)?,
        };
        Entry::read(&name, self.reg.get(&name)?)
    }

    /// `registered`: the entry of the longest registered root or linked-checkout alias that
    /// holds `real`, a canonical path.
    pub(crate) fn registered(&self, real: &str) -> Option<Entry> {
        let mut roots: Vec<&String> = self.reg.keys().chain(self.aliases.keys()).collect();
        roots.sort_by_key(|root| std::cmp::Reverse(quoted::utf16(root).len()));
        let root = roots.into_iter().find(|root| {
            let root = text(root);
            real == root || real.starts_with(&format!("{root}/"))
        })?;
        // `root ? … : undefined`: the empty root matches every path but is falsy.
        if root.is_empty() {
            return None;
        }
        self.lookup(root)
    }
}

#[cfg(all(test, unix))]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn regular_files_are_read_with_o_nonblock_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repos.json");
        fs::write(&path, "{}").unwrap();
        let Ok(Some(file)) = open_regular(&path) else {
            panic!("{path:?} did not open as a regular file");
        };
        let flags = OFlag::from_bits_retain(fcntl(&file, FcntlArg::F_GETFL).unwrap());
        assert!(!flags.contains(OFlag::O_NONBLOCK));
    }
}
