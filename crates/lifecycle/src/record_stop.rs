//! Store-only slice of `taskStop` in `src/tasks/api.ts` without agent-session
//! gates, live-worker release, remote host stop or process signals.
use pacer_store::{StoreError, TaskStore, is_task_id};
use serde_json::{Value, json};

const TERMINAL_STATES: [&str; 6] = [
    "done", "partial", "failed", "limit", "stopped", "needs_input",
];

#[derive(Debug, thiserror::Error)]
pub enum RecordStopError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("unknown task {0}")]
    UnknownTask(String),
    #[error("{message}")]
    Conflict { message: String, task: Value },
    #[error(transparent)]
    Store(StoreError),
}

impl From<StoreError> for RecordStopError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::UnknownTask(id) => Self::UnknownTask(id),
            StoreError::Conflict => Self::Conflict {
                message: "task changed".into(),
                task: Value::Null,
            },
            other => Self::Store(other),
        }
    }
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn terminal(task: &Value) -> bool {
    task.get("state")
        .and_then(Value::as_str)
        .is_some_and(|state| TERMINAL_STATES.contains(&state))
}

fn expect_matches(task: &Value, expect_rev: Option<f64>) -> bool {
    match expect_rev {
        None => true,
        Some(expected) => task
            .get("rev")
            .and_then(Value::as_f64)
            .is_some_and(|rev| rev == expected),
    }
}

fn remote_transfer_blocks(task: &Value) -> bool {
    let Some(run) = task.get("run").and_then(Value::as_object) else {
        return false;
    };
    let Some(intent) = task.get("remoteTransferIntent").and_then(Value::as_object) else {
        return false;
    };
    intent.get("attempt").zip(run.get("attempt")).is_some_and(|(a, b)| a == b)
        && intent.get("dir").zip(run.get("dir")).is_some_and(|(a, b)| a == b)
        && intent
            .get("startedAt")
            .zip(run.get("startedAt"))
            .is_some_and(|(a, b)| a == b)
        && !truth(run.get("transferredHead").unwrap_or(&Value::Null))
}

fn truth(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        _ => true,
    }
}

fn stop_result_stub() -> Value {
    json!({
        "status": "stopped",
        "executor": null,
        "model": null,
        "files": "",
        "report": "stopped before an executor ran",
        "backend": "direct",
    })
}

fn stop_pending(task: &Value, now: f64) -> Value {
    let attempt = task
        .get("run")
        .and_then(|run| run.get("attempt"))
        .cloned()
        .or_else(|| {
            task.get("attempts")
                .and_then(Value::as_array)
                .map(|attempts| json!(attempts.len() + 1))
        })
        .unwrap_or_else(|| json!(1));
    let provider = task
        .get("executorProvider")
        .cloned()
        .unwrap_or(Value::Null);
    json!({
        "attempt": attempt,
        "requestedAt": now,
        "providerId": provider,
        "graceMs": 5000,
        "reason": "user",
    })
}

