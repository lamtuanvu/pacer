//! Read-only SSH alias discovery for supported local config files.

use pacer_foundation::{
    Ctx,
    api::{
        error::{Code, CoreError},
        registry::NativeOp,
    },
};
use rustix::{
    fs::{CWD, Mode, OFlags, openat},
    io::Errno,
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use crate::routing::host_targets;

const MAX_SSH_BYTES: u64 = 64 * 1024;
const MAX_SSH_FILES: usize = 128;

fn words(line: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;
    for ch in line.chars() {
        if escaped {
            word.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(expected) = quote {
            if ch == expected {
                quote = None;
            } else {
                word.push(ch);
            }
            continue;
        }
        if matches!(ch, '"' | '\'') {
            quote = Some(ch);
            continue;
        }
        if ch == '#' {
            break;
        }
        if ch.is_whitespace() {
            if !word.is_empty() {
                result.push(std::mem::take(&mut word));
            }
        } else {
            word.push(ch);
        }
    }
    if !word.is_empty() {
        result.push(word);
    }
    result
}

fn directive(line: &str) -> Option<(&str, &str)> {
    let line = line.trim_start();
    for name in ["Host", "Include"] {
        let Some(prefix) = line.get(..name.len()) else {
            continue;
        };
        if !prefix.eq_ignore_ascii_case(name) {
            continue;
        }
        let tail = &line[name.len()..];
        if let Some(rest) = tail.strip_prefix('=') {
            return Some((name, rest.trim_start()));
        }
        if tail.chars().next().is_some_and(char::is_whitespace) {
            let rest = tail.trim_start();
            return Some((name, rest.strip_prefix('=').unwrap_or(rest).trim_start()));
        }
    }
    None
}

struct Reader<'a> {
    home: &'a Path,
    ssh: PathBuf,
    aliases: Vec<String>,
    seen: HashSet<String>,
    active: HashSet<PathBuf>,
    files: usize,
}
impl Reader<'_> {
    fn open_file(&self, path: &Path) -> Result<Option<File>, ()> {
        let relative = path.strip_prefix(self.home).map_err(|_| ())?;
        let mut dir = match openat(
            CWD,
            self.home,
            OFlags::RDONLY
                | OFlags::DIRECTORY
                | OFlags::NOFOLLOW
                | OFlags::CLOEXEC
                | OFlags::NONBLOCK,
            Mode::empty(),
        ) {
            Ok(dir) => dir,
            Err(Errno::NOENT) => return Ok(None),
            Err(_) => return Err(()),
        };
        let mut parts = relative.components().peekable();
        while let Some(part) = parts.next() {
            let std::path::Component::Normal(name) = part else {
                return Err(());
            };
            if parts.peek().is_some() {
                dir = match openat(
                    &dir,
                    name,
                    OFlags::RDONLY
                        | OFlags::DIRECTORY
                        | OFlags::NOFOLLOW
                        | OFlags::CLOEXEC
                        | OFlags::NONBLOCK,
                    Mode::empty(),
                ) {
                    Ok(next) => next,
                    Err(Errno::NOENT) => return Ok(None),
                    Err(_) => return Err(()),
                };
            } else {
                let fd = match openat(
                    &dir,
                    name,
                    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
                    Mode::empty(),
                ) {
                    Ok(fd) => fd,
                    Err(Errno::NOENT) => return Ok(None),
                    Err(_) => return Err(()),
                };
                let file = File::from(fd);
                let meta = file.metadata().map_err(|_| ())?;
                if !meta.is_file() || meta.len() > MAX_SSH_BYTES {
                    return Err(());
                }
                return Ok(Some(file));
            }
        }
        Err(())
    }

    fn visit(&mut self, path: PathBuf, depth: usize) -> Result<(), ()> {
        if depth > 8 || self.active.contains(&path) {
            return Ok(());
        }
        self.files += 1;
        if self.files > MAX_SSH_FILES {
            return Err(());
        }
        let Some(file) = self.open_file(&path)? else {
            return Ok(());
        };
        let mut bytes = Vec::new();
        file.take(MAX_SSH_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        if bytes.len() as u64 > MAX_SSH_BYTES {
            return Err(());
        }
        // JavaScript's \s and Unicode token handling exceed this ASCII subset.
        if !bytes.is_ascii() {
            return Err(());
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| ())?;
        self.active.insert(path.clone());
        let result = (|| {
            for line in text.split('\n') {
                let Some((name, tail)) = directive(line) else {
                    continue;
                };
                for value in words(tail) {
                    if name == "Host" {
                        if value.contains(['*', '?', '!']) {
                            continue;
                        }
                        if self.seen.insert(value.clone()) {
                            self.aliases.push(value);
                        }
                    } else {
                        let include = self.include(&value)?;
                        self.visit(include, depth + 1)?;
                    }
                }
            }
            Ok(())
        })();
        self.active.remove(&path);
        result
    }

    fn include(&self, value: &str) -> Result<PathBuf, ()> {
        if value.is_empty() || value.contains(['*', '?', '[', ']']) {
            return Err(());
        }
        let (base, suffix) = if let Some(suffix) = value.strip_prefix("~/") {
            (self.home, suffix)
        } else if Path::new(value).is_absolute() {
            return Err(());
        } else {
            (self.ssh.as_path(), value)
        };
        if suffix
            .split('/')
            .any(|part| matches!(part, "" | "." | ".."))
        {
            return Err(());
        }
        Ok(base.join(suffix))
    }
}

fn aliases(home: &Path) -> Result<Vec<String>, ()> {
    let ssh = home.join(".ssh");
    let mut reader = Reader {
        home,
        ssh: ssh.clone(),
        aliases: Vec::new(),
        seen: HashSet::new(),
        active: HashSet::new(),
        files: 0,
    };
    reader.visit(ssh.join("config"), 0)?;
    Ok(reader.aliases)
}

fn load(ctx: &Ctx) -> Option<Value> {
    let used = host_targets(ctx)?;
    let aliases = aliases(&ctx.home).ok()?;
    Some(json!(
        aliases
            .into_iter()
            .filter(|alias| !used.contains(alias))
            .collect::<Vec<_>>()
    ))
}

pub fn requires_core_host_suggest_parser(ctx: &Ctx) -> bool {
    load(ctx).is_none()
}

pub fn host_suggest(ctx: &Ctx) -> Result<Value, CoreError> {
    load(ctx).ok_or_else(|| CoreError::new(Code::Conflict, "host suggestions changed during read"))
}

fn suggest(ctx: &Ctx, params: Value) -> pacer_foundation::api::registry::OpFuture<'_> {
    Box::pin(async move {
        if !params.is_object() && !params.is_null() {
            let received = match params {
                Value::Array(_) => "array",
                Value::String(_) => "string",
                Value::Number(_) => "number",
                Value::Bool(_) => "boolean",
                _ => "unknown",
            };
            return Err(CoreError::new(
                Code::InvalidInput,
                format!("params: Invalid input: expected object, received {received}"),
            ));
        }
        host_suggest(ctx)
    })
}

pub fn ops() -> &'static [NativeOp] {
    &[NativeOp {
        name: "host.suggest",
        call: suggest,
    }]
}
