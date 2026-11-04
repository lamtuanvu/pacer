//! Outbox store for event publishing.
use crate::schema::SchemaError;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum OutboxError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("schema error: {0}")]
    Schema(#[from] SchemaError),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, OutboxError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxEntry {
    pub id: i64,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub created_at: f64,
    pub published_at: Option<f64>,
}

/// Outbox store for reliable event publishing.
pub struct OutboxStore {
    conn: Connection,
}

impl OutboxStore {
    /// Open the outbox store using an existing connection.
    pub fn new(conn: Connection) -> Self {
        Self { conn }
    }

    /// Append an event to the outbox.
    pub fn append(&mut self, event_type: &str, payload: serde_json::Value) -> Result<i64> {
        let created_at = chrono::Utc::now().timestamp() as f64;
        let payload_json = serde_json::to_string(&payload)?;

        self.conn.execute(
            "INSERT INTO outbox (event_type, payload, created_at) VALUES (?1, ?2, ?3)",
            params![event_type, payload_json, created_at],
        )?;

        Ok(self.conn.last_insert_rowid())
    }

    /// Get unpublished events.
    pub fn unpublished(&self, limit: Option<usize>) -> Result<Vec<OutboxEntry>> {
        let limit = limit.unwrap_or(100) as i64;
        let mut stmt = self.conn.prepare(
            "SELECT id, event_type, payload, created_at, published_at FROM outbox WHERE published_at IS NULL ORDER BY created_at ASC LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            let payload: String = row.get(2)?;
            Ok(OutboxEntry {
                id: row.get(0)?,
                event_type: row.get(1)?,
                payload: serde_json::from_str(&payload).map_err(|e| rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e)))?,
                created_at: row.get(3)?,
                published_at: row.get(4)?,
            })
        })?;

        let mut entries = Vec::new();
        for entry in rows {
            entries.push(entry?);
        }
        Ok(entries)
    }

    /// Mark events as published.
    pub fn mark_published(&mut self, ids: &[i64]) -> Result<usize> {
        if ids.is_empty() {
            return Ok(0);
        }
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let published_at = chrono::Utc::now().timestamp() as f64;
        let mut stmt = self.conn.prepare(&format!(
            "UPDATE outbox SET published_at = ?1 WHERE id IN ({placeholders})"
        ))?;
        let mut params: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Real(published_at)];
        for id in ids {
            params.push(rusqlite::types::Value::Integer(*id));
        }
        let changed = stmt.execute(rusqlite::params_from_iter(params))?;
        Ok(changed)
    }

    /// Get all events (for debugging/admin).
    pub fn all(&self, limit: Option<usize>) -> Result<Vec<OutboxEntry>> {
        let limit = limit.unwrap_or(100) as i64;
        let mut stmt = self.conn.prepare(
            "SELECT id, event_type, payload, created_at, published_at FROM outbox ORDER BY created_at DESC LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            let payload: String = row.get(2)?;
            Ok(OutboxEntry {
                id: row.get(0)?,
                event_type: row.get(1)?,
                payload: serde_json::from_str(&payload).map_err(|e| rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e)))?,
                created_at: row.get(3)?,
                published_at: row.get(4)?,
            })
        })?;

        let mut entries = Vec::new();
        for entry in rows {
            entries.push(entry?);
        }
        Ok(entries)
    }
}