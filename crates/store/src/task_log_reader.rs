//! Native reads never write state. Schema setup and compatibility imports remain
//! authoritative in the TS core; callers must forward CompatibilityRequired.
use super::*;
use rusqlite::OpenFlags;
use std::{cell::RefCell, os::unix::fs::MetadataExt};

struct Reader {
    db: Option<Connection>,
    identity: Option<(u64, u64)>,
    directory_stamp: Option<String>,
    current_schema: bool,
}

/// Retained read-only connection. Replacement databases reopen on the next read.
/// Pending legacy imports are never projected into a private per-stream cache.
pub struct TaskLogReader {
    home: PathBuf,
    reader: RefCell<Reader>,
}
fn identity(path: &Path) -> io::Result<Option<(u64, u64)>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !metadata.file_type().is_file()
        || metadata.nlink() != 1
        || metadata.uid() != rustix::process::geteuid().as_raw()
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unsafe task database",
        ));
    }
    Ok(Some((metadata.dev(), metadata.ino())))
}
fn check_state(home: &Path) -> io::Result<()> {
    // Refuse redirected parents/SQLite companions before either SQLite opens or
    // forwarding can make the core's existing state writer reachable.
    for dir in [home.join("state"), home.join("tasks")] {
        match fs::symlink_metadata(dir) {
            Ok(m) if !m.is_dir() || m.uid() != rustix::process::geteuid().as_raw() => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "unsafe task directory",
                ));
            }
            Ok(_) => (),
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
    }
    for name in [
        "tasks.db",
        "tasks.db-wal",
        "tasks.db-shm",
        "tasks.db-journal",
    ] {
        identity(&home.join("state").join(name))?;
    }
    Ok(())
}
impl Reader {
    fn open(home: &Path) -> Result<Self> {
        check_state(home)?;
        let path = home.join("state/tasks.db");
        let before = identity(&path)?;
        let db = if before.is_some() {
            let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            if identity(&path)? != before {
                return Err(io::Error::other("task database changed while opening").into());
            }
            db.busy_timeout(Duration::from_millis(5000))?;
            Some(db)
        } else {
            None
        };
        let current_schema = if let Some(db) = &db {
            let fields = db
                .prepare("PRAGMA table_info(tasks)")?
                .query_map([], |r| r.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ["record", "rev", "json_mtime", "archived"]
                .iter()
                .all(|field| fields.iter().any(|f| f == field))
        } else {
            false
        };
        Ok(Self {
            db,
            identity: before,
            directory_stamp: None,
            current_schema,
        })
    }
    fn check_import(&mut self, home: &Path) -> Result<()> {
        if !self.current_schema {
            return Err(StoreError::CompatibilityRequired);
        }
        let dir = home.join("tasks");
        let stamp = match directory_stamp(&dir) {
            Ok(stamp) => stamp,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Err(StoreError::CompatibilityRequired);
            }
            Err(e) => return Err(e.into()),
        };
        if self.directory_stamp.as_ref() == Some(&stamp) {
            return Ok(());
        }
        let db = self.db.as_ref().ok_or(StoreError::CompatibilityRequired)?;
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Some(id) = name.strip_suffix(".json").filter(|id| is_task_id(id)) else {
                continue;
            };
            let mtime = match mtime_ms(&entry.path()) {
                Ok(mtime) => mtime,
                Err(StoreError::Io(e)) if e.kind() == io::ErrorKind::NotFound => continue,
                // Bun's stat accepts timestamps predating UNIX_EPOCH. Other
                // metadata errors also belong to the authoritative TS import.
                Err(_) => return Err(StoreError::CompatibilityRequired),
            };
            let old: Option<Option<f64>> = db
                .query_row("SELECT json_mtime FROM tasks WHERE id=?", [id], |r| {
                    r.get(0)
                })
                .optional()?;
            if old != Some(Some(mtime)) {
                // Do not guess whether JSON is valid, newer, or already rejected:
                // importJson owns parsing, JS numbers and shared durable recovery.
                return Err(StoreError::CompatibilityRequired);
            }
        }
        self.directory_stamp = Some(stamp);
        Ok(())
    }
}
impl TaskLogReader {
    pub fn open(home: impl AsRef<Path>) -> Result<Self> {
        let home = home.as_ref().to_path_buf();
        let reader = RefCell::new(Reader::open(&home)?);
        Ok(Self { home, reader })
    }
    pub fn read(&self, id: &str) -> Result<Option<Value>> {
        if !is_task_id(id) {
            return Ok(None);
        }
        check_state(&self.home)?;
        let mut reader = self.reader.borrow_mut();
        if identity(&self.home.join("state/tasks.db"))? != reader.identity {
            *reader = Reader::open(&self.home)?;
        }
        reader.check_import(&self.home)?;
        let db = reader
            .db
            .as_ref()
            .ok_or(StoreError::CompatibilityRequired)?;
        let text: Option<String> = db
            .query_row("SELECT record FROM tasks WHERE id=?", [id], |r| r.get(0))
            .optional()?;
        text.map(|text| {
            let value: Value =
                serde_json::from_str(&text).map_err(|_| StoreError::CompatibilityRequired)?;
            if !value.is_object() {
                return Err(StoreError::CompatibilityRequired);
            }
            Ok(value)
        })
        .transpose()
    }
}

#[cfg(test)]
#[path = "task_log_reader/tests.rs"]
mod tests;
