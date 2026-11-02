//! Descriptor-relative writes pinned at issuance. No descendant symlinks are followed.
use crate::{BrokerError, WriteResource};
use nix::{
    errno::Errno,
    fcntl::{OFlag, open, openat, renameat},
    sys::stat::{Mode, mkdirat},
    unistd::{UnlinkatFlags, unlinkat},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{self, File, Metadata, Permissions},
    io::{Read, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, PermissionsExt},
    },
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, PartialEq, Eq)]
struct Identity(u64, u64);
fn identity(m: &Metadata) -> Identity {
    Identity(m.dev(), m.ino())
}
fn denied() -> BrokerError {
    crate::AuthorityError::Denied("write path changed or was not issued".into()).into()
}
fn flags() -> OFlag {
    OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK
}
fn directory(parent: &File, name: &Path) -> Result<File, BrokerError> {
    openat(parent, name, flags() | OFlag::O_DIRECTORY, Mode::empty())
        .map(File::from)
        .map_err(|_| denied())
}
fn target(parent: &File, name: &Path) -> Result<Option<File>, BrokerError> {
    match openat(parent, name, flags(), Mode::empty()) {
        Ok(fd) => Ok(Some(File::from(fd))),
        Err(Errno::ENOENT) => Ok(None),
        Err(_) => Err(denied()),
    }
}
fn checked(file: &File, kind: &str) -> Result<Metadata, BrokerError> {
    let m = file.metadata().map_err(|_| denied())?;
    if if kind == "file" {
        !m.is_file() || m.nlink() != 1
    } else {
        !m.is_dir()
    } {
        return Err(denied());
    }
    Ok(m)
}
struct Resource {
    descriptor: WriteResource,
    relative: PathBuf,
    expected: Option<Identity>,
}
pub struct NativeWrite {
    logical: PathBuf,
    canonical: PathBuf,
    root: File,
    root_id: Identity,
    directories: HashMap<PathBuf, (Identity, File)>,
    resources: Vec<Resource>,
    cleanup_failed: bool,
}
impl NativeWrite {
    pub fn prepare(root: &Path, descriptors: &[WriteResource]) -> Result<Self, BrokerError> {
        let canonical = fs::canonicalize(root).map_err(|_| denied())?;
        let file = File::from(
            open(&canonical, flags() | OFlag::O_DIRECTORY, Mode::empty()).map_err(|_| denied())?,
        );
        let root_id = identity(&checked(&file, "directory")?);
        let mut native = Self {
            logical: root.into(),
            canonical,
            root: file,
            root_id,
            directories: HashMap::new(),
            resources: vec![],
            cleanup_failed: false,
        };
        native.directories.insert(
            PathBuf::new(),
            (root_id, native.root.try_clone().map_err(|_| denied())?),
        );
        for descriptor in descriptors {
            crate::authority::valid_path(&descriptor.path)?;
            let relative = Path::new(&descriptor.path)
                .strip_prefix(root)
                .map_err(|_| denied())?
                .to_path_buf();
            if relative.as_os_str().is_empty()
                || !["file", "directory"].contains(&descriptor.kind.as_str())
            {
                return Err(denied());
            }
            let mut parent = native.root.try_clone().map_err(|_| denied())?;
            let mut prefix = PathBuf::new();
            let mut absent = false;
            for part in relative.parent().ok_or_else(denied)?.iter() {
                if absent {
                    continue;
                }
                let next = match openat(
                    &parent,
                    Path::new(part),
                    flags() | OFlag::O_DIRECTORY,
                    Mode::empty(),
                ) {
                    Ok(fd) => File::from(fd),
                    Err(Errno::ENOENT) => {
                        absent = true;
                        continue;
                    }
                    Err(_) => return Err(denied()),
                };
                prefix.push(part);
                native.directories.insert(
                    prefix.clone(),
                    (
                        identity(&checked(&next, "directory")?),
                        next.try_clone().map_err(|_| denied())?,
                    ),
                );
                parent = next;
            }
            let expected = if absent {
                None
            } else {
                target(&parent, Path::new(relative.file_name().ok_or_else(denied)?))?
                    .map(|file| checked(&file, &descriptor.kind).map(|m| identity(&m)))
                    .transpose()?
            };
            if descriptor.kind == "directory"
                && let Some(id) = expected
            {
                native.directories.insert(
                    relative.clone(),
                    (
                        id,
                        directory(&parent, Path::new(relative.file_name().ok_or_else(denied)?))?,
                    ),
                );
            }
            native.resources.push(Resource {
                descriptor: descriptor.clone(),
                relative,
                expected,
            });
        }
        native.current_root()?;
        Ok(native)
    }
    fn current_root(&self) -> Result<(), BrokerError> {
        if fs::canonicalize(&self.logical).ok().as_ref() != Some(&self.canonical)
            || !fs::symlink_metadata(&self.canonical)
                .is_ok_and(|m| m.is_dir() && identity(&m) == self.root_id)
            || identity(&checked(&self.root, "directory")?) != self.root_id
        {
            return Err(denied());
        }
        Ok(())
    }
    fn parent(&self, relative: &Path) -> Result<File, BrokerError> {
        self.current_root()?;
        let mut file = self.root.try_clone().map_err(|_| denied())?;
        let mut prefix = PathBuf::new();
        for part in relative.parent().ok_or_else(denied)?.iter() {
            prefix.push(part);
            let (expected, pin) = self.directories.get(&prefix).ok_or_else(denied)?;
            file = directory(&file, Path::new(part))?;
            if identity(&checked(&file, "directory")?) != *expected
                || identity(&checked(pin, "directory")?) != *expected
            {
                return Err(denied());
            }
        }
        Ok(file)
    }
    fn current(&self, index: usize, parent: &File) -> Result<Option<File>, BrokerError> {
        let r = &self.resources[index];
        let file = target(
            parent,
            Path::new(r.relative.file_name().ok_or_else(denied)?),
        )?;
        let actual = file
            .as_ref()
            .map(|f| checked(f, &r.descriptor.kind).map(|m| identity(&m)))
            .transpose()?;
        if actual != r.expected {
            return Err(denied());
        }
        Ok(file)
    }
    /// Recheck without mutation before staging a transfer.
    pub fn check(&self, path: &str, operation: &str) -> Result<(), BrokerError> {
        let index = self.index(path, operation)?;
        let parent = self.parent(&self.resources[index].relative)?;
        self.current(index, &parent)?;
        Ok(())
    }
    fn index(&self, path: &str, operation: &str) -> Result<usize, BrokerError> {
        self.resources
            .iter()
            .position(|r| {
                r.descriptor.path == path && r.descriptor.operations.iter().any(|o| o == operation)
            })
            .ok_or_else(denied)
    }
    /// Host-only binary capture; the write descriptors still authorize exact paths.
    pub fn write_bytes(&mut self, path: &str, bytes: &[u8]) -> Result<Value, BrokerError> {
        self.write_bytes_io(path, bytes, |file, bytes| file.write_all(bytes))
    }
    pub fn retirement(&self) -> Result<(), BrokerError> {
        if self.cleanup_failed {
            Err(BrokerError::Effect(
                "write staging cleanup unverified".into(),
            ))
        } else {
            Ok(())
        }
    }
    fn write_bytes_io(
        &mut self,
        path: &str,
        bytes: &[u8],
        write: impl FnOnce(&mut File, &[u8]) -> std::io::Result<()>,
    ) -> Result<Value, BrokerError> {
        self.write_bytes_checked_io(path, bytes, write, || Ok(()))
    }
    pub fn write_bytes_owned(
        &mut self,
        path: &str,
        bytes: &[u8],
        guard: impl Fn() -> Result<(), BrokerError>,
    ) -> Result<Value, BrokerError> {
        self.write_bytes_checked_io(path, bytes, |file, bytes| file.write_all(bytes), guard)
    }
    fn write_bytes_checked_io(
        &mut self,
        path: &str,
        bytes: &[u8],
        write: impl FnOnce(&mut File, &[u8]) -> std::io::Result<()>,
        guard: impl Fn() -> Result<(), BrokerError>,
    ) -> Result<Value, BrokerError> {
        self.retirement()?;
        guard()?;
        let index = self.index(path, "write")?;
        if self.resources[index].descriptor.kind != "file" {
            return Err(denied());
        }
        let relative = self.resources[index].relative.clone();
        let parent = self.parent(&relative)?;
        let prior = self.current(index, &parent)?;
        let name = Path::new(relative.file_name().ok_or_else(denied)?);
        if let Some(mut file) = prior {
            let before = checked(&file, "file")?;
            if before.len() == bytes.len() as u64 {
                let mut existing = vec![];
                Read::by_ref(&mut file)
                    .take(before.len() + 1)
                    .read_to_end(&mut existing)
                    .map_err(|_| denied())?;
                let after = checked(&file, "file")?;
                if before.len() != after.len()
                    || before.mtime() != after.mtime()
                    || before.mtime_nsec() != after.mtime_nsec()
                {
                    return Err(denied());
                }
                if existing == bytes {
                    self.parent(&relative)?;
                    self.current(index, &parent)?;
                    guard()?;
                    file.set_permissions(Permissions::from_mode(0o600))
                        .map_err(|_| denied())?;
                    return Ok(json!({"ok":true}));
                }
            }
        }
        guard()?;
        let temp = format!(".pacer-write-{}.tmp", uuid::Uuid::new_v4());
        let staged = openat(
            &parent,
            temp.as_str(),
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::S_IRUSR | Mode::S_IWUSR,
        )
        .map_err(|_| denied())?;
        let mut file = File::from(staged);
        let result = (|| {
            file.set_permissions(Permissions::from_mode(0o600))
                .map_err(|_| denied())?;
            write(&mut file, bytes).map_err(|_| denied())?;
            file.sync_all().map_err(|_| denied())?;
            let id = identity(&checked(&file, "file")?);
            self.parent(&relative)?;
            self.current(index, &parent)?;
            guard()?;
            renameat(&parent, temp.as_str(), &parent, name).map_err(|_| denied())?;
            self.resources[index].expected = Some(id);
            self.parent(&relative)?;
            self.current(index, &parent)?;
            Ok(json!({"ok":true}))
        })();
        // Refuse replacement and retain cleanup uncertainty even when the
        // caller catches the write error. Never unlink another owner's inode.
        let cleanup = match target(&parent, Path::new(&temp)) {
            Ok(None) => Ok(()),
            Ok(Some(named))
                if named
                    .metadata()
                    .ok()
                    .zip(file.metadata().ok())
                    .is_some_and(|(a, b)| identity(&a) == identity(&b)) =>
            {
                unlinkat(&parent, temp.as_str(), UnlinkatFlags::NoRemoveDir).map_err(|_| denied())
            }
            _ => Err(denied()),
        };
        if cleanup.is_err() {
            self.cleanup_failed = true;
            return Err(BrokerError::Effect(
                "write staging cleanup unverified".into(),
            ));
        }
        result
    }
    pub fn answer(&mut self, method: &str, params: &Value) -> Result<Value, BrokerError> {
        self.answer_owned(method, params, || Ok(()))
    }
    pub fn answer_owned(
        &mut self,
        method: &str,
        params: &Value,
        guard: impl Fn() -> Result<(), BrokerError>,
    ) -> Result<Value, BrokerError> {
        guard()?;
        let operation = method.strip_prefix("capability.fs.").ok_or_else(denied)?;
        let path = params["path"]
            .as_str()
            .ok_or(BrokerError::Invalid("write path"))?;
        let index = self.index(path, operation)?;
        let r = &self.resources[index];
        let relative = r.relative.clone();
        let kind = r.descriptor.kind.clone();
        let parent = self.parent(&relative)?;
        let prior = self.current(index, &parent)?;
        let name = Path::new(relative.file_name().ok_or_else(denied)?);
        match operation {
            "write" => {
                let text = params["text"]
                    .as_str()
                    .ok_or(BrokerError::Invalid("write text"))?;
                if text.len() > 4 * 1024 * 1024
                    || params
                        .get("mode")
                        .is_some_and(|m| crate::js_semantics::safe_u64(m) != Some(0o600))
                {
                    return Err(BrokerError::Invalid("write bounds"));
                }
                self.write_bytes_owned(path, text.as_bytes(), &guard)
            }
            "mkdir" => {
                if kind != "directory" {
                    return Err(denied());
                }
                guard()?;
                if let Some(file) = prior.as_ref() {
                    file.set_permissions(Permissions::from_mode(0o700))
                        .map_err(|_| denied())?;
                }
                if prior.is_none() {
                    mkdirat(&parent, name, Mode::S_IRWXU).map_err(|_| denied())?;
                    let file = directory(&parent, name)?;
                    file.set_permissions(Permissions::from_mode(0o700))
                        .map_err(|_| denied())?;
                    let id = identity(&checked(&file, "directory")?);
                    self.resources[index].expected = Some(id);
                    self.directories.insert(relative.clone(), (id, file));
                }
                self.parent(&relative)?;
                self.current(index, &parent)?;
                Ok(json!({"ok":true}))
            }
            "remove" => {
                if params.get("recursive").is_some_and(|v| !v.is_boolean()) {
                    return Err(BrokerError::Invalid("recursive"));
                }
                if prior.is_some() {
                    self.parent(&relative)?;
                    self.current(index, &parent)?;
                    if kind == "directory" && params["recursive"] == true {
                        remove_tree(&parent, name, self.resources[index].expected, &guard)?;
                    } else {
                        guard()?;
                        unlinkat(
                            &parent,
                            name,
                            if kind == "directory" {
                                UnlinkatFlags::RemoveDir
                            } else {
                                UnlinkatFlags::NoRemoveDir
                            },
                        )
                        .map_err(|_| denied())?;
                    }
                    for resource in &mut self.resources {
                        if resource.relative.starts_with(&relative) {
                            resource.expected = None;
                        }
                    }
                    self.directories
                        .retain(|path, _| !path.starts_with(&relative));
                }
                self.parent(&relative)?;
                self.current(index, &parent)?;
                Ok(json!({"ok":true}))
            }
            _ => Err(BrokerError::Invalid("write operation")),
        }
    }
}

