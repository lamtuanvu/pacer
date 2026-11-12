//! Where a stdio connection binds its owner socket (ADR 0027).
//!
//! Normally `$PACER_HOME/run/`, beside `host.sock`. When `run/s<12-hex>.sock`
//! would not fit in `sockaddr_un`, the socket goes to a private per-user
//! directory outside the home, `<user dir>/pacer-<hash of the canonical home>/`,
//! so deep homes keep native plugin ownership. The user directory is the OS's
//! per-user private directory (`DARWIN_USER_TEMP_DIR` on macOS,
//! `$XDG_RUNTIME_DIR` on Linux), never a shared `/tmp` name or `$TMPDIR`.
//! Every directory a socket is bound in must be a real directory owned by the
//! current user with no group or other access.

use crate::bridge_listener::BridgeError;
use crate::host_bridge::{SOCKET_PATH_MAX, prepare_run_dir};
use std::{
    fs, io,
    os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

/// A socket younger than this may belong to a connection between `bind` and
/// `listen`, which refuses connections too; the sweep leaves it alone.
const STALE_AFTER: Duration = Duration::from_secs(10);

/// Why `meta` is not a directory only `uid` can use; `None` when it is one.
pub(crate) fn private_dir_problem(meta: &fs::Metadata, uid: u32) -> Option<&'static str> {
    if meta.file_type().is_symlink() {
        Some("is a symlink")
    } else if !meta.is_dir() {
        Some("is not a directory")
    } else if meta.uid() != uid {
        Some("belongs to another user")
    } else if meta.mode() & 0o077 != 0 {
        Some("is open to other users")
    } else {
        None
    }
}

/// `lstat` `dir` and require [`private_dir_problem`] to find nothing.
pub(crate) fn check_private_dir(dir: &Path, uid: u32) -> Result<fs::Metadata, String> {
    let meta = fs::symlink_metadata(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    match private_dir_problem(&meta, uid) {
        Some(problem) => Err(format!("{} {problem}", dir.display())),
        None => Ok(meta),
    }
}

/// Nobody but root and `uid` may rename `base` away: every directory above its
/// canonical path is owned by one of them, and sticky when others can write.
pub(crate) fn check_ancestors(base: &Path, uid: u32) -> Result<(), String> {
    let canonical =
        fs::canonicalize(base).map_err(|error| format!("{}: {error}", base.display()))?;
    for dir in canonical.ancestors().skip(1) {
        let meta =
            fs::symlink_metadata(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
        if meta.uid() != 0 && meta.uid() != uid {
            return Err(format!("{} belongs to another user", dir.display()));
        }
        if meta.mode() & 0o022 != 0 && meta.mode() & 0o1000 == 0 {
            return Err(format!(
                "{} is writable by other users without the sticky bit",
                dir.display()
            ));
        }
    }
    Ok(())
}

/// The directory a connection socket named `name` binds in, as `uid`.
pub(crate) fn connection_socket_dir(
    pacer_home: &Path,
    name: &str,
    uid: u32,
) -> Result<PathBuf, BridgeError> {
    if pacer_home.join("run").join(name).as_os_str().len() <= SOCKET_PATH_MAX {
        return Ok(prepare_run_dir(pacer_home)?);
    }
    private_socket_dir(pacer_home, user_private_dir(), name, uid)
}

/// `<base>/pacer-<hash>/` for a home whose `run/` path is too long. `base` is
/// the OS per-user directory, or why there is none.
pub(crate) fn private_socket_dir(
    pacer_home: &Path,
    base: Result<PathBuf, String>,
    name: &str,
    uid: u32,
) -> Result<PathBuf, BridgeError> {
    let in_home = pacer_home.join("run").join(name);
    let refuse = |reason: String| BridgeError::NoPrivateDir {
        path: in_home.clone(),
        reason,
    };
    let base = base.map_err(refuse)?;
    check_private_dir(&base, uid).map_err(refuse)?;
    check_ancestors(&base, uid).map_err(refuse)?;
    let canonical = fs::canonicalize(pacer_home).unwrap_or_else(|_| pacer_home.to_path_buf());
    let dir = base.join(format!(
        "pacer-{:016x}",
        fnv1a(canonical.as_os_str().as_encoded_bytes())
    ));
    match fs::DirBuilder::new().mode(0o700).create(&dir) {
        Err(error) if error.kind() != io::ErrorKind::AlreadyExists => {
            return Err(refuse(format!("{}: {error}", dir.display())));
        }
        _ => {}
    }
    check_private_dir(&dir, uid).map_err(refuse)?;
    if dir.join(name).as_os_str().len() > SOCKET_PATH_MAX {
        return Err(refuse(format!(
            "{} is too long for a socket path",
            dir.display()
        )));
    }
    Ok(dir)
}

/// The OS per-user private directory: `confstr(_CS_DARWIN_USER_TEMP_DIR)`
/// through `getconf`, since the workspace forbids the unsafe FFI call.
#[cfg(target_os = "macos")]
fn user_private_dir() -> Result<PathBuf, String> {
    let output = std::process::Command::new("/usr/bin/getconf")
        .arg("DARWIN_USER_TEMP_DIR")
        .env_clear()
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|error| format!("getconf DARWIN_USER_TEMP_DIR: {error}"))?;
    let text = String::from_utf8(output.stdout).unwrap_or_default();
    let dir = text.trim_end_matches('\n').trim_end_matches('/');
    if !output.status.success() || !dir.starts_with('/') {
        return Err("the per-user temporary directory is unavailable".into());
    }
    Ok(PathBuf::from(dir))
}

/// The OS per-user private directory: `$XDG_RUNTIME_DIR`.
#[cfg(not(target_os = "macos"))]
fn user_private_dir() -> Result<PathBuf, String> {
    match std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) {
        Some(dir) if dir.is_absolute() => Ok(dir),
        _ => Err("XDG_RUNTIME_DIR is not set".into()),
    }
}

