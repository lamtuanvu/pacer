//! Private durable files shared by plugin stores. Resolve roots; protect leaf files.
#![allow(clippy::result_large_err)] // Matches the operation boundary CoreError ABI.
use pacer_foundation::api::{Code, CoreError};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};
pub(crate) fn error(e: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::PluginRefused, e.to_string())
}
pub(crate) fn internal(e: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::Internal, e.to_string())
}
pub(crate) fn io_error(e: std::io::Error, syscall: &str, path: &Path) -> CoreError {
    let (code, message) = match e.raw_os_error() {
        Some(libc::ENOENT) => ("ENOENT", "no such file or directory"),
        Some(libc::EEXIST) => ("EEXIST", "file already exists"),
        Some(libc::ENOTDIR) => ("ENOTDIR", "not a directory"),
        Some(libc::EACCES) => ("EACCES", "permission denied"),
        Some(libc::EPERM) => ("EPERM", "operation not permitted"),
        Some(libc::EROFS) => ("EROFS", "read-only file system"),
        Some(libc::ENOSPC) => ("ENOSPC", "no space left on device"),
        Some(libc::ELOOP) => ("ELOOP", "too many symbolic links encountered"),
        Some(libc::EISDIR) => return internal("EISDIR: illegal operation on a directory, read"),
        _ => return internal(e),
    };
    internal(format!("{code}: {message}, {syscall} '{}'", path.display()))
}
fn shared_error(mut e: CoreError) -> CoreError {
    e.code = Code::Internal;
    e
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
pub(crate) fn write_shared(path: &Path, bytes: &[u8]) -> Result<(), CoreError> {
    write_inner(path, bytes, false).map_err(shared_error)
}
fn write_inner(path: &Path, bytes: &[u8], private: bool) -> Result<(), CoreError> {
    let parent = path.parent().ok_or_else(|| error("missing store parent"))?;
    if private {
        root(parent, true)?;
    } else {
        fs::create_dir_all(parent).map_err(error)?;
    }
    let resolved = fs::canonicalize(parent).map_err(error)?;
    let parent = resolved.as_path();
    let path = parent.join(
        path.file_name()
            .ok_or_else(|| error("missing store name"))?,
    );
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
        if private && f.metadata().map_err(error)?.uid() != before.uid() {
            return Err(error("store parent is not owned"));
        }
        f.write_all(bytes).map_err(error)?;
        f.sync_all().map_err(error)?;
        parents(parent)?;
        let after = fs::symlink_metadata(parent).map_err(error)?;
        if after.dev() != before.dev()
            || after.ino() != before.ino()
            || (private && after.mode() & 0o022 != 0)
        {
            return Err(error("publisher directory changed before publication"));
        }
        fs::rename(&tmp, &path).map_err(error)?;
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
        .map_err(|e| io_error(e, "mkdir", path))?;
    let resolved = fs::canonicalize(path).map_err(internal)?;
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
    let display_path = ctx.pacer_home.join("orca").join(format!("{name}.lock"));
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
                    Err(e) => return Err(internal(e)),
                };
                if !m.is_file()
                    || m.file_type().is_symlink()
                    || m.nlink() != 1
                    || m.uid() != nix::unistd::geteuid().as_raw()
                {
                    return Err(internal("unsafe plugin lock"));
                }
                if m.modified()
                    .map_err(internal)?
                    .elapsed()
                    .is_ok_and(|age| age > std::time::Duration::from_secs(120))
                {
                    match fs::remove_file(&path) {
                        Ok(()) => (),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                        Err(e) => return Err(internal(e)),
                    }
                    continue;
                }
                if std::time::Instant::now() > deadline {
                    return Err(internal(format!(
                        "timed out waiting for {}",
                        display_path.display()
                    )));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(io_error(e, "open", &path)),
        }
    }
    let _guard = Guard(path);
    f(&ctx)
}
