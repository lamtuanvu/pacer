//! `openReadOnlyStore` and its readers (`src/dispatch/readonly.ts`): a view of the
//! task store that runs no DDL, sets no journal mode and imports no legacy JSON.
//! A missing store creates no file, and a missing store or table reads as empty.
//!
//! SQLite may still create `tasks.db-wal` and `tasks.db-shm` beside a WAL-mode
//! store whose `state/` directory is writable. For a cleanly closed WAL store
//! this view reads the rows, while Bun's system SQLite on macOS fails the first
//! read and reads empty (or `conflict` when strict). The immutable fallback is
//! unreachable in both: the open succeeds, and any failure comes on the first
//! read, outside the fallback (issue #974).
#![allow(clippy::result_large_err)]
use pacer_foundation::api::{Code, CoreError};
use rusqlite::{Connection, OpenFlags, Params, Row, types::ValueRef};
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

use crate::js::{Object, num};
use crate::observation::stored_row;

/// A read-only task store. With `strict`, failures are `conflict` errors instead
/// of empty reads.
pub struct ReadOnlyStore {
    db: Option<Connection>,
    tables: HashSet<String>,
    immutable: bool,
    strict: bool,
}

/// One `work_reservations` row: `pools` as `JSON.parse` returns it.
#[derive(Debug, Clone, PartialEq)]
pub struct Reservation {
    pub pool_ids: Value,
    pub estimate: Value,
}

/// `JSON.parse(cell)`, which reads the cell's JavaScript `String()` text: `null`,
/// numbers, text, or a blob's bytes joined by commas.
pub(crate) fn parse_cell(cell: ValueRef<'_>) -> Option<Value> {
    let text = match cell {
        ValueRef::Null => "null".to_owned(),
        ValueRef::Integer(n) => n.to_string(),
        ValueRef::Real(n) => pacer_js_json::number_string(n),
        ValueRef::Text(text) => String::from_utf8_lossy(text).into_owned(),
        ValueRef::Blob(bytes) => bytes
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(","),
    };
    serde_json::from_str(&text).ok()
}

fn conflict(message: &str) -> CoreError {
    CoreError::new(Code::Conflict, message)
}

fn open(target: &str, flags: OpenFlags) -> rusqlite::Result<Connection> {
    let db = Connection::open_with_flags(target, flags)?;
    db.execute_batch("PRAGMA query_only = ON")?;
    Ok(db)
}

fn read_tables(db: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")?;
    let names = stmt.query_map([], |row| row.get::<_, String>(0))?;
    names.collect()
}

/// The store connection, or the immutable fallback for a cleanly closed WAL
/// database (no `-wal` content to miss).
fn connect(path: &Path) -> rusqlite::Result<(Connection, bool)> {
    let display = path.to_string_lossy();
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    match open(&display, flags) {
        Ok(db) => Ok((db, false)),
        Err(error) => {
            let wal = path.with_file_name("tasks.db-wal");
            if std::fs::metadata(&wal).is_ok_and(|m| m.len() > 0) {
                return Err(error);
            }
            let uri = format!("file:{display}?mode=ro&immutable=1");
            let db = open(&uri, flags | OpenFlags::SQLITE_OPEN_URI)?;
            Ok((db, true))
        }
    }
}

impl ReadOnlyStore {
    /// `openReadOnlyStore(ctx, strict)` over `<pacer_home>/state/tasks.db`.
    pub fn open(pacer_home: &Path, strict: bool) -> Result<Self, CoreError> {
        let path = pacer_home.join("state").join("tasks.db");
        let mut store = Self {
            db: None,
            tables: HashSet::new(),
            immutable: false,
            strict,
        };
        if !path.exists() {
            return Ok(store);
        }
        match connect(&path) {
            Ok((db, immutable)) => {
                store.db = Some(db);
                store.immutable = immutable;
            }
            Err(_) if strict => {
                return Err(conflict(
                    "Session reservations are unavailable; retry before changing workspaces",
                ));
            }
            Err(_) => return Ok(store),
        }
        store.refresh().map(|()| store)
    }

