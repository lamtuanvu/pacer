//! Assistant grants (`pag_`) in the shared grant table.
//!
//! Port of `issueAssistantGrant` / `authorizeAssistantGrant` /
//! `revokeAssistantGrants` in `src/dispatch/work.ts` for `kind = 'assistant'`.
//! Only assistant rows are created here: work grants stay with the TypeScript
//! core, and a row's `kind` decides which identity it can answer as. The raw
//! token never reaches the store; only its SHA-256 hex is persisted.

use crate::StoreError;
use rusqlite::Connection;
use std::time::{SystemTime, UNIX_EPOCH};

/// The grant store's distinct kind; a work-grant row can never answer as one.
pub const ASSISTANT_GRANT_KIND: &str = "assistant";
/// Default turn deadline (`assistantLimitsSchema.deadlineMs`, seconds). A grant
/// issued here lives for one turn and dies with it.
pub const ASSISTANT_GRANT_TTL: f64 = 120.0;
const TOKEN_PREFIX: &str = "pag_";

/// Ensure the shared grant table and its assistant columns exist. Same DDL as
/// `connection()` in `src/dispatch/store.ts`, including the two additive
/// columns older databases may lack.
pub fn ensure(db: &Connection) -> Result<(), StoreError> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS work_grants(hash TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, expires REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'work', conversation_id TEXT NOT NULL DEFAULT '');",
    )?;
    let columns: Vec<String> = db
        .prepare("PRAGMA table_info(work_grants)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<_>>()?;
    if !columns.iter().any(|c| c == "kind") {
        db.execute_batch("ALTER TABLE work_grants ADD COLUMN kind TEXT NOT NULL DEFAULT 'work'")?;
    }
    if !columns.iter().any(|c| c == "conversation_id") {
        db.execute_batch(
            "ALTER TABLE work_grants ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''",
        )?;
    }
    Ok(())
}

/// `createHash("sha256").update(token).digest("hex")`.
pub fn token_hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn valid(token: &str) -> bool {
    let Some(hex) = token.strip_prefix(TOKEN_PREFIX) else {
        return false;
    };
    hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// Issue a per-turn assistant grant: `pag_` + 64 hex, hashed at rest, bound to
/// one conversation and expiring `ASSISTANT_GRANT_TTL` after `now`.
pub fn issue_assistant(
    db: &Connection,
    conversation_id: &str,
    at: f64,
) -> Result<String, StoreError> {
    if conversation_id.is_empty() {
        return Err(StoreError::Admission(
            "An assistant grant binds one turn of one conversation".into(),
        ));
    }
    ensure(db)?;
    let bytes: [u8; 32] = rand::random();
    let token = format!(
        "{TOKEN_PREFIX}{}",
        bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>()
    );
    db.execute(
        "INSERT INTO work_grants(hash,task_id,attempt,expires,revoked,kind,conversation_id) VALUES(?,?,0,?,0,?,?)",
        rusqlite::params![
            token_hash(&token),
            conversation_id,
            at + ASSISTANT_GRANT_TTL,
            ASSISTANT_GRANT_KIND,
            conversation_id
        ],
    )?;
    Ok(token)
}

/// Resolve a `pag_` token to its conversation id while it is live. An unknown,
/// malformed, expired, revoked or wrongly-kinded token is `Ok(None)`: it never
/// answers as anyone else's identity.
pub fn authorize_assistant(
    db: &Connection,
    token: &str,
) -> Result<Option<String>, StoreError> {
    if !valid(token) {
        return Ok(None);
    }
    ensure(db)?;
    let row: Option<(String, f64, i64, String)> = db
        .query_row(
            "SELECT conversation_id,expires,revoked,kind FROM work_grants WHERE hash=?",
            [token_hash(token)],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                ))
            },
        )
        .optional()?;
    Ok(row.and_then(|(conversation_id, expires, revoked, kind)| {
        (kind == ASSISTANT_GRANT_KIND && revoked == 0 && expires > now())
            .then_some(conversation_id)
    }))
}

/// End of turn, cancellation or deadline: stop answering at once.
pub fn revoke_assistant(db: &Connection, token: &str) -> Result<(), StoreError> {
    if !valid(token) {
        return Ok(());
    }
    ensure(db)?;
    db.execute(
        "UPDATE work_grants SET revoked=1 WHERE hash=? AND kind=?",
        rusqlite::params![token_hash(token), ASSISTANT_GRANT_KIND],
    )?;
    Ok(())
}

/// Revoke every live assistant grant of a conversation (its turns ended).
pub fn revoke_conversation(db: &Connection, conversation_id: &str) -> Result<(), StoreError> {
    ensure(db)?;
    db.execute(
        "UPDATE work_grants SET revoked=1 WHERE conversation_id=? AND kind=?",
        rusqlite::params![conversation_id, ASSISTANT_GRANT_KIND],
    )?;
    Ok(())
}

/// Test/introspection helper: the stored rows for assistant grants.
pub fn assistant_rows(db: &Connection) -> Result<Vec<(String, i64, f64)>, StoreError> {
    ensure(db)?;
    let mut statement = db.prepare(
        "SELECT task_id,revoked,expires FROM work_grants WHERE kind=? ORDER BY task_id",
    )?;
    let rows = statement
        .query_map([ASSISTANT_GRANT_KIND], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Adapter for rusqlite's `OptionalExtension` without importing the trait name
/// at every call site.
use rusqlite::OptionalExtension as _;
