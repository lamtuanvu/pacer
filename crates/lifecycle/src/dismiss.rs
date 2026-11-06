//! Store-only `task.dismiss` field updates matching `taskDismiss` in `src/tasks/api.ts`.
use pacer_store::{StoreError, TaskStore, is_task_id};
use serde_json::{Value, json};

#[derive(Debug, thiserror::Error)]
pub enum DismissError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("{message}")]
    Conflict { message: String, task: Value },
    #[error(transparent)]
    Store(StoreError),
}

impl From<StoreError> for DismissError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Conflict => Self::Conflict {
                message: "task changed".into(),
                task: Value::Null,
            },
            other => Self::Store(other),
        }
    }
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

fn revision(task: &Value) -> Result<i64, StoreError> {
    task.get("rev")
        .and_then(Value::as_i64)
        .or_else(|| task.get("rev").and_then(Value::as_f64).map(|n| n as i64))
        .ok_or(StoreError::InvalidRecord)
}

/// Set `dismissed: true` on one task. Missing ids return `Ok(None)` without error.
pub fn dismiss_task(
    store: &mut TaskStore,
    id: &str,
    expect_rev: Option<f64>,
    now: f64,
) -> Result<Option<Value>, DismissError> {
    if id.is_empty() || id.encode_utf16().count() > 128 {
        return Err(DismissError::InvalidInput(
            "id: Invalid input: expected string length 1–128".into(),
        ));
    }
    if !is_task_id(id) {
        return Ok(None);
    }
    let Some(task) = store.read(id).map_err(DismissError::from)? else {
        return Ok(None);
    };
    if !expect_matches(&task, expect_rev) {
        return Err(DismissError::Conflict {
            message: "task changed".into(),
            task,
        });
    }
    let rev = revision(&task).map_err(DismissError::from)?;
    let updated = store
        .update(id, rev, now, |current| {
            current["dismissed"] = json!(true);
        })
        .map_err(DismissError::from)?;
    Ok(Some(updated))
}

#[derive(Debug)]
pub struct DismissBatch {
    pub dismissed: Vec<Value>,
    pub unknown: Vec<String>,
}

/// Validate every known revision, then dismiss known ids in request order.
pub fn dismiss_tasks(
    store: &mut TaskStore,
    ids: &[String],
    expect_rev: Option<f64>,
    now: f64,
) -> Result<DismissBatch, DismissError> {
    if ids.is_empty() || ids.len() > 100 {
        return Err(DismissError::InvalidInput(
            "ids: Invalid input: expected array length 1–100".into(),
        ));
    }
    let mut lock_order: Vec<String> = ids.iter().cloned().collect();
    lock_order.sort();
    lock_order.dedup();
    for id in &lock_order {
        if id.is_empty() || id.encode_utf16().count() > 128 {
            return Err(DismissError::InvalidInput(
                "ids: Invalid input: expected string length 1–128".into(),
            ));
        }
        if !is_task_id(id) {
            continue;
        }
        let Some(task) = store.read(id).map_err(DismissError::from)? else {
            continue;
        };
        if !expect_matches(&task, expect_rev) {
            return Err(DismissError::Conflict {
                message: "task changed".into(),
                task,
            });
        }
    }
    let mut dismissed = Vec::new();
    let mut unknown = Vec::new();
    for id in ids {
        match dismiss_task(store, id, expect_rev, now)? {
            Some(task) => dismissed.push(task),
            None => unknown.push(id.clone()),
        }
    }
    Ok(DismissBatch { dismissed, unknown })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use tempfile::tempdir;

    fn seed(now: f64) -> (tempfile::TempDir, TaskStore, String) {
        let dir = tempdir().unwrap();
        let mut store = TaskStore::open(dir.path()).unwrap();
        let id = "t-20261106-000000-abcd";
        store
            .insert(
                &json!({
                    "id": id,
                    "rev": 1,
                    "brief": {"goal": "Dismiss me", "repo": "/repo"},
                    "state": "failed",
                    "createdAt": now,
                    "attempts": [],
                    "timeoutS": 60,
                    "requestedExecutor": null,
                }),
                now,
            )
            .unwrap();
        (dir, store, id.into())
    }

    #[test]
    fn dismisses_known_and_reports_unknown() {
        let (_dir, mut store, id) = seed(10.0);
        let batch = dismiss_tasks(
            &mut store,
            &["missing-1".into(), id.clone(), "missing-2".into()],
            None,
            10.0,
        )
        .unwrap();
        assert_eq!(batch.dismissed.len(), 1);
        assert_eq!(batch.dismissed[0]["id"], id);
        assert!(batch.dismissed[0]["dismissed"].as_bool().unwrap());
        assert_eq!(batch.unknown, ["missing-1", "missing-2"]);
    }

    #[test]
    fn rejects_stale_expect_rev_before_batch() {
        let (_dir, mut store, id) = seed(10.0);
        let err = dismiss_tasks(&mut store, &[id], Some(2.0), 10.0).unwrap_err();
        assert!(matches!(err, DismissError::Conflict { .. }));
    }
}
