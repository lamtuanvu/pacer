//! Task store implementation with SQLite backend.
use crate::schema::{init_db, SchemaError};
use crate::types::*;
use pacer_foundation::{Ctx, fsutil::write_json_atomic, lock::{LockOptions, with_lock}};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum TaskStoreError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("schema error: {0}")]
    Schema(#[from] SchemaError),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("lock error: {0}")]
    Lock(#[from] pacer_foundation::lock::LockError),
    #[error("invalid task id: {0}")]
    InvalidTaskId(String),
    #[error("task not found: {0}")]
    TaskNotFound(String),
    #[error("task conflict: {0}")]
    Conflict(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("system time error: {0}")]
    SystemTime(#[from] std::time::SystemTimeError),
}

pub type Result<T> = std::result::Result<T, TaskStoreError>;

const TASK_ID_REGEX: &str = r"^t-\d{8}-\d{6}-[0-9a-f]{4}$";

/// Generate a new task ID in the format `t-YYYYMMDD-HHMMSS-xxxx`.
pub fn new_task_id(now_s: u64) -> String {
    let dt = chrono::DateTime::from_timestamp(now_s as i64, 0)
        .unwrap_or_else(|| chrono::Utc::now());
    let stamp = dt.format("%Y%m%d-%H%M%S").to_string();
    let random = rand::random::<u16>();
    format!("t-{stamp}-{random:04x}")
}

/// Check if a string is a valid task ID.
pub fn is_task_id(id: &str) -> bool {
    regex::Regex::new(TASK_ID_REGEX).unwrap().is_match(id)
}

fn tasks_dir(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("tasks")
}

fn task_archive_dir(ctx: &Ctx, task: &TaskRecord) -> PathBuf {
    let dt = chrono::DateTime::from_timestamp(task.created_at as i64, 0)
        .unwrap_or_else(|| chrono::Utc::now());
    let month = dt.format("%Y-%m").to_string();
    ctx.pacer_home.join("archive").join(month).join(&task.id)
}

fn activity_at(task: &TaskRecord) -> u64 {
    let mut max_time = task.created_at;
    if let Some(v) = task.attempt_started_at {
        max_time = max_time.max(v);
    }
    if let Some(v) = task.review_request.as_ref().map(|r| r.at) {
        max_time = max_time.max(v);
    }
    if let Some(v) = task.review.as_ref().map(|r| r.at) {
        max_time = max_time.max(v);
    }
    for attempt in &task.attempts {
        max_time = max_time.max(attempt.started_at);
        max_time = max_time.max(attempt.ended_at);
    }
    max_time
}

fn values(task: &TaskRecord, now: u64) -> Vec<rusqlite::types::Value> {
    let updated = now.max(activity_at(task));
    let settled_at = if task.is_terminal() {
        task.settled_at.or_else(|| {
            let times: Vec<u64> = task
                .attempts
                .iter()
                .filter_map(|a| if a.ended_at > 0 { Some(a.ended_at) } else { None })
                .collect();
            if let Some(&max) = times.iter().max() {
                Some(max.max(task.created_at))
            } else {
                None
            }
        })
    } else {
        None
    };

    vec![
        rusqlite::types::Value::Text(task.id.clone()),
        rusqlite::types::Value::Integer(task.rev as i64),
        rusqlite::types::Value::Text(task.state.clone()),
        rusqlite::types::Value::Real(task.created_at as f64),
        rusqlite::types::Value::Real(updated as f64),
        settled_at.map(|v| rusqlite::types::Value::Real(v as f64)).unwrap_or(rusqlite::types::Value::Null),
        rusqlite::types::Value::Text(task.brief.repo.clone()),
        rusqlite::types::Value::Text(serde_json::to_string(task).unwrap()),
        rusqlite::types::Value::Integer(if task.archived.unwrap_or(false) { 1 } else { 0 }),
    ]
}

/// Import legacy JSON task files into SQLite.
fn import_json(ctx: &Ctx, conn: &mut Connection) -> Result<()> {
    let dir = tasks_dir(ctx);
    if !dir.exists() {
        return Ok(());
    }

    let tx = conn.transaction()?;

    if let Ok(entries) = std::fs::read_dir(&dir) {;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            let id = name_str.strip_suffix(".json").unwrap_or("");
            if !is_task_id(id) {
                continue;
            }

            let mtime = entry.metadata()?.modified()?.duration_since(std::time::UNIX_EPOCH)?.as_millis() as u64;

            // Check if already imported with same or newer mtime
            let existing: Option<(i64, Option<f64>)> = tx
                .query_row(
                    "SELECT rev, json_mtime FROM tasks WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get::<_, Option<f64>>(1)?)),
                )
                .optional()?;

            if let Some((_, Some(existing_mtime))) = existing {
                if existing_mtime >= mtime as f64 {
                    continue;
                }
            }

            // Read and validate the JSON
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    eprintln!("pacer: skipping corrupt task {name_str}: {e}");
                    continue;
                }
            };

            let task: TaskRecord = match serde_json::from_str(&content) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("pacer: skipping corrupt task {name_str}: {e}");
                    continue;
                }
            };

            // Validate task record
            let is_terminal = TERMINAL_STATES.contains(&task.state.as_str());
            let attempts_valid = if is_terminal {
                !task.attempts.is_empty() && task.attempts.iter().all(|a| a.started_at > 0 && a.ended_at > 0)
            } else {
                true // Non-terminal tasks can have empty attempts
            };
            
            if task.id != id
                || !is_task_id(&task.id)
                || task.created_at == 0
                || !attempts_valid
                || (!is_terminal && !["queued", "running"].contains(&task.state.as_str()))
                || task.brief.repo.is_empty()
            {
                eprintln!("pacer: skipping invalid task {name_str}");
                continue;
            }

            let task_rev = task.rev.max(1);
            let mut task_with_rev = task;
            task_with_rev.rev = task_rev;

            let vals = values(&task_with_rev, activity_at(&task_with_rev));
            tx.execute(
                r#"
                INSERT INTO tasks (id, rev, state, created_at, updated_at, settled_at, repo, record, archived, json_mtime)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                ON CONFLICT(id) DO UPDATE SET
                    rev = excluded.rev,
                    state = excluded.state,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    settled_at = excluded.settled_at,
                    repo = excluded.repo,
                    record = excluded.record,
                    archived = excluded.archived,
                    json_mtime = excluded.json_mtime
                WHERE excluded.rev > tasks.rev
                   OR (excluded.rev = tasks.rev AND (tasks.json_mtime IS NULL OR excluded.json_mtime > tasks.json_mtime))
                "#,
                params![
                    vals[0], vals[1], vals[2], vals[3], vals[4], vals[5], vals[6], vals[7], vals[8], mtime as f64
                ],
            )?;
        }
    }

    tx.commit()?;
    Ok(())
}

