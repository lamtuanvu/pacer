//! Grant identity resolution over `state/tasks.db` (`src/dispatch/work.ts`:96-145).
//!
//! A `pwg_` work grant resolves to a live `work_node` only while its row is live: the
//! token's sha256 hex matches a row whose kind is `work`, whose `revoked = 0`, whose
//! `expires` is after now, whose task is `running`, and whose `attempt` is exactly one
//! past the task's current attempt list. A `pag_` assistant grant resolves to its turn
//! only while its row is live (kind `assistant`). Anything else is refused and never
//! answers as anyone else's identity.

use std::collections::HashSet;

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_store::TaskStore;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// sha256 hex of the grant token (`src/dispatch/work.ts:96`).
pub fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

/// `^pwg_[0-9a-f]{64}$`.
pub fn is_pwg(token: &str) -> bool {
    token.len() == 68
        && token.starts_with("pwg_")
        && token[4..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// `^pag_[0-9a-f]{64}$`.
fn is_pag(token: &str) -> bool {
    token.len() == 68
        && token.starts_with("pag_")
        && token[4..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// The subtree node a live work grant is bound to (only the fields authorization needs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkNode {
    pub task_id: String,
    pub parent_id: Option<String>,
    pub root_id: String,
    pub depth: i64,
}

/// What a live `pag_` token is bound to: one turn of one conversation, until its deadline.
#[derive(Debug, Clone, PartialEq)]
pub struct AssistantGrant {
    pub turn_id: String,
    pub conversation_id: String,
    pub expires_at: f64,
}

/// Maps a store error to an internal gate error. Grant refusals each carry their own
/// `not_allowed` message; a broken store is an internal fault.
pub(crate) fn store_err(e: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::Internal, format!("work grant store: {e}"))
}

fn expired() -> CoreError {
    CoreError::new(Code::NotAllowed, "Expired or revoked work grant")
}

/// Open `state/tasks.db` and ensure the `work_grants`/`work_nodes` tables exist
/// (`TaskStore::open` prepares only the `tasks` schema; the work tables are the
/// dispatch schema from `work.sql`). Idempotent, so the real instance's tables are
/// left untouched.
pub(crate) fn open(ctx: &Ctx) -> Result<TaskStore, CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(store_err)?;
    let db = store.connection().map_err(store_err)?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS work_grants(hash TEXT PRIMARY KEY, task_id TEXT NOT NULL, \
         attempt INTEGER NOT NULL, expires REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, \
         kind TEXT NOT NULL DEFAULT 'work', conversation_id TEXT NOT NULL DEFAULT ''); \
         CREATE TABLE IF NOT EXISTS work_nodes(task_id TEXT PRIMARY KEY, parent_id TEXT, \
         root_id TEXT NOT NULL, depth INTEGER NOT NULL, options TEXT NOT NULL, \
         dependencies TEXT NOT NULL DEFAULT '[]');",
    )
    .map_err(store_err)?;
    Ok(store)
}

