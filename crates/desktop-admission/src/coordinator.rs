//! Crash-safe desktop admission coordinator (mirror of
//! `src/update/desktop/coordinator.ts` `withDesktopCoordinator`).
//!
//! SQLite owns the stable inode's kernel lock; there is no time-based expiry,
//! lockfile unlink, or application lock takeover. Full synchronous rollback
//! journaling survives process death. Short synchronous transactions only. The
//! physical lock is released before entity operations; the callback must NEVER
//! await, start work, or acquire an entity lock.
//!
//! The coordinator owns the physical `desktop-updates/admission.sqlite` file:
//! private-directory entrance checks, inode pinning across the transaction,
//! `busy_timeout` and `synchronous=FULL`, and the `BEGIN IMMEDIATE` / COMMIT /
//! ROLLBACK envelope. The `admission` table itself is created and decoded by
//! the caller (the plugin host's admission-row codec), so this module stays
//! domain-agnostic and reusable by the desktop-update store.
use rusqlite::{Connection, OpenFlags, Transaction};
use std::{
    fs::{self, File, OpenOptions},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

/// A coordinator-level failure. Distinguishes the two error shapes a caller
/// needs to surface: an "invalid"/denied prerequisite (mode, ownership,
/// symlink, inode, or sqlite) versus a raw sqlite error.
#[derive(Debug, thiserror::Error)]
pub enum AdmissionError {
    /// A file, directory or inode prerequisite was not private or not owned
    /// by the service user, or the sqlite file could not be opened safely.
    #[error("desktop coordination prerequisite failed")]
    Denied,
    /// A domain reason supplied by the caller (for example a reservation
    /// conflict message), surfaced verbatim.
    #[error("{0}")]
    Reason(String),
    /// Any typed error carried unchanged through the coordinator, to be
    /// downcast and reconstructed by the caller.
    #[error(transparent)]
    Passthrough(Box<dyn std::error::Error + Send + Sync>),
    /// SQLite could not open or run the transaction.
    #[error("desktop coordination sqlite failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// Shared entry point for a short desktop-coordination transaction. Creates the
/// private `desktop-updates` directory and `admission.sqlite` file on first
/// use (durable: fsync of file and parent), verifies privacy and ownership,
/// pins the state file's inode, opens SQLite, applies `busy_timeout` and
/// `synchronous=FULL`, and runs `action` inside a `BEGIN IMMEDIATE`
/// transaction. The callback must be synchronous (never `await`).
pub fn with_coordinator<T>(
    home: &Path,
    action: impl FnOnce(&Transaction<'_>) -> Result<T, AdmissionError>,
) -> Result<T, AdmissionError> {
    let dir = home.join("desktop-updates");
    match fs::DirBuilder::new().mode(0o700).create(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(AdmissionError::Denied),
    }
    private(&dir, true)?;
    let path = dir.join("admission.sqlite");
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(file) => {
            file.sync_all().map_err(|_| AdmissionError::Denied)?;
            File::open(&dir)
                .and_then(|f| f.sync_all())
                .map_err(|_| AdmissionError::Denied)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(AdmissionError::Denied),
    }
    let pinned = private(&path, false)?;
    for suffix in ["-journal", "-wal", "-shm"] {
        let p = PathBuf::from(format!("{}{suffix}", path.display()));
        match fs::symlink_metadata(&p) {
            Ok(_) => {
                private(&p, false)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(AdmissionError::Denied),
        }
    }
    // Resolve the already-checked private directory, retaining inode checks on
    // the logical state path around the transaction. SQLite NOFOLLOW also
    // rejects symlinked ancestors such as macOS /var.
    let database_path = fs::canonicalize(&dir)
        .map_err(|_| AdmissionError::Denied)?
        .join("admission.sqlite");
    let mut db = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    db.busy_timeout(Duration::from_secs(5))?;
    db.pragma_update(None, "synchronous", "FULL")?;
    let current = private(&path, false)?;
    if current.dev() != pinned.dev() || current.ino() != pinned.ino() {
        return Err(AdmissionError::Denied);
    }
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let result = action(&tx)?;
    let current = private(&path, false)?;
    if current.dev() != pinned.dev() || current.ino() != pinned.ino() {
        return Err(AdmissionError::Denied);
    }
    tx.commit()?;
    Ok(result)
}

/// Alias with the historical native name from `work_lease::mutate`.
pub fn mutate<T>(
    home: &Path,
    action: impl FnOnce(&Transaction<'_>) -> Result<T, AdmissionError>,
) -> Result<T, AdmissionError> {
    with_coordinator(home, action)
}

/// Validates a file (or directory when `directory`) is private to the current
/// user: mode has no group/other bits, the owner is us, and it is the real
/// object (a symlink is rejected via `symlink_metadata` rather than followed).
fn private(path: &Path, directory: bool) -> Result<fs::Metadata, AdmissionError> {
    let m = fs::symlink_metadata(path).map_err(|_| AdmissionError::Denied)?;
    if (if directory { !m.is_dir() } else { !m.is_file() })
        || m.mode() & 0o077 != 0
        || m.uid() != nix_like_current_uid()
    {
        return Err(AdmissionError::Denied);
    }
    Ok(m)
}

/// Current user id, matching `process.getuid()` in the TS coordinator.
fn nix_like_current_uid() -> u32 {
    nix::unistd::Uid::current().as_raw()
}
