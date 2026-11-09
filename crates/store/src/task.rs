use pacer_foundation::{
    Ctx,
    lock::{LockError, LockOptions, with_lock},
};
use rusqlite::{
    Connection, OptionalExtension, TransactionBehavior, params, params_from_iter,
    types::Value as SqlValue,
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, UNIX_EPOCH},
};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Lock(#[from] LockError),
    #[error("task read requires the TypeScript compatibility path")]
    CompatibilityRequired,
    #[error("{0}")]
    Admission(String),
    #[error("invalid task record")]
    InvalidRecord,
    #[error("unknown task {0}")]
    UnknownTask(String),
    #[error("task was unchanged")]
    Unchanged,
    #[error("task revision conflict")]
    Conflict,
    #[error("task id collision")]
    Collision,
    #[error("process-wide task import tracking lock was poisoned")]
    ImportTrackingPoisoned,
}
type Result<T> = std::result::Result<T, StoreError>;
fn no_after(_: &Connection, _: &Value) -> Result<()> {
    Ok(())
}
const TERMINAL: &[&str] = &[
    "done",
    "partial",
    "failed",
    "limit",
    "stopped",
    "needs_input",
];

pub fn is_task_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 22
        && b.starts_with(b"t-")
        && b[10] == b'-'
        && b[17] == b'-'
        && b[2..10].iter().all(u8::is_ascii_digit)
        && b[11..17].iter().all(u8::is_ascii_digit)
        && b[18..22]
            .iter()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
}
fn number(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|v| v.is_finite())
}
fn import_numbers(value: &mut Value) {
    match value {
        Value::Number(n) => {
            if let Some(n) = n.as_f64() {
                // JSON.parse uses doubles; JSON.stringify writes negative zero as 0.
                *value = if n == 0.0 { json!(0) } else { json!(n) };
            }
        }
        Value::Array(values) => values.iter_mut().for_each(import_numbers),
        Value::Object(values) => values.values_mut().for_each(import_numbers),
        _ => (),
    }
}
pub(crate) fn revision(task: &Value) -> Option<i64> {
    let value = task.get("rev")?.as_f64()?;
    if value.is_finite() && value.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(&value)
    {
        Some(value as i64)
    } else {
        None
    }
}
fn field<'a>(task: &'a Value, key: &str) -> Option<&'a str> {
    task.get(key)?.as_str()
}
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Bool(true) | Value::Array(_) | Value::Object(_)) => true,
    }
}
fn valid(task: &Value, id: &str) -> bool {
    field(task, "id") == Some(id)
        && is_task_id(id)
        && number(task.get("createdAt")).is_some()
        && task
            .get("attempts")
            .and_then(Value::as_array)
            .is_some_and(|a| {
                a.iter().all(|v| {
                    number(v.get("startedAt")).is_some() && number(v.get("endedAt")).is_some()
                })
            })
        && field(task, "state")
            .is_some_and(|s| s == "queued" || s == "running" || TERMINAL.contains(&s))
        && task
            .pointer("/brief/repo")
            .and_then(Value::as_str)
            .is_some()
        && revision(task).is_some()
}
fn max_number(values: impl Iterator<Item = Option<f64>>) -> f64 {
    values.flatten().fold(f64::NEG_INFINITY, f64::max)
}
pub fn settled_at(task: &Value) -> f64 {
    let attempts = task
        .get("attempts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|a| number(a.get("endedAt")));
    let latest = max_number(
        [
            number(task.get("settledAt")),
            number(task.pointer("/review/at")),
        ]
        .into_iter()
        .chain(attempts),
    );
    if latest.is_finite() {
        latest.max(number(task.get("createdAt")).unwrap_or(0.0))
    } else {
        f64::INFINITY
    }
}
fn activity_at(task: &Value) -> f64 {
    let attempts = task
        .get("attempts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|a| [number(a.get("startedAt")), number(a.get("endedAt"))]);
    max_number(
        [
            number(task.get("createdAt")),
            number(task.get("attemptStartedAt")),
            number(task.pointer("/review/at")),
            number(task.pointer("/reviewRequest/at")),
        ]
        .into_iter()
        .chain(attempts),
    )
}
fn row_values(task: &Value, now: f64) -> Result<[SqlValue; 9]> {
    let id = field(task, "id").ok_or(StoreError::InvalidRecord)?;
    let state = field(task, "state").ok_or(StoreError::InvalidRecord)?;
    let settled = if TERMINAL.contains(&state) && settled_at(task).is_finite() {
        SqlValue::Real(settled_at(task))
    } else {
        SqlValue::Null
    };
    Ok([
        SqlValue::Text(id.into()),
        SqlValue::Integer(revision(task).ok_or(StoreError::InvalidRecord)?),
        SqlValue::Text(state.into()),
        SqlValue::Real(number(task.get("createdAt")).ok_or(StoreError::InvalidRecord)?),
        SqlValue::Real(now.max(activity_at(task))),
        settled,
        field(task.get("brief").ok_or(StoreError::InvalidRecord)?, "repo")
            .map_or(SqlValue::Null, |r| SqlValue::Text(r.into())),
        SqlValue::Text(serde_json::to_string(task)?),
        SqlValue::Integer(i64::from(truthy(task.get("archived")))),
    ])
}
fn parse_record(text: &str) -> Result<Value> {
    let mut value: Value = serde_json::from_str(text)?;
    if value.get("rev").is_none_or(Value::is_null) {
        value["rev"] = json!(1);
    }
    Ok(value)
}
fn mtime_ms(path: &Path) -> Result<f64> {
    let time = fs::metadata(path)?.modified()?;
    let (duration, sign) = match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => (duration, 1.0),
        Err(error) => (error.duration(), -1.0),
    };
    Ok(sign
        * (duration.as_secs() as f64 * 1000.0 + f64::from(duration.subsec_nanos()) / 1_000_000.0))
}
#[cfg(unix)]
pub(crate) fn private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}
#[cfg(not(unix))]
pub(crate) fn private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)
}
fn private_file(path: &Path) -> io::Result<File> {
    let mut o = OpenOptions::new();
    o.write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let f = o.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(f)
}
/// Writes the JSON copy atomically (temp file + rename) and returns its
/// (mtime in ms, inode) signature, matching what the import scan compares
/// against the row.
fn write_json(home: &Path, task: &Value) -> Result<(f64, u64)> {
    let id = field(task, "id").ok_or(StoreError::InvalidRecord)?;
    let dir = if truthy(task.get("archived")) {
        let month = archive_month(number(task.get("createdAt")).ok_or(StoreError::InvalidRecord)?)?;
        let root = home.join("archive");
        private_dir(&root)?;
        let month = root.join(month);
        private_dir(&month)?;
        month.join(id)
    } else {
        home.join("tasks")
    };
    private_dir(&dir)?;
    let target = dir.join(format!("{id}.json"));
    let temp = dir.join(format!(
        "{id}.{}.{}.tmp",
        std::process::id(),
        unique_suffix()
    ));
    let result = (|| -> Result<(f64, u64)> {
        let mut o = OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut f = o.open(&temp)?;
        f.write_all(serde_json::to_string(task)?.as_bytes())?;
        drop(f);
        fs::rename(&temp, &target)?;
        Ok((mtime_ms(&target)?, file_inode(&target)?))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn unique_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos())
}
pub(crate) fn archive_month(seconds: f64) -> Result<String> {
    // UTC calendar month, matching Date.toISOString().slice(0, 7).
    let days = (seconds / 86_400.0).floor() as i64;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + i64::from(m <= 2);
    if !(0..=9999).contains(&year) {
        return Err(StoreError::InvalidRecord);
    }
    Ok(format!("{year:04}-{m:02}"))
}

#[path = "task_log_reader.rs"]
mod log_reader;
pub use log_reader::TaskLogReader;

/// Tracks which (db path, inode) pairs have already run a JSON import in
/// this process, so request-path opens after the first never pay for a
/// directory scan. Keyed by inode (not path alone) so a replaced home with
/// the same path but a different underlying file imports again.
static IMPORTED: LazyLock<Mutex<HashSet<(PathBuf, u64)>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Same object list as TypeScript `schemaReady` in `src/tasks/store.ts`.
fn schema_ready(db: &Connection) -> Result<bool> {
    let fields: Vec<String> = db
        .prepare("PRAGMA table_info(tasks)")?
        .query_map([], |r| r.get(1))?
        .collect::<rusqlite::Result<_>>()?;
    if !["json_mtime", "archived", "json_ino"]
        .iter()
        .all(|name| fields.iter().any(|f| f == name))
    {
        return Ok(false);
    }
    let objects: Vec<String> = db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('index', 'table')")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok([
        "tasks_state",
        "tasks_updated_at",
        "tasks_created_at",
        "tasks_retention",
        "task_first_settle",
    ]
    .iter()
    .all(|name| objects.iter().any(|o| o == name)))
}

