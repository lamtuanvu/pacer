//! Message store reads and read receipts shared with `src/messaging/store.ts`.
//!
//! The TypeScript store creates the `messages` table on first use; a database without it
//! reads as empty and marks nothing read, which is what the TypeScript handlers return.
use crate::{StoreError, TaskStore};
use rusqlite::{
    Connection, OptionalExtension, Row, Transaction, TransactionBehavior, types::Value as SqlValue,
};
use serde_json::{Map, Value, json};

type Result<T> = std::result::Result<T, StoreError>;

const MAX_DEPTH: usize = 64;
const COLUMNS: &str = "id,task_id,root_id,sender,recipient,kind,body,reply_to,request_id,status,created_at,delivered_at,read_at,turn_id";
const FIELDS: [&str; 14] = [
    "id",
    "taskId",
    "rootId",
    "from",
    "to",
    "kind",
    "body",
    "replyTo",
    "requestId",
    "status",
    "createdAt",
    "deliveredAt",
    "readAt",
    "turnId",
];

fn has_table(db: &Connection, name: &str) -> Result<bool> {
    Ok(db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            [name],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// The value Bun's SQLite binding returns for a stored column.
pub(crate) fn sql_json(value: SqlValue) -> Value {
    match value {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(n) => json!(n),
        SqlValue::Real(n) => js_number(n),
        SqlValue::Text(s) => json!(s),
        SqlValue::Blob(b) => json!(b),
    }
}

fn js_number(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n >= i64::MIN as f64 && n < i64::MAX as f64 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// `toMessage`: the wire field names in their TypeScript order.
fn message(row: &Row<'_>) -> rusqlite::Result<Value> {
    let mut out = Map::new();
    for (i, field) in FIELDS.iter().enumerate() {
        out.insert((*field).into(), sql_json(row.get(i)?));
    }
    Ok(Value::Object(out))
}

fn messages(db: &Connection, sql: &str, params: impl rusqlite::Params) -> Result<Vec<Value>> {
    if !has_table(db, "messages")? {
        return Ok(Vec::new());
    }
    let mut stmt = db.prepare(sql)?;
    let rows = stmt
        .query_map(params, message)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// `store.thread`: a task's messages after a cursor, in id order.
pub fn thread(
    store: &mut TaskStore,
    task_id: &str,
    after: Option<&str>,
    limit: Option<u32>,
) -> Result<Vec<Value>> {
    let limit = limit.unwrap_or(200).min(1000);
    messages(
        store.connection()?,
        &format!("SELECT {COLUMNS} FROM messages WHERE task_id=? AND id>? ORDER BY id LIMIT ?"),
        rusqlite::params![task_id, after.unwrap_or(""), limit],
    )
}

/// `store.inbox`: messages addressed to `to`; held messages are never listed.
pub fn inbox(
    store: &mut TaskStore,
    to: &str,
    unread_only: bool,
    limit: Option<u32>,
) -> Result<Vec<Value>> {
    let limit = limit.unwrap_or(200).min(1000);
    let filter = if unread_only {
        "AND status IN ('pending','delivered')"
    } else {
        "AND status<>'held'"
    };
    messages(
        store.connection()?,
        &format!("SELECT {COLUMNS} FROM messages WHERE recipient=? {filter} ORDER BY id LIMIT ?"),
        rusqlite::params![to, limit],
    )
}

/// `store.markRead`: one immediate transaction, counting rows that changed.
pub fn mark_read(store: &mut TaskStore, to: &str, ids: &[&str], at: f64) -> Result<usize> {
    let db = store.connection()?;
    if !has_table(db, "messages")? {
        return Ok(0);
    }
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
    let mut read = 0;
    {
        let mut stmt = tx.prepare("UPDATE messages SET status='read', read_at=? WHERE id=? AND recipient=? AND status<>'read' AND status<>'held'")?;
        for id in ids {
            read += stmt.execute(rusqlite::params![at, id, to])?;
        }
    }
    tx.commit()?;
    Ok(read)
}

/// `store.countSentSince`: messages `from` sent at or after `since` seconds.
pub fn count_sent_since(store: &mut TaskStore, from: &str, since: f64) -> Result<i64> {
    let db = store.connection()?;
    if !has_table(db, "messages")? {
        return Ok(0);
    }
    Ok(db.query_row(
        "SELECT COUNT(*) FROM messages WHERE sender=? AND created_at>=?",
        rusqlite::params![from, since],
        |r| r.get(0),
    )?)
}

fn count(db: &Connection, table: &str, sql: &str, key: &str) -> Result<i64> {
    if !has_table(db, table)? {
        return Ok(0);
    }
    Ok(db.query_row(sql, [key], |r| r.get(0))?)
}

/// `store.pendingFor(to).length`.
pub fn pending_count(store: &mut TaskStore, to: &str) -> Result<i64> {
    count(
        store.connection()?,
        "messages",
        "SELECT COUNT(*) FROM messages WHERE recipient=? AND status='pending'",
        to,
    )
}

/// `store.turnsForRoot`: turns recorded anywhere in the tree.
pub fn turns_for_root(store: &mut TaskStore, root: &str) -> Result<i64> {
    count(
        store.connection()?,
        "msg_turns",
        "SELECT COUNT(*) FROM msg_turns WHERE root_id=?",
        root,
    )
}

/// The task ids of `workTree(id).nodes` in their order, or `None` for unmanaged work.
pub fn work_tree_ids(store: &mut TaskStore, id: &str) -> Result<Option<Vec<String>>> {
    let db = store.connection()?;
    if !has_table(db, "work_nodes")? {
        return Ok(None);
    }
    let Some(root) = db
        .query_row(
            "SELECT root_id FROM work_nodes WHERE task_id=?",
            [id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    else {
        return Ok(None);
    };
    let mut stmt =
        db.prepare("SELECT task_id FROM work_nodes WHERE root_id=? ORDER BY depth,task_id")?;
    let ids = stmt
        .query_map([root], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(Some(ids))
}

/// `taskOf`: the task id of a `task:` participant; an empty id is no task.
pub fn task_of(participant: &str) -> Option<&str> {
    participant
        .strip_prefix("task:")
        .filter(|id| !id.is_empty())
}

/// `parentOf`: the managed-work parent, else the task's origin or source default.
pub fn parent_of(store: &mut TaskStore, participant: &str) -> Result<Option<String>> {
    let Some(id) = participant.strip_prefix("task:") else {
        return Ok(None);
    };
    if id.is_empty() {
        return Ok(None);
    }
    let db = store.connection()?;
    if has_table(db, "work_nodes")? {
        let parent = db
            .query_row(
                "SELECT parent_id FROM work_nodes WHERE task_id=?",
                [id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
            .filter(|parent| !parent.is_empty());
        if let Some(parent) = parent {
            return Ok(Some(format!("task:{parent}")));
        }
    }
    let Some(task) = store.read(id)? else {
        return Ok(None);
    };
    Ok(Some(match task.get("origin") {
        Some(Value::String(origin)) => origin.clone(),
        _ if task["source"] == "planner" => "external:planner".into(),
        _ => "human".into(),
    }))
}

/// `rootOf`: the top-most task above the participant, or the participant itself.
pub fn root_of(store: &mut TaskStore, participant: &str) -> Result<String> {
    let mut root = task_of(participant).map(|_| participant.to_owned());
    let mut current = parent_of(store, participant)?;
    let mut depth = 0;
    while let Some(node) = current.filter(|node| !node.is_empty() && depth < MAX_DEPTH) {
        depth += 1;
        if task_of(&node).is_some() {
            root = Some(node.clone());
        }
        current = parent_of(store, &node)?;
    }
    Ok(root.unwrap_or_else(|| participant.to_owned()))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    const SCHEMA: &str = "CREATE TABLE messages(id TEXT PRIMARY KEY, task_id TEXT NULL, root_id TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT NULL, request_id TEXT NULL, status TEXT NOT NULL, created_at REAL NOT NULL, delivered_at REAL NULL, read_at REAL NULL, turn_id TEXT NULL, fingerprint TEXT NULL);";

    fn store() -> (tempfile::TempDir, TaskStore) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TaskStore::open(dir.path()).unwrap();
        store.connection().unwrap().execute_batch(SCHEMA).unwrap();
        (dir, store)
    }

    fn insert(store: &mut TaskStore, id: &str, task: Option<&str>, to: &str, status: &str) {
        store
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO messages(id,task_id,root_id,sender,recipient,kind,body,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                rusqlite::params![id, task, "task:root", "human", to, "note", "hi", status, 1_700_000_000.5],
            )
            .unwrap();
    }

    #[test]
    fn missing_table_reads_empty_and_marks_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TaskStore::open(dir.path()).unwrap();
        assert!(inbox(&mut store, "human", true, None).unwrap().is_empty());
        assert!(thread(&mut store, "t", None, None).unwrap().is_empty());
        assert_eq!(mark_read(&mut store, "human", &["m"], 1.0).unwrap(), 0);
    }

    #[test]
    fn inbox_filters_status_and_keeps_wire_order() {
        let (_dir, mut store) = store();
        insert(&mut store, "m-2", Some("t"), "human", "delivered");
        insert(&mut store, "m-1", Some("t"), "human", "pending");
        insert(&mut store, "m-3", Some("t"), "human", "read");
        insert(&mut store, "m-4", Some("t"), "human", "held");
        let unread = inbox(&mut store, "human", true, None).unwrap();
        let ids: Vec<_> = unread.iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["m-1", "m-2"]);
        let all = inbox(&mut store, "human", false, Some(2)).unwrap();
        assert_eq!(all.len(), 2);
        let keys: Vec<_> = unread[0].as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, FIELDS);
        assert_eq!(unread[0]["createdAt"], json!(1_700_000_000.5));
        assert_eq!(unread[0]["replyTo"], Value::Null);
    }

    #[test]
    fn thread_pages_after_cursor() {
        let (_dir, mut store) = store();
        for id in ["m-1", "m-2", "m-3"] {
            insert(&mut store, id, Some("t"), "human", "pending");
        }
        insert(&mut store, "m-4", Some("other"), "human", "pending");
        let page = thread(&mut store, "t", Some("m-1"), Some(1)).unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0]["id"], "m-2");
    }

    #[test]
    fn mark_read_counts_each_change_once_and_skips_held() {
        let (_dir, mut store) = store();
        insert(&mut store, "m-1", None, "task:a", "pending");
        insert(&mut store, "m-2", None, "task:a", "held");
        insert(&mut store, "m-3", None, "task:b", "pending");
        let read = mark_read(&mut store, "task:a", &["m-1", "m-1", "m-2", "m-3"], 5.0).unwrap();
        assert_eq!(read, 1);
        let row = inbox(&mut store, "task:a", false, None).unwrap();
        assert_eq!(row[0]["status"], "read");
        assert_eq!(row[0]["readAt"], json!(5));
    }

    #[test]
    fn counts_sent_messages_from_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let mut empty = TaskStore::open(dir.path()).unwrap();
        assert_eq!(count_sent_since(&mut empty, "human", 0.0).unwrap(), 0);
        let (_dir, mut store) = store();
        insert(&mut store, "m-1", None, "task:a", "pending");
        insert(&mut store, "m-2", None, "task:a", "held");
        assert_eq!(
            count_sent_since(&mut store, "human", 1_700_000_000.5).unwrap(),
            2
        );
        assert_eq!(
            count_sent_since(&mut store, "human", 1_700_000_001.0).unwrap(),
            0
        );
        assert_eq!(count_sent_since(&mut store, "task:a", 0.0).unwrap(), 0);
    }

    #[test]
    fn root_walks_work_parents_and_origins() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TaskStore::open(dir.path()).unwrap();
        let task = |id: &str, origin: Value| json!({"id":id,"rev":1,"state":"done","createdAt":1,"updatedAt":1,"brief":{"goal":"g","repo":"/r"},"attempts":[],"origin":origin,"source":"cli"});
        let root = "t-20260101-000000-0001";
        let mid = "t-20260101-000000-0002";
        let leaf = "t-20260101-000000-0003";
        store.insert(&task(root, Value::Null), 1.0).unwrap();
        store
            .insert(&task(mid, json!(format!("task:{root}"))), 1.0)
            .unwrap();
        store.insert(&task(leaf, Value::Null), 1.0).unwrap();
        store.connection().unwrap().execute_batch(&format!(
            "CREATE TABLE work_nodes(task_id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL, depth INTEGER NOT NULL, options TEXT NOT NULL); INSERT INTO work_nodes VALUES('{leaf}','{mid}','{root}',2,'{{}}');"
        )).unwrap();
        assert_eq!(
            parent_of(&mut store, &format!("task:{root}")).unwrap(),
            Some("human".into())
        );
        assert_eq!(
            root_of(&mut store, &format!("task:{leaf}")).unwrap(),
            format!("task:{root}")
        );
        assert_eq!(root_of(&mut store, "human").unwrap(), "human");
        assert_eq!(root_of(&mut store, "task:").unwrap(), "task:");
        assert_eq!(
            root_of(&mut store, "task:t-20990101-000000-ffff").unwrap(),
            "task:t-20990101-000000-ffff"
        );
    }
}
