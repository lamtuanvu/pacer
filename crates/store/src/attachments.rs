#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.

//! Private attachment drafts and files shared with `src/attachments/store.ts`.
//!
//! Like the TypeScript store, every read first creates the attachment tables, so a
//! database without them ends with the same schema TypeScript would leave behind.
//! The byte layout (`<pacer-home>/attachments/<draft>/<id>`, a `.upload` temp file
//! renamed once ready) and the row states are the contract the TypeScript
//! readers and the native front door share.
use crate::TaskStore;
use pacer_foundation::api::{Code, CoreError};
use rusqlite::{Connection, OptionalExtension, params, types::Value as SqlValue};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, CoreError>;

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS attachment_drafts (id TEXT PRIMARY KEY, created REAL NOT NULL, task TEXT);
    CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, draft TEXT NOT NULL, batch TEXT NOT NULL,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, task TEXT, state TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS attachments_draft ON attachments(draft);";

/// Unclaimed drafts expire after 24 hours.
pub const DRAFT_TTL_SECONDS: f64 = 86_400.0;
/// `FILE_LIMIT` in `src/attachments/store.ts`.
pub const FILE_LIMIT: u64 = 25 * 1024 * 1024;
/// `SESSION_LIMIT` in `src/attachments/store.ts`.
pub const SESSION_LIMIT: u64 = 100 * 1024 * 1024;
/// A batch can contain at most this many files.
pub const BATCH_LIMIT: i64 = 20;

