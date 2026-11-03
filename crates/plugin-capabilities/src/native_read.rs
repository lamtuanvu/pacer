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
            let normalized = crate::authority::normalize_path(&resource.path);
            let path = Path::new(&normalized);
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
                    normalized.clone()
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
        let path = params["path"]
            .as_str()
            .ok_or(BrokerError::Invalid("path"))?;
        crate::authority::valid_path(path)?;
        let path = crate::authority::normalize_path(path);
        let mut normalized = params.clone();
        normalized["path"] = json!(path);
        let params = &normalized;
        let path = path.as_str();
        if let Some(image) = self.images.iter().find(|i| i.path == path) {
            return Self::answer_image(image, method, params);
        }
        let root = self
            .directories
            .iter()
            .find(|i| {
                Path::new(path).starts_with(&i.path)
                    && (crate::authority::rollout_path(path)
                        || (path == i.path && method == "capability.fs.stat"))
            })
            .ok_or(BrokerError::Invalid("read path was not issued"))?;
        check_root(root)?;
        let Some(canonical) = root.parent.as_ref() else {
            return Ok(json!({"missing":true}));
        };
        if path == root.path {
            if method != "capability.fs.stat" {
                return Err(BrokerError::Invalid("root bytes were not issued"));
            }
            let metadata = fs::symlink_metadata(canonical)
                .map_err(|_| BrokerError::Invalid("read root changed"))?;
            check_root(root)?;
            return Ok(json!({"info":info(path,&metadata)}));
        }
        let relative = Path::new(path)
            .strip_prefix(&root.path)
            .map_err(|_| BrokerError::Invalid("read path escaped root"))?;
        let mut held = open_directory(canonical)?;
        let mut parent_path = canonical.clone();
        for part in relative
            .parent()
            .ok_or(BrokerError::Invalid("read parent"))?
            .iter()
        {
            let next = match Dir::openat(&held, Path::new(part), directory_flags(), Mode::empty()) {
                Ok(dir) => dir,
                Err(nix::errno::Errno::ENOENT) => {
                    check_root(root)?;
                    return Ok(json!({"missing":true}));
                }
                Err(_) => return Err(BrokerError::Invalid("read ancestor changed")),
            };
            held = next;
            parent_path.push(part);
        }
        let metadata = fs::symlink_metadata(&parent_path)
            .map_err(|_| BrokerError::Invalid("read parent changed"))?;
        let opened = fstat(&held).map_err(|_| BrokerError::Invalid("read parent changed"))?;
        if metadata.dev() != device_id(opened.st_dev) || metadata.ino() != opened.st_ino {
            return Err(BrokerError::Invalid("read parent changed"));
        }
        let image = Image {
            path: path.into(),
            logical_parent: Path::new(path)
                .parent()
                .ok_or(BrokerError::Invalid("read parent"))?
                .into(),
            parent: Some(parent_path),
            parent_identity: Some(metadata),
        };
        let result = Self::answer_image(&image, method, params);
        check_root(root)?;
        result
    }
    fn answer_image(image: &Image, method: &str, params: &Value) -> Result<Value, BrokerError> {
        let path = image.path.as_str();
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

use pacer_bun_glob::{ScanPattern, matches_visible, may_descend};
fn expand_braces(input: &str, deadline: Instant) -> Result<Vec<ScanPattern>, BrokerError> {
    pacer_bun_glob::expand_braces(input, deadline).map_err(|_| BrokerError::Timeout)
}
pub fn matches_bun_scope(pattern: &str, path: &str) -> Result<bool, BrokerError> {
    pacer_bun_glob::matches_bun_scope(pattern, path).map_err(|_| BrokerError::Timeout)
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