/// Write compatibility JSON file for older binaries.
fn write_compatibility_json(ctx: &Ctx, task: &TaskRecord) -> Result<u64> {
    let dir = if task.archived.unwrap_or(false) {
        task_archive_dir(ctx, task)
    } else {
        tasks_dir(ctx)
    };

    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }

    let file = dir.join(format!("{}.json", task.id));
    write_json_atomic(&file, task)?;

    let mtime = std::fs::metadata(&file)?.modified()?.duration_since(std::time::UNIX_EPOCH)?.as_millis() as u64;
    Ok(mtime)
}

/// Task store handle.
pub struct TaskStore {
    conn: Connection,
    ctx: Ctx,
}

impl TaskStore {
    /// Open or create the task store.
    pub fn open(ctx: Ctx) -> Result<Self> {
        assert_pacer_home_allowed(&ctx.pacer_home)?;
        let mut conn = init_db(&ctx)?;
        import_json(&ctx, &mut conn)?;
        Ok(Self { conn, ctx })
    }

    /// Get the underlying database connection.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Get a mutable reference to the connection.
    pub fn connection_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// Create a new task.
    pub fn create_task(
        &mut self,
        input: CreateTaskInput,
        on_create: Option<&dyn Fn(&TaskRecord, &Connection)>,
    ) -> Result<TaskRecord> {
        let now = self.ctx.now as u64;

        for _ in 0..65 {
            let id = new_task_id(now);
            let task = TaskRecord {
                id: id.clone(),
                rev: 1,
                created_at: now,
                state: "queued".to_string(),
                attempts: vec![],
                brief: input.brief.clone(),
                kind: input.kind.clone(),
                requested_executor: input.requested_executor.clone(),
                timeout_s: input.timeout_s,
                title: input.title.clone(),
                source: input.source.clone(),
                request_id: input.request_id.clone(),
                repo: input.repo.clone(),
                client: input.client.clone(),
                placement: input.placement.clone(),
                base_branch: input.base_branch.clone(),
                base_sha: input.base_sha.clone(),
                interaction_mode: input.interaction_mode.clone(),
                conversation: input.conversation.clone(),
                session_draft_id: input.session_draft_id.clone(),
                ..Default::default()
            };

            let tx = self.conn.transaction()?;
            let result = tx.execute(
                r#"
                INSERT OR IGNORE INTO tasks (id, rev, state, created_at, updated_at, settled_at, repo, record, archived)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
                params![
                    task.id,
                    task.rev,
                    task.state,
                    task.created_at as f64,
                    task.created_at as f64,
                    Option::<f64>::None,
                    task.brief.repo,
                    serde_json::to_string(&task).unwrap(),
                    0,
                ],
            )?;

            if result == 0 {
                continue;
            }

            if let Some(cb) = on_create {
                cb(&task, &tx);
            }

            let mtime = write_compatibility_json(&self.ctx, &task)?;
            tx.execute("UPDATE tasks SET json_mtime = ?1 WHERE id = ?2", params![mtime as f64, &task.id])?;
            tx.commit()?;

            return Ok::<TaskRecord, TaskStoreError>(task);
        }

        Err(TaskStoreError::InvalidInput("could not allocate a unique task id".into()))
    }