fn error(code: Code, message: impl Into<String>) -> CoreError {
    CoreError::new(code, message)
}
fn internal(error: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

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

fn sql_text(value: &SqlValue) -> String {
    match value {
        SqlValue::Text(s) => s.clone(),
        SqlValue::Null => String::new(),
        SqlValue::Integer(n) => n.to_string(),
        SqlValue::Real(n) => n.to_string(),
        SqlValue::Blob(b) => String::from_utf8_lossy(b).into_owned(),
    }
}

fn meta_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AttachmentMeta> {
    let size = js_number(&row.get::<_, SqlValue>("size")?);
    Ok(AttachmentMeta {
        id: sql_text(&row.get::<_, SqlValue>("id")?),
        name: sql_text(&row.get::<_, SqlValue>("name")?),
        mime: sql_text(&row.get::<_, SqlValue>("mime")?),
        size: if size.is_finite() && size > 0.0 {
            size as u64
        } else {
            0
        },
    })
}

/// SQLite `BEGIN IMMEDIATE` over a shared connection. Writes from concurrent
/// requests serialize here, which is what keeps the batch and draft quotas honest.
fn immediate<T>(db: &Connection, work: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    db.execute_batch("BEGIN IMMEDIATE").map_err(internal)?;
    match work(db) {
        Ok(value) => {
            if let Err(failed) = db.execute_batch("COMMIT") {
                let _ = db.execute_batch("ROLLBACK");
                return Err(internal(failed));
            }
            Ok(value)
        }
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn private_dir(path: &Path, message: &'static str) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true).mode(0o700);
    builder.create(path).map_err(internal)?;
    let stat = fs::symlink_metadata(path).map_err(internal)?;
    if !stat.file_type().is_dir() {
        return Err(error(Code::NotAllowed, message));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(internal)?;
    Ok(())
}

fn attachment_root(home: &Path) -> Result<PathBuf> {
    let root = home.join("attachments");
    private_dir(&root, "Attachment storage is not a private directory")?;
    Ok(root)
}

fn attachment_dir(home: &Path, draft_id: &str) -> Result<PathBuf> {
    // Draft ids are UUIDs minted by `create_draft`; a row that does not look like
    // one must never be able to escape the private root.
    if draft_id.is_empty()
        || draft_id.len() > 128
        || draft_id
            .bytes()
            .any(|b| !b.is_ascii_alphanumeric() && b != b'-' && b != b'_')
    {
        return Err(error(Code::NotAllowed, "Attachment directory is invalid"));
    }
    let dir = attachment_root(home)?.join(draft_id);
    private_dir(&dir, "Attachment directory is invalid")?;
    Ok(dir)
}

fn ensure(db: &Connection) -> Result<()> {
    db.execute_batch(SCHEMA).map_err(internal)
}

/// Creates the attachment tables when missing (`database` in the TypeScript store).
pub fn ensure_schema(store: &mut TaskStore) -> Result<()> {
    ensure(store.connection().map_err(internal)?)
}

/// The draft row when it exists and has not expired unclaimed.
fn draft_row(db: &Connection, draft_id: &str, now: f64) -> Result<Option<(SqlValue, SqlValue)>> {
    db.query_row(
        "SELECT created, task FROM attachment_drafts WHERE id=?",
        [draft_id],
        |row| {
            Ok((
                row.get::<_, SqlValue>("created")?,
                row.get::<_, SqlValue>("task")?,
            ))
        },
    )
    .optional()
    .map_err(internal)
    .map(|row| {
        row.filter(|(created, task)| truthy(task) || js_number(created) > now - DRAFT_TTL_SECONDS)
    })
}

fn require_draft(db: &Connection, draft_id: &str, now: f64) -> Result<()> {
    if draft_row(db, draft_id, now)?.is_none() {
        return Err(error(
            Code::NotFound,
            "Attachment draft expired or does not exist",
        ));
    }
    Ok(())
}

fn uuid() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// `createDraft`: records a new private draft and returns its random UUID.
pub fn create_draft(store: &mut TaskStore, now: f64) -> Result<String> {
    ensure_schema(store)?;
    let id = uuid();
    store
        .connection()
        .map_err(internal)?
        .execute(
            "INSERT INTO attachment_drafts(id,created) VALUES (?,?)",
            params![id, now],
        )
        .map_err(internal)?;
    Ok(id)
}

/// The public `{id, name, mime, size}` shape shared with the TypeScript store.
#[derive(Debug, Clone, PartialEq)]
pub struct AttachmentMeta {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
}

impl AttachmentMeta {
    /// The `{id, name, mime, size}` wire shape.
    pub fn as_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "mime": self.mime,
            "size": self.size,
        })
    }
}

/// A ready attachment and its private file path.
#[derive(Debug, Clone, PartialEq)]
pub struct AttachmentFile {
    pub meta: AttachmentMeta,
    pub path: PathBuf,
}

/// `listAttachments`: the ready attachments of a draft, or `None` when the draft
/// does not exist or expired unclaimed (`requireDraft`).
pub fn list_draft(
    store: &mut TaskStore,
    draft_id: &str,
    now: f64,
) -> Result<Option<Vec<AttachmentMeta>>> {
    let db = store.connection().map_err(internal)?;
    ensure(db)?;
    let Some(_draft) = draft_row(db, draft_id, now)? else {
        return Ok(None);
    };
    let mut query = db
        .prepare("SELECT id,name,mime,size FROM attachments WHERE draft=? AND state='ready'")
        .map_err(internal)?;
    let rows = query
        .query_map([draft_id], meta_from_row)
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(Some(rows))
}

/// Backwards-compatible JSON view used by the native session-context operations.
pub fn draft_attachments(
    store: &mut TaskStore,
    draft_id: &str,
    now: f64,
) -> Result<Option<Vec<Value>>> {
    Ok(list_draft(store, draft_id, now)?
        .map(|rows| rows.iter().map(AttachmentMeta::as_json).collect()))
}

fn valid_batch(batch: &str) -> bool {
    !batch.is_empty()
        && batch.len() <= 128
        && batch
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `basename(name.replaceAll("\\", "/"))` with control characters removed and a
/// 255-character display cap, exactly as the TypeScript store derives a name.
fn display_name(raw: &str) -> String {
    let replaced = raw.replace('\\', "/");
    let base = replaced.rsplit('/').next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| (*c as u32) > 0x1f && (*c as u32) != 0x7f)
        .take(255)
        .collect();
    if cleaned.is_empty() {
        "attachment".to_owned()
    } else {
        cleaned
    }
}

/// Metadata a caller supplies for one upload.
#[derive(Debug, Clone, Copy)]
pub struct UploadInput<'a> {
    pub draft_id: &'a str,
    pub batch_id: &'a str,
    pub name: &'a str,
    pub mime: &'a str,
}

