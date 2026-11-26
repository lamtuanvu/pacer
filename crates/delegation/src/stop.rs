//! Native `task.stop` and managed-work `stopWork`.
//!
//! Ports `taskStop` (`src/tasks/api.ts`) and `applyTaskStopSignals`
//! (`src/api/task-stop-bridge.ts`). The store transition stays in
//! `pacer_lifecycle::record_task_stop`; this module owns the effectful sides:
//! agent sessions, live-worker and remote-stop plugin calls, process-group
//! signals and the `task_settled` activity line.
#![allow(clippy::result_large_err)]

use std::process::Command;
use std::time::Duration;

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_lifecycle::{RecordStopError, record_task_stop, work_reads::WorkReads};
use pacer_read_model::tasks::task_data;
use pacer_store::{TaskStore, publish};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};

use crate::delegate::summarize;
use crate::runtime::Runtime;

#[cfg(test)]
mod tests;

/// Options of the native stop (`task.stop` has no `signal` field; the op defaults it to true).
#[derive(Debug, Clone, Copy)]
pub struct StopOptions {
    pub signal: bool,
    pub expect_rev: Option<i64>,
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn unknown(id: &str) -> CoreError {
    CoreError::new(Code::UnknownTask, format!("unknown task {id}"))
}

fn internal(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Internal, message)
}

fn conflict(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Conflict, message)
}

/// `process.kill(-pid)` without `unsafe`: signal the executor's process group,
/// then fall back to the direct child exactly as `killTree` does.
fn kill_tree(pid: u32) {
    let group = format!("-{pid}");
    let _ = Command::new("kill").args(["-TERM", "--", &group]).status();
    let _ = Command::new("kill")
        .args(["-TERM", pid.to_string().as_str()])
        .status();
}

/// `pidAlive` for a truthy pid field, using `kill -0` (no libc/unsafe).
fn pid_alive(pid: &Value) -> bool {
    // Task JSON writes integral pids as `123.0`, so serde stores them as f64.
    let Some(n) = pid.as_f64() else {
        return false;
    };
    if n <= 0.0 || !n.is_finite() {
        return false;
    }
    let pid = n as u32;
    Command::new("kill")
        .args(["-0", pid.to_string().as_str()])
        .status()
        .is_ok_and(|status| status.success())
}

fn terminal_state(state: &str) -> bool {
    matches!(state, "done" | "partial" | "failed" | "limit" | "stopped" | "needs_input")
}

fn terminal(task: &Value) -> bool {
    task.get("state")
        .and_then(Value::as_str)
        .is_some_and(terminal_state)
}

pub(crate) fn agent_checks_pending(db: &Connection, task_id: &str) -> bool {
    let has_table = db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_session_checks'",
            [],
            |_| Ok(()),
        )
        .optional()
        .unwrap_or(None)
        .is_some();
    if !has_table {
        return false;
    }
    db.query_row(
        "SELECT 1 FROM agent_session_checks WHERE task=?1 AND generation>verified LIMIT 1",
        [task_id],
        |_| Ok(()),
    )
    .optional()
    .unwrap_or(None)
    .is_some()
}

pub(crate) fn active_agent_sessions(db: &Connection, task_id: &str) -> bool {
    let has_table = db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_sessions'",
            [],
            |_| Ok(()),
        )
        .optional()
        .unwrap_or(None)
        .is_some();
    if !has_table {
        return false;
    }
    // `activeAgentSessions` (`src/session/agents-state.ts`) only holds a wait
    // for a starting/running session. An ended row must not burn the deadline.
    let mut statement = match db.prepare("SELECT record FROM agent_sessions WHERE task=?1") {
        Ok(statement) => statement,
        Err(_) => return false,
    };
    statement
        .query_map([task_id], |row| row.get::<_, String>(0))
        .ok()
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>().ok())
        .unwrap_or_default()
        .iter()
        .any(|raw| {
            serde_json::from_str::<Value>(raw)
                .ok()
                .and_then(|record| record.get("state").and_then(Value::as_str).map(str::to_owned))
                .is_some_and(|state| state == "starting" || state == "running")
        })
}

