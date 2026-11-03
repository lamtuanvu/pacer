//! Call-issued root snapshots for the shadow host's exact-file read methods.
//! Each request opens a no-follow descriptor and checks the observed file identity.
use crate::{BrokerError, CallAuthority, ReadResource, ScopeRoots};
use base64::{Engine, engine::general_purpose::STANDARD};
use nix::{
    dir::Dir,
    fcntl::{AtFlags, OFlag, openat},
    sys::stat::{FileStat, Mode, SFlag, fstat, fstatat},
};
use serde_json::{Value, json};
use std::{
    fs::{self, File, Metadata},
    io::{Read, Seek, SeekFrom},
    os::unix::fs::MetadataExt,
    os::{fd::AsFd, unix::ffi::OsStrExt},
    path::{Path, PathBuf},
    time::Instant,
};

const CHUNK: u64 = 256 * 1024;

struct Image {
    path: String,
    logical_parent: PathBuf,
    parent: Option<PathBuf>,
    parent_identity: Option<Metadata>,
}

/// Prepare exact file resources at call issuance, before any plugin RPC.
pub struct NativeRead {
    images: Vec<Image>,
    directories: Vec<Image>,
}

impl NativeRead {
    pub fn prepare(resources: &[ReadResource]) -> Result<Self, BrokerError> {
        let mut images = Vec::new();
        let mut directories = Vec::new();
        for resource in resources
            .iter()
            .filter(|r| r.kind == "file" || r.kind == "codex-logs")
        {
            crate::authority::valid_path(&resource.path)?;
            let path = Path::new(&resource.path);
            let logical_parent = if resource.kind == "codex-logs" {
                path
            } else {
                path.parent().ok_or(BrokerError::Invalid("read parent"))?
            };
            let (parent, parent_identity) = match fs::canonicalize(logical_parent) {
                Ok(parent) => {
                    let identity = fs::symlink_metadata(&parent)
                        .map_err(|_| BrokerError::Invalid("read root unavailable"))?;
                    if !identity.is_dir() || identity.file_type().is_symlink() {
                        return Err(BrokerError::Invalid("read root is not a directory"));
                    }
                    (Some(parent), Some(identity))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (None, None),
                Err(_) => return Err(BrokerError::Invalid("read root unavailable")),
            };
            let image = Image {
                path: if resource.kind == "codex-logs" {
                    crate::authority::normalize_path(&resource.path)
                } else {
                    resource.path.clone()
                },
                logical_parent: logical_parent.to_path_buf(),
                parent,
                parent_identity,
            };
            if resource.kind == "codex-logs" {
                directories.push(image);
            } else {
                images.push(image);
            }
        }
        Ok(Self {
            images,
            directories,
        })
    }

    pub fn list(
        &self,
        params: &Value,
        scopes: &[String],
        scope_roots: &ScopeRoots,
        authority: &CallAuthority,
        deadline: Instant,
    ) -> Result<Value, BrokerError> {
        self.list_with_hook(params, scopes, scope_roots, authority, deadline, |_| {})
    }

    fn list_with_hook(
        &self,
        params: &Value,
        scopes: &[String],
        scope_roots: &ScopeRoots,
        authority: &CallAuthority,
        deadline: Instant,
        mut on_directory: impl FnMut(&Path),
    ) -> Result<Value, BrokerError> {
        let dir = params
            .get("dir")
            .and_then(Value::as_str)
            .ok_or(BrokerError::Invalid("dir"))?;
        let image = self
            .directories
            .iter()
            .find(|i| i.path == dir)
            .ok_or(BrokerError::Invalid("read directory was not issued"))?;
        authority.active()?;
        let glob = params
            .get("glob")
            .and_then(Value::as_str)
            .ok_or(BrokerError::Invalid("glob"))?;
        if glob.is_empty()
            || crate::js_semantics::utf16_len(glob) > 4096
            || glob.starts_with('/')
            || glob.contains('\0')
            || glob
                .split(['/', '\\'])
                .any(|part| part == "." || part == "..")
        {
            return Err(BrokerError::Invalid("read glob"));
        }
        let limit = match params.get("limit") {
            None => 1000,
            Some(value) => crate::js_semantics::safe_u64(value)
                .filter(|n| (1..=1000).contains(n))
                .ok_or(BrokerError::Invalid("list limit"))? as usize,
        };
        let Some(root) = &image.parent else {
            return Ok(json!({"files":[],"complete":true}));
        };
        check_root(image)?;
        let patterns = expand_braces(glob, deadline)?;
        let root_dir = open_directory(root)?;
        if !image.parent_identity.as_ref().is_some_and(|old| {
            fstat(&root_dir)
                .is_ok_and(|now| device_id(now.st_dev) == old.dev() && now.st_ino == old.ino())
        }) {
            return Err(BrokerError::Invalid("read root changed"));
        }
        let mut stack = vec![(
            Dir::openat(&root_dir, ".", directory_flags(), Mode::empty())
                .map_err(|_| BrokerError::Invalid("read directory unavailable"))?,
            PathBuf::new(),
        )];
        let mut files: Vec<Value> = Vec::new();
        let mut total = 0usize;
        while let Some((mut directory, relative_dir)) = stack.pop() {
            on_directory(&relative_dir);
            authority.active()?;
            if Instant::now() >= deadline {
                return Err(BrokerError::Timeout);
            }
            let dir_fd = directory
                .as_fd()
                .try_clone_to_owned()
                .map_err(|_| BrokerError::Invalid("read directory unavailable"))?;
            for entry in directory.iter() {
                authority.active()?;
                if Instant::now() >= deadline {
                    return Err(BrokerError::Timeout);
                }
                let entry = entry.map_err(|_| BrokerError::Invalid("read directory changed"))?;
                let name = std::ffi::OsStr::from_bytes(entry.file_name().to_bytes());
                if name.as_bytes() == b"." || name.as_bytes() == b".." {
                    continue;
                }
                let relative = relative_dir.join(name);
                let stat = match fstatat(&dir_fd, name, AtFlags::AT_SYMLINK_NOFOLLOW) {
                    Ok(stat) => stat,
                    Err(nix::errno::Errno::ENOENT) => continue,
                    Err(_) => return Err(BrokerError::Invalid("read entry unavailable")),
                };
                let kind = SFlag::from_bits_truncate(stat.st_mode & libc::S_IFMT);
                if kind == SFlag::S_IFLNK {
                    continue;
                }
                if kind == SFlag::S_IFDIR {
                    if patterns
                        .iter()
                        .any(|pattern| may_descend(pattern, &relative))
                    {
                        let child = Dir::openat(&dir_fd, name, directory_flags(), Mode::empty())
                            .map_err(|_| BrokerError::Invalid("read directory changed"))?;
                        if !fstat(&child)
                            .is_ok_and(|now| now.st_dev == stat.st_dev && now.st_ino == stat.st_ino)
                        {
                            return Err(BrokerError::Invalid("read directory changed"));
                        }
                        stack.push((child, relative));
                    }
                    continue;
                }
                if kind != SFlag::S_IFREG {
                    continue;
                }
                if !patterns
                    .iter()
                    .any(|pattern| matches_visible(pattern, &relative))
                {
                    continue;
                }
                let Some(name) = name.to_str() else {
                    continue;
                };
                if !(name.starts_with("rollout-")
                    && name.ends_with(".jsonl")
                    && !name.contains(['\n', '\r', '\u{2028}', '\u{2029}']))
                {
                    continue;
                }
                let logical = Path::new(dir).join(&relative);
                let Some(path_str) = logical.to_str() else {
                    continue;
                };
                if !scope_roots.declares_path(scopes, path_str)? {
                    continue;
                }
                let current = fstatat(&dir_fd, name, AtFlags::AT_SYMLINK_NOFOLLOW)
                    .map_err(|_| BrokerError::Invalid("read entry changed"))?;
                if current.st_dev != stat.st_dev
                    || current.st_ino != stat.st_ino
                    || current.st_mode != stat.st_mode
                    || current.st_size != stat.st_size
                {
                    return Err(BrokerError::Invalid("read entry changed"));
                }
                check_descendant(&root_dir, &relative_dir, &dir_fd)?;
                total += 1;
                let item = stat_info(path_str, &current);
                let index = files
                    .iter()
                    .position(|old| {
                        old["mtimeMs"].as_f64().unwrap_or(0.0)
                            < item["mtimeMs"].as_f64().unwrap_or(0.0)
                    })
                    .unwrap_or(files.len());
                if index < limit {
                    files.insert(index, item);
                }
                if files.len() > limit {
                    files.pop();
                }
            }
        }
        check_root(image)?;
        for item in &files {
            let path = item["path"]
                .as_str()
                .ok_or(BrokerError::Invalid("read entry changed"))?;
            let relative = Path::new(path)
                .strip_prefix(dir)
                .map_err(|_| BrokerError::Invalid("read entry changed"))?;
            check_listed_entry(&root_dir, relative, item)?;
        }
        if Instant::now() >= deadline {
            return Err(BrokerError::Timeout);
        }
        Ok(json!({"files":files,"complete":total <= limit}))
    }

    pub fn answer(&mut self, method: &str, params: &Value) -> Result<Value, BrokerError> {
        let path = params
            .get("path")
            .and_then(Value::as_str)
            .ok_or(BrokerError::Invalid("path"))?;
        let image = self
            .images
            .iter_mut()
            .find(|i| i.path == path)
            .ok_or(BrokerError::Invalid("read path was not issued"))?;
        let Some(parent) = image.parent.as_ref() else {
            return Ok(json!({"missing":true}));
        };
        if fs::canonicalize(&image.logical_parent).ok().as_deref() != Some(parent.as_path())
            || !fs::symlink_metadata(parent).is_ok_and(|m| {
                image
                    .parent_identity
                    .as_ref()
                    .is_some_and(|old| same_root(&m, old))
            })
        {
            return Err(BrokerError::Invalid("read root changed"));
        }
        let named = Path::new(path);
        let name = named
            .file_name()
            .ok_or(BrokerError::Invalid("read file name"))?;
        let root_dir = open_directory(parent)?;
        if !image.parent_identity.as_ref().is_some_and(|old| {
            fstat(&root_dir)
                .is_ok_and(|now| device_id(now.st_dev) == old.dev() && now.st_ino == old.ino())
        }) {
            return Err(BrokerError::Invalid("read root changed"));
        }
        let current = match fstatat(&root_dir, name, AtFlags::AT_SYMLINK_NOFOLLOW) {
            Ok(current) => current,
            Err(nix::errno::Errno::ENOENT) => {
                return Ok(json!({"missing":true}));
            }
            Err(_) => return Err(BrokerError::Invalid("read target unavailable")),
        };
        if SFlag::from_bits_truncate(current.st_mode & libc::S_IFMT) != SFlag::S_IFREG {
            return Err(BrokerError::Invalid("read target is not a regular file"));
        }
        let mut file = File::from(
            openat(
                &root_dir,
                name,
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| BrokerError::Invalid("read file unavailable"))?,
        );
        let before = file
            .metadata()
            .map_err(|_| BrokerError::Invalid("read descriptor unavailable"))?;
        if !same_stat_meta(&current, &before) {
            return Err(BrokerError::Invalid("read contents changed"));
        }
        let info = info(path, &before);
        if method == "capability.fs.stat" {
            check_root(image)?;
            return Ok(json!({"info":info}));
        }
        if method == "capability.fs.read" && before.len() > CHUNK {
            check_root(image)?;
            return Ok(json!({"ranged":info}));
        }
        let (offset, length) = if method == "capability.fs.readRange" {
            let offset = params
                .get("offset")
                .and_then(crate::js_semantics::safe_u64)
                .ok_or(BrokerError::Invalid("offset"))?;
            let length = params
                .get("length")
                .and_then(crate::js_semantics::safe_u64)
                .filter(|n| *n <= CHUNK)
                .ok_or(BrokerError::Invalid("length"))?;
            let expected = params
                .get("expected")
                .ok_or(BrokerError::Invalid("expected"))?;
            if !expected_identity(expected, &before) {
                return Err(BrokerError::Invalid("expected file identity changed"));
            }
            (offset, length.min(before.len().saturating_sub(offset)))
        } else if method == "capability.fs.read" {
            (0, before.len())
        } else {
            return Err(BrokerError::Invalid("unsupported read method"));
        };
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| BrokerError::Invalid("read seek"))?;
        let mut bytes = vec![0; length as usize];
        file.read_exact(&mut bytes)
            .map_err(|_| BrokerError::Invalid("read changed"))?;
        let after = file
            .metadata()
            .map_err(|_| BrokerError::Invalid("read descriptor unavailable"))?;
        let named_after = fstatat(&root_dir, name, AtFlags::AT_SYMLINK_NOFOLLOW)
            .map_err(|_| BrokerError::Invalid("read target disappeared"))?;
        if !same(&after, &before) || !same_stat_meta(&named_after, &before) {
            return Err(BrokerError::Invalid("read changed"));
        }
        check_root(image)?;
        if method == "capability.fs.readRange" {
            Ok(json!({"base64":STANDARD.encode(bytes),"info":info}))
        } else {
            let text = String::from_utf8_lossy(&bytes);
            let result = json!({"text":text,"mtime": before.mtime() as f64 + before.mtime_nsec() as f64 / 1e9,"mode":before.mode()});
            if serde_json::to_vec(&result).is_ok_and(|v| v.len() > 768 * 1024) {
                Ok(json!({"ranged":info}))
            } else {
                Ok(result)
            }
        }
    }
}

fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.mode() == b.mode()
}

// libc uses different underlying types for these fields on macOS and Linux.
#[allow(clippy::unnecessary_cast)]
fn device_id(device: libc::dev_t) -> u64 {
    device as u64
}

#[allow(clippy::unnecessary_cast)]
fn file_mode(mode: libc::mode_t) -> u32 {
    mode as u32
}

fn same_stat_meta(stat: &FileStat, meta: &Metadata) -> bool {
    device_id(stat.st_dev) == meta.dev()
        && stat.st_ino == meta.ino()
        && stat.st_size as u64 == meta.len()
        && stat.st_mtime == meta.mtime()
        && stat.st_mtime_nsec == meta.mtime_nsec()
        && file_mode(stat.st_mode) == meta.mode()
}

fn same_root(a: &Metadata, b: &Metadata) -> bool {
    a.is_dir() && !a.file_type().is_symlink() && a.dev() == b.dev() && a.ino() == b.ino()
}

fn directory_flags() -> OFlag {
    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC
}

fn open_directory(path: &Path) -> Result<Dir, BrokerError> {
    Dir::open(path, directory_flags(), Mode::empty())
        .map_err(|_| BrokerError::Invalid("read directory changed"))
}

fn check_descendant(root: &Dir, relative: &Path, opened: &impl AsFd) -> Result<(), BrokerError> {
    let clone = root
        .as_fd()
        .try_clone_to_owned()
        .map_err(|_| BrokerError::Invalid("read directory unavailable"))?;
    let mut reachable =
        Dir::from_fd(clone).map_err(|_| BrokerError::Invalid("read directory unavailable"))?;
    for part in relative.iter() {
        reachable = Dir::openat(&reachable, part, directory_flags(), Mode::empty())
            .map_err(|_| BrokerError::Invalid("read descendant moved"))?;
    }
    let actual = fstat(opened).map_err(|_| BrokerError::Invalid("read directory unavailable"))?;
    let current = fstat(&reachable).map_err(|_| BrokerError::Invalid("read descendant moved"))?;
    if actual.st_dev != current.st_dev || actual.st_ino != current.st_ino {
        return Err(BrokerError::Invalid("read descendant moved"));
    }
    Ok(())
}