/// A streaming upload. Each chunk is capped and quota-checked before it is
/// written to the `O_NOFOLLOW` temp file; `finish` renames it into place. Dropping
/// without finishing removes the temp file, the target and the `uploading` row.
pub struct Upload {
    // Owned so the streaming server can hold the session across an await:
    // `TaskStore` is Send, while a borrowed `&Connection` would not be.
    store: TaskStore,
    id: String,
    draft_id: String,
    name: String,
    mime: String,
    path: PathBuf,
    temp: PathBuf,
    file: Option<File>,
    size: u64,
    now: f64,
    finished: bool,
}

/// `storeAttachment` step one: validate metadata, reserve a batch slot and open
/// the private temp file. Call [`Upload::push`] for each body chunk and
/// [`Upload::finish`] once the stream ends.
pub fn begin_upload(mut store: TaskStore, now: f64, input: UploadInput<'_>) -> Result<Upload> {
    let home = store.home.clone();
    if !valid_batch(input.batch_id)
        || input.name.chars().count() > 4096
        || input.mime.chars().count() > 128
    {
        return Err(error(Code::InvalidInput, "Invalid attachment metadata"));
    }
    let name = display_name(input.name);
    let id = uuid();
    let dir = attachment_dir(&home, input.draft_id)?;
    let path = dir.join(&id);
    let temp = PathBuf::from(format!("{}.upload", path.to_string_lossy()));
    {
        let db = store.connection().map_err(internal)?;
        ensure(db)?;
        require_draft(db, input.draft_id, now)?;
        immediate(db, |db| {
            let count: i64 = db
                .query_row(
                    "SELECT COUNT(*) FROM attachments WHERE draft=? AND batch=?",
                    params![input.draft_id, input.batch_id],
                    |row| row.get(0),
                )
                .map_err(internal)?;
            if count >= BATCH_LIMIT {
                return Err(error(
                    Code::TooLarge,
                    "A batch can contain at most 20 files",
                ));
            }
            db.execute(
                "INSERT INTO attachments(id,draft,batch,name,mime,state) VALUES (?,?,?,?,?,'uploading')",
                params![id, input.draft_id, input.batch_id, name, input.mime],
            )
            .map_err(internal)?;
            Ok(())
        })?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let file = match options.open(&temp) {
        Ok(file) => file,
        Err(failed) => {
            let _ = store
                .connection()
                .map(|db| db.execute("DELETE FROM attachments WHERE id=?", params![&id]));
            return Err(internal(failed));
        }
    };
    Ok(Upload {
        store,
        id,
        draft_id: input.draft_id.to_owned(),
        name,
        mime: input.mime.to_owned(),
        path,
        temp,
        file: Some(file),
        size: 0,
        now,
        finished: false,
    })
}

impl Upload {
    /// Reserve and write one streamed chunk. The first byte past either cap is
    /// refused, before any oversized bytes reach the file.
    pub fn push(&mut self, chunk: &[u8]) -> Result<()> {
        self.size = self.size.saturating_add(chunk.len() as u64);
        if self.size > FILE_LIMIT {
            return Err(error(Code::TooLarge, "Attachment exceeds 25 MiB"));
        }
        let size = self.size;
        let draft_id = self.draft_id.clone();
        let id = self.id.clone();
        let now = self.now;
        {
            let db = self.store.connection().map_err(internal)?;
            immediate(db, |db| {
                require_draft(db, &draft_id, now)?;
                let sum: f64 = db
                    .query_row(
                        "SELECT COALESCE(SUM(size),0) FROM attachments WHERE draft=?",
                        [&draft_id],
                        |row| row.get::<_, SqlValue>(0).map(|value| js_number(&value)),
                    )
                    .map_err(internal)?;
                if sum + chunk.len() as f64 > SESSION_LIMIT as f64 {
                    return Err(error(Code::TooLarge, "Session attachments exceed 100 MiB"));
                }
                db.execute(
                    "UPDATE attachments SET size=? WHERE id=? AND state='uploading'",
                    params![size as i64, id],
                )
                .map_err(internal)?;
                Ok(())
            })?;
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| internal("upload closed"))?;
        file.write_all(chunk).map_err(internal)
    }

    /// Publish the file and mark the row ready.
    pub fn finish(mut self) -> Result<AttachmentMeta> {
        if let Some(file) = self.file.take() {
            drop(file);
        }
        fs::rename(&self.temp, &self.path).map_err(internal)?;
        self.store
            .connection()
            .map_err(internal)?
            .execute(
                "UPDATE attachments SET state='ready' WHERE id=?",
                params![&self.id],
            )
            .map_err(internal)?;
        self.finished = true;
        Ok(AttachmentMeta {
            id: self.id.clone(),
            name: self.name.clone(),
            mime: self.mime.clone(),
            size: self.size,
        })
    }

    /// Discard an upload whose body stream failed or was cancelled.
    pub fn abort(self) {
        drop(self);
    }
}

impl Drop for Upload {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        drop(self.file.take());
        let _ = fs::remove_file(&self.temp);
        let _ = fs::remove_file(&self.path);
        let _ = self
            .store
            .connection()
            .map(|db| db.execute("DELETE FROM attachments WHERE id=?", params![&self.id]));
    }
}

