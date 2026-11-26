//! Native port of `src/tasks/cleanup.ts:170-296`: per-task worktree auto-clean.
//!
//! Cleanup is best effort: a recorded verdict must never turn into an operation error.
//! Every decision that can keep a worktree is recorded as a `verdict` activity line
//! (`Kept worktree: <reason>`), exactly as the TypeScript implementation does.

use std::{
    collections::HashSet,
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    time::Duration,
};

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    lock::{LockOptions, with_lock_async},
};
use pacer_store::{TaskStore, append_activity};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::{Value, json};

use crate::runtime::Runtime;

#[cfg(test)]
mod tests;

/// Boxed unit future, used by effects that never report an error to the caller.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

const NOT_OWN_WORKTREE: &str = "worktree path is not this task's worktree; not deleted";
const WORKTREE_CHANGED: &str = "worktree changed during cleanup; not deleted";
const AWAITING_TURN: &str =
    "task has messages waiting for its next turn; review, dismiss or close it (pacer msg close) to clean";
const DAY_S: f64 = 86_400.0;
const TERMINAL_STATES: &[&str] = &["done", "partial", "failed", "limit", "stopped", "needs_input"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Kept {
    pub id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CleanResult {
    pub removed: Vec<String>,
    pub kept: Vec<Kept>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CleanOptions {
    pub dry_run: bool,
    pub force: bool,
}

fn internal(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Internal, message)
}

fn agent_sessions_lock() -> LockOptions {
    LockOptions {
        stale: Duration::from_secs(600),
        ..LockOptions::default()
    }
}

#[cfg(test)]
static LOCK_ORDER: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

#[cfg(test)]
fn record_lock(name: &str) {
    if let Ok(mut order) = LOCK_ORDER.lock() {
        order.push(name.to_owned());
    }
}

#[cfg(not(test))]
fn record_lock(_: &str) {}

fn task_worktrees_dir(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("worktrees")
}

fn read_task(ctx: &Ctx, id: &str) -> Option<Value> {
    let mut store = TaskStore::open(&ctx.pacer_home).ok()?;
    store.read(id).ok().flatten()
}

fn list_tasks(ctx: &Ctx) -> Vec<Value> {
    let Ok(mut store) = TaskStore::open(&ctx.pacer_home) else {
        return Vec::new();
    };
    store.list(&Default::default()).unwrap_or_default()
}

fn str_field(task: &Value, pointer: &str) -> Option<String> {
    task.pointer(pointer)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Bool(true) | Value::Array(_) | Value::Object(_)) => true,
    }
}

fn worktree_of(task: &Value) -> Option<String> {
    str_field(task, "/worktree")
        .or_else(|| str_field(task, "/run/workdir"))
        .or_else(|| str_field(task, "/brief/repo"))
}

fn is_closed(task: &Value) -> bool {
    truthy(task.get("review"))
        || truthy(task.get("dismissed"))
        || truthy(task.get("msgClosed"))
        || task.get("state").and_then(Value::as_str) == Some("stopped")
}

fn cleanable(task: &Value) -> bool {
    let state = task.get("state").and_then(Value::as_str).unwrap_or_default();
    if !TERMINAL_STATES.contains(&state) {
        return false;
    }
    if state == "needs_input" && task.pointer("/question/answer").is_none() {
        return false;
    }
    if truthy(task.get("question")) && task.pointer("/question/answer").is_none() {
        return false;
    }
    truthy(task.get("review")) || truthy(task.get("dismissed")) || truthy(task.get("resolved"))
}

fn cleanable_chain(ctx: &Ctx, task: &Value) -> bool {
    let mut seen = HashSet::new();
    let mut current = Some(task.clone());
    while let Some(t) = current {
        if !seen.insert(t.get("id").and_then(Value::as_str).unwrap_or_default().to_owned()) {
            return false;
        }
        if !cleanable(&t) {
            return false;
        }
        let Some(next) = str_field(&t, "/retriedBy") else {
            return true;
        };
        current = read_task(ctx, &next);
    }
    false
}

