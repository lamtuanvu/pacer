//! Assistant settings and history tables shared with `src/assistant/store.ts`.
//!
//! Values cross as Bun's SQLite binding returns them, and stored JSON parses with
//! `JSON.parse` key order (array-index keys first).
use crate::{StoreError, TaskStore};
pub use rusqlite::Connection;
use rusqlite::{
    OptionalExtension, Row, Transaction, TransactionBehavior, params, types::Value as SqlValue,
};
use serde_json::{Map, Value, json};

type Result<T> = std::result::Result<T, StoreError>;

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS assistant_settings(id INTEGER PRIMARY KEY CHECK(id=1), runner TEXT, account TEXT, limits TEXT NOT NULL, retention TEXT NOT NULL, rev INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS assistant_conversations_updated ON assistant_conversations(updated_at);
    CREATE TABLE IF NOT EXISTS assistant_turns(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE, seq INTEGER NOT NULL, at REAL NOT NULL,
      question TEXT NOT NULL, answer TEXT, state TEXT NOT NULL, error TEXT, account TEXT, scope TEXT NOT NULL, tool_calls TEXT NOT NULL DEFAULT '[]', cards TEXT NOT NULL DEFAULT '[]', citations TEXT NOT NULL DEFAULT '[]');
    CREATE INDEX IF NOT EXISTS assistant_turns_conversation ON assistant_turns(conversation_id, seq);
    CREATE TABLE IF NOT EXISTS assistant_usage(turn_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, at REAL NOT NULL, account TEXT, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER, cache_write INTEGER, coverage TEXT NOT NULL DEFAULT 'unknown' CHECK(coverage IN ('measured','partial','unknown')));
    CREATE INDEX IF NOT EXISTS assistant_usage_at ON assistant_usage(at);
  ";

/// One integer setting: `z.number().int().min(min).max(max).default(default)`.
pub struct Field {
    pub name: &'static str,
    pub min: i64,
    pub max: i64,
    pub default: i64,
}
const fn field(name: &'static str, min: i64, max: i64, default: i64) -> Field {
    Field {
        name,
        min,
        max,
        default,
    }
}
/// `assistantLimitsSchema`, in schema key order.
pub const LIMITS: [Field; 5] = [
    field("maxInputTokens", 1000, 200_000, 32_000),
    field("maxOutputTokens", 100, 32_000, 8_000),
    field("maxToolRounds", 0, 6, 6),
    field("turnsPerDay", 1, 1000, 50),
    field("deadlineMs", 1000, 120_000, 120_000),
];
/// `retentionSchema`, in schema key order.
pub const RETENTION: [Field; 2] = [
    field("days", 1, 365, 30),
    field("conversations", 1, 1000, 200),
];

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub runner: Option<String>,
    pub account: Option<String>,
    pub limits: Vec<i64>,
    pub retention: Vec<i64>,
    pub rev: i64,
}
impl Settings {
    fn defaults() -> Self {
        Self {
            runner: None,
            account: None,
            limits: LIMITS.iter().map(|f| f.default).collect(),
            retention: RETENTION.iter().map(|f| f.default).collect(),
            rev: 1,
        }
    }
    pub fn limit(&self, name: &str) -> i64 {
        LIMITS
            .iter()
            .position(|f| f.name == name)
            .map_or(0, |i| self.limits[i])
    }
    pub fn retention(&self, name: &str) -> i64 {
        RETENTION
            .iter()
            .position(|f| f.name == name)
            .map_or(0, |i| self.retention[i])
    }
    pub fn limits_json(&self) -> Value {
        fields_json(&LIMITS, &self.limits)
    }
    pub fn retention_json(&self) -> Value {
        fields_json(&RETENTION, &self.retention)
    }
    /// `AssistantSettings` as `readSettings` returns it.
    pub fn to_json(&self) -> Value {
        json!({"runner":self.runner,"account":self.account,"limits":self.limits_json(),"retention":self.retention_json(),"rev":self.rev})
    }
}

fn fields_json(fields: &[Field], values: &[i64]) -> Value {
    Value::Object(
        fields
            .iter()
            .zip(values)
            .map(|(f, v)| (f.name.to_owned(), json!(v)))
            .collect(),
    )
}

