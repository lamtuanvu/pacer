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
                path: resource.path.clone(),
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
            || glob.len() > 4096
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
            Some(value) => value
                .as_u64()
                .filter(|n| (1..=1000).contains(n))
                .ok_or(BrokerError::Invalid("list limit"))? as usize,
        };
        let Some(root) = &image.parent else {
            return Ok(json!({"files":[],"complete":true}));
        };
        check_root(image)?;
        let patterns = expand_braces(glob, deadline)?;
        for pattern in &patterns {
            glob::Pattern::new(pattern).map_err(|_| BrokerError::Invalid("read glob"))?;
        }
        let root_dir = open_directory(root)?;
        if !image.parent_identity.as_ref().is_some_and(|old| {
            fstat(&root_dir)
                .is_ok_and(|now| now.st_dev as u64 == old.dev() && now.st_ino == old.ino())
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
                if !(name.starts_with("rollout-") && name.ends_with(".jsonl")) {
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
                .is_ok_and(|now| now.st_dev as u64 == old.dev() && now.st_ino == old.ino())
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
                .and_then(Value::as_u64)
                .ok_or(BrokerError::Invalid("offset"))?;
            let length = params
                .get("length")
                .and_then(Value::as_u64)
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

fn same_stat_meta(stat: &FileStat, meta: &Metadata) -> bool {
    stat.st_dev as u64 == meta.dev()
        && stat.st_ino == meta.ino()
        && stat.st_size as u64 == meta.len()
        && stat.st_mtime == meta.mtime()
        && stat.st_mtime_nsec == meta.mtime_nsec()
        && stat.st_mode as u32 == meta.mode()
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
        || item["inode"].as_u64() != Some(stat.st_ino)
        || item["device"].as_u64() != Some(stat.st_dev as u64)
        || item["size"].as_u64() != Some(stat.st_size as u64)
        || item["mode"].as_u64() != Some(stat.st_mode as u64)
        || item["mtimeMs"].as_f64()
            != Some(stat.st_mtime as f64 * 1000.0 + stat.st_mtime_nsec as f64 / 1e6)
    {
        return Err(BrokerError::Invalid("read entry changed"));
    }
    Ok(())
}

fn expand_braces(input: &str, deadline: Instant) -> Result<Vec<String>, BrokerError> {
    let mut pending = vec![input.to_owned()];
    let mut expanded = Vec::new();
    while let Some(pattern) = pending.pop() {
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
            expanded.push(pattern);
            continue;
        };
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
                pending.push(format!(
                    "{}{}{}",
                    &pattern[..start],
                    &pattern[start_alt..index],
                    &pattern[end + 1..]
                ));
                start_alt = index + 1;
            }
        }
    }
    Ok(expanded)
}

fn pattern_reaches(glob: &str, path: &Path, complete: bool) -> bool {
    let patterns: Vec<_> = glob.split('/').collect();
    let parts: Vec<_> = path.iter().filter_map(|part| part.to_str()).collect();
    fn reachable(patterns: &[&str], parts: &[&str], pi: usize, di: usize, complete: bool) -> bool {
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
            return reachable(patterns, parts, pi + 1, di, complete)
                || (!parts[di].starts_with('.')
                    && reachable(patterns, parts, pi, di + 1, complete));
        }
        (!parts[di].starts_with('.') || patterns[pi].starts_with('.'))
            && glob::Pattern::new(patterns[pi]).is_ok_and(|p| p.matches(parts[di]))
            && reachable(patterns, parts, pi + 1, di + 1, complete)
    }
    reachable(&patterns, &parts, 0, 0, complete)
}

fn may_descend(glob: &str, directory: &Path) -> bool {
    pattern_reaches(glob, directory, false)
}

fn matches_visible(glob: &str, file: &Path) -> bool {
    pattern_reaches(glob, file, true)
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
    value.get("size").and_then(Value::as_u64) == Some(meta.len())
        && value.get("inode").and_then(Value::as_u64) == Some(meta.ino())
        && value.get("device").and_then(Value::as_u64) == Some(meta.dev())
        && value.get("mtimeMs").and_then(Value::as_f64)
            == Some(meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1e6)
        && value
            .get("mode")
            .is_none_or(|v| v.as_u64() == Some(meta.mode() as u64))
}

#[cfg(test)]
mod tests;
