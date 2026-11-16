//! Message writes shared with `src/messaging/store.ts`: schema, inserts and held releases.
use super::{COLUMNS, message};
use crate::{StoreError, TaskStore};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::Value;
use sha2::{Digest, Sha256};

type Result<T> = std::result::Result<T, StoreError>;

/// `messagesDatabase`: the statement text matches TypeScript so `sqlite_master` is identical.
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS messages(
    id TEXT PRIMARY KEY, task_id TEXT NULL, root_id TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
    kind TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT NULL, request_id TEXT NULL, status TEXT NOT NULL,
    created_at REAL NOT NULL, delivered_at REAL NULL, read_at REAL NULL, turn_id TEXT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS messages_request ON messages(sender, request_id) WHERE request_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient, status);
  CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id);
  CREATE INDEX IF NOT EXISTS messages_turn ON messages(turn_id);
  CREATE TABLE IF NOT EXISTS msg_turns(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, root_id TEXT NOT NULL, started_at REAL NOT NULL, ended_at REAL NULL, outcome TEXT NULL);
  CREATE INDEX IF NOT EXISTS msg_turns_root ON msg_turns(root_id);";

/// Creates the message tables as TypeScript does on first use, then adds `fingerprint` in place.
pub fn ensure_schema(store: &mut TaskStore) -> Result<&Connection> {
    let db = store.connection()?;
    db.execute_batch(SCHEMA)?;
    let mut stmt = db.prepare("PRAGMA table_info(messages)")?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    if !names.iter().any(|n| n == "fingerprint") {
        db.execute_batch("ALTER TABLE messages ADD COLUMN fingerprint TEXT NULL")?;
    }
    Ok(db)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `fingerprint`: what a request id stands for, the same recipient, kind and body.
pub fn fingerprint(to: &str, kind: &str, body: &str) -> String {
    let text = serde_json::to_string(&[to, kind, &sha256_hex(body.as_bytes())]).unwrap_or_default();
    sha256_hex(text.as_bytes())
}

fn get_in(db: &Connection, id: &str) -> Result<Option<Value>> {
    Ok(db
        .query_row(
            &format!("SELECT {COLUMNS} FROM messages WHERE id=?"),
            [id],
            message,
        )
        .optional()?)
}

/// `getMessage`.
pub fn get(store: &mut TaskStore, id: &str) -> Result<Option<Value>> {
    get_in(ensure_schema(store)?, id)
}

fn prior_in(
    db: &Connection,
    from: &str,
    request_id: &str,
) -> Result<Option<(Value, Option<String>)>> {
    Ok(db
        .query_row(
            &format!("SELECT {COLUMNS},fingerprint FROM messages WHERE sender=? AND request_id=?"),
            [from, request_id],
            |r| Ok((message(r)?, r.get::<_, Option<String>>(14)?)),
        )
        .optional()?)
}

/// `byRequest`: the message a sender stored under a request id, and its fingerprint.
pub fn by_request(
    store: &mut TaskStore,
    from: &str,
    request_id: &str,
) -> Result<Option<(Value, Option<String>)>> {
    prior_in(ensure_schema(store)?, from, request_id)
}

/// Read-only routing probe; errors leave the decision to Core.
pub fn prior_is_answer(home: &std::path::Path, from: &str, request_id: &str) -> Result<bool> {
    let path = std::path::Path::new(home).join("state/tasks.db");
    if !path.exists() {
        return Ok(false);
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let answer: Option<i64> = db.query_row(
        "SELECT 1 FROM messages WHERE sender=? AND request_id=? AND kind='answer' AND reply_to IS NOT NULL",
        [from, request_id], |row| row.get(0),
    ).optional()?;
    Ok(answer.is_some())
}

pub struct NewMessage<'a> {
    pub task_id: Option<&'a str>,
    pub root_id: &'a str,
    pub from: &'a str,
    pub to: &'a str,
    pub kind: &'a str,
    pub body: &'a str,
    pub reply_to: Option<&'a str>,
    pub request_id: Option<&'a str>,
    pub held: bool,
}

/// `insertMessage`: one immediate transaction; a request id already stored returns that
/// message as a duplicate. Ids sort by creation: zero-padded milliseconds, then random.
pub fn insert(store: &mut TaskStore, m: &NewMessage<'_>, now: f64) -> Result<(Value, bool)> {
    let db = ensure_schema(store)?;
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
    if let Some(request_id) = m.request_id
        && let Some((prior, _)) = prior_in(&tx, m.from, request_id)?
    {
        tx.commit()?;
        return Ok((prior, true));
    }
    let id = format!(
        "m-{:014}-{:08x}",
        (now * 1000.0).round() as i64,
        rand::random::<u32>()
    );
    tx.execute(
        "INSERT INTO messages(id,task_id,root_id,sender,recipient,kind,body,reply_to,request_id,status,created_at,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        rusqlite::params![
            id,
            m.task_id,
            m.root_id,
            m.from,
            m.to,
            m.kind,
            m.body,
            m.reply_to,
            m.request_id,
            if m.held { "held" } else { "pending" },
            now,
            fingerprint(m.to, m.kind, m.body)
        ],
    )?;
    let stored = get_in(&tx, &id)?.ok_or(StoreError::InvalidRecord)?;
    tx.commit()?;
    Ok((stored, false))
}

/// `confirmHeld`: releases a held message to pending; `None` when it was not held.
pub fn confirm_held(store: &mut TaskStore, id: &str) -> Result<Option<Value>> {
    let db = ensure_schema(store)?;
    if db.execute(
        "UPDATE messages SET status='pending' WHERE id=? AND status='held'",
        [id],
    )? == 0
    {
        return Ok(None);
    }
    get_in(db, id)
}