/// Persist stop-related task fields matching `taskStop` when agent sessions,
/// signaling and live-worker release are handled elsewhere.
pub fn record_task_stop(
    store: &mut TaskStore,
    id: &str,
    expect_rev: Option<f64>,
    now: f64,
    runner_alive: bool,
) -> Result<Value, RecordStopError> {
    if id.is_empty() || utf16_len(id) > 128 {
        return Err(RecordStopError::InvalidInput(
            "id: Invalid input: expected string length 1–128".into(),
        ));
    }
    if !is_task_id(id) {
        return Err(RecordStopError::UnknownTask(id.into()));
    }
    store.with_task_lock(id, |locked| {
        let task = locked.read()?;
        if !expect_matches(&task, expect_rev) {
            return Err(RecordStopError::Conflict {
                message: "task changed".into(),
                task,
            });
        }
        if task.get("stopPending").is_some_and(|v| !v.is_null()) {
            return Ok(task);
        }
        if task.get("executorProvider").is_some()
            && task.get("state").and_then(Value::as_str) == Some("running")
        {
            if remote_transfer_blocks(&task) {
                return Err(RecordStopError::Conflict {
                    message: "remote transfer is in progress; retry stop after it settles".into(),
                    task,
                });
            }
            let rev = task
                .get("rev")
                .and_then(Value::as_i64)
                .or_else(|| task.get("rev").and_then(Value::as_f64).map(|n| n as i64))
                .ok_or(StoreError::InvalidRecord)?;
            return locked
                .update(rev, now, |current| {
                    current["stopPending"] = stop_pending(current, now);
                })
                .map_err(RecordStopError::from);
        }
        if task.get("state").and_then(Value::as_str) == Some("needs_input") {
            let rev = task
                .get("rev")
                .and_then(Value::as_i64)
                .or_else(|| task.get("rev").and_then(Value::as_f64).map(|n| n as i64))
                .ok_or(StoreError::InvalidRecord)?;
            return locked
                .update(rev, now, |current| {
                    current["state"] = json!("stopped");
                    if let Some(result) = current.get_mut("result").and_then(Value::as_object_mut) {
                        result.insert("status".into(), json!("stopped"));
                    }
                })
                .map_err(RecordStopError::from);
        }
        if terminal(&task) {
            return Ok(task);
        }
        let rev = task
            .get("rev")
            .and_then(Value::as_i64)
            .or_else(|| task.get("rev").and_then(Value::as_f64).map(|n| n as i64))
            .ok_or(StoreError::InvalidRecord)?;
        let handed_over = task
            .get("handover")
            .and_then(|h| h.get("state"))
            .and_then(Value::as_str)
            == Some("handed-over");
        locked
            .update(rev, now, |current| {
                if terminal(current) {
                    return;
                }
                current["state"] = json!("stopped");
                if !runner_alive && !handed_over {
                    current["result"] = stop_result_stub();
                }
            })
            .map_err(RecordStopError::from)
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use tempfile::tempdir;

    fn seed(state: &str, now: f64) -> (tempfile::TempDir, TaskStore, String) {
        let dir = tempdir().unwrap();
        let mut store = TaskStore::open(dir.path()).unwrap();
        let id = "t-20261106-000000-abcd";
        store
            .insert(
                &json!({
                    "id": id,
                    "rev": 1,
                    "brief": {"goal": "Stop me", "repo": "/repo"},
                    "state": "queued",
                    "createdAt": now,
                    "attempts": [],
                    "timeoutS": 60,
                    "requestedExecutor": null,
                }),
                now,
            )
            .unwrap();
        if state != "queued" {
            store
                .update(id, 1, now, |t| t["state"] = json!(state))
                .unwrap();
        }
        (dir, store, id.into())
    }

    #[test]
    fn queued_stop_writes_result_when_runner_not_alive() {
        let (_dir, mut store, id) = seed("queued", 10.0);
        let out = record_task_stop(&mut store, &id, None, 10.0, false).unwrap();
        assert_eq!(out["state"], "stopped");
        assert_eq!(out["result"]["report"], "stopped before an executor ran");
    }

    #[test]
    fn running_provider_sets_stop_pending() {
        let (_dir, mut store, id) = seed("running", 10.0);
        store
            .update(&id, 2, 10.0, |t| {
                t["executorProvider"] = json!("pacer-exec-direct");
                t["run"] = json!({"attempt": 1, "host": "h", "dir": "d"});
            })
            .unwrap();
        let out = record_task_stop(&mut store, &id, Some(3.0), 11.0, true).unwrap();
        assert_eq!(out["state"], "running");
        assert_eq!(out["stopPending"]["reason"], "user");
    }

    #[test]
    fn terminal_task_is_unchanged() {
        let (_dir, mut store, id) = seed("done", 10.0);
        store
            .update(&id, 2, 10.0, |t| t["state"] = json!("done"))
            .unwrap();
        let out = record_task_stop(&mut store, &id, Some(3.0), 11.0, false).unwrap();
        assert_eq!(out["state"], "done");
        assert_eq!(out["rev"], 3);
    }
}