fn check_listed_entry(root: &Dir, relative: &Path, item: &Value) -> Result<(), BrokerError> {
    let parent = relative
        .parent()
        .ok_or(BrokerError::Invalid("read entry changed"))?;
    let name = relative
        .file_name()
        .ok_or(BrokerError::Invalid("read entry changed"))?;
    let mut directory = Dir::openat(root, ".", directory_flags(), Mode::empty())
        .map_err(|_| BrokerError::Invalid("read entry changed"))?;
    for part in parent.iter() {
        directory = Dir::openat(&directory, part, directory_flags(), Mode::empty())
            .map_err(|_| BrokerError::Invalid("read entry changed"))?;
    }
    let stat = fstatat(&directory, name, AtFlags::AT_SYMLINK_NOFOLLOW)
        .map_err(|_| BrokerError::Invalid("read entry changed"))?;
    if SFlag::from_bits_truncate(stat.st_mode & libc::S_IFMT) != SFlag::S_IFREG
        || crate::js_semantics::safe_u64(&item["inode"]) != Some(stat.st_ino)
        || crate::js_semantics::safe_u64(&item["device"]) != Some(device_id(stat.st_dev))
        || crate::js_semantics::safe_u64(&item["size"]) != Some(stat.st_size as u64)
        || crate::js_semantics::safe_u64(&item["mode"]) != Some(stat.st_mode as u64)
        || crate::js_semantics::finite_f64(&item["mtimeMs"])
            != Some(stat.st_mtime as f64 * 1000.0 + stat.st_mtime_nsec as f64 / 1e6)
    {
        return Err(BrokerError::Invalid("read entry changed"));
    }
    Ok(())
}

