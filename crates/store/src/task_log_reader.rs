//! Read-only projection of the TS compatibility import. No state writes or writer locks.
use super::*;
use rusqlite::OpenFlags;
use std::{cell::RefCell, collections::HashMap, os::unix::fs::MetadataExt};

struct Record {
    task: Value,
    rev: i64,
    mtime: Option<f64>,
}
impl Record {
    fn supersedes(&self, old: &Self) -> bool {
        self.rev > old.rev
            || (self.rev == old.rev && (old.mtime.is_none() || self.mtime > old.mtime))
    }
}
struct Reader {
    db: Option<Connection>,
    identity: Option<(u64, u64)>,
    directory_stamp: Option<String>,
    imported: HashMap<String, Record>,
}

/// A retained, read-only database connection with an in-memory legacy JSON merge.
/// Accepted JSON survives deletion for this reader, just as an imported TS row does.
/// Replacing the database discards that projection and starts a fresh import.
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
impl Reader {
    fn open(home: &Path) -> Result<Self> {
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
        Ok(Self {
            db,
            identity: before,
            directory_stamp: None,
            imported: HashMap::new(),
        })
    }
    fn row(&self, id: &str) -> Result<Option<Record>> {
        let Some(db) = &self.db else {
            return Ok(None);
        };
        db.query_row(
            "SELECT record,rev,json_mtime FROM tasks WHERE id=?",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<f64>>(2)?,
                ))
            },
        )
        .optional()?
        .map(|(text, rev, mtime)| {
            Ok(Record {
                task: parse_record(&text)?,
                rev,
                mtime,
            })
        })
        .transpose()
    }
    fn merged(&self, id: &str) -> Result<Option<Record>> {
        let row = self.row(id)?;
        if let Some(imported) = self.imported.get(id)
            && row.as_ref().is_none_or(|row| imported.supersedes(row))
        {
            return Ok(Some(Record {
                task: imported.task.clone(),
                rev: imported.rev,
                mtime: imported.mtime,
            }));
        }
        Ok(row)
    }
    fn import(&mut self, home: &Path) -> Result<()> {
        let dir = home.join("tasks");
        let stamp = match directory_stamp(&dir) {
            Ok(stamp) => stamp,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        if self.directory_stamp.as_ref() == Some(&stamp) {
            return Ok(());
        }
        // Match connection()/importJson(): scan only after an atomic directory change,
        // skip unchanged mtimes and reject older revisions, including restored JSON.
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
                Err(e) => return Err(e),
            };
            let old = self.merged(id)?;
            if old.as_ref().is_some_and(|row| row.mtime == Some(mtime)) {
                continue;
            }
            // TS treats malformed, unreadable and disappearing compatibility files as
            // corrupt records; SQL errors above must still propagate.
            let Ok(text) = fs::read_to_string(entry.path()) else {
                continue;
            };
            let Ok(mut task) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if !task.is_object() {
                continue;
            }
            if task.get("rev").is_none_or(Value::is_null) {
                task["rev"] = json!(1);
            }
            if !valid(&task, id) {
                continue;
            }
            let rev = revision(&task).ok_or(StoreError::InvalidRecord)?;
            task["rev"] = json!(rev);
            let next = Record {
                task,
                rev,
                mtime: Some(mtime),
            };
            if old.as_ref().is_none_or(|old| next.supersedes(old)) {
                self.imported.insert(id.into(), next);
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
        let mut reader = self.reader.borrow_mut();
        if identity(&self.home.join("state/tasks.db"))? != reader.identity {
            *reader = Reader::open(&self.home)?;
        }
        reader.import(&self.home)?;
        Ok(reader.merged(id)?.map(|row| row.task))
    }
}

#[cfg(test)]
#[path = "task_log_reader/tests.rs"]
mod tests;