fn ancestor_owns_worktree(ctx: &Ctx, task: &Value, wt: &str) -> bool {
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(
        task.get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    );
    let mut id = str_field(task, "/retryOf");
    while let Some(current) = id {
        if !seen.insert(current.clone()) {
            return false;
        }
        let Some(ancestor) = read_task(ctx, &current) else {
            return false;
        };
        if verified_root(ctx, &ancestor, wt).is_ok() {
            return true;
        }
        id = str_field(&ancestor, "/retryOf");
    }
    false
}

struct DirId {
    path: PathBuf,
    dev: u64,
    ino: u64,
}

struct Verified {
    path: PathBuf,
    #[allow(dead_code)]
    real: PathBuf,
    exists: bool,
    symlinked_root: bool,
    ids: Vec<DirId>,
}

fn dir_id(path: PathBuf) -> Result<DirId, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(DirId {
            path,
            dev: meta.dev(),
            ino: meta.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        Ok(DirId { path, dev: 0, ino: 0 })
    }
}

fn same_dir(path: &Path, d: &DirId) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.dev() == d.dev && meta.ino() == d.ino
    }
    #[cfg(not(unix))]
    {
        let _ = d;
        true
    }
}

fn unchanged_dirs(ids: &[DirId]) -> bool {
    ids.iter().all(|d| same_dir(&d.path, d))
}

/// The TS comment below is kept verbatim: the accepted `rmSync` window is the only
/// place where cleanup deletes a directory it did not prove unchanged immediately
/// before. See `.project/decisions.md`.
fn verified_root(ctx: &Ctx, task: &Value, wt: &str) -> Result<Verified, String> {
    let root = task_worktrees_dir(ctx);
    let path = Path::new(wt);
    let Ok(rel) = path.strip_prefix(&root) else {
        return Err(NOT_OWN_WORKTREE.to_owned());
    };
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.len() < 2
        || parts.iter().any(|p| p.is_empty() || p == "." || p == "..")
        || parts[1] != task.get("id").and_then(Value::as_str).unwrap_or_default()
    {
        return Err(NOT_OWN_WORKTREE.to_owned());
    }
    let tag = &parts[0];
    let target = root.join(tag).join(task.get("id").and_then(Value::as_str).unwrap_or_default());

    let root_meta = match std::fs::symlink_metadata(&root) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound || e.kind() == io::ErrorKind::NotADirectory => {
            return Ok(Verified {
                path: target.clone(),
                real: target,
                exists: false,
                symlinked_root: false,
                ids: Vec::new(),
            });
        }
        Err(e) => return Err(e.to_string()),
    };
    let symlinked_root = root_meta.file_type().is_symlink();
    let root_meta = if symlinked_root {
        std::fs::metadata(&root).map_err(|e| e.to_string())?
    } else {
        root_meta
    };
    if !root_meta.is_dir() {
        return Err("worktrees folder is not a directory; not deleted".to_owned());
    }
    let canonical = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
    let tag_dir = canonical.join(tag);
    let real = tag_dir.join(task.get("id").and_then(Value::as_str).unwrap_or_default());
    let mut ids = vec![dir_id(canonical.clone())?];
    for dir in [&tag_dir, &real] {
        let meta = match std::fs::symlink_metadata(dir) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound || e.kind() == io::ErrorKind::NotADirectory => {
                return Ok(Verified {
                    path: target.clone(),
                    real: real.clone(),
                    exists: false,
                    symlinked_root,
                    ids,
                });
            }
            Err(e) => return Err(e.to_string()),
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(NOT_OWN_WORKTREE.to_owned());
        }
        if std::fs::canonicalize(dir).map_err(|e| e.to_string())? != *dir {
            return Err(NOT_OWN_WORKTREE.to_owned());
        }
        ids.push(dir_id(dir.clone())?);
    }
    Ok(Verified {
        path: target,
        real,
        exists: true,
        symlinked_root,
        ids,
    })
}