struct ScanPattern {
    glob: String,
    explicit_dot: Vec<bool>,
}

fn expand_braces(input: &str, deadline: Instant) -> Result<Vec<ScanPattern>, BrokerError> {
    expand_braces_mode(input, deadline, true)
}

pub(crate) fn matches_bun_scope(pattern: &str, path: &str) -> Result<bool, BrokerError> {
    let alternatives = expand_braces_mode(
        pattern,
        Instant::now() + std::time::Duration::from_secs(5),
        false,
    )?;
    Ok(alternatives
        .iter()
        .any(|alternative| pattern_reaches(alternative, Path::new(path), true, false)))
}

fn expand_braces_mode(
    input: &str,
    deadline: Instant,
    scan: bool,
) -> Result<Vec<ScanPattern>, BrokerError> {
    // Keep each byte's original component visibility. A dot introduced by brace
    // expansion is not an explicit dot in Bun.Glob.scan's source pattern.
    let mut source_dot = Vec::with_capacity(input.len());
    let mut component_dot = false;
    let mut at_start = true;
    for byte in input.bytes() {
        if at_start {
            component_dot = byte == b'.';
            at_start = false;
        }
        source_dot.push(component_dot);
        if byte == b'/' {
            at_start = true;
        }
    }
    let mut pending = vec![(input.to_owned(), source_dot)];
    let mut expanded = Vec::new();
    while let Some((pattern, source_dot)) = pending.pop() {
        if Instant::now() >= deadline {
            return Err(BrokerError::Timeout);
        }
        let bytes = pattern.as_bytes();
        let mut escaped = false;
        let mut bracket = false;
        let mut opening = None;
        let mut closing = None;
        let mut depth = 0usize;
        for (index, byte) in bytes.iter().copied().enumerate() {
            if escaped {
                escaped = false;
                continue;
            }
            if byte == b'\\' {
                escaped = true;
                continue;
            }
            if byte == b'[' {
                bracket = true;
                continue;
            }
            if byte == b']' {
                bracket = false;
                continue;
            }
            if bracket {
                continue;
            }
            if byte == b'{' {
                if opening.is_none() {
                    opening = Some(index);
                }
                depth += 1;
            } else if byte == b'}' && depth > 0 {
                depth -= 1;
                if depth == 0 {
                    closing = Some(index);
                    break;
                }
            }
        }
        let (Some(start), Some(end)) = (opening, closing) else {
            let mut explicit_dot = Vec::new();
            let mut at_start = true;
            for (index, byte) in pattern.bytes().enumerate() {
                if at_start {
                    explicit_dot.push(source_dot[index]);
                    at_start = false;
                }
                if byte == b'/' {
                    at_start = true;
                }
            }
            expanded.push(ScanPattern {
                glob: pattern,
                explicit_dot,
            });
            continue;
        };
        // Bun.Glob.scan does not enumerate patterns whose brace expression
        // spans path components, even when another alternative has no slash.
        if scan && bytes[start..=end].contains(&b'/') {
            return Ok(Vec::new());
        }
        let mut start_alt = start + 1;
        let mut depth = 0usize;
        let mut escaped = false;
        let mut bracket = false;
        for index in start + 1..=end {
            let byte = bytes[index];
            if escaped {
                escaped = false;
                continue;
            }
            if byte == b'\\' {
                escaped = true;
                continue;
            }
            if byte == b'[' {
                bracket = true;
                continue;
            }
            if byte == b']' {
                bracket = false;
                continue;
            }
            if bracket {
                continue;
            }
            if byte == b'{' {
                depth += 1;
            }
            if byte == b'}' && index != end {
                depth -= 1;
            }
            if index == end || (byte == b',' && depth == 0) {
                let next = format!(
                    "{}{}{}",
                    &pattern[..start],
                    &pattern[start_alt..index],
                    &pattern[end + 1..]
                );
                let mut next_source = Vec::with_capacity(next.len());
                next_source.extend_from_slice(&source_dot[..start]);
                next_source.extend_from_slice(&source_dot[start_alt..index]);
                next_source.extend_from_slice(&source_dot[end + 1..]);
                pending.push((next, next_source));
                start_alt = index + 1;
            }
        }
    }
    Ok(expanded)
}