/// `schema.parse(JSON.parse(text))`; `None` where TypeScript throws.
fn stored_fields(text: &str, fields: &[Field]) -> Option<Vec<i64>> {
    let value: Value = serde_json::from_str(text).ok()?;
    let map = value.as_object()?;
    fields
        .iter()
        .map(|f| match map.get(f.name) {
            None => Some(f.default),
            Some(v) => {
                let n = v.as_f64()?;
                (n.fract() == 0.0 && n >= f.min as f64 && n <= f.max as f64).then_some(n as i64)
            }
        })
        .collect()
}

/// The value Bun's SQLite binding returns for a stored column.
pub fn sql_json(value: SqlValue) -> Value {
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

fn array_index(key: &str) -> Option<u32> {
    key.parse::<u32>()
        .ok()
        .filter(|n| *n < u32::MAX && n.to_string() == key)
}

/// `JSON.parse` own-key order: array-index keys ascending, then insertion order.
fn js_order(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(js_order).collect()),
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> =
                map.into_iter().map(|(k, v)| (k, js_order(v))).collect();
            if entries.iter().any(|(k, _)| array_index(k).is_some()) {
                entries.sort_by_key(|(k, _)| array_index(k).map_or((1, 0), |n| (0, n)));
            }
            Value::Object(entries.into_iter().collect())
        }
        other => other,
    }
}

pub fn js_parse(text: &str) -> Result<Value> {
    Ok(js_order(serde_json::from_str(text)?))
}

/// `assistantDatabase`: the shared task database with the assistant tables.
pub fn database(store: &mut TaskStore) -> Result<&Connection> {
    let db = store.connection()?;
    db.execute_batch("PRAGMA secure_delete = ON")?;
    db.execute_batch(SCHEMA)?;
    db.execute_batch("PRAGMA foreign_keys = ON")?;
    Ok(db)
}