/// `storeAttachment`: one synchronous upload over a sequence of chunks. The
/// streaming front door uses [`begin_upload`] directly so it can feed chunks as
/// they arrive from the HTTP body.
pub fn store_upload(
    home: &std::path::Path,
    now: f64,
    input: UploadInput<'_>,
    chunks: impl IntoIterator<Item = Result<Vec<u8>>>,
) -> Result<AttachmentMeta> {
    let store = TaskStore::open(home).map_err(internal)?;
    let mut upload = begin_upload(store, now, input)?;
    for chunk in chunks {
        upload.push(&chunk?)?;
    }
    upload.finish()
}

/// `deleteAttachment`: remove a ready, unclaimed attachment from this draft.
pub fn delete(store: &mut TaskStore, draft_id: &str, id: &str, now: f64) -> Result<()> {
    let home = store.home.clone();
    let db = store.connection().map_err(internal)?;
    ensure(db)?;
    require_draft(db, draft_id, now)?;
    let row = db
        .query_row(
            "SELECT task,state FROM attachments WHERE id=? AND draft=?",
            params![id, draft_id],
            |row| {
                Ok((
                    row.get::<_, SqlValue>("task")?,
                    row.get::<_, SqlValue>("state")?,
                ))
            },
        )
        .optional()
        .map_err(internal)?;
    let Some((task, state)) = row else {
        return Err(error(
            Code::NotFound,
            "Attachment does not belong to this draft",
        ));
    };
    if truthy(&task) || sql_text(&state) != "ready" {
        return Err(error(Code::Conflict, "This attachment is in use"));
    }
    let path = attachment_dir(&home, draft_id)?.join(id);
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(failed) if failed.kind() == std::io::ErrorKind::NotFound => {}
        Err(failed) => return Err(internal(failed)),
    }
    db.execute("DELETE FROM attachments WHERE id=?", [id])
        .map_err(internal)?;
    Ok(())
}

