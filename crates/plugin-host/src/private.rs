//! Private durable files shared by plugin stores. Resolve roots; protect leaf files.
#![allow(clippy::result_large_err)] // Matches the operation boundary CoreError ABI.
use pacer_foundation::api::{Code, CoreError};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};
pub(crate) fn error(e: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::PluginRefused, e.to_string())
}
pub(crate) fn parents(path: &Path) -> Result<(), CoreError> {
    if !path.is_absolute() {
        return Err(error("redirected publisher parent path"));
    }
    let mut at = std::path::PathBuf::new();
    for part in path.components() {
        if matches!(
            part,
            std::path::Component::ParentDir | std::path::Component::CurDir
        ) {
            return Err(error("redirected publisher parent path"));
        }
        at.push(part);
        match fs::symlink_metadata(&at) {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => (),
            Ok(_) => return Err(error("redirected publisher parent path")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(error(e)),
        }
    }
    Ok(())
}
pub(crate) fn root(path: &Path, create: bool) -> Result<bool, CoreError> {
    parents(path)?;
    if create {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .map_err(error)?;
    }
    let m = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(error(e)),
    };
    if !m.is_dir()
        || m.file_type().is_symlink()
        || m.uid() != nix::unistd::geteuid().as_raw()
        || m.mode() & 0o022 != 0
    {
        return Err(error(
            "publisher directory must be owned and not writable by others",
        ));
    }
    // Compare ownership to a newly created private file without unsafe getuid calls.
    if create {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(error)?;
        let opened = file.metadata().map_err(error)?;
        if opened.dev() != m.dev() || opened.ino() != m.ino() || opened.uid() != m.uid() {
            return Err(error("publisher directory changed before mode migration"));
        }
        file.set_permissions(fs::Permissions::from_mode(0o700))
            .map_err(error)?;
        let after = fs::symlink_metadata(path).map_err(error)?;
        if after.dev() != m.dev() || after.ino() != m.ino() || after.mode() & 0o777 != 0o700 {
            return Err(error("publisher directory changed after mode migration"));
        }
    }
    Ok(true)
}
pub(crate) fn read(path: &Path, max: u64, private: bool) -> Result<Option<Vec<u8>>, CoreError> {
    parents(path.parent().ok_or_else(|| error("missing store parent"))?)?;
    let before = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(error(e)),
    };
    if !before.is_file()
        || before.file_type().is_symlink()
        || before.uid() != nix::unistd::geteuid().as_raw()
        || before.nlink() != 1
        || (private && before.mode() & 0o777 != 0o600)
    {
        return Err(error("publisher store must be private and owned"));
    }
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(error)?;
    let opened = f.metadata().map_err(error)?;
    if opened.dev() != before.dev() || opened.ino() != before.ino() || opened.len() > max {
        return Err(error("invalid publisher store identity or size"));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut f)
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    let after = f.metadata().map_err(error)?;
    let named = fs::symlink_metadata(path).map_err(error)?;
    if bytes.len() as u64 != opened.len()
        || after.len() != opened.len()
        || after.mtime() != opened.mtime()
        || after.mtime_nsec() != opened.mtime_nsec()
        || after.ctime() != opened.ctime()
        || after.ctime_nsec() != opened.ctime_nsec()
        || after.mode() != opened.mode()
        || named.ino() != opened.ino()
        || named.dev() != opened.dev()
    {
        return Err(error("publisher store changed during read"));
    }
    Ok(Some(bytes))
}
pub(crate) fn write(path: &Path, bytes: &[u8]) -> Result<(), CoreError> {
    let parent = path.parent().ok_or_else(|| error("missing store parent"))?;
    root(parent, true)?;
    let before = fs::symlink_metadata(parent).map_err(error)?;
    let tmp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&tmp)
            .map_err(error)?;
        if f.metadata().map_err(error)?.uid() != before.uid() {
            return Err(error("store parent is not owned"));
        }
        f.write_all(bytes).map_err(error)?;
        f.sync_all().map_err(error)?;
        parents(parent)?;
        let after = fs::symlink_metadata(parent).map_err(error)?;
        if after.dev() != before.dev() || after.ino() != before.ino() || after.mode() & 0o022 != 0 {
            return Err(error("publisher directory changed before publication"));
        }
        fs::rename(&tmp, path).map_err(error)?;
        std::fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(error)
    })();
    let _ = fs::remove_file(tmp);
    result
}

/// Resolve configured directory aliases before applying private-store checks.
/// Leaf lock/store opens still use O_NOFOLLOW; atomic saves replace store links.
fn resolved_root(path: &Path) -> Result<std::path::PathBuf, CoreError> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(error)?;
    let resolved = fs::canonicalize(path).map_err(error)?;
    root(&resolved, true)?;
    Ok(resolved)
}

/// Shared TS lock name and stale-lock protocol, with private creation modes.
pub(crate) fn locked<T>(
    ctx: &pacer_foundation::Ctx,
    name: &str,
    f: impl FnOnce(&pacer_foundation::Ctx) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    // PACER_HOME is a configured directory, not an untrusted state-file leaf.
    // Like TS mkdir/join, accept relative paths and symlinked ancestors. Retain
    // the resolved owned root for the entire transaction, including its reads.
    let mut ctx = ctx.clone();
    ctx.pacer_home = resolved_root(&ctx.pacer_home)?;
    let dir = resolved_root(&ctx.pacer_home.join("orca"))?;
    let path = dir.join(format!("{name}.lock"));
    struct Guard(std::path::PathBuf);
    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
        {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let m = match fs::symlink_metadata(&path) {
                    Ok(m) => m,
                    // The previous holder may release between create_new and
                    // inspection. Retry acquisition, as the TS lock does.
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(error(e)),
                };
                if !m.is_file()
                    || m.file_type().is_symlink()
                    || m.nlink() != 1
                    || m.uid() != nix::unistd::geteuid().as_raw()
                {
                    return Err(error("unsafe plugin lock"));
                }
                if m.modified()
                    .map_err(error)?
                    .elapsed()
                    .is_ok_and(|age| age > std::time::Duration::from_secs(120))
                {
                    fs::remove_file(&path).map_err(error)?;
                    continue;
                }
                if std::time::Instant::now() > deadline {
                    return Err(error(format!("timed out waiting for {}", path.display())));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(error(e)),
        }
    }
    let _guard = Guard(path);
    f(&ctx)
}