/// Best-effort agent-session release. B5 owns the native session host; until it
/// lands, ending the persisted attempt records keeps `task.wait`'s settle
/// predicate honest. Process termination of the agent itself is reported as
/// UNVERIFIED in the CT-11 evidence.
fn stop_agent_sessions(db: &Connection, task_id: &str, now: f64) {
    let has_table = db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_sessions'",
            [],
            |_| Ok(()),
        )
        .optional()
        .unwrap_or(None)
        .is_some();
    if !has_table {
        return;
    }
    let rows: Vec<(String, String)> = match db.prepare("SELECT id, record FROM agent_sessions WHERE task=?1") {
        Ok(mut statement) => statement
            .query_map([task_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .ok()
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>().ok())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    for (id, raw) in rows {
        if let Ok(mut record) = serde_json::from_str::<Value>(&raw) {
            record["state"] = json!("ended");
            record["endedAt"] = json!(now);
            if let Ok(encoded) = serde_json::to_string(&record) {
                let _ = db.execute(
                    "UPDATE agent_sessions SET record=?1 WHERE id=?2",
                    rusqlite::params![encoded, id],
                );
            }
        }
    }
    if db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_session_checks'",
            [],
            |_| Ok(()),
        )
        .optional()
        .unwrap_or(None)
        .is_some()
    {
        let _ = db.execute(
            "UPDATE agent_session_checks SET verified=generation WHERE task=?1",
            [task_id],
        );
    }
}

fn executor_for(task: &Value) -> Option<String> {
    let last = task
        .get("attempts")
        .and_then(Value::as_array)
        .and_then(|attempts| attempts.last());
    for value in [
        task.pointer("/result/executor"),
        task.get("executor"),
        last.and_then(|a| a.get("executor")),
        task.get("requestedExecutor"),
    ] {
        if let Some(executor) = value.and_then(Value::as_str).filter(|s| !s.is_empty()) {
            return Some(executor.to_owned());
        }
    }
    None
}