/// `draftAttachment`: a ready attachment and its verified private file path.
pub fn read(store: &mut TaskStore, draft_id: &str, id: &str, now: f64) -> Result<AttachmentFile> {
    let home = store.home.clone();
    let db = store.connection().map_err(internal)?;
    ensure(db)?;
    require_draft(db, draft_id, now)?;
    let meta = db
        .query_row(
            "SELECT id,name,mime,size FROM attachments WHERE id=? AND draft=? AND state='ready'",
            params![id, draft_id],
            meta_from_row,
        )
        .optional()
        .map_err(internal)?;
    let Some(meta) = meta else {
        return Err(error(
            Code::NotFound,
            "Attachment does not belong to this draft",
        ));
    };
    let path = attachment_dir(&home, draft_id)?.join(id);
    let stat = fs::symlink_metadata(&path).map_err(internal)?;
    if !stat.file_type().is_file() {
        return Err(error(
            Code::NotAllowed,
            "Attachment is not a regular private file",
        ));
    }
    Ok(AttachmentFile { meta, path })
}

/// `expireDraftAttachments`: delete expired unclaimed drafts and their files,
/// returning the number of drafts removed.
pub fn expire_drafts(store: &mut TaskStore, now: f64) -> Result<usize> {
    let home = store.home.clone();
    let db = store.connection().map_err(internal)?;
    ensure(db)?;
    let mut query = db
        .prepare("SELECT id FROM attachment_drafts WHERE task IS NULL AND created<=?")
        .map_err(internal)?;
    let ids: Vec<String> = query
        .query_map([now - DRAFT_TTL_SECONDS], |row| row.get(0))
        .map_err(internal)?
        .collect::<rusqlite::Result<_>>()
        .map_err(internal)?;
    drop(query);
    let root = attachment_root(&home)?;
    for id in &ids {
        let mut files = db
            .prepare("SELECT id FROM attachments WHERE draft=?")
            .map_err(internal)?;
        let file_ids: Vec<String> = files
            .query_map([id], |row| row.get(0))
            .map_err(internal)?
            .collect::<rusqlite::Result<_>>()
            .map_err(internal)?;
        drop(files);
        for file_id in file_ids {
            for suffix in ["", ".upload"] {
                let _ = fs::remove_file(root.join(id).join(format!("{file_id}{suffix}")));
            }
        }
        immediate(db, |db| {
            db.execute("DELETE FROM attachments WHERE draft=?", [id])
                .map_err(internal)?;
            db.execute("DELETE FROM attachment_drafts WHERE id=?", [id])
                .map_err(internal)?;
            Ok(())
        })?;
    }
    Ok(ids.len())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn store() -> (tempfile::TempDir, TaskStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = TaskStore::open(dir.path()).unwrap();
        (dir, store)
    }

    #[test]
    fn missing_draft_creates_schema_and_reads_none() {
        let (_dir, mut store) = store();
        assert_eq!(list_draft(&mut store, "d", 100.0).unwrap(), None);
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
        let live = list_draft(&mut store, "d", 1000.0 + DRAFT_TTL_SECONDS - 0.5).unwrap();
        assert_eq!(
            live,
            Some(vec![AttachmentMeta {
                id: "a2".into(),
                name: "two.png".into(),
                mime: "image/png".into(),
                size: 7,
            }])
        );
        let expired = list_draft(&mut store, "d", 1000.0 + DRAFT_TTL_SECONDS).unwrap();
        assert_eq!(expired, None);
        let claimed = list_draft(&mut store, "c", 1e12).unwrap().unwrap();
        assert_eq!(claimed[0].size, 2);
    }

    #[test]
    fn display_names_are_sanitized_like_typescript() {
        assert_eq!(display_name("../../secret.txt"), "secret.txt");
        assert_eq!(display_name("dir\\win.txt"), "win.txt");
        assert_eq!(display_name("bad\u{0007}name"), "badname");
        assert_eq!(display_name(""), "attachment");
    }
}