pub struct TaskStore {
    pub(crate) home: PathBuf,
    db: Connection,
    generation: u64,
    inode: u64,
    directory_stamp: Option<String>,
}
#[derive(Default)]
pub struct TaskFilter<'a> {
    pub states: Option<&'a [&'a str]>,
    pub updated_since: Option<f64>,
    pub settled_before: Option<f64>,
    pub all: bool,
    pub before: Option<&'a str>,
    pub limit: Option<usize>,
}
impl TaskStore {
    pub fn open(home: impl AsRef<Path>) -> Result<Self> {
        let home = home.as_ref().to_path_buf();
        private_dir(&home.join("state"))?;
        private_dir(&home.join("tasks"))?;
        let path = home.join("state/tasks.db");
        drop(private_file(&path)?);
        let mut db = Connection::open(&path)?;
        db.busy_timeout(Duration::from_millis(5000))?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "NORMAL")?;
        // Skip the IMMEDIATE schema transaction once the schema is ready, so a
        // request-path open never waits behind another writer's reservation
        // just to re-run idempotent DDL.
        let fresh_schema = !schema_ready(&db)?;
        if fresh_schema {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, rev INTEGER, state TEXT, created_at REAL, updated_at REAL, settled_at REAL NULL, repo TEXT NULL, record TEXT NOT NULL, json_mtime REAL, archived INTEGER NOT NULL DEFAULT 0, json_ino INTEGER); CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state); CREATE INDEX IF NOT EXISTS tasks_updated_at ON tasks(updated_at); CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks(created_at);")?;
            let fields: Vec<String> = tx
                .prepare("PRAGMA table_info(tasks)")?
                .query_map([], |r| r.get(1))?
                .collect::<rusqlite::Result<_>>()?;
            if !fields.iter().any(|v| v == "json_mtime") {
                tx.execute_batch("ALTER TABLE tasks ADD COLUMN json_mtime REAL")?;
            }
            if !fields.iter().any(|v| v == "archived") {
                tx.execute_batch(
                    "ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
                )?;
            }
            if !fields.iter().any(|v| v == "json_ino") {
                tx.execute_batch("ALTER TABLE tasks ADD COLUMN json_ino INTEGER")?;
            }
            tx.execute_batch("CREATE INDEX IF NOT EXISTS tasks_retention ON tasks(archived, settled_at); CREATE TABLE IF NOT EXISTS task_first_settle(task_id TEXT PRIMARY KEY, at REAL NOT NULL);")?;
            tx.commit()?;
        }
        let inode = file_inode(&path)?;
        let mut store = Self {
            home,
            db,
            generation: 1,
            inode,
            directory_stamp: None,
        };
        // Import JSON on the first successful open in this process for this
        // (path, inode) pair, and whenever the database is new or holds no
        // tasks: a database recreated at a reused inode (common on Linux) must
        // still be rebuilt from the JSON copies. Later opens rely on the
        // TypeScript core's periodic reconcile, which imports into the same
        // database, instead of importing on every request.
        let key = (path.clone(), inode);
        let seen = IMPORTED
            .lock()
            .map_err(|_| StoreError::ImportTrackingPoisoned)?
            .contains(&key);
        let rebuild = fresh_schema || {
            let empty: bool =
                store
                    .db
                    .query_row("SELECT NOT EXISTS(SELECT 1 FROM tasks)", [], |r| r.get(0))?;
            empty && has_task_json(&store.home.join("tasks"))?
        };
        if !seen || rebuild {
            store.import_json()?;
            // Recorded only after a successful import, so a failed first
            // import (a busy writer, an unreadable directory) is retried.
            IMPORTED
                .lock()
                .map_err(|_| StoreError::ImportTrackingPoisoned)?
                .insert(key);
        }
        Ok(store)
    }
    pub(crate) fn refresh(&mut self) -> Result<()> {
        let current = match file_inode(&self.home.join("state/tasks.db")) {
            Ok(inode) => Some(inode),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        if current != Some(self.inode) {
            let generation = self.generation + 1;
            *self = Self::open(&self.home)?;
            self.generation = generation;
        }
        Ok(())
    }
    fn import_json(&mut self) -> Result<usize> {
        self.import_json_with(false)
    }
    /// Force a full JSON import regardless of the cached directory stamp,
    /// returning the number of task rows actually imported (rows where the
    /// SQL upsert's revision guard accepted the write). For explicit recovery
    /// and tests; never called from a request path.
    pub fn reconcile_json(&mut self) -> Result<usize> {
        self.import_json_with(true)
    }
    fn import_json_with(&mut self, force: bool) -> Result<usize> {
        let dir = self.home.join("tasks");
        let stamp = directory_stamp(&dir)?;
        if !force && self.directory_stamp.as_ref() == Some(&stamp) {
            return Ok(0);
        }
        let mut imported = 0usize;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Some(id) = name.strip_suffix(".json") else {
                continue;
            };
            if !is_task_id(id) {
                continue;
            }
            let path = entry.path();
            let mtime = match mtime_ms(&path) {
                Ok(v) => v,
                Err(StoreError::Io(e)) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            };
            let ino = match file_inode(&path) {
                Ok(v) => v,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            };
            // Bun returns SQLite storage types without coercing text to a number.
            // Only a numeric json_mtime can strictly equal stat().mtimeMs. The
            // revision comparison belongs to the SQL UPSERT below, not a typed read.
            let row: Option<(SqlValue, SqlValue)> = tx
                .query_row(
                    "SELECT json_mtime, json_ino FROM tasks WHERE id=?",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            // The row's (mtime, inode) pair marks the copy it already holds. An
            // atomic rewrite within the same coarse clock tick keeps the mtime
            // but replaces the inode, so both must match before the file can be
            // skipped without reading. A row written by TypeScript, which has no
            // json_ino, is read once and marked below.
            let reconciled = row.is_some_and(|(marked_mtime, marked_ino)| {
                let same_mtime = match marked_mtime {
                    SqlValue::Real(value) => value == mtime,
                    SqlValue::Integer(value) => value as f64 == mtime,
                    _ => false,
                };
                same_mtime
                    && matches!(marked_ino, SqlValue::Integer(value) if value >= 0 && value as u64 == ino)
            });
            if reconciled {
                continue;
            }
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            };
            let Ok(mut task) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            if task.get("rev").is_none_or(Value::is_null) {
                task["rev"] = json!(1);
            }
            if !valid(&task, id) {
                continue;
            }
            import_numbers(&mut task);
            // JSON.parse represents integral decimal and exponent forms as integers.
            task["rev"] = json!(revision(&task).ok_or(StoreError::InvalidRecord)?);
            let values = row_values(&task, activity_at(&task))?;
            let accepted = tx.execute("INSERT INTO tasks(id,rev,state,created_at,updated_at,settled_at,repo,record,archived,json_mtime,json_ino) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET rev=excluded.rev,state=excluded.state,created_at=excluded.created_at,updated_at=excluded.updated_at,settled_at=excluded.settled_at,repo=excluded.repo,record=excluded.record,archived=excluded.archived,json_mtime=excluded.json_mtime,json_ino=excluded.json_ino WHERE excluded.rev>tasks.rev OR (excluded.rev=tasks.rev AND (tasks.json_mtime IS NULL OR excluded.json_mtime>tasks.json_mtime))", params_from_iter(values.into_iter().chain([SqlValue::Real(mtime), SqlValue::Integer(ino as i64)])))?;
            if accepted == 0 {
                // The row kept a newer revision or an equal copy, so rescanning
                // this file cannot change it (TypeScript remembers the same per
                // connection). Mark the file as reconciled for the pair check
                // above; json_mtime stays the revision tiebreaker.
                tx.execute(
                    "UPDATE tasks SET json_ino=? WHERE id=? AND json_mtime=?",
                    params![ino as i64, id, mtime],
                )?;
            }
            imported += accepted;
            if let Some(at) = number(task.get("settledAt")) {
                tx.execute(
                    "INSERT OR IGNORE INTO task_first_settle(task_id,at) VALUES(?,?)",
                    params![id, at],
                )?;
            }
        }
        tx.commit()?;
        self.directory_stamp = Some(stamp);
        Ok(imported)
    }
    pub fn version(&mut self) -> Result<String> {
        self.refresh()?;
        let external: i64 = self.db.query_row("PRAGMA data_version", [], |r| r.get(0))?;
        let local: i64 = self
            .db
            .query_row("SELECT total_changes()", [], |r| r.get(0))?;
        Ok(format!("{}:{external}:{local}", self.generation))
    }
    pub fn connection(&mut self) -> Result<&Connection> {
        self.refresh()?;
        Ok(&self.db)
    }
    pub fn read(&mut self, id: &str) -> Result<Option<Value>> {
        if !is_task_id(id) {
            return Ok(None);
        }
        self.refresh()?;
        self.db
            .query_row("SELECT record FROM tasks WHERE id=?", [id], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .map(|s| parse_record(&s))
            .transpose()
    }
    pub fn list(&mut self, filter: &TaskFilter<'_>) -> Result<Vec<Value>> {
        if filter.states == Some(&[][..]) || filter.limit == Some(0) {
            return Ok(Vec::new());
        }
        self.refresh()?;
        let mut clauses = Vec::new();
        let mut bind = Vec::<SqlValue>::new();
        if !filter.all {
            clauses.push("archived=0".to_owned());
        }
        if let Some(v) = filter.settled_before {
            clauses.push("settled_at<?".into());
            bind.push(SqlValue::Real(v));
        }
        if let Some(v) = filter.before {
            clauses.push("id<?".into());
            bind.push(SqlValue::Text(v.into()));
        }
        if let Some(states) = filter.states {
            clauses.push(format!("state IN ({})", vec!["?"; states.len()].join(",")));
            bind.extend(states.iter().map(|s| SqlValue::Text((*s).into())));
        }
        if let Some(v) = filter.updated_since {
            clauses.push("updated_at>=?".into());
            bind.push(SqlValue::Real(v));
        }
        let sql = format!(
            "SELECT record FROM tasks {} ORDER BY id DESC LIMIT ?",
            if clauses.is_empty() {
                String::new()
            } else {
                format!("WHERE {}", clauses.join(" AND "))
            }
        );
        bind.push(filter.limit.map_or(SqlValue::Integer(-1), |n| {
            SqlValue::Integer(i64::try_from(n).unwrap_or(i64::MAX))
        }));
        let mut stmt = self.db.prepare(&sql)?;
        let records = stmt
            .query_map(params_from_iter(bind), |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        records.into_iter().map(|s| parse_record(&s)).collect()
    }
    pub fn list_live(&mut self) -> Result<Vec<Value>> {
        self.refresh()?;
        let mut stmt = self.db.prepare("SELECT record FROM tasks WHERE json_extract(record, '$.live') IS NOT NULL ORDER BY id DESC")?;
        let records = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        records.into_iter().map(|s| parse_record(&s)).collect()
    }
    pub fn list_active_and_recent(&mut self, updated_since: f64) -> Result<Vec<Value>> {
        self.refresh()?;
        let mut stmt = self.db.prepare("SELECT record FROM tasks WHERE archived=0 AND (updated_at>=? OR state IN ('queued','running')) ORDER BY id DESC")?;
        let records = stmt
            .query_map([updated_since], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        records.into_iter().map(|s| parse_record(&s)).collect()
    }
    pub fn insert(&mut self, task: &Value, now: f64) -> Result<()> {
        self.insert_with(task, now, |_| Ok(()))
    }
    /// Admit related domain rows under the task insert's IMMEDIATE transaction.
    /// Validation runs before JSON write-through, so rejection leaves no orphan.
    pub fn insert_with(
        &mut self,
        task: &Value,
        now: f64,
        admit: impl FnOnce(&Connection) -> Result<()>,
    ) -> Result<()> {
        let id = field(task, "id").ok_or(StoreError::InvalidRecord)?;
        if !valid(task, id) {
            return Err(StoreError::InvalidRecord);
        }
        self.refresh()?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let values = row_values(task, now)?;
        if tx.execute("INSERT OR IGNORE INTO tasks(id,rev,state,created_at,updated_at,settled_at,repo,record,archived) VALUES(?,?,?,?,?,?,?,?,?)", params_from_iter(values))? == 0 { return Err(StoreError::Collision); }
        admit(&tx)?;
        let (mtime, ino) = write_json(&self.home, task)?;
        tx.execute(
            "UPDATE tasks SET json_mtime=?, json_ino=? WHERE id=?",
            params![mtime, ino as i64, id],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn update(
        &mut self,
        id: &str,
        expected_rev: i64,
        now: f64,
        mutate: impl FnOnce(&mut Value),
    ) -> Result<Value> {
        if !is_task_id(id) {
            return Err(StoreError::InvalidRecord);
        }
        let ctx = Ctx::with(
            self.home.clone(),
            self.home.clone(),
            Default::default(),
            now,
        );
        with_lock(&ctx, &format!("task-{id}"), LockOptions::default(), || {
            self.update_locked(id, expected_rev, now, mutate)
        })?
    }
    /// Update current state under the shared task lock, without a caller CAS.
    /// Lifecycle metadata maintenance must not use revisions from a prior list.
    pub fn update_current(
        &mut self,
        id: &str,
        now: f64,
        mutate: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<Value> {
        let ctx = Ctx::with(
            self.home.clone(),
            self.home.clone(),
            Default::default(),
            now,
        );
        with_lock(&ctx, &format!("task-{id}"), LockOptions::default(), || {
            let current = self
                .read(id)?
                .ok_or_else(|| StoreError::UnknownTask(id.into()))?;
            let rev = revision(&current).ok_or(StoreError::InvalidRecord)?;
            self.update_admitted_locked(id, rev, now, |_, task| mutate(task), no_after)
        })?
    }
    pub(crate) fn update_locked(
        &mut self,
        id: &str,
        expected_rev: i64,
        now: f64,
        mutate: impl FnOnce(&mut Value),
    ) -> Result<Value> {
        self.update_admitted_locked(
            id,
            expected_rev,
            now,
            |_, task| {
                mutate(task);
                Ok(())
            },
            no_after,
        )
    }
    /// Recheck domain admission and mutate while holding the same SQLite writer
    /// reservation. The caller holds any required cross-runtime operation lock.
    pub fn update_admitted(
        &mut self,
        id: &str,
        expected_rev: i64,
        now: f64,
        mutate: impl FnOnce(&Connection, &mut Value) -> Result<()>,
    ) -> Result<Value> {
        let ctx = Ctx::with(
            self.home.clone(),
            self.home.clone(),
            Default::default(),
            now,
        );
        with_lock(&ctx, &format!("task-{id}"), LockOptions::default(), || {
            self.update_admitted_locked(id, expected_rev, now, mutate, no_after)
        })?
    }
    /// `update_admitted`, then `after` sees the written record in the same
    /// transaction, after the `tasks` row triggers have run.
    pub fn update_admitted_then(
        &mut self,
        id: &str,
        expected_rev: i64,
        now: f64,
        mutate: impl FnOnce(&Connection, &mut Value) -> Result<()>,
        after: impl FnOnce(&Connection, &Value) -> Result<()>,
    ) -> Result<Value> {
        let ctx = Ctx::with(
            self.home.clone(),
            self.home.clone(),
            Default::default(),
            now,
        );
        with_lock(&ctx, &format!("task-{id}"), LockOptions::default(), || {
            self.update_admitted_locked_inner(id, expected_rev, now, mutate, after, false)
        })?
    }
    /// `update_admitted_then`, but forces the write and revision bump even
    /// when the record reads back unchanged. For callers whose domain state
    /// lives outside the task record (the work dependency graph), so an
    /// `expect_rev` held by another caller must still see a conflict after
    /// it changes, matching TypeScript `touchTask`.
    pub fn touch_admitted_then(
        &mut self,
        id: &str,
        expected_rev: i64,
        now: f64,
        mutate: impl FnOnce(&Connection, &mut Value) -> Result<()>,
        after: impl FnOnce(&Connection, &Value) -> Result<()>,
    ) -> Result<Value> {
        let ctx = Ctx::with(
            self.home.clone(),
            self.home.clone(),
            Default::default(),
            now,
        );
        with_lock(&ctx, &format!("task-{id}"), LockOptions::default(), || {
            self.update_admitted_locked_inner(id, expected_rev, now, mutate, after, true)
        })?
    }
    fn update_admitted_locked(
        &mut self,
        id: &str,
        expected_rev: i64,
        now: f64,
        mutate: impl FnOnce(&Connection, &mut Value) -> Result<()>,
        after: impl FnOnce(&Connection, &Value) -> Result<()>,
    ) -> Result<Value> {
        self.update_admitted_locked_inner(id, expected_rev, now, mutate, after, false)
    }
    /// `force`: skip the no-op comparison and always write and bump `rev`.
    fn update_admitted_locked_inner(
        &mut self,
        id: &str,
        expected_rev: i64,
        now: f64,
        mutate: impl FnOnce(&Connection, &mut Value) -> Result<()>,
        after: impl FnOnce(&Connection, &Value) -> Result<()>,
        force: bool,
    ) -> Result<Value> {
        if !is_task_id(id) {
            return Err(StoreError::InvalidRecord);
        }
        let home = self.home.clone();
        self.refresh()?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let text: String = tx
            .query_row("SELECT record FROM tasks WHERE id=?", [id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| StoreError::UnknownTask(id.into()))?;
        let mut task: Value = serde_json::from_str(&text)?;
        let rev = revision(&task).unwrap_or(1);
        if rev != expected_rev {
            return Err(StoreError::Conflict);
        }
        let before = task.clone();
        let prior = field(&task, "state").unwrap_or("").to_owned();
        mutate(&tx, &mut task)?;
        let terminal = TERMINAL.contains(&field(&task, "state").ok_or(StoreError::InvalidRecord)?);
        if terminal && !TERMINAL.contains(&prior.as_str()) {
            task["settledAt"] = json!(now);
        }
        if !terminal {
            task.as_object_mut()
                .ok_or(StoreError::InvalidRecord)?
                .remove("settledAt");
        }
        task["id"] = json!(id);
        // An update that changes nothing writes nothing: no JSON rewrite,
        // revision bump or row update (TypeScript `updateTask` parity). The
        // transaction still commits and `after` still runs, so writes the
        // callbacks made to other tables are kept, as in TypeScript.
        if !force && task == before {
            after(&tx, &task)?;
            tx.commit()?;
            return Ok(task);
        }
        task["rev"] = json!(rev + 1);
        if !valid(&task, id) {
            return Err(StoreError::InvalidRecord);
        }
        let (mtime, ino) = write_json(&home, &task)?;
        if let Some(at) = number(task.get("settledAt")) {
            tx.execute(
                "INSERT OR IGNORE INTO task_first_settle(task_id,at) VALUES(?,?)",
                params![id, at],
            )?;
        }
        let values = row_values(
            &task,
            if now.is_finite() {
                now
            } else {
                current_seconds()
            },
        )?;
        let changed = tx.execute("UPDATE tasks SET rev=?,state=?,created_at=?,updated_at=?,settled_at=?,repo=?,record=?,archived=?,json_mtime=?,json_ino=? WHERE id=? AND rev=?",
                params_from_iter(values.into_iter().skip(1).chain([SqlValue::Real(mtime), SqlValue::Integer(ino as i64), SqlValue::Text(id.into()), SqlValue::Integer(rev)])))?;
        if changed != 1 {
            return Err(StoreError::Conflict);
        }
        after(&tx, &task)?;
        tx.commit()?;
        Ok(task)
    }
    pub fn home_path(&self) -> &Path {
        &self.home
    }
    pub(crate) fn home(&self) -> &Path {
        &self.home
    }
}
/// Whether the tasks directory holds any JSON task copy to rebuild from.
fn has_task_json(dir: &Path) -> io::Result<bool> {
    for entry in fs::read_dir(dir)? {
        if entry?.file_name().to_string_lossy().ends_with(".json") {
            return Ok(true);
        }
    }
    Ok(false)
}
fn current_seconds() -> f64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64())
}
#[cfg(unix)]
fn file_inode(path: &Path) -> io::Result<u64> {
    use std::os::unix::fs::MetadataExt;
    Ok(fs::metadata(path)?.ino())
}
#[cfg(not(unix))]
fn file_inode(path: &Path) -> io::Result<u64> {
    Ok(fs::metadata(path)?.len())
}
#[cfg(unix)]
fn directory_stamp(path: &Path) -> io::Result<String> {
    use std::os::unix::fs::MetadataExt;
    let m = fs::metadata(path)?;
    Ok(format!(
        "{}:{}:{}",
        m.ino(),
        m.mtime_nsec() as i128 + m.mtime() as i128 * 1_000_000_000,
        m.ctime_nsec() as i128 + m.ctime() as i128 * 1_000_000_000
    ))
}
#[cfg(not(unix))]
fn directory_stamp(path: &Path) -> io::Result<String> {
    Ok(format!("{:?}", fs::metadata(path)?.modified()?))
}

pub fn retention_eligible(task: &Value, days: i64, now: f64) -> bool {
    if days <= 0
        || truthy(task.get("archived"))
        || !field(task, "state").is_some_and(|s| TERMINAL.contains(&s))
        || !(truthy(task.get("review")) || truthy(task.get("dismissed")))
        || settled_at(task) >= now - days as f64 * 86_400.0
        || truthy(task.pointer("/run/remoteWorktree"))
    {
        return false;
    }
    [
        task.get("worktree"),
        task.pointer("/result/worktree"),
        if task.pointer("/run/mode").and_then(Value::as_str) == Some("new") {
            task.pointer("/run/workdir")
        } else {
            None
        },
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .all(|p| p.is_empty() || !Path::new(p).exists())
}
