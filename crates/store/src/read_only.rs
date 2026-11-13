//! The read-only task store connection behind `openReadOnlyStore`
//! (`src/dispatch/readonly.ts`): no DDL, no journal mode, no legacy import, and
//! no file created.
//!
//! A WAL-mode store needs `-wal` and `-shm` to be read normally, and SQLite
//! creates them when `state/` is writable (or fails the first read when it is
//! not). A WAL-mode store whose WAL is absent or empty has nothing to miss, so
//! when either file is absent it is opened `immutable`. Otherwise the plain
//! open and its first read run first, and a WAL-mode store with an empty WAL
//! falls back to `immutable` if either fails. The one file SQLite may still
//! create is `-shm` beside a WAL with content whose index was removed.
use rusqlite::{Connection, OpenFlags};
use std::collections::HashSet;
use std::io::Read;
use std::path::Path;

/// An open read-only store and its table names.
pub struct ReadOnlyConnection {
    pub db: Connection,
    pub tables: HashSet<String>,
    /// Opened `immutable`: a snapshot that cannot observe a later WAL.
    pub immutable: bool,
}

/// Which step failed: opening the store, or its first read.
#[derive(Debug)]
pub enum ReadOnlyError {
    Open(rusqlite::Error),
    Read(rusqlite::Error),
}

/// The names of the store's tables.
pub fn read_tables(db: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")?;
    let names = stmt.query_map([], |row| row.get::<_, String>(0))?;
    names.collect()
}

/// The database header says WAL mode (read version 2).
fn wal_mode(path: &Path) -> bool {
    let mut header = [0u8; 20];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .is_ok_and(|()| header.starts_with(b"SQLite format 3\0") && header[19] == 2)
}

/// `file:` URI text for `path`: `%`, `?` and `#` are escaped.
fn uri_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.replace('%', "%25")
        .replace('?', "%3f")
        .replace('#', "%23")
}

fn attempt(
    target: &str,
    flags: OpenFlags,
    immutable: bool,
) -> Result<ReadOnlyConnection, ReadOnlyError> {
    let db = Connection::open_with_flags(target, flags).map_err(ReadOnlyError::Open)?;
    db.execute_batch("PRAGMA query_only = ON")
        .map_err(ReadOnlyError::Open)?;
    let tables = read_tables(&db).map_err(ReadOnlyError::Read)?;
    Ok(ReadOnlyConnection {
        db,
        tables,
        immutable,
    })
}

/// Opens `path` read-only; `Ok(None)` when it does not exist.
pub fn open_read_only(path: &Path) -> Result<Option<ReadOnlyConnection>, ReadOnlyError> {
    if !path.exists() {
        return Ok(None);
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let sidecar = |suffix: &str| {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        std::fs::metadata(name).ok()
    };
    let wal = sidecar("-wal");
    let empty_wal = wal_mode(path) && wal.as_ref().is_none_or(|m| m.len() == 0);
    let immutable = || {
        let uri = format!("file:{}?mode=ro&immutable=1", uri_path(path));
        attempt(&uri, flags | OpenFlags::SQLITE_OPEN_URI, true)
    };
    if empty_wal && (wal.is_none() || sidecar("-shm").is_none()) {
        return immutable().map(Some);
    }
    match attempt(&path.to_string_lossy(), flags, false) {
        Ok(store) => Ok(Some(store)),
        Err(_) if empty_wal => immutable().map(Some),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn seed(dir: &Path, journal: &str) -> std::path::PathBuf {
        let path = dir.join("tasks.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(&format!(
            "PRAGMA journal_mode={journal}; CREATE TABLE tasks(id TEXT); INSERT INTO tasks VALUES ('t1');"
        ))
        .unwrap();
        drop(db);
        path
    }

    fn count(store: &ReadOnlyConnection) -> i64 {
        store
            .db
            .query_row("SELECT count(*) FROM tasks", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn reads_a_cleanly_closed_wal_store_without_creating_files() {
        for writable in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let state = dir.path().join("st?a#te%");
            std::fs::create_dir(&state).unwrap();
            let path = seed(&state, "WAL");
            assert_eq!(files(&state), ["tasks.db"]);
            let mode = if writable { 0o755 } else { 0o555 };
            std::fs::set_permissions(&state, std::fs::Permissions::from_mode(mode)).unwrap();
            let store = open_read_only(&path).unwrap().unwrap();
            assert!(store.immutable && store.tables.contains("tasks"));
            assert_eq!(count(&store), 1);
            drop(store);
            std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(files(&state), ["tasks.db"], "writable: {writable}");
        }
    }

    #[test]
    fn reads_a_live_wal_through_the_writer() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed(dir.path(), "WAL");
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch("PRAGMA wal_autocheckpoint=0; INSERT INTO tasks VALUES ('t2');")
            .unwrap();
        let store = open_read_only(&path).unwrap().unwrap();
        assert!(!store.immutable);
        assert_eq!(count(&store), 2);
    }

    #[test]
    fn missing_garbage_and_rollback_stores() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tasks.db");
        assert!(open_read_only(&path).unwrap().is_none());
        std::fs::write(&path, "not a database").unwrap();
        assert!(matches!(open_read_only(&path), Err(ReadOnlyError::Read(_))));
        std::fs::remove_file(&path).unwrap();
        let path = seed(dir.path(), "DELETE");
        let store = open_read_only(&path).unwrap().unwrap();
        assert!(!store.immutable);
        assert_eq!(count(&store), 1);
        assert_eq!(files(dir.path()), ["tasks.db"]);
    }
}