    /// Read a task by ID.
    pub fn read_task(&self, id: &str) -> Result<Option<TaskRecord>> {
        if !is_task_id(id) {
            return Ok(None);
        }

        let record: Option<String> = self.conn.query_row(
            "SELECT record FROM tasks WHERE id = ?1",
            params![id],
            |row| row.get(0),
        ).optional()?;

        match record {
            Some(json) => {
                let mut task: TaskRecord = serde_json::from_str(&json)?;
                if task.rev == 0 {
                    task.rev = 1;
                }
                Ok(Some(task))
            }
            None => Ok(None),
        }
    }

    /// Update a task with a mutation function.
    pub fn update_task<F>(&mut self, id: &str, mutate: F) -> Result<TaskRecord>
    where
        F: FnOnce(&mut TaskRecord),
    {
        if !is_task_id(id) {
            return Err(TaskStoreError::InvalidTaskId(id.into()));
        }

        // Read the task first (outside the lock) to avoid borrowing issues
        let mut task = self.read_task(id)?.ok_or_else(|| TaskStoreError::TaskNotFound(id.into()))?;

        let lock_name = format!("task-{id}");
        let result = with_lock(&self.ctx, &lock_name, LockOptions::default(), || -> Result<TaskRecord> {
            let tx = self.conn.transaction()?;
            let rev = task.rev;
            let prior_state = task.state.clone();

            mutate(&mut task);

            if task.is_terminal() && !TERMINAL_STATES.contains(&prior_state.as_str()) {
                task.settled_at = Some(self.ctx.now as u64);
            }
            if !task.is_terminal() {
                task.settled_at = None;
            }
            task.id = id.to_string();
            task.rev = rev + 1;

            // Write JSON first (compatibility)
            let mtime = write_compatibility_json(&self.ctx, &task)?;

            let vals = values(&task, self.ctx.now as u64);
            tx.execute(
                r#"
                UPDATE tasks SET
                    rev = ?1, state = ?2, created_at = ?3, updated_at = ?4,
                    settled_at = ?5, repo = ?6, record = ?7, archived = ?8, json_mtime = ?9
                WHERE id = ?10
                "#,
                params![
                    vals[1], vals[2], vals[3], vals[4], vals[5], vals[6], vals[7], vals[8], mtime as f64, id
                ],
            )?;

            tx.commit()?;
            Ok(task)
        })??;

        Ok(result)
    }