fn canonical(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

fn paths_overlap(a: &str, b: &Path) -> bool {
    let x = canonical(a);
    let y = canonical(b.to_string_lossy().as_ref());
    x == y || x.starts_with(&y) || y.starts_with(&x)
}

fn shared(ctx: &Ctx, db: &Connection, task: &Value, path: &Path) -> Result<bool, String> {
    if agent_workspace_busy(ctx, db, path)? {
        return Ok(true);
    }
    let id = task.get("id").and_then(Value::as_str).unwrap_or_default();
    Ok(list_tasks(ctx).iter().any(|other| {
        if other.get("id").and_then(Value::as_str) == Some(id) {
            return false;
        }
        let overlaps = [
            "/worktree",
            "/result/worktree",
            "/run/workdir",
            "/brief/repo",
        ]
        .iter()
        .filter_map(|p| str_field(other, p))
        .any(|p| paths_overlap(&p, path));
        overlaps && !cleanable(other)
    }))
}

fn runs_root(ctx: &Ctx, id: &str) -> PathBuf {
    ctx.pacer_home.join("runs").join(id)
}

fn has_disposable_runs(ctx: &Ctx, id: &str) -> bool {
    let root = runs_root(ctx, id);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        if !entry.path().is_dir() {
            return true;
        }
        if !path.join("diff.json").exists() {
            return true;
        }
        std::fs::read_dir(&path)
            .map(|names| names.flatten().any(|n| n.file_name() != "diff.json"))
            .unwrap_or(false)
    })
}

fn remove_entry(path: &Path) -> io::Result<()> {
    if path.is_dir() && !path.is_symlink() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

/// Port of `src/tasks/diff.ts:114-126` (`cleanTaskRuns`).
fn clean_task_runs(ctx: &Ctx, id: &str) -> io::Result<()> {
    let root = runs_root(ctx, id);
    if !root.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&root)?.flatten() {
        let path = entry.path();
        if entry.file_type()?.is_dir() && path.join("diff.json").exists() {
            for name in std::fs::read_dir(&path)?.flatten() {
                if name.file_name() != "diff.json" {
                    remove_entry(&name.path())?;
                }
            }
        } else {
            remove_entry(&path)?;
        }
    }
    if std::fs::read_dir(&root)?.next().is_none() {
        std::fs::remove_dir(&root)?;
    }
    Ok(())
}

fn prune_runs(ctx: &Ctx, id: &str) -> Option<String> {
    match clean_task_runs(ctx, id) {
        Ok(()) => None,
        Err(e) => Some(format!(
            "worktree deleted; run files could not be pruned: {e}"
        )),
    }
}

/// Read the two strategy settings cleanup needs without requiring the whole
/// strategy to validate (a missing or partial strategy is valid here: TS treats
/// a missing strategy as defaults). Keys are the snake_case config names; the
/// camelCase alias is accepted for parity with older fixtures.
fn strategy_value(ctx: &Ctx) -> Option<Value> {
    let text = std::fs::read_to_string(ctx.pacer_home.join("strategy.yaml")).ok()?;
    let mut sections = serde_json::Map::new();
    let mut current: Option<(String, serde_json::Map<String, Value>)> = None;
    for line in text.lines() {
        if !line.starts_with(' ') && !line.trim().is_empty() {
            if let Some((name, map)) = current.take() {
                sections.insert(name, Value::Object(map));
            }
            let name = line.trim_end().trim_end_matches(':').trim().to_owned();
            current = Some((name, serde_json::Map::new()));
            continue;
        }
        let Some((_, map)) = current.as_mut() else {
            continue;
        };
        let Some((key, value)) = line.trim().split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches(['"', '\'']);
        let parsed = match value {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            _ => value.parse::<f64>().map_or_else(
                |_| Value::String(value.to_owned()),
                |n| json!(n),
            ),
        };
        map.insert(key.trim().to_owned(), parsed);
    }
    if let Some((name, map)) = current {
        sections.insert(name, Value::Object(map));
    }
    Some(Value::Object(sections))
}

