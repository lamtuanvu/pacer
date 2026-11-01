//! Call-issued root snapshots for the shadow host's exact-file read methods.
//! Each request opens a no-follow descriptor and checks the observed file identity.
use crate::{BrokerError, CallAuthority, ReadResource, ScopeRoots};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    fs::{self, Metadata, OpenOptions},
    io::{Read, Seek, SeekFrom},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
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
        let pattern = glob::Pattern::new(glob).map_err(|_| BrokerError::Invalid("read glob"))?;
        let mut stack = vec![(
            root.clone(),
            image
                .parent_identity
                .as_ref()
                .ok_or(BrokerError::Invalid("read root unavailable"))?
                .clone(),
        )];
        let mut files: Vec<Value> = Vec::new();
        let mut total = 0usize;
        while let Some((directory, identity)) = stack.pop() {
            authority.active()?;
            if Instant::now() >= deadline {
                return Err(BrokerError::Timeout);
            }
            if !fs::symlink_metadata(&directory).is_ok_and(|m| same_root(&m, &identity)) {
                return Err(BrokerError::Invalid("read directory changed"));
            }
            let entries = fs::read_dir(&directory)
                .map_err(|_| BrokerError::Invalid("read directory unavailable"))?;
            for entry in entries {
                authority.active()?;
                if Instant::now() >= deadline {
                    return Err(BrokerError::Timeout);
                }
                let entry = entry.map_err(|_| BrokerError::Invalid("read directory changed"))?;
                let path = entry.path();
                let meta = match fs::symlink_metadata(&path) {
                    Ok(meta) => meta,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(_) => return Err(BrokerError::Invalid("read entry unavailable")),
                };
                if meta.file_type().is_symlink() {
                    continue;
                }
                if meta.is_dir() {
                    stack.push((path, meta));
                    continue;
                }
                if !meta.is_file() {
                    continue;
                }
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| BrokerError::Invalid("read entry escaped"))?;
                if !pattern.matches_path_with(
                    relative,
                    glob::MatchOptions {
                        require_literal_separator: true,
                        ..Default::default()
                    },
                ) {
                    continue;
                }
                let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                    continue;
                };
                if !(name.starts_with("rollout-") && name.ends_with(".jsonl")) {
                    continue;
                }
                let logical = Path::new(dir).join(relative);
                let Some(path_str) = logical.to_str() else {
                    continue;
                };
                if !scope_roots.declares_path(scopes, path_str)? {
                    continue;
                }
                let current = fs::symlink_metadata(&path)
                    .map_err(|_| BrokerError::Invalid("read entry changed"))?;
                if !same(&meta, &current) {
                    return Err(BrokerError::Invalid("read entry changed"));
                }
                total += 1;
                let item = info(path_str, &meta);
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
            if !fs::symlink_metadata(&directory).is_ok_and(|m| same_root(&m, &identity)) {
                return Err(BrokerError::Invalid("read directory changed"));
            }
        }
        check_root(image)?;
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
        let current = match fs::symlink_metadata(named) {
            Ok(current) => current,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(json!({"missing":true}));
            }
            Err(_) => return Err(BrokerError::Invalid("read target unavailable")),
        };
        if !current.is_file() || current.file_type().is_symlink() {
            return Err(BrokerError::Invalid("read target is not a regular file"));
        }
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(named)
            .map_err(|_| BrokerError::Invalid("read file unavailable"))?;
        let before = file
            .metadata()
            .map_err(|_| BrokerError::Invalid("read descriptor unavailable"))?;
        if !same(&before, &current) {
            return Err(BrokerError::Invalid("read contents changed"));
        }
        let info = info(path, &before);
        if method == "capability.fs.stat" {
            return Ok(json!({"info":info}));
        }
        if method == "capability.fs.read" && before.len() > CHUNK {
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
        let named_after = fs::symlink_metadata(named)
            .map_err(|_| BrokerError::Invalid("read target disappeared"))?;
        if !same(&after, &before) || !same(&named_after, &before) {
            return Err(BrokerError::Invalid("read changed"));
        }
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

fn same_root(a: &Metadata, b: &Metadata) -> bool {
    a.is_dir() && !a.file_type().is_symlink() && a.dev() == b.dev() && a.ino() == b.ino()
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