/// `readSettings`; `None` when the stored row fails the TypeScript schemas.
pub fn read_settings(db: &Connection) -> Result<Option<Settings>> {
    let row = db
        .query_row(
            "SELECT runner,account,limits,retention,rev FROM assistant_settings WHERE id=1",
            [],
            |r| {
                Ok((
                    r.get::<_, SqlValue>(0)?,
                    r.get::<_, SqlValue>(1)?,
                    r.get::<_, SqlValue>(2)?,
                    r.get::<_, SqlValue>(3)?,
                    r.get::<_, SqlValue>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((runner, account, limits, retention, rev)) = row else {
        return Ok(Some(Settings::defaults()));
    };
    let text = |v: SqlValue| match v {
        SqlValue::Null => Some(None),
        SqlValue::Text(s) => Some(Some(s)),
        _ => None,
    };
    let fields = |v: SqlValue, fields: &[Field]| match v {
        SqlValue::Text(s) => stored_fields(&s, fields),
        _ => None,
    };
    let rev = match rev {
        SqlValue::Integer(n) => Some(n),
        _ => None,
    };
    Ok((|| {
        Some(Settings {
            runner: text(runner)?,
            account: text(account)?,
            limits: fields(limits, &LIMITS)?,
            retention: fields(retention, &RETENTION)?,
            rev: rev?,
        })
    })())
}

pub enum SettingsWrite {
    Saved(Settings),
    Conflict(i64),
    Unusable,
}

/// `writeSettings`. A present `limits` or `retention` is already a full,
/// default-filled object (`schema.partial()` applies field defaults).
pub fn write_settings(
    db: &Connection,
    runner: Option<String>,
    account: Option<String>,
    limits: Option<Vec<i64>>,
    retention: Option<Vec<i64>>,
    expect_rev: i64,
) -> Result<SettingsWrite> {
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
    let Some(current) = read_settings(&tx)? else {
        return Ok(SettingsWrite::Unusable);
    };
    if current.rev != expect_rev {
        return Ok(SettingsWrite::Conflict(current.rev));
    }
    let next = Settings {
        runner,
        account,
        limits: limits.unwrap_or(current.limits),
        retention: retention.unwrap_or(current.retention),
        rev: current.rev + 1,
    };
    tx.execute("INSERT INTO assistant_settings(id,runner,account,limits,retention,rev) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET runner=excluded.runner,account=excluded.account,limits=excluded.limits,retention=excluded.retention,rev=excluded.rev",
        params![next.runner, next.account, next.limits_json().to_string(), next.retention_json().to_string(), next.rev])?;
    tx.commit()?;
    Ok(SettingsWrite::Saved(next))
}

/// `enforceRetention`: conversations past their period or over the count.
pub fn enforce_retention(
    db: &Connection,
    now: f64,
    days: i64,
    conversations: i64,
) -> Result<usize> {
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
    let mut ids: Vec<String> = Vec::new();
    for (sql, bound) in [
        (
            "SELECT id FROM assistant_conversations WHERE updated_at<?",
            js_bound(now - (days * 86400) as f64),
        ),
        (
            "SELECT id FROM assistant_conversations ORDER BY updated_at DESC LIMIT -1 OFFSET ?",
            SqlValue::Integer(conversations),
        ),
    ] {
        let mut stmt = tx.prepare(sql)?;
        for id in stmt.query_map([bound], |r| r.get::<_, String>(0))? {
            let id = id?;
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    for id in &ids {
        tx.execute("DELETE FROM assistant_turns WHERE conversation_id=?", [id])?;
        tx.execute("DELETE FROM assistant_conversations WHERE id=?", [id])?;
    }
    tx.commit()?;
    Ok(ids.len())
}

/// Deleted text can linger in WAL frames until a checkpoint; a busy log retries on the next write.
pub fn checkpoint(db: &Connection) {
    let _ = db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
}

/// `listConversations`: newest first, before an `updated_at` bound.
pub fn conversations(db: &Connection, before: f64, limit: i64) -> Result<Vec<Value>> {
    let mut stmt = db.prepare("SELECT c.id,c.title,c.updated_at,(SELECT COUNT(*) FROM assistant_turns t WHERE t.conversation_id=c.id) AS turns FROM assistant_conversations c WHERE c.updated_at<? ORDER BY c.updated_at DESC LIMIT ?")?;
    let rows = stmt
        .query_map(params![js_bound(before), limit], |r| {
            Ok(json!({"id":sql_json(r.get(0)?),"title":sql_json(r.get(1)?),"updatedAt":sql_json(r.get(2)?),"turns":sql_json(r.get(3)?)}))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

const TURN: &str = "SELECT id,conversation_id,at,question,answer,state,error,account,scope,cards,citations FROM assistant_turns";

fn usage(db: &Connection, id: &Value) -> Result<Value> {
    let Some(id) = id.as_str() else {
        return Ok(Value::Null);
    };
    let row = db
        .query_row(
            "SELECT input,output,cache_read,cache_write,coverage FROM assistant_usage WHERE turn_id=?",
            [id],
            |r| {
                let mut out = Map::new();
                out.insert("input".into(), sql_json(r.get(0)?));
                out.insert("output".into(), sql_json(r.get(1)?));
                out.insert("coverage".into(), sql_json(r.get(4)?));
                for (i, key) in [(2, "cacheRead"), (3, "cacheWrite")] {
                    let value = sql_json(r.get(i)?);
                    if !value.is_null() {
                        out.insert(key.into(), value);
                    }
                }
                Ok(Value::Object(out))
            },
        )
        .optional()?;
    Ok(row.unwrap_or(Value::Null))
}

fn raw_turn(r: &Row<'_>) -> rusqlite::Result<Vec<Value>> {
    (0..11)
        .map(|i| r.get::<_, SqlValue>(i).map(sql_json))
        .collect()
}

/// `toView`: the turn, its usage and its parsed cards, citations and scope.
fn turn_view(db: &Connection, row: Vec<Value>) -> Result<Value> {
    let parse = |v: &Value| js_parse(v.as_str().unwrap_or("null"));
    let mut out = Map::new();
    for (key, value) in [
        "id",
        "conversationId",
        "at",
        "question",
        "answer",
        "state",
        "error",
        "account",
    ]
    .into_iter()
    .zip(&row)
    {
        out.insert(key.into(), value.clone());
    }
    out.insert("usage".into(), usage(db, &row[0])?);
    out.insert("cards".into(), parse(&row[9])?);
    out.insert("citations".into(), parse(&row[10])?);
    out.insert("scope".into(), parse(&row[8])?);
    Ok(Value::Object(out))
}

/// `getTurn`.
pub fn turn(db: &Connection, id: &str) -> Result<Option<Value>> {
    let row = db
        .query_row(&format!("{TURN} WHERE id=?"), [id], raw_turn)
        .optional()?;
    row.map(|row| turn_view(db, row)).transpose()
}

fn has_conversation(db: &Connection, id: &str) -> Result<bool> {
    Ok(db
        .query_row(
            "SELECT 1 FROM assistant_conversations WHERE id=?",
            [id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// `conversationTurns`; `None` for an unknown conversation.
pub fn conversation_turns(db: &Connection, id: &str) -> Result<Option<Vec<Value>>> {
    if !has_conversation(db, id)? {
        return Ok(None);
    }
    let mut stmt = db.prepare(&format!("{TURN} WHERE conversation_id=? ORDER BY seq"))?;
    let rows = stmt
        .query_map([id], raw_turn)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|row| turn_view(db, row))
        .collect::<Result<Vec<_>>>()
        .map(Some)
}

/// `deleteConversations`: text only, usage rows stay; `None` for an unknown conversation.
pub fn delete_conversations(db: &Connection, id: Option<&str>) -> Result<Option<usize>> {
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
    let deleted = match id {
        Some(id) => {
            if !has_conversation(&tx, id)? {
                return Ok(None);
            }
            tx.execute("DELETE FROM assistant_turns WHERE conversation_id=?", [id])?;
            tx.execute("DELETE FROM assistant_conversations WHERE id=?", [id])?
        }
        None => {
            tx.execute("DELETE FROM assistant_turns", [])?;
            tx.execute("DELETE FROM assistant_conversations", [])?
        }
    };
    tx.commit()?;
    Ok(Some(deleted))
}

pub enum CardUpdate {
    UnknownTurn,
    UnknownCard,
    Updated(Value),
}

/// `updateCard`: patch one card in place and store the cards as `stringify` writes them.
pub fn update_card(
    db: &Connection,
    turn_id: &str,
    card_id: &str,
    patch: impl FnOnce(&mut Map<String, Value>),
    stringify: impl Fn(&Value) -> String,
) -> Result<CardUpdate> {
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
    let Some(text) = tx
        .query_row(
            "SELECT cards FROM assistant_turns WHERE id=?",
            [turn_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    else {
        return Ok(CardUpdate::UnknownTurn);
    };
    let mut cards = js_parse(&text)?;
    let Some(card) = cards.as_array_mut().and_then(|cards| {
        cards
            .iter_mut()
            .find(|c| c.get("id").and_then(Value::as_str) == Some(card_id))
    }) else {
        return Ok(CardUpdate::UnknownCard);
    };
    if let Some(map) = card.as_object_mut() {
        patch(map);
    }
    let updated = card.clone();
    tx.execute(
        "UPDATE assistant_turns SET cards=? WHERE id=?",
        params![stringify(&cards), turn_id],
    )?;
    tx.commit()?;
    Ok(CardUpdate::Updated(updated))
}

/// `usageToday` from a local-midnight bound: `[turns, input, output]`.
pub fn usage_since(db: &Connection, at: f64) -> Result<[Value; 3]> {
    let row = db.query_row(
        "SELECT COUNT(*) AS n,SUM(input) AS i,SUM(output) AS o FROM assistant_usage WHERE at>=?",
        [js_bound(at)],
        |r| {
            Ok([
                sql_json(r.get(0)?),
                sql_json(r.get(1)?),
                sql_json(r.get(2)?),
            ])
        },
    )?;
    Ok(row.map(|v| if v.is_null() { json!(0) } else { v }))
}

/// Bun binds an integral JavaScript number as an integer.
fn js_bound(n: f64) -> SqlValue {
    if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
        SqlValue::Integer(n as i64)
    } else {
        SqlValue::Real(n)
    }
}

#[cfg(test)]
mod tests;
