//! Resumable bootstrap: clearing rows, projecting current records, then ready.
//! Every transaction revalidates schema identity and progress before advancing.
use super::{Result, StoreError, projection};
use rusqlite::{Connection, TransactionBehavior, params, types::Value};
use std::{
    collections::HashMap,
    thread,
    time::{Duration, Instant},
};

const META: &str = "CREATE TABLE IF NOT EXISTS task_cost_meta_v1(version INTEGER NOT NULL, phase TEXT NOT NULL, cursor TEXT)";
const DATA: &str = "CREATE TABLE IF NOT EXISTS task_cost_invalid_v1(owner TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS task_cost_intervals_v1(
 owner TEXT NOT NULL, record_id TEXT NOT NULL, kind INTEGER NOT NULL, ordinal INTEGER NOT NULL,
 start_token TEXT, end_token TEXT, start_bound REAL, end_bound REAL,
 PRIMARY KEY(owner,kind,ordinal));";
const INDEXES: &str = "CREATE INDEX IF NOT EXISTS task_cost_exact_v1 ON task_cost_intervals_v1(end_bound,start_bound,record_id)
 WHERE kind=0 AND start_bound IS NOT NULL AND end_bound IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_cost_residual_v1 ON task_cost_intervals_v1(owner,ordinal)
 WHERE kind=0 AND (start_bound IS NULL OR end_bound IS NULL);
CREATE INDEX IF NOT EXISTS task_cost_pending_v1 ON task_cost_intervals_v1(start_bound,record_id) WHERE kind=1;";
const OBJECTS: &[(&str, &str, &str)] = &[
    ("task_cost_meta_v1", "table", "task_cost_meta_v1"),
    ("task_cost_invalid_v1", "table", "task_cost_invalid_v1"),
    ("task_cost_intervals_v1", "table", "task_cost_intervals_v1"),
    ("task_cost_insert_v1", "trigger", "tasks"),
    ("task_cost_update_v1", "trigger", "tasks"),
    ("task_cost_delete_v1", "trigger", "tasks"),
    ("task_cost_exact_v1", "index", "task_cost_intervals_v1"),
    ("task_cost_residual_v1", "index", "task_cost_intervals_v1"),
    ("task_cost_pending_v1", "index", "task_cost_intervals_v1"),
];
const RECORD_BATCH: i64 = 16;
const ROW_BATCH: i64 = 256;
const WORK_BUDGET: Duration = Duration::from_millis(10);

