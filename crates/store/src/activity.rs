//! Activity log store.
use crate::schema::SchemaError;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ActivityError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("schema error: {0}")]
    Schema(#[from] SchemaError),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, ActivityError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityEntry {
    pub id: i64,
    pub task_id: String,
    pub kind: String,
    pub message: String,
    pub metadata: Option<serde_json::Value>,
    pub created_at: f64,
}

/// Activity log store for recording task lifecycle events.
pub struct ActivityStore {
    conn: Connection,
}

impl ActivityStore {
    /// Open the activity store using an existing connection.
    pub fn new(conn: Connection) -> Self {
        Self { conn }
    }

    /// Append an activity entry.
    pub fn append(&mut self, task_id: &str, kind: &str, message: &str, metadata: Option<serde_json::Value>) -> Result<i64> {
        let created_at = chrono::Utc::now().timestamp() as f64;
        let metadata_json = metadata.map(|v| serde_json::to_string(&v)).transpose()?;

        self.conn.execute(
            "INSERT INTO activity_log (task_id, kind, message, metadata, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![task_id, kind, message, metadata_json, created_at],
        )?;

        Ok(self.conn.last_insert_rowid())
    }

    /// List activity entries for a task.
    pub fn list(&self, task_id: &str, limit: Option<usize>) -> Result<Vec<ActivityEntry>> {
        let limit = limit.unwrap_or(100) as i64;
        let mut stmt = self.conn.prepare(
            "SELECT id, task_id, kind, message, metadata, created_at FROM activity_log WHERE task_id = ?1 ORDER BY created_at DESC LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![task_id, limit], |row| {
            let metadata: Option<String> = row.get(4)?;
            let metadata_val = metadata.as_deref().map(serde_json::from_str).transpose().map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            Ok(ActivityEntry {
                id: row.get(0)?,
                task_id: row.get(1)?,
                kind: row.get(2)?,
                message: row.get(3)?,
                metadata: metadata_val,
                created_at: row.get(5)?,
            })
        })?;

        let mut entries = Vec::new();
        for entry in rows {
            entries.push(entry?);
        }
        Ok(entries)
    }

    /// List recent activity across all tasks.
    pub fn list_recent(&self, limit: Option<usize>) -> Result<Vec<ActivityEntry>> {
        let limit = limit.unwrap_or(100) as i64;
        let mut stmt = self.conn.prepare(
            "SELECT id, task_id, kind, message, metadata, created_at FROM activity_log ORDER BY created_at DESC LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            let metadata: Option<String> = row.get(4)?;
            let metadata_val = metadata.as_deref().map(serde_json::from_str).transpose().map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            Ok(ActivityEntry {
                id: row.get(0)?,
                task_id: row.get(1)?,
                kind: row.get(2)?,
                message: row.get(3)?,
                metadata: metadata_val,
                created_at: row.get(5)?,
            })
        })?;

        let mut entries = Vec::new();
        for entry in rows {
            entries.push(entry?);
        }
        Ok(entries)
    }
}