fn auto_clean_enabled(ctx: &Ctx) -> bool {
    let Some(strategy) = strategy_value(ctx) else {
        return true; // MissingStrategyError: enabled by default.
    };
    let execution = &strategy["execution"];
    let value = if execution["auto_clean"].is_null() {
        &execution["autoClean"]
    } else {
        &execution["auto_clean"]
    };
    !matches!(value, Value::Bool(false))
}

fn pending_turn(db: &Connection, id: &str) -> Result<bool, String> {
    db.query_row(
        "SELECT COUNT(*) FROM messages WHERE (recipient=?1 AND status IN ('pending','held')) \
         OR (sender=?1 AND kind='question' AND status IN ('pending','delivered'))",
        [format!("task:{id}")],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .map_err(|e| format!("message state unreadable: {e}"))
}

fn last_message_at(db: &Connection, id: &str) -> Result<Option<f64>, String> {
    db.query_row(
        "SELECT MAX(created_at) FROM messages WHERE task_id=?1",
        [id],
        |row| row.get::<_, Option<f64>>(0),
    )
    .map_err(|e| format!("message state unreadable: {e}"))
}

fn turn_capable(task: &Value) -> bool {
    let executor = str_field(task, "/run/executor")
        .or_else(|| str_field(task, "/result/executor"));
    executor.is_some()
        && str_field(task, "/run/host").is_none()
        && task
            .pointer("/result/backend")
            .and_then(Value::as_str)
            .map_or(true, |b| b == "direct")
}

fn kept_for_messages(ctx: &Ctx, task: &Value, db: &Connection) -> Result<Option<String>, String> {
    if is_closed(task)
        || task.get("interactionMode").and_then(Value::as_str) == Some("conversation")
        || !turn_capable(task)
    {
        return Ok(None);
    }
    let id = task.get("id").and_then(Value::as_str).unwrap_or_default();
    if truthy(task.get("pendingTurn")) || pending_turn(db, id)? {
        return Ok(Some(AWAITING_TURN.to_owned()));
    }
    let days = strategy_value(ctx)
        .and_then(|s| s["messaging"]["keep_worktree_days"].as_f64())
        .unwrap_or(7.0);
    if days == 0.0 {
        return Ok(None);
    }
    let attempts = task.get("attempts").and_then(Value::as_array);
    let ended = attempts
        .and_then(|a| a.last())
        .and_then(|v| v.get("endedAt"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let settled = task.get("settledAt").and_then(Value::as_f64).unwrap_or(0.0);
    let last = last_message_at(db, id)?.unwrap_or(0.0).max(ended).max(settled);
    if ctx.now - last >= days * DAY_S {
        return Ok(None);
    }
    Ok(Some(format!(
        "task is open for messages (last activity under {days} day{} ago); review, dismiss or close it (pacer msg close) to clean",
        if days == 1.0 { "" } else { "s" }
    )))
}

fn read_only_db(ctx: &Ctx) -> Result<Connection, String> {
    Connection::open_with_flags(
        ctx.pacer_home.join("state/tasks.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| format!("state database unreadable: {e}"))
}

/// A DB read error keeps the worktree: cleanup must fail closed at the safety
/// checks, as `src/tasks/cleanup.ts` does when `awaitingTurn` or the session
/// store throws.
fn db_guard<T>(value: Result<T, String>, result: &mut CleanResult, id: &str) -> Option<T> {
    match value {
        Ok(value) => Some(value),
        Err(error) => {
            result.kept.push(Kept {
                id: id.to_owned(),
                reason: format!("cleanup state unavailable: {error}"),
            });
            None
        }
    }
}

fn agent_checks_pending(db: &Connection, task_id: &str) -> Result<bool, String> {
    // A table that does not exist means no reservations, as in TypeScript's
    // `db.has('agent_session_checks')` check. A query failure on a real table is
    // an error and must keep the worktree.
    if db
        .query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_session_checks'", [], |_| Ok(()))
        .optional()
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Ok(false);
    }
    db.query_row(
        "SELECT 1 FROM agent_session_checks WHERE task=?1 AND generation>verified LIMIT 1",
        [task_id],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|e| format!("agent session state unreadable: {e}"))
}

/// `pacer_sessions::agents::agent_workspace_busy` is a B5 step-2 prerequisite. This
/// local read covers the same SQLite reservations and active-session rows at this
/// base; B5 will replace it with the shared crate function when it lands.
fn agent_workspace_busy(ctx: &Ctx, db: &Connection, path: &Path) -> Result<bool, String> {
    let has_table = |name: &str| -> Result<bool, String> {
        db.query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(|e| e.to_string())
    };
    if has_table("agent_session_checks")? {
        let mut stmt = db
            .prepare("SELECT task, workspace FROM agent_session_checks WHERE generation>verified")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)))
            .map_err(|e| format!("agent session state unreadable: {e}"))?;
        for row in rows {
            let (task, workspace) = row.map_err(|e| format!("agent session state unreadable: {e}"))?;
            let candidate = workspace.or_else(|| worktree_of(&read_task(ctx, &task)?));
            if let Some(candidate) = candidate
                && paths_overlap(&candidate, path)
            {
                return Ok(true);
            }
        }
    }
    if has_table("agent_sessions")? {
        // `agent_sessions` has columns (id, task, request_id, payload, record);
        // `cwd` and `state` live in the `record` JSON (src/session/agents.ts:44).
        let mut stmt = db
            .prepare("SELECT record FROM agent_sessions")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("agent session state unreadable: {e}"))?;
        for row in rows {
            let record: String = row.map_err(|e| format!("agent session state unreadable: {e}"))?;
            let session: Value = serde_json::from_str(&record)
                .map_err(|e| format!("session reservations could not be read: {e}"))?;
            if session.get("state").and_then(Value::as_str) == Some("ended") {
                continue;
            }
            let Some(cwd) = session.get("cwd").and_then(Value::as_str) else {
                continue;
            };
            if paths_overlap(cwd, path) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Git runs under the same deadlines as `src/supervisor/worktree.ts` (15 s
/// status, 60 s remove). `kill_on_drop` makes a timeout kill the child instead
/// of detaching it, so a late `git worktree remove` cannot mutate a worktree
/// that cleanup just decided to keep.
async fn git_output(
    ctx: &Ctx,
    args: &[&str],
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let mut command = tokio::process::Command::new("git");
    command
        .args(args)
        .env("HOME", &ctx.home)
        .env("PACER_HOME", &ctx.pacer_home)
        .kill_on_drop(true);
    tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| {
            format!(
                "git {} timed out",
                args.first().copied().unwrap_or("command")
            )
        })?
        .map_err(|error| error.to_string())
}

async fn worktree_dirty(ctx: &Ctx, path: &Path) -> Option<bool> {
    let path_arg = path.to_string_lossy().into_owned();
    let out = git_output(ctx, &["-C", &path_arg, "status", "--porcelain"], Duration::from_secs(15))
        .await
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim() != "")
    } else {
        None
    }
}

async fn git_worktree_remove(ctx: &Ctx, top: &Path, path: &Path, force: bool) -> Result<(), String> {
    let top_arg = top.to_string_lossy().into_owned();
    let path_arg = path.to_string_lossy().into_owned();
    let mut args: Vec<&str> = vec!["-C", &top_arg, "worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path_arg);
    let out = git_output(ctx, &args, Duration::from_secs(60)).await?;
    if out.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        let first = stderr.trim().lines().next().unwrap_or_default();
        Err(format!(
            "git worktree remove failed: {}",
            if first.is_empty() {
                format!("exit {}", out.status)
            } else {
                first.to_owned()
            }
        ))
    }
}

fn record_error(ctx: &Ctx, id: &str, error: &str) {
    if let Some(task) = read_task(ctx, id) {
        record_verdict(ctx, &task, &format!("Kept worktree: {error}"));
    }
}

fn record_verdict(ctx: &Ctx, task: &Value, text: &str) {
    let id = task.get("id").and_then(Value::as_str).unwrap_or_default();
    let mut activity = json!({
        "kind": "verdict",
        "level": "info",
        "text": text,
        "taskId": id,
    });
    if let Some(repo) = str_field(task, "/repo").or_else(|| str_field(task, "/brief/repo")) {
        activity["repo"] = json!(repo);
    }
    let executor = str_field(task, "/result/executor")
        .or_else(|| str_field(task, "/executor"))
        .or_else(|| {
            task.get("attempts")
                .and_then(Value::as_array)
                .and_then(|a| a.last())
                .and_then(|v| str_field(v, "/executor"))
        })
        .or_else(|| str_field(task, "/requestedExecutor"));
    if let Some(executor) = executor {
        activity["executor"] = json!(executor);
    }
    if let Some(host) = str_field(task, "/run/host") {
        activity["host"] = json!(host);
    }
    let _ = append_activity(ctx, activity);
}

/// One task under the `agent-sessions` lock; caller holds every clean lock in the
/// retry chain. Port of `cleanTaskSessionsLocked`.
async fn clean_task_sessions_locked(
    ctx: &Ctx,
    _rt: &Runtime,
    id: &str,
    options: CleanOptions,
) -> Result<CleanResult, CoreError> {
    let mut result = CleanResult::default();
    let Some(task) = read_task(ctx, id) else {
        return Ok(result);
    };
    if !cleanable(&task) || !cleanable_chain(ctx, &task) {
        return Ok(result);
    }

    let workspace = worktree_of(&task).unwrap_or_default();
    let db = match read_only_db(ctx) {
        Ok(db) => db,
        Err(error) => {
            result.kept.push(Kept {
                id: id.to_owned(),
                reason: format!("cleanup state unavailable: {error}"),
            });
            return Ok(result);
        }
    };
    let Some(checks) = db_guard(agent_checks_pending(&db, id), &mut result, id) else {
        return Ok(result);
    };
    let Some(busy) = db_guard(agent_workspace_busy(ctx, &db, Path::new(&workspace)), &mut result, id) else {
        return Ok(result);
    };
    if checks || busy {
        result.kept.push(Kept {
            id: id.to_owned(),
            reason: "worktree has an active agent session or pending checks".to_owned(),
        });
        return Ok(result);
    }

    // Host-owned worktrees are kept until a B0a hosts-plugin provider claims
    // them; this slice never deletes a remote workspace locally.

    if task.pointer("/run/mode").and_then(Value::as_str) != Some("new") {
        return Ok(result);
    }
    let top = str_field(&task, "/brief/repo").map(|repo| canonical(&repo));
    let is_host = truthy(task.get("run/host"));
    if top.is_none() && is_host {
        result.kept.push(Kept {
            id: id.to_owned(),
            reason: "source repository is missing; remote cleanup needs it".to_owned(),
        });
        return Ok(result);
    }
    let wt = match (is_host, &top) {
        (true, Some(top)) => task_worktrees_dir(ctx)
            .join(format!("{}-{}", top.file_name().unwrap_or_default().to_string_lossy(), "00000000"))
            .join(id),
        _ => match str_field(&task, "/run/workdir") {
            Some(wt) => PathBuf::from(wt),
            None => return Ok(result),
        },
    };
    let root = task_worktrees_dir(ctx);
    if !wt.starts_with(&root) || !wt.to_string_lossy().starts_with(&format!("{}/", root.display())) {
        return Ok(result);
    }

    let own = match verified_root(ctx, &task, &wt.to_string_lossy()) {
        Ok(own) => own,
        Err(reason) => {
            if reason != NOT_OWN_WORKTREE || !ancestor_owns_worktree(ctx, &task, &wt.to_string_lossy()) {
                result.kept.push(Kept {
                    id: id.to_owned(),
                    reason,
                });
            }
            return Ok(result);
        }
    };
    if !is_host && !own.exists {
        if !has_disposable_runs(ctx, id) {
            return Ok(result);
        }
        let failed = if options.dry_run {
            None
        } else {
            prune_runs(ctx, id)
        };
        if let Some(reason) = failed {
            result.kept.push(Kept {
                id: id.to_owned(),
                reason,
            });
        } else {
            result.removed.push(id.to_owned());
        }
        return Ok(result);
    }
    if !is_host && !own.path.exists() {
        return Ok(result);
    }

    let kept = if options.force {
        Ok(None)
    } else {
        kept_for_messages(ctx, &task, &db)
    };
    let Some(kept) = db_guard(kept, &mut result, id) else {
        return Ok(result);
    };
    if let Some(reason) = kept {
        result.kept.push(Kept {
            id: id.to_owned(),
            reason,
        });
        return Ok(result);
    }
    let Some(is_shared) = db_guard(shared(ctx, &db, &task, &own.path), &mut result, id) else {
        return Ok(result);
    };
    if is_shared {
        result.kept.push(Kept {
            id: id.to_owned(),
            reason: "worktree is shared with an active or unreviewed task".to_owned(),
        });
        return Ok(result);
    }

    let top = top.filter(|p| p.exists());
    if top.is_none() {
        // Without the repository git cannot check or remove the worktree. The
        // direct-delete path is intentionally not ported: it relies on the
        // accepted `rmSync` window documented in `.project/decisions.md`. B0a
        // owns remote host clean, which is a separate path.
        if !options.force {
            result.kept.push(Kept {
                id: id.to_owned(),
                reason: "source repository is missing; use --force to delete the worktree".to_owned(),
            });
            return Ok(result);
        }
        if own.symlinked_root {
            result.kept.push(Kept {
                id: id.to_owned(),
                reason: "worktrees folder is a symlink; not deleted".to_owned(),
            });
            return Ok(result);
        }
        if !unchanged_dirs(&own.ids) {
            result.kept.push(Kept {
                id: id.to_owned(),
                reason: WORKTREE_CHANGED.to_owned(),
            });
        } else {
            // The accepted direct-delete (`rmSync`) window is deliberately not
            // ported; report the no-op instead of silently claiming success.
            result.kept.push(Kept {
                id: id.to_owned(),
                reason: "direct delete not available natively; source repository is missing".to_owned(),
            });
        }
        return Ok(result);
    }

    if own.path.exists()
        && !options.force
        && worktree_dirty(ctx, &own.path).await != Some(false)
    {
        result.kept.push(Kept {
            id: id.to_owned(),
            reason: "uncommitted changes; use --force".to_owned(),
        });
        return Ok(result);
    }
    if options.dry_run {
        result.removed.push(id.to_owned());
        return Ok(result);
    }

    if is_host {
        result.kept.push(Kept {
            id: id.to_owned(),
            reason: "remote cleanup needs a configured host, checkout and run".to_owned(),
        });
        return Ok(result);
    }
    if own.path.exists() {
        let top = top.unwrap_or_else(|| root.clone());
        if let Err(reason) = git_worktree_remove(ctx, &top, &own.path, options.force).await {
            result.kept.push(Kept {
                id: id.to_owned(),
                reason,
            });
            return Ok(result);
        }
    }
    if let Some(reason) = prune_runs(ctx, id) {
        result.kept.push(Kept {
            id: id.to_owned(),
            reason,
        });
        return Ok(result);
    }
    result.removed.push(id.to_owned());
    Ok(result)
}

async fn clean_task_locked(
    ctx: &Ctx,
    rt: &Runtime,
    id: &str,
    options: CleanOptions,
) -> Result<CleanResult, CoreError> {
    record_lock("agent-sessions");
    with_lock_async(ctx, "agent-sessions", agent_sessions_lock(), || {
        clean_task_sessions_locked(ctx, rt, id, options)
    })
    .await
    .map_err(|e| internal(format!("agent-sessions lock: {e}")))?
}

/// Best-effort per-task auto-clean. Never fails: problems become verdict activity lines.
pub fn auto_clean_task<'a>(ctx: &'a Ctx, rt: &'a Runtime, id: &'a str) -> BoxFuture<'a, ()> {
    Box::pin(async move {
        if !auto_clean_enabled(ctx) {
            return;
        }
        let mut ids: Vec<String> = Vec::new();
        let mut seen = HashSet::new();
        let mut current = Some(id.to_owned());
        while let Some(key) = current {
            if !seen.insert(key.clone()) {
                break;
            }
            let task = read_task(ctx, &key);
            current = task
                .as_ref()
                .and_then(|t| str_field(t, "/retryOf"));
            if task.is_some() {
                ids.push(key);
            }
        }
        let mut locks = ids.clone();
        locks.sort();
        auto_clean_locked(ctx, rt, &ids, &locks, 0).await;
    })
}