/// `getWork` (`src/dispatch/work.ts:36`): the subtree node for a task, if present.
fn get_work(db: &Connection, task_id: &str) -> Option<WorkNode> {
    db.query_row(
        "SELECT task_id, parent_id, root_id, depth FROM work_nodes WHERE task_id = ?1",
        [task_id],
        |row| {
            Ok(WorkNode {
                task_id: row.get(0)?,
                parent_id: row.get(1)?,
                root_id: row.get(2)?,
                depth: row.get(3)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

struct GrantRow {
    task_id: String,
    attempt: i64,
    expires: f64,
    revoked: i64,
    kind: Option<String>,
}

/// The live work grant for a token, or the shared refusal. Returns the caller's node.
pub fn authorize_work_grant(ctx: &Ctx, token: &str) -> Result<WorkNode, CoreError> {
    if !is_pwg(token) {
        return Err(CoreError::new(Code::NotAllowed, "Invalid work grant"));
    }
    let mut store = open(ctx)?;
    let db = store.connection().map_err(store_err)?;
    authorize_work_grant_db(&db, ctx, token)
}

/// Internal, shared-connection form so an operation gate opens the store once.
pub(crate) fn authorize_work_grant_db(
    db: &Connection,
    ctx: &Ctx,
    token: &str,
) -> Result<WorkNode, CoreError> {
    if !is_pwg(token) {
        return Err(CoreError::new(Code::NotAllowed, "Invalid work grant"));
    }
    let row = db
        .query_row(
            "SELECT task_id, attempt, expires, revoked, kind FROM work_grants WHERE hash = ?1",
            [token_hash(token)],
            |row| {
                Ok(GrantRow {
                    task_id: row.get(0)?,
                    attempt: row.get(1)?,
                    expires: row.get(2)?,
                    revoked: row.get(3)?,
                    kind: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(store_err)?;
    let row = row.ok_or_else(expired)?;
    if let Some(kind) = &row.kind
        && kind != "work"
    {
        return Err(expired());
    }
    if row.revoked != 0 || row.expires <= ctx.now {
        return Err(expired());
    }
    // The grant's task must be running and this must be its next attempt
    // (`src/dispatch/work.ts:107`: `row.attempt === task.attempts.length + 1`).
    let task = db
        .query_row(
            "SELECT state, record FROM tasks WHERE id = ?1",
            [&row.task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(store_err)?;
    let (state, record) = task.ok_or_else(expired)?;
    if state != "running" {
        return Err(expired());
    }
    let attempts_len = attempts_len(&record);
    if row.attempt != attempts_len + 1 {
        return Err(expired());
    }
    get_work(db, &row.task_id).ok_or_else(expired)
}

/// `authorizeAssistantGrant` (`src/dispatch/work.ts`:129). Refused, never another identity.
pub fn authorize_assistant_grant(ctx: &Ctx, token: &str) -> Result<AssistantGrant, CoreError> {
    if !is_pag(token) {
        return Err(CoreError::new(Code::NotAllowed, "Invalid assistant grant"));
    }
    let mut store = open(ctx)?;
    let db = store.connection().map_err(store_err)?;
    let row = db
        .query_row(
            "SELECT task_id, conversation_id, expires, revoked, kind FROM work_grants \
             WHERE hash = ?1",
            [token_hash(token)],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(store_err)?;
    match row {
        Some((turn_id, conversation_id, expires, revoked, kind))
            if kind == "assistant" && revoked == 0 && expires > ctx.now =>
        {
            Ok(AssistantGrant {
                turn_id,
                conversation_id,
                expires_at: expires,
            })
        }
        _ => Err(CoreError::new(
            Code::NotAllowed,
            "Expired or revoked assistant grant",
        )),
    }
}

/// `requireWorkScope` (`src/dispatch/work.ts`:140): the target must be within the grant's
/// subtree. For a review op the caller's own task is not in scope.
pub fn require_work_scope(
    ctx: &Ctx,
    token: &str,
    id: &str,
    review: bool,
) -> Result<WorkNode, CoreError> {
    let mut store = open(ctx)?;
    let db = store.connection().map_err(store_err)?;
    require_work_scope_db(&db, ctx, token, id, review)
}

pub(crate) fn require_work_scope_db(
    db: &Connection,
    ctx: &Ctx,
    token: &str,
    id: &str,
    review: bool,
) -> Result<WorkNode, CoreError> {
    let caller = authorize_work_grant_db(db, ctx, token)?;
    let mut cursor = get_work(db, id);
    let mut seen: HashSet<String> = HashSet::new();
    loop {
        let Some(node) = cursor else { break };
        if !seen.insert(node.task_id.clone()) {
            break;
        }
        if node.task_id == caller.task_id {
            if review && id == caller.task_id {
                break;
            }
            return Ok(caller);
        }
        cursor = match &node.parent_id {
            Some(parent) => get_work(db, parent),
            None => break,
        };
    }
    Err(CoreError::new(
        Code::NotAllowed,
        "Operation is outside the delegated subtree",
    ))
}

/// The number of entries in the task record's `attempts` array (`task.attempts.length`).
fn attempts_len(record: &str) -> i64 {
    serde_json::from_str::<Value>(record)
        .ok()
        .and_then(|value| {
            value
                .get("attempts")
                .and_then(Value::as_array)
                .map(|a| a.len() as i64)
        })
        .unwrap_or(0)
}