    /// List tasks with filters.
    pub fn list_tasks(&self, filter: TaskFilter) -> Result<Vec<TaskRecord>> {
        let mut clauses: Vec<String> = Vec::new();
        let mut bindings: Vec<rusqlite::types::Value> = Vec::new();

        if !filter.all.unwrap_or(false) {
            clauses.push("archived = 0".to_string());
        }
        if let Some(v) = filter.settled_before {
            clauses.push("settled_at < ?".to_string());
            bindings.push(rusqlite::types::Value::Real(v as f64));
        }
        if let Some(v) = filter.before {
            clauses.push("id < ?".to_string());
            bindings.push(rusqlite::types::Value::Text(v));
        }
        if let Some(states) = filter.states {
            if states.is_empty() {
                return Ok(vec![]);
            }
            let placeholders = states.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let state_clause = format!("state IN ({placeholders})");
            clauses.push(state_clause);
            for s in states {
                bindings.push(rusqlite::types::Value::Text(s));
            }
        }
        if let Some(v) = filter.updated_since {
            clauses.push("updated_at >= ?".to_string());
            bindings.push(rusqlite::types::Value::Real(v as f64));
        }

        let limit = filter.limit.unwrap_or(20) as i64;
        let sql = format!(
            "SELECT record FROM tasks {} ORDER BY id DESC LIMIT ?",
            if clauses.is_empty() { String::new() } else { format!("WHERE {}", clauses.join(" AND ")) }
        );
        bindings.push(rusqlite::types::Value::Integer(limit));

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(bindings), |row| {
            let json: String = row.get(0)?;
            let mut task: TaskRecord = serde_json::from_str(&json).map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?;
            if task.rev == 0 {
                task.rev = 1;
            }
            Ok(task)
        })?;

        let mut tasks = Vec::new();
        for task in rows {
            tasks.push(task?);
        }
        Ok(tasks)
    }

    /// Get the store version token for change detection.
    pub fn version(&self) -> Result<String> {
        let external: i64 = self.conn.query_row("PRAGMA data_version", [], |row| row.get(0))?;
        let local: i64 = self.conn.query_row("SELECT total_changes()", [], |row| row.get(0))?;
        Ok(format!("1:{external}:{local}"))
    }

    /// Dismiss a task.
    pub fn dismiss_task(&mut self, id: &str) -> Result<Option<TaskRecord>> {
        let task = self.read_task(id)?;
        if task.is_none() {
            return Ok(None);
        }
        self.update_task(id, |t| t.dismissed = Some(true)).map(Some)
    }

    /// Get the tasks directory path.
    pub fn tasks_dir(&self) -> PathBuf {
        tasks_dir(&self.ctx)
    }
}