#[derive(Debug, PartialEq)]
enum State {
    Repair,
    Clearing,
    Building(Option<String>),
    Ready,
}
fn invalid(message: &str) -> StoreError {
    StoreError::Admission(format!("cost projection: {message}"))
}
fn fields(db: &Connection) -> Result<Vec<(String, String, i64)>> {
    Ok(db
        .prepare("PRAGMA table_info(task_cost_meta_v1)")?
        .query_map([], |r| Ok((r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?)
}
fn legacy(fields: &[(String, String, i64)]) -> bool {
    fields == [("version".into(), "INTEGER".into(), 1)]
}
fn inspect(db: &Connection) -> Result<State> {
    let objects: HashMap<String, (String, String)> = db
        .prepare("SELECT name,type,tbl_name FROM sqlite_master WHERE name LIKE 'task_cost_%_v1'")?
        .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?
        .collect::<rusqlite::Result<_>>()?;
    for (name, kind, owner) in OBJECTS {
        if let Some((actual_kind, actual_owner)) = objects.get(*name)
            && (actual_kind != kind || actual_owner != owner)
        {
            return Err(invalid("schema object has unexpected type or owner"));
        }
    }
    if !objects.contains_key("task_cost_meta_v1") {
        return Ok(State::Repair);
    }
    let shape = fields(db)?;
    if legacy(&shape) {
        let versions: Vec<Value> = db
            .prepare("SELECT version FROM task_cost_meta_v1")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        if versions.len() > 1 || versions.iter().any(|v| v != &Value::Integer(1)) {
            return Err(invalid("unsupported legacy metadata version or contents"));
        }
        return Ok(State::Repair);
    }
    if shape
        != [
            ("version".into(), "INTEGER".into(), 1),
            ("phase".into(), "TEXT".into(), 1),
            ("cursor".into(), "TEXT".into(), 0),
        ]
    {
        return Err(invalid("unsupported metadata shape"));
    }
    let rows: Vec<(Value, Value, Value)> = db
        .prepare("SELECT version,phase,cursor FROM task_cost_meta_v1")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if rows.is_empty() {
        return Ok(State::Repair);
    }
    if rows.len() != 1 {
        return Err(invalid("inconsistent metadata row count"));
    }
    let (version, phase, cursor) = &rows[0];
    if version != &Value::Integer(2) {
        return Err(invalid("unsupported metadata version"));
    }
    let state = match (phase, cursor) {
        (Value::Text(p), Value::Null) if p == "clearing" => State::Clearing,
        (Value::Text(p), Value::Null) if p == "ready" => State::Ready,
        (Value::Text(p), Value::Null) if p == "building" => State::Building(None),
        (Value::Text(p), Value::Text(c)) if p == "building" => State::Building(Some(c.clone())),
        _ => return Err(invalid("inconsistent phase or cursor")),
    };
    // Indexes are intentionally absent while clearing. Building/ready requires
    // every object. Any missing maintenance restarts, never advances old cursor.
    let required = if state == State::Clearing {
        &OBJECTS[..6]
    } else {
        OBJECTS
    };
    if required
        .iter()
        .any(|(name, _, _)| !objects.contains_key(*name))
    {
        return Ok(State::Repair);
    }
    Ok(state)
}

pub(super) fn ready(db: &Connection) -> Result<bool> {
    Ok(inspect(db)? == State::Ready)
}

fn initialize(db: &Connection) -> Result<()> {
    // inspect() has rejected wrong-kind/owner collisions and future versions.
    if legacy(&fields(db)?) {
        db.execute_batch("DROP TABLE task_cost_meta_v1")?;
    }
    db.execute_batch(META)?;
    db.execute_batch(DATA)?;
    db.execute("DELETE FROM task_cost_meta_v1", [])?;
    db.execute(
        "INSERT INTO task_cost_meta_v1 VALUES(2,'clearing',NULL)",
        [],
    )?;
    let insert=projection("SELECT NEW.id AS owner,NEW.record AS record WHERE (SELECT phase FROM task_cost_meta_v1) IN ('building','ready')").join("\n");
    db.execute_batch(&format!(
        "
DROP TRIGGER IF EXISTS task_cost_insert_v1;
DROP TRIGGER IF EXISTS task_cost_update_v1;
DROP TRIGGER IF EXISTS task_cost_delete_v1;
CREATE TRIGGER task_cost_insert_v1 AFTER INSERT ON tasks BEGIN
 DELETE FROM task_cost_intervals_v1 WHERE owner=NEW.id;
 DELETE FROM task_cost_invalid_v1 WHERE owner=NEW.id;
 {insert} END;
CREATE TRIGGER task_cost_update_v1 AFTER UPDATE OF record,id ON tasks
 WHEN NEW.record IS NOT OLD.record OR NEW.id IS NOT OLD.id BEGIN
 DELETE FROM task_cost_intervals_v1 WHERE owner IN (OLD.id,NEW.id);
 DELETE FROM task_cost_invalid_v1 WHERE owner IN (OLD.id,NEW.id);
 {insert} END;
CREATE TRIGGER task_cost_delete_v1 AFTER DELETE ON tasks BEGIN
 DELETE FROM task_cost_intervals_v1 WHERE owner=OLD.id;
 DELETE FROM task_cost_invalid_v1 WHERE owner=OLD.id; END;"
    ))?;
    Ok(())
}

/// One short reservation. Even a retained builder rechecks all identities and
/// metadata INSIDE its transaction; another builder or repair may have advanced.
fn step(db: &mut Connection) -> Result<bool> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let started = Instant::now();
    match inspect(&tx)? {
        State::Ready => {
            tx.commit()?;
            return Ok(true);
        }
        State::Repair => initialize(&tx)?,
        State::Clearing => {
            // Bound derived ROWS, not owners (one task can have many attempts).
            tx.execute("DELETE FROM task_cost_intervals_v1 WHERE rowid IN (SELECT rowid FROM task_cost_intervals_v1 LIMIT ?1)",[ROW_BATCH])?;
            tx.execute("DELETE FROM task_cost_invalid_v1 WHERE rowid IN (SELECT rowid FROM task_cost_invalid_v1 LIMIT ?1)",[ROW_BATCH])?;
            let empty:bool=tx.query_row("SELECT NOT EXISTS(SELECT 1 FROM task_cost_intervals_v1) AND NOT EXISTS(SELECT 1 FROM task_cost_invalid_v1)",[],|r|r.get(0))?;
            if empty {
                tx.execute_batch(INDEXES)?;
                tx.execute(
                    "UPDATE task_cost_meta_v1 SET phase='building',cursor=NULL",
                    [],
                )?;
            }
        }
        State::Building(cursor) => {
            let ids: Vec<String> = if let Some(cursor) = cursor {
                tx.prepare("SELECT id FROM tasks WHERE id>?1 ORDER BY id LIMIT ?2")?
                    .query_map(params![cursor, RECORD_BATCH], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?
            } else {
                tx.prepare("SELECT id FROM tasks ORDER BY id LIMIT ?1")?
                    .query_map([RECORD_BATCH], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?
            };
            if ids.is_empty() {
                tx.execute("UPDATE task_cost_meta_v1 SET phase='ready',cursor=NULL", [])?;
            } else {
                let [invalid, intervals] =
                    projection("SELECT id AS owner,record FROM tasks WHERE id=?1");
                let mut invalid_statement = tx.prepare(&invalid)?;
                let mut interval_statement = tx.prepare(&intervals)?;
                for id in ids {
                    tx.execute("DELETE FROM task_cost_intervals_v1 WHERE owner=?1", [&id])?;
                    tx.execute("DELETE FROM task_cost_invalid_v1 WHERE owner=?1", [&id])?;
                    invalid_statement.execute([&id])?;
                    interval_statement.execute([&id])?;
                    tx.execute("UPDATE task_cost_meta_v1 SET cursor=?1", [&id])?;
                    if started.elapsed() >= WORK_BUDGET {
                        break;
                    }
                }
            }
        }
    }
    tx.commit()?;
    Ok(false)
}

pub(super) fn ensure(db: &mut Connection) -> Result<()> {
    if ready(db)? {
        return Ok(());
    }
    while !step(db)? {
        // No transaction is held here. Scheduling opportunity, not a fairness
        // guarantee; retained competing-writer tests establish observed bounds.
        thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