fn remove_tree(
    parent: &File,
    name: &Path,
    expected: Option<Identity>,
    guard: &impl Fn() -> Result<(), BrokerError>,
) -> Result<(), BrokerError> {
    guard()?;
    let Some(file) = target(parent, name)? else {
        return Ok(());
    };
    let stat = file.metadata().map_err(|_| denied())?;
    if expected.is_some_and(|id| id != identity(&stat)) {
        return Err(denied());
    }
    if stat.is_file() {
        checked(&file, "file")?;
        guard()?;
        unlinkat(parent, name, UnlinkatFlags::NoRemoveDir).map_err(|_| denied())?;
    } else if stat.is_dir() {
        let fd = openat(parent, name, flags() | OFlag::O_DIRECTORY, Mode::empty())
            .map_err(|_| denied())?;
        let mut dir = nix::dir::Dir::from_fd(fd).map_err(|_| denied())?;
        let names = dir
            .iter()
            .map(|entry| entry.map(|e| e.file_name().to_owned()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| denied())?;
        for child in names {
            if child.to_bytes() != b"." && child.to_bytes() != b".." {
                remove_tree(
                    &file,
                    Path::new(std::ffi::OsStr::from_bytes(child.to_bytes())),
                    None,
                    guard,
                )?;
            }
        }
        let named = target(parent, name)?.ok_or_else(denied)?;
        if identity(&named.metadata().map_err(|_| denied())?) != identity(&stat) {
            return Err(denied());
        }
        guard()?;
        unlinkat(parent, name, UnlinkatFlags::RemoveDir).map_err(|_| denied())?;
    } else {
        return Err(denied());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