impl Default for TaskRecord {
    fn default() -> Self {
        Self {
            session_draft_id: None,
            interaction_mode: None,
            conversation: None,
            review_request: None,
            settled_at: None,
            archived: None,
            archive_path: None,
            title: None,
            source: None,
            request_id: None,
            repo: None,
            client: None,
            pending_attempt: None,
            rev: 0,
            question: None,
            run: None,
            takeover: None,
            progress: None,
            resume_spawned_at: None,
            review: None,
            resolved: None,
            resolution_checked_at: None,
            base_branch: None,
            base_sha: None,
            placement: None,
            worktree: None,
            id: String::new(),
            created_at: 0,
            kind: None,
            requested_executor: None,
            executor_fallback: None,
            timeout_s: 0,
            brief: Brief {
                goal: String::new(),
                repo: String::new(),
                scope: None,
                acceptance: None,
                constraints: None,
                context: None,
                feedback: None,
                qa: None,
                base: None,
                worktree_base: None,
            },
            state: String::new(),
            queue: None,
            runner_pid: None,
            executor: None,
            backend: None,
            attempt_started_at: None,
            dismissed: None,
            retry_of: None,
            retried_by: None,
            force: None,
            from_panel: None,
            child_pid: None,
            attempts: Vec::new(),
            result: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CreateTaskInput {
    pub brief: Brief,
    pub kind: Option<String>,
    pub requested_executor: Option<String>,
    pub timeout_s: u64,
    pub title: Option<String>,
    pub source: Option<String>,
    pub request_id: Option<String>,
    pub repo: Option<RepoRef>,
    pub client: Option<String>,
    pub placement: Option<TaskPlacement>,
    pub base_branch: Option<String>,
    pub base_sha: Option<String>,
    pub interaction_mode: Option<InteractionMode>,
    pub conversation: Option<ConversationState>,
    pub session_draft_id: Option<String>,
}

fn assert_pacer_home_allowed(pacer_home: &Path) -> Result<()> {
    let canonical = pacer_home.canonicalize()?;
    let allowed = [
        dirs::home_dir().unwrap_or_default().join(".pacer"),
        std::env::temp_dir().join("pacer-test"),
    ];
    let allowed = allowed.iter().filter_map(|p| p.canonicalize().ok()).collect::<Vec<_>>();
    let temp_dir = std::env::temp_dir().canonicalize().ok();
    if !allowed.iter().any(|a| canonical.starts_with(a)) 
        && !temp_dir.as_ref().is_some_and(|t| canonical.starts_with(t))
        && !cfg!(test) {
        return Err(TaskStoreError::InvalidInput("pacer home not allowed".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use std::mem;

    fn test_ctx() -> Ctx {
        let dir = tempdir().unwrap();
        let path = dir.path().to_path_buf();
        mem::forget(dir); // Leak the TempDir to keep the directory alive
        Ctx::with(
            path.clone(),
            path,
            Default::default(),
            1000.0,
        )
    }

    #[test]
    fn test_new_task_id() {
        let id = new_task_id(1000);
        assert!(is_task_id(&id));
        assert!(id.starts_with("t-"));
    }

    #[test]
    fn test_is_task_id() {
        assert!(is_task_id("t-20261019-120000-abcd"));
        assert!(!is_task_id("invalid"));
        assert!(!is_task_id("t-invalid"));
    }

    #[test]
    fn test_create_and_read_task() {
        let ctx = test_ctx();
        let mut store = TaskStore::open(ctx).unwrap();

        let input = CreateTaskInput {
            brief: Brief {
                goal: "test goal".into(),
                repo: "/tmp/repo".into(),
                ..Default::default()
            },
            kind: None,
            requested_executor: None,
            timeout_s: 60,
            title: Some("test".into()),
            source: None,
            request_id: None,
            repo: None,
            client: None,
            placement: None,
            base_branch: None,
            base_sha: None,
            interaction_mode: None,
            conversation: None,
            session_draft_id: None,
        };

        let task = store.create_task(input, None).unwrap();
        assert_eq!(task.title, Some("test".into()));
        assert_eq!(task.state, "queued");
        assert_eq!(task.rev, 1);

        let read = store.read_task(&task.id).unwrap().unwrap();
        assert_eq!(read.id, task.id);
        assert_eq!(read.title, task.title);
    }

    #[test]
    fn test_update_task() {
        let ctx = test_ctx();
        let mut store = TaskStore::open(ctx).unwrap();

        let input = CreateTaskInput {
            brief: Brief {
                goal: "test goal".into(),
                repo: "/tmp/repo".into(),
                ..Default::default()
            },
            kind: None,
            requested_executor: None,
            timeout_s: 60,
            title: Some("test".into()),
            source: None,
            request_id: None,
            repo: None,
            client: None,
            placement: None,
            base_branch: None,
            base_sha: None,
            interaction_mode: None,
            conversation: None,
            session_draft_id: None,
        };

        let task = store.create_task(input, None).unwrap();
        let updated = store.update_task(&task.id, |t| {
            t.title = Some("updated".into());
            t.state = "done".into();
        }).unwrap();

        assert_eq!(updated.title, Some("updated".into()));
        assert_eq!(updated.state, "done");
        assert_eq!(updated.rev, 2);
        assert!(updated.settled_at.is_some());
    }

    #[test]
    fn test_list_tasks_filter() {
        let ctx = test_ctx();
        let mut store = TaskStore::open(ctx.clone()).unwrap();

        let input = CreateTaskInput {
            brief: Brief {
                goal: "test".into(),
                repo: "/tmp/repo".into(),
                ..Default::default()
            },
            kind: None,
            requested_executor: None,
            timeout_s: 60,
            title: None,
            source: None,
            request_id: None,
            repo: None,
            client: None,
            placement: None,
            base_branch: None,
            base_sha: None,
            interaction_mode: None,
            conversation: None,
            session_draft_id: None,
        };

        let t1 = store.create_task(input.clone(), None).unwrap();
        let t2 = store.create_task(input.clone(), None).unwrap();
        let t3 = store.create_task(input, None).unwrap();

        store.update_task(&t1.id, |t| t.state = "running".to_string()).unwrap();
        store.update_task(&t3.id, |t| t.state = "done".to_string()).unwrap();

        let running = store.list_tasks(TaskFilter { states: Some(vec!["running".into()]), ..Default::default() }).unwrap();
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].id, t1.id);

        let all = store.list_tasks(TaskFilter { all: Some(true), ..Default::default() }).unwrap();
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn test_version_token_changes() {
        let ctx = test_ctx();
        let mut store = TaskStore::open(ctx).unwrap();

        let input = CreateTaskInput {
            brief: Brief { goal: "test".into(), repo: "/tmp/repo".into(), ..Default::default() },
            kind: None,
            requested_executor: None,
            timeout_s: 60,
            title: None,
            source: None,
            request_id: None,
            repo: None,
            client: None,
            placement: None,
            base_branch: None,
            base_sha: None,
            interaction_mode: None,
            conversation: None,
            session_draft_id: None,
        };

        let v1 = store.version().unwrap();
        let task = store.create_task(input, None).unwrap();
        let v2 = store.version().unwrap();
        assert_ne!(v1, v2);

        store.update_task(&task.id, |t| t.title = Some("x".into())).unwrap();
        let v3 = store.version().unwrap();
        assert_ne!(v2, v3);
    }

    #[test]
    fn test_dismiss_task() {
        let ctx = test_ctx();
        let mut store = TaskStore::open(ctx).unwrap();

        let input = CreateTaskInput {
            brief: Brief { goal: "test".into(), repo: "/tmp/repo".into(), ..Default::default() },
            kind: None,
            requested_executor: None,
            timeout_s: 60,
            title: None,
            source: None,
            request_id: None,
            repo: None,
            client: None,
            placement: None,
            base_branch: None,
            base_sha: None,
            interaction_mode: None,
            conversation: None,
            session_draft_id: None,
        };

        let task = store.create_task(input, None).unwrap();
        let dismissed = store.dismiss_task(&task.id).unwrap().unwrap();
        assert_eq!(dismissed.dismissed, Some(true));
        assert_eq!(dismissed.rev, 2);

        let not_found = store.dismiss_task("t-invalid").unwrap();
        assert!(not_found.is_none());
    }

    #[test]
    fn test_archived_filter() {
        let ctx = test_ctx();
        let mut store = TaskStore::open(ctx.clone()).unwrap();

        let input = CreateTaskInput {
            brief: Brief { goal: "test".into(), repo: "/tmp/repo".into(), ..Default::default() },
            kind: None,
            requested_executor: None,
            timeout_s: 60,
            title: None,
            source: None,
            request_id: None,
            repo: None,
            client: None,
            placement: None,
            base_branch: None,
            base_sha: None,
            interaction_mode: None,
            conversation: None,
            session_draft_id: None,
        };

        let t1 = store.create_task(input.clone(), None).unwrap();
        let t2 = store.create_task(input.clone(), None).unwrap();
        store.update_task(&t1.id, |t| {
            t.state = "done".into();
            t.archived = Some(true);
        }).unwrap();

        let active = store.list_tasks(TaskFilter::default()).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, t2.id);

        let all = store.list_tasks(TaskFilter { all: Some(true), ..Default::default() }).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn test_compatibility_json_write_through() {
        let ctx = test_ctx();
        let mut store = TaskStore::open(ctx.clone()).unwrap();

        let input = CreateTaskInput {
            brief: Brief { goal: "test".into(), repo: "/tmp/repo".into(), ..Default::default() },
            kind: None,
            requested_executor: None,
            timeout_s: 60,
            title: Some("test".into()),
            source: None,
            request_id: None,
            repo: None,
            client: None,
            placement: None,
            base_branch: None,
            base_sha: None,
            interaction_mode: None,
            conversation: None,
            session_draft_id: None,
        };

        let task = store.create_task(input, None).unwrap();

        let json_path = ctx.pacer_home.join("tasks").join(format!("{}.json", task.id));
        assert!(json_path.exists());

        let json_content = std::fs::read_to_string(&json_path).unwrap();
        let json_task: TaskRecord = serde_json::from_str(&json_content).unwrap();
        assert_eq!(json_task.id, task.id);
        assert_eq!(json_task.title, task.title);

        store.update_task(&task.id, |t| t.title = Some("updated".into())).unwrap();
        let json_content2 = std::fs::read_to_string(&json_path).unwrap();
        let json_task2: TaskRecord = serde_json::from_str(&json_content2).unwrap();
        assert_eq!(json_task2.title, Some("updated".into()));
        assert_eq!(json_task2.rev, 2);
    }

    #[test]
    fn test_import_legacy_json() {
        let ctx = test_ctx();
        let tasks_dir = ctx.pacer_home.join("tasks");
        std::fs::create_dir_all(&tasks_dir).unwrap();

        let legacy_task = TaskRecord {
            id: "t-20261019-120000-abcd".into(),
            rev: 1,
            created_at: 1000,
            state: "queued".into(),
            attempts: vec![],
            brief: Brief {
                goal: "legacy".into(),
                repo: "/tmp/repo".into(),
                ..Default::default()
            },
            kind: None,
            requested_executor: None,
            timeout_s: 60,
            title: Some("legacy".into()),
            ..Default::default()
        };

        std::fs::write(
            tasks_dir.join("t-20261019-120000-abcd.json"),
            serde_json::to_string(&legacy_task).unwrap()
        ).unwrap();

        let mut store = TaskStore::open(ctx.clone()).unwrap();
        let imported = store.read_task("t-20261019-120000-abcd").unwrap().unwrap();

        assert_eq!(imported.id, "t-20261019-120000-abcd");
        assert_eq!(imported.title, Some("legacy".into()));
        assert_eq!(imported.brief.goal, "legacy");

        assert!(tasks_dir.join("t-20261019-120000-abcd.json").exists());
    }

    #[test]
    fn test_import_idempotent() {
        let ctx = test_ctx();
        let tasks_dir = ctx.pacer_home.join("tasks");
        std::fs::create_dir_all(&tasks_dir).unwrap();

        let legacy_task = TaskRecord {
            id: "t-20261019-120000-abcd".into(),
            rev: 1,
            created_at: 1000,
            state: "queued".into(),
            attempts: vec![],
            brief: Brief {
                goal: "legacy".into(),
                repo: "/tmp/repo".into(),
                ..Default::default()
            },
            kind: None,
            requested_executor: None,
            timeout_s: 60,
            title: Some("legacy".into()),
            ..Default::default()
        };

        std::fs::write(
            tasks_dir.join("t-20261019-120000-abcd.json"),
            serde_json::to_string(&legacy_task).unwrap()
        ).unwrap();

        for _ in 0..3 {
            let mut store = TaskStore::open(ctx.clone()).unwrap();
            let imported = store.read_task("t-20261019-120000-abcd").unwrap().unwrap();
            assert_eq!(imported.rev, 1);
        }

        assert!(tasks_dir.join("t-20261019-120000-abcd.json").exists());
    }
}