// Match one Bun glob component. Adjacent stars are ordinary wildcards and a
// backslash escapes the following character, including a literal star.
fn component_matches(pattern: &str, value: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let value: Vec<char> = value.chars().collect();
    let mut memo = vec![vec![None; value.len() + 1]; pattern.len() + 1];
    fn matches(
        p: &[char],
        v: &[char],
        pi: usize,
        vi: usize,
        memo: &mut [Vec<Option<bool>>],
    ) -> bool {
        if let Some(result) = memo[pi][vi] {
            return result;
        }
        let result = if pi == p.len() {
            vi == v.len()
        } else {
            match p[pi] {
                '*' => {
                    matches(p, v, pi + 1, vi, memo)
                        || (vi < v.len() && matches(p, v, pi, vi + 1, memo))
                }
                '?' => vi < v.len() && matches(p, v, pi + 1, vi + 1, memo),
                '\\' => {
                    pi + 1 < p.len()
                        && vi < v.len()
                        && p[pi + 1] == v[vi]
                        && matches(p, v, pi + 2, vi + 1, memo)
                }
                '[' => {
                    let end = p[pi + 1..]
                        .iter()
                        .position(|c| *c == ']')
                        .map(|i| pi + 1 + i);
                    if let Some(end) = end {
                        let start = pi + 1;
                        let negated = matches!(p.get(start), Some('!' | '^'));
                        let mut i = start + usize::from(negated);
                        let mut found = false;
                        while i < end {
                            if i + 2 < end && p[i + 1] == '-' {
                                found |= vi < v.len() && p[i] <= v[vi] && v[vi] <= p[i + 2];
                                i += 3;
                            } else {
                                found |= vi < v.len() && p[i] == v[vi];
                                i += 1;
                            }
                        }
                        vi < v.len() && (found != negated) && matches(p, v, end + 1, vi + 1, memo)
                    } else {
                        vi < v.len() && v[vi] == '[' && matches(p, v, pi + 1, vi + 1, memo)
                    }
                }
                literal => vi < v.len() && literal == v[vi] && matches(p, v, pi + 1, vi + 1, memo),
            }
        };
        memo[pi][vi] = Some(result);
        result
    }
    matches(&pattern, &value, 0, 0, &mut memo)
}