fn auto_clean_locked<'a>(
    ctx: &'a Ctx,
    rt: &'a Runtime,
    ids: &'a [String],
    locks: &'a [String],
    index: usize,
) -> BoxFuture<'a, ()> {
    Box::pin(async move {
        if index < locks.len() {
            let name = format!("clean-{}", locks[index]);
            record_lock(&name);
            let next = auto_clean_locked(ctx, rt, ids, locks, index + 1);
            if let Err(e) = with_lock_async(ctx, &name, LockOptions::default(), move || next).await {
                record_error(ctx, &locks[index], &e.to_string());
            }
            return;
        }
        for key in ids {
            let some_task = read_task(ctx, key);
            let eligible = some_task.as_ref().is_some_and(|t| {
                cleanable(t)
                    && (t.get("run").is_some()
                        || truthy(t.get("worktree"))
                        || truthy(t.get("result/worktree")))
            });
            if !eligible {
                continue;
            }
            match clean_task_locked(ctx, rt, key, CleanOptions::default()).await {
                Ok(result) => {
                    for kept in result.kept {
                        if let Some(current) = read_task(ctx, &kept.id) {
                            record_verdict(ctx, &current, &format!("Kept worktree: {}", kept.reason));
                        }
                    }
                }
                Err(e) => record_error(ctx, key, &e.message),
            }
        }
    })
}

/// Auto-clean each id in order, replacing the former Core bridge effect.
pub fn auto_clean_tasks<'a>(ctx: &'a Ctx, rt: &'a Runtime, ids: &'a [String]) -> OpFuture<'a> {
    Box::pin(async move {
        for id in ids {
            auto_clean_task(ctx, rt, id).await;
        }
        Ok(json!({"ok": true}))
    })
}

/// Manual clean for one task, with explicit options.
pub async fn clean_task(
    ctx: &Ctx,
    rt: &Runtime,
    id: &str,
    options: CleanOptions,
) -> Result<CleanResult, CoreError> {
    record_lock(&format!("clean-{id}"));
    with_lock_async(ctx, &format!("clean-{id}"), LockOptions::default(), || {
        clean_task_locked(ctx, rt, id, options)
    })
    .await
    .map_err(|e| internal(format!("clean-{id} lock: {e}")))?
}