fn repo_for(task: &Value) -> Option<String> {
    task.get("repo")
        .or_else(|| task.get("brief")?.get("repo"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// `taskActivity(ctx, task, "task_settled", …)` (`src/tasks/activity.ts`).
fn task_settled_activity(ctx: &Ctx, task: &Value) {
    let mut activity = json!({
        "kind": "task_settled",
        "level": "info",
        "text": format!("Stopped “{}”", pacer_read_model::tasks::full_title(task)),
        "taskId": task.get("id").cloned().unwrap_or(Value::Null),
    });
    if let Some(repo) = repo_for(task) {
        activity["repo"] = json!(repo);
    }
    if let Some(executor) = executor_for(task) {
        activity["executor"] = json!(executor);
    }
    if let Some(host) = task.pointer("/run/host").and_then(Value::as_str) {
        activity["host"] = json!(host);
    }
    if let Err(error) = pacer_store::append_activity(ctx, activity) {
        eprintln!("pacer: task.stop activity failed: {error}");
    }
}

fn publish_stop(ctx: &Ctx, task: &Value) {
    for error in publish(ctx, &[json!({"type":"task","data": task_data(task, &|_| false)})]).errors {
        eprintln!("pacer: task.stop publication failed: {error}");
    }
}

fn map_stop_error(_ctx: &Ctx, _store: &mut TaskStore, error: RecordStopError) -> CoreError {
    match error {
        RecordStopError::InvalidInput(message) => invalid(message),
        RecordStopError::UnknownTask(id) => unknown(&id),
        RecordStopError::Conflict { message, task } => {
            let projected = (!task.is_null()).then(|| task_data(&task, &|_| false));
            let mut err = conflict(message);
            if let Some(task) = projected {
                let mut data = serde_json::Map::new();
                data.insert("task".into(), task);
                err = err.data(data);
            }
            err
        }
        RecordStopError::Store(error) => internal(error.to_string()),
    }
}

/// Port of `taskStop` plus `taskStopAfterStore`: record the store transition,
/// release the exact worker/remote attempt and append `task_settled`.
pub async fn stop_task(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    options: StopOptions,
) -> Result<Value, CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let before = store.read(id).map_err(|e| internal(e.to_string()))?.ok_or_else(|| unknown(id))?;
    let before_state = before.get("state").and_then(Value::as_str).unwrap_or("").to_owned();
    let runner_alive = before.get("state").and_then(Value::as_str) == Some("running")
        && before.get("runnerPid").is_some_and(pid_alive);

    // Agent sessions are released before the store transition, as in `taskStop`.
    let has_agent = {
        let db = store.connection().map_err(|e| internal(e.to_string()))?;
        agent_checks_pending(db, id) || active_agent_sessions(db, id)
    };
    if has_agent {
        if let Ok(db) = store.connection() {
            stop_agent_sessions(db, id, ctx.now);
        }
    }

    let recorded = record_task_stop(
        &mut store,
        id,
        options.expect_rev.map(|rev| rev as f64),
        ctx.now,
        runner_alive,
    )
    .map_err(|error| map_stop_error(ctx, &mut store, error))?;

    let after = store.read(id).map_err(|e| internal(e.to_string()))?.unwrap_or(recorded);
    publish_stop(ctx, &after);

    let stop_pending = after.get("stopPending").is_some_and(|v| !v.is_null());
    if options.signal && !stop_pending {
        let live = after.get("live").and_then(Value::as_bool).unwrap_or(false);
        if before_state == "needs_input" && live {
            release_live_worker(ctx, runtime, &after).await;
        } else if let (Some(host), Some(remote_dir)) = (
            after.pointer("/run/host").and_then(Value::as_str),
            after.pointer("/run/remoteDir").and_then(Value::as_str),
        ) {
            stop_remote(ctx, runtime, host, remote_dir).await;
        } else if let Some(pid) = after
            .get("childPid")
            .and_then(Value::as_f64)
            .filter(|n| *n > 0.0 && n.is_finite())
        {
            kill_tree(pid as u32);
        }
    }

    if !terminal_state(&before_state) && terminal(&after) {
        task_settled_activity(ctx, &after);
    }
    Ok(summarize(&after))
}

/// `releaseLiveWorker` through the executor plugin (`executor.stop`).
///
/// B0b owns the host-issued `orcaLive` grant. At this base the plugin call is
/// best-effort, as in TypeScript (`src/tasks/api.ts` catches release failures
/// and leaves them to the next supervision pass); an unavailable capability is
/// reported loudly instead of being silently swallowed.
async fn release_live_worker(ctx: &Ctx, runtime: &Runtime, task: &Value) {
    let provider = task
        .pointer("/live/backend")
        .and_then(Value::as_str)
        .or_else(|| task.get("executorProvider").and_then(Value::as_str))
        .map(str::to_owned);
    let Some(provider) = provider else {
        eprintln!("pacer: task.stop live worker has no executor backend to release");
        return;
    };
    let attempt = task
        .get("attempts")
        .and_then(Value::as_array)
        .map(|a| a.len() as u64 + 1)
        .unwrap_or(1);
    let mut params = json!({
        "taskId": task.get("id").cloned().unwrap_or(Value::Null),
        "attempt": attempt,
        "graceMs": 0,
    });
    if let Some(live) = task.get("live") {
        params["resources"] = json!({"orcaLive": live});
    }
    let providers = runtime.plugins.providers(ctx, "executor.stop");
    let target = if providers.iter().any(|id| id == &provider) {
        provider.clone()
    } else {
        providers.first().cloned().unwrap_or(provider.clone())
    };
    let result = runtime
        .plugins
        .call(ctx, &target, "executor.stop", params, Duration::from_secs(120))
        .await;
    if result.is_err() {
        eprintln!(
            "pacer: task.stop could not release live worker on {target}; the supervision pass retries"
        );
    }
}

/// Remote host stop through the hosts plugin. The exact host-owned stop
/// capability lands with B0a; until then this is a best-effort plugin call and
/// is reported UNVERIFIED in CT-11 (SEC-6).
async fn stop_remote(ctx: &Ctx, runtime: &Runtime, host: &str, remote_dir: &str) {
    let providers = runtime.plugins.providers(ctx, "host.stop");
    let Some(provider) = providers.first().cloned() else {
        eprintln!(
            "pacer: task.stop has no host stop provider for {host}; supervisor retries host clean"
        );
        return;
    };
    let params = json!({"host": host, "remoteDir": remote_dir, "graceMs": 5000});
    let result = runtime
        .plugins
        .call(ctx, &provider, "host.stop", params, Duration::from_secs(120))
        .await;
    if result.is_err() {
        eprintln!("pacer: task.stop could not stop remote host {host}; supervisor retries");
    }
}

/// `stopWork` (`src/core/work.ts`): stop every non-terminal node in the scoped
/// tree. The work-tree reader is `pacer_lifecycle::work_reads` (the grant-scoped
/// variant moves to `pacer-work` with B2-1).
pub async fn stop_work(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    expect_rev: Option<i64>,
) -> Result<Value, CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let root = store.read(id).map_err(|e| internal(e.to_string()))?.ok_or_else(|| unknown(id))?;
    if let Some(expect) = expect_rev
        && root.get("rev").and_then(Value::as_i64) != Some(expect)
    {
        return Err(conflict("Task changed"));
    }
    let ids: Vec<String> = {
        let db = store.connection().map_err(|e| internal(e.to_string()))?;
        let reads = WorkReads {
            db,
            now: ctx.now,
            pid_alive: &pid_alive,
        };
        match reads.scoped_tree(id) {
            Ok(tree) => tree["nodes"]
                .as_array()
                .map(|nodes| {
                    nodes
                        .iter()
                        .filter_map(|node| node.get("taskId").and_then(Value::as_str))
                        .filter(|node_id| *node_id != id)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    };
    // Stop children first, then the root, matching `stopWork`'s tree walk.
    for node_id in ids {
        let _ = stop_task(ctx, runtime, &node_id, StopOptions { signal: true, expect_rev: None }).await;
    }
    let stopped = stop_task(ctx, runtime, id, StopOptions { signal: true, expect_rev: None }).await?;
    Ok(stopped)
}
