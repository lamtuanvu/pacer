//! Database schema initialization and migrations.
use pacer_foundation::Ctx;
use rusqlite::{Connection, OptionalExtension, params};
use std::path::PathBuf;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum SchemaError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, SchemaError>;

/// Initialize the task store database with all required tables and indexes.
pub fn init_db(ctx: &Ctx) -> Result<Connection> {
    let db_path = db_path(ctx);
    let state_dir = db_path.parent().unwrap();

    std::fs::create_dir_all(state_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(state_dir, std::fs::Permissions::from_mode(0o700))?;
    }

    // Create the database file with correct permissions before SQLite opens it
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let _ = options.open(&db_path)?;

    let mut conn = Connection::open(&db_path)?;

    // Configure SQLite
    // Pragmas that return results need special handling - ignore ExecuteReturnedResults
    let _ = conn.execute("PRAGMA journal_mode = WAL", []);
    let _ = conn.execute("PRAGMA synchronous = NORMAL", []);
    conn.busy_timeout(std::time::Duration::from_millis(5000))?;

    // Run migrations
    let migrations = migrations();
    for migration in migrations {
        migration.apply(&mut conn)?;
    }

    Ok(conn)
}

fn db_path(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("state").join("tasks.db")
}

struct Migration {
    version: u32,
    name: &'static str,
    up: fn(&mut Connection) -> rusqlite::Result<()>,
}

impl Migration {
    fn apply(&self, conn: &mut Connection) -> rusqlite::Result<()> {
        // Check if migration already applied
        let applied: Option<u32> = conn
            .query_row(
                "SELECT version FROM schema_migrations WHERE version = ?1",
                params![self.version],
                |row| row.get(0),
            )
            .optional()
            .or_else(|e| {
                // If the schema_migrations table doesn't exist yet, treat as not applied
                if let rusqlite::Error::SqliteFailure(err, _) = &e {
                    if err.code == rusqlite::ErrorCode::Unknown && err.extended_code == 1 {
                        return Ok(None);
                    }
                }
                Err(e)
            })?;

        if applied.is_some() {
            return Ok(());
        }

        // Apply migration
        (self.up)(conn)?;

        // Record migration
        conn.execute(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, datetime('now'))",
            params![self.version, self.name],
        )?;

        Ok(())
    }
}

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            name: "initial_schema",
            up: |conn| {
                conn.execute_batch(
                    r#"
                    CREATE TABLE IF NOT EXISTS schema_migrations (
                        version INTEGER PRIMARY KEY,
                        name TEXT NOT NULL,
                        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
                    );

                    CREATE TABLE IF NOT EXISTS tasks (
                        id TEXT PRIMARY KEY,
                        rev INTEGER NOT NULL,
                        state TEXT NOT NULL,
                        created_at REAL NOT NULL,
                        updated_at REAL NOT NULL,
                        settled_at REAL,
                        repo TEXT,
                        record TEXT NOT NULL,
                        json_mtime REAL,
                        archived INTEGER NOT NULL DEFAULT 0
                    );

                    CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state);
                    CREATE INDEX IF NOT EXISTS tasks_updated_at ON tasks(updated_at);
                    CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks(created_at);
                    CREATE INDEX IF NOT EXISTS tasks_retention ON tasks(archived, settled_at);
                    "#,
                )?;
                Ok(())
            },
        },
        Migration {
            version: 2,
            name: "activity_log",
            up: |conn| {
                conn.execute_batch(
                    r#"
                    CREATE TABLE IF NOT EXISTS activity_log (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        task_id TEXT NOT NULL,
                        kind TEXT NOT NULL,
                        message TEXT NOT NULL,
                        metadata TEXT,
                        created_at REAL NOT NULL DEFAULT (strftime('%s', 'now'))
                    );

                    CREATE INDEX IF NOT EXISTS activity_log_task_id ON activity_log(task_id);
                    CREATE INDEX IF NOT EXISTS activity_log_created_at ON activity_log(created_at);
                    "#,
                )?;
                Ok(())
            },
        },
        Migration {
            version: 3,
            name: "outbox",
            up: |conn| {
                conn.execute_batch(
                    r#"
                    CREATE TABLE IF NOT EXISTS outbox (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        event_type TEXT NOT NULL,
                        payload TEXT NOT NULL,
                        created_at REAL NOT NULL DEFAULT (strftime('%s', 'now')),
                        published_at REAL
                    );

                    CREATE INDEX IF NOT EXISTS outbox_published_at ON outbox(published_at);
                    CREATE INDEX IF NOT EXISTS outbox_created_at ON outbox(created_at);
                    "#,
                )?;
                Ok(())
            },
        },
    ]
}