/// 64-bit FNV-1a: a stable name for a home's private directory, not a secret.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// True for `s<12 lowercase hex>.sock`, the shape of [`crate::connection_socket_name`].
fn is_connection_socket_name(name: &str) -> bool {
    name.strip_prefix('s')
        .and_then(|rest| rest.strip_suffix(".sock"))
        .is_some_and(|hex| {
            hex.len() == 12
                && hex
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

/// What a non-blocking connect learned about a socket path.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Probe {
    /// Accepted, or a listener with a full backlog (`EAGAIN`/`EINPROGRESS`).
    Live,
    /// Nobody listens. macOS also answers this for a full backlog; the sweep's
    /// stale-age rule bounds that for connection sockets.
    Refused,
    Missing,
    Other(nix::errno::Errno),
}

/// Connect without blocking, so a listener whose accept queue is full reads
/// as live instead of hanging or looking stale.
pub(crate) fn probe_socket(path: &Path) -> Probe {
    use nix::{
        errno::Errno,
        fcntl::{FcntlArg, FdFlag, OFlag, fcntl},
        sys::socket::{AddressFamily, SockFlag, SockType, UnixAddr, connect, socket},
    };
    use std::os::fd::AsRawFd;
    let attempt = || -> Result<(), Errno> {
        let address = UnixAddr::new(path)?;
        let fd = socket(
            AddressFamily::Unix,
            SockType::Stream,
            SockFlag::empty(),
            None,
        )?;
        fcntl(&fd, FcntlArg::F_SETFD(FdFlag::FD_CLOEXEC))?;
        fcntl(&fd, FcntlArg::F_SETFL(OFlag::O_NONBLOCK))?;
        connect(fd.as_raw_fd(), &address)
    };
    match attempt() {
        Ok(()) | Err(Errno::EAGAIN | Errno::EINPROGRESS) => Probe::Live,
        Err(Errno::ECONNREFUSED) => Probe::Refused,
        Err(Errno::ENOENT) => Probe::Missing,
        Err(errno) => Probe::Other(errno),
    }
}

/// Unlink connection sockets in `dir` that a killed connection left behind:
/// sockets (never symlinks) owned by `uid`, older than [`STALE_AFTER`], that
/// refuse connections. Returns how many were removed.
pub(crate) fn sweep_stale_sockets(dir: &Path, uid: u32) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_str()
            .is_some_and(is_connection_socket_name)
        {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        let old = meta
            .modified()
            .ok()
            .and_then(|at| now.duration_since(at).ok())
            .is_some_and(|age| age >= STALE_AFTER);
        if !meta.file_type().is_socket() || meta.uid() != uid || !old {
            continue;
        }
        if probe_socket(&path) == Probe::Refused && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
#[path = "connection_dir/tests.rs"]
mod tests;