fn pattern_reaches(pattern: &ScanPattern, path: &Path, complete: bool, scan: bool) -> bool {
    let patterns: Vec<_> = if scan {
        pattern
            .glob
            .split('/')
            .filter(|part| !part.is_empty())
            .collect()
    } else {
        pattern
            .glob
            .split('/')
            .skip(usize::from(pattern.glob.starts_with('/')))
            .collect()
    };
    let parts: Vec<_> = path
        .components()
        .filter_map(|part| match part {
            std::path::Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect();
    fn reachable(
        patterns: &[&str],
        explicit_dot: &[bool],
        parts: &[&str],
        pi: usize,
        di: usize,
        complete: bool,
        scan: bool,
    ) -> bool {
        if di == parts.len() {
            return if complete {
                patterns[pi..].iter().all(|part| *part == "**")
            } else {
                pi < patterns.len()
            };
        }
        if pi >= patterns.len() {
            return false;
        }
        if patterns[pi] == "**" {
            return reachable(patterns, explicit_dot, parts, pi + 1, di, complete, scan)
                || ((!scan || !parts[di].starts_with('.'))
                    && reachable(patterns, explicit_dot, parts, pi, di + 1, complete, scan));
        }
        (!scan || !parts[di].starts_with('.') || explicit_dot.get(pi) == Some(&true))
            && component_matches(patterns[pi], parts[di])
            && reachable(
                patterns,
                explicit_dot,
                parts,
                pi + 1,
                di + 1,
                complete,
                scan,
            )
    }
    reachable(
        &patterns,
        &pattern.explicit_dot,
        &parts,
        0,
        0,
        complete,
        scan,
    )
}

fn may_descend(pattern: &ScanPattern, directory: &Path) -> bool {
    pattern_reaches(pattern, directory, false, true)
}

fn matches_visible(pattern: &ScanPattern, file: &Path) -> bool {
    pattern_reaches(pattern, file, true, true)
}

fn check_root(image: &Image) -> Result<(), BrokerError> {
    let Some(parent) = image.parent.as_ref() else {
        return Ok(());
    };
    if fs::canonicalize(&image.logical_parent).ok().as_deref() != Some(parent.as_path())
        || !fs::symlink_metadata(parent).is_ok_and(|m| {
            image
                .parent_identity
                .as_ref()
                .is_some_and(|old| same_root(&m, old))
        })
    {
        return Err(BrokerError::Invalid("read root changed"));
    }
    Ok(())
}

fn info(path: &str, meta: &Metadata) -> Value {
    json!({"path":path,"size":meta.len(),"mtimeMs":meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1e6,
        "inode":meta.ino(),"device":meta.dev(),"mode":meta.mode()})
}

fn stat_info(path: &str, stat: &FileStat) -> Value {
    let (seconds, nanos) = (stat.st_mtime, stat.st_mtime_nsec);
    json!({"path":path,"size":stat.st_size,"mtimeMs":seconds as f64 * 1000.0 + nanos as f64 / 1e6,
        "inode":stat.st_ino,"device":stat.st_dev,"mode":stat.st_mode})
}

fn expected_identity(value: &Value, meta: &Metadata) -> bool {
    value.get("size").and_then(crate::js_semantics::safe_u64) == Some(meta.len())
        && value.get("inode").and_then(crate::js_semantics::safe_u64) == Some(meta.ino())
        && value.get("device").and_then(crate::js_semantics::safe_u64) == Some(meta.dev())
        && value
            .get("mtimeMs")
            .and_then(crate::js_semantics::finite_f64)
            == Some(meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1e6)
        && value
            .get("mode")
            .is_none_or(|v| crate::js_semantics::safe_u64(v) == Some(meta.mode() as u64))
}

#[cfg(test)]
mod tests;