    /// The store exists and has a `tasks` table.
    pub fn available(&self) -> bool {
        self.db.is_some() && self.tables.contains("tasks")
    }

    /// True only for the cleanly closed WAL fallback, which cannot observe a later WAL.
    pub fn immutable(&self) -> bool {
        self.immutable
    }

    /// Re-reads the table list.
    pub fn refresh(&mut self) -> Result<(), CoreError> {
        let Some(db) = &self.db else {
            return Ok(());
        };
        match read_tables(db) {
            Ok(tables) => self.tables = tables,
            Err(_) => {
                self.tables.clear();
                if self.strict {
                    return Err(conflict("Session reservations are unreadable"));
                }
            }
        }
        Ok(())
    }

    pub fn has(&self, table: &str) -> bool {
        self.tables.contains(table)
    }

    /// Every row of `sql`; an error reads as no rows unless the store is strict.
    pub fn query<T>(
        &self,
        sql: &str,
        params: impl Params,
        map: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
    ) -> Result<Vec<T>, CoreError> {
        let Some(db) = &self.db else {
            return Ok(Vec::new());
        };
        let rows = db
            .prepare(sql)
            .and_then(|mut stmt| stmt.query_map(params, map)?.collect());
        match rows {
            Ok(rows) => Ok(rows),
            Err(_) if self.strict => Err(conflict("Session reservations could not be read")),
            Err(_) => Ok(Vec::new()),
        }
    }

    fn records(&self, sql: &str) -> Result<Vec<Value>, CoreError> {
        if !self.has("tasks") {
            return Ok(Vec::new());
        }
        let rows = self.query(sql, [], |row| Ok(parse_cell(row.get_ref(0)?)))?;
        Ok(rows.into_iter().flatten().collect())
    }

    /// `runningTasksReadOnly`: running task records, newest id first.
    pub fn running_tasks(&self) -> Result<Vec<Value>, CoreError> {
        self.records("SELECT record FROM tasks WHERE state='running' ORDER BY id DESC")
    }

    /// `slotTasksReadOnly`: tasks that may hold an executor slot (running, or
    /// waiting on a question with a live worker).
    pub fn slot_tasks(&self) -> Result<Vec<Value>, CoreError> {
        self.records(
            "SELECT record FROM tasks WHERE state IN ('running','needs_input') ORDER BY id DESC",
        )
    }

    /// `storedObservationsReadOnly`: the newest 2,048 rows that parse and have not expired.
    pub fn stored_observations(&self, now: f64) -> Result<Vec<Object>, CoreError> {
        if !self.has("work_observations") {
            return Ok(Vec::new());
        }
        let sql = "SELECT data FROM work_observations ORDER BY at DESC LIMIT 2048";
        let rows = self.query(sql, [], |row| Ok(stored_row(row.get_ref(0)?, now)))?;
        Ok(rows.into_iter().flatten().collect())
    }

    /// `reservationsReadOnly`: rows whose `pools` parse as JSON.
    pub fn reservations(&self) -> Result<Vec<Reservation>, CoreError> {
        if !self.has("work_reservations") {
            return Ok(Vec::new());
        }
        let sql = "SELECT pools,estimate FROM work_reservations";
        let rows = self.query(sql, [], |row| {
            let estimate = match row.get_ref(1)? {
                ValueRef::Integer(n) => num(n as f64),
                ValueRef::Real(n) => num(n),
                ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into()),
                ValueRef::Null | ValueRef::Blob(_) => Value::Null,
            };
            let pools = parse_cell(row.get_ref(0)?);
            Ok(pools.map(|pool_ids| Reservation { pool_ids, estimate }))
        })?;
        Ok(rows.into_iter().flatten().collect())
    }
}
