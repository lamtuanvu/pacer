//! Private attachment draft metadata shared with `src/attachments/store.ts`.
//!
//! Like the TypeScript store, every read first creates the attachment tables, so a
//! database without them ends with the same schema TypeScript would leave behind.
use crate::{StoreError, TaskStore, messages::sql_json};
use rusqlite::{OptionalExtension, types::Value as SqlValue};
use serde_json::{Map, Value};

type Result<T> = std::result::Result<T, StoreError>;

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS attachment_drafts (id TEXT PRIMARY KEY, created REAL NOT NULL, task TEXT);
    CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, draft TEXT NOT NULL, batch TEXT NOT NULL,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, task TEXT, state TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS attachments_draft ON attachments(draft);";

/// Unclaimed drafts expire after 24 hours.
pub const DRAFT_TTL_SECONDS: f64 = 86_400.0;

/// JavaScript truthiness of a value Bun's SQLite binding returns.
fn truthy(value: &SqlValue) -> bool {
    match value {
        SqlValue::Null => false,
        SqlValue::Integer(n) => *n != 0,
        SqlValue::Real(n) => *n != 0.0 && !n.is_nan(),
        SqlValue::Text(s) => !s.is_empty(),
        SqlValue::Blob(_) => true,
    }
}

/// The number a JavaScript relational comparison reads from a column value.
fn js_number(value: &SqlValue) -> f64 {
    match value {
        SqlValue::Null => 0.0,
        SqlValue::Integer(n) => *n as f64,
        SqlValue::Real(n) => *n,
        SqlValue::Text(s) if s.trim().is_empty() => 0.0,
        SqlValue::Text(s) => s.trim().parse().unwrap_or(f64::NAN),
        SqlValue::Blob(_) => f64::NAN,
    }
}

/// Creates the attachment tables when missing (`database` in the TypeScript store).
pub fn ensure_schema(store: &mut TaskStore) -> Result<()> {
    store.connection()?.execute_batch(SCHEMA)?;
    Ok(())
}

/// `listAttachments`: `{id, name, mime, size}` of the draft's ready attachments, or `None`
/// when the draft does not exist or expired unclaimed (`requireDraft`).
pub fn draft_attachments(
    store: &mut TaskStore,
    draft_id: &str,
    now: f64,
) -> Result<Option<Vec<Value>>> {
    ensure_schema(store)?;
    let db = store.connection()?;
    let draft = db
        .query_row(
            "SELECT * FROM attachment_drafts WHERE id=?",
            [draft_id],
            |row| {
                Ok((
                    row.get::<_, SqlValue>("created")?,
                    row.get::<_, SqlValue>("task")?,
                ))
            },
        )
        .optional()?;
    let Some((created, task)) = draft else {
        return Ok(None);
    };
    if !truthy(&task) && js_number(&created) <= now - DRAFT_TTL_SECONDS {
        return Ok(None);
    }
    let mut query = db.prepare("SELECT * FROM attachments WHERE draft=? AND state='ready'")?;
    let rows = query.query_map([draft_id], |row| {
        let mut out = Map::new();
        for field in ["id", "name", "mime", "size"] {
            out.insert(field.into(), sql_json(row.get(field)?));
        }
        Ok(Value::Object(out))
    })?;
    Ok(Some(rows.collect::<rusqlite::Result<_>>()?))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use serde_json::json;

    fn store() -> (tempfile::TempDir, TaskStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = TaskStore::open(dir.path()).unwrap();
        (dir, store)
    }

    #[test]
    fn missing_draft_creates_schema_and_reads_none() {
        let (_dir, mut store) = store();
        assert_eq!(draft_attachments(&mut store, "d", 100.0).unwrap(), None);
        let tables: i64 = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('attachment_drafts','attachments','attachments_draft')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 3);
    }

    #[test]
    fn lists_ready_attachments_until_unclaimed_expiry() {
        let (_dir, mut store) = store();
        ensure_schema(&mut store).unwrap();
        store
            .connection()
            .unwrap()
            .execute_batch(
                "INSERT INTO attachment_drafts VALUES('d',1000,NULL),('c',1000,'t-1');
                 INSERT INTO attachments VALUES('a2','d','b','two.png','image/png',7,NULL,'ready'),
                   ('a1','d','b','one.txt','text/plain',3,NULL,'uploading'),
                   ('a3','c','b','three','x/y',2.0,'t-1','ready');",
            )
            .unwrap();
        let live = draft_attachments(&mut store, "d", 1000.0 + DRAFT_TTL_SECONDS - 0.5).unwrap();
        assert_eq!(
            live,
            Some(vec![
                json!({"id": "a2", "name": "two.png", "mime": "image/png", "size": 7})
            ])
        );
        let expired = draft_attachments(&mut store, "d", 1000.0 + DRAFT_TTL_SECONDS).unwrap();
        assert_eq!(expired, None);
        let claimed = draft_attachments(&mut store, "c", 1e12).unwrap().unwrap();
        assert_eq!(claimed[0]["size"], json!(2));
    }
}
