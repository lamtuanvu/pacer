//! `task.request_review`: persist a human handoff note without a quality verdict.
//! No runner, plugin, messaging or supervision side effects.
use crate::js;
use pacer_store::{StoreError, TaskStore, is_task_id};
use serde_json::{Value, json};

#[derive(Debug)]
pub enum RequestReviewError {
    InvalidInput(String),
    UnknownTask(String),
    Conflict { message: String, task: Value },
    Store(StoreError),
}

impl From<StoreError> for RequestReviewError {
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

fn truth(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.0),
        _ => true,
    }
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn normalize_note(note: &str) -> Result<String, RequestReviewError> {
    let trimmed = js::trim(note);
    let len = utf16_len(trimmed);
    if trimmed.is_empty() || len > 2000 {
        return Err(RequestReviewError::InvalidInput(
            "review request needs a note of 1–2000 characters".into(),
        ));
    }
    Ok(trimmed.to_owned())
}

fn eligible(task: &Value) -> bool {
    matches!(
        task.get("state").and_then(Value::as_str),
        Some("done" | "partial")
    ) && !truth(task.get("review").unwrap_or(&Value::Null))
        && !truth(task.get("resolved").unwrap_or(&Value::Null))
        && !truth(task.get("dismissed").unwrap_or(&Value::Null))
        && !truth(task.get("retriedBy").unwrap_or(&Value::Null))
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

/// Record or refresh a review request on a settled task. Same note is idempotent.
pub fn request_review(
    store: &mut TaskStore,
    id: &str,
    note: &str,
    expect_rev: Option<f64>,
    now: f64,
) -> Result<Value, RequestReviewError> {
    let note = normalize_note(note)?;
    if id.is_empty() || utf16_len(id) > 128 {
        return Err(RequestReviewError::InvalidInput(
            "id: Invalid input: expected string length 1–128".into(),
        ));
    }
    if !is_task_id(id) {
        // Match TS `readTask` miss → unknown_task for any unresolved id.
        return Err(RequestReviewError::UnknownTask(id.into()));
    }
    store.with_task_lock(id, |locked| {
        let task = locked.read()?;
        if !expect_matches(&task, expect_rev) {
            return Err(RequestReviewError::Conflict {
                message: "task changed".into(),
                task,
            });
        }
        if !eligible(&task) {
            return Err(RequestReviewError::Conflict {
                message: "task no longer needs a review request".into(),
                task,
            });
        }
        if task.pointer("/reviewRequest/note").and_then(Value::as_str) == Some(note.as_str()) {
            return Ok(task);
        }
        let rev = task
            .get("rev")
            .and_then(Value::as_i64)
            .or_else(|| task.get("rev").and_then(Value::as_f64).map(|n| n as i64))
            .ok_or(StoreError::InvalidRecord)?;
        locked
            .update(rev, now, |current| {
                current["reviewRequest"] = json!({"note": note, "at": now});
            })
            .map_err(RequestReviewError::from)
    })
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
                    "brief": {"goal": "Review permissions", "repo": "/repo"},
                    "state": "done",
                    "createdAt": now,
                    "attempts": [],
                    "timeoutS": 60,
                    "requestedExecutor": null,
                }),
                now,
            )
            .unwrap();
        // insert starts at rev 1; bump once like createTask→updateTask(state=done).
        let task = store
            .update(id, 1, now, |t| t["state"] = json!("done"))
            .unwrap();
        assert_eq!(task["rev"], 2);
        (dir, store, id.into())
    }

    #[test]
    fn persists_trimmed_note_and_is_idempotent() {
        let (_dir, mut store, id) = seed(100.0);
        let first = request_review(&mut store, &id, "  Check access  ", Some(2.0), 100.0).unwrap();
        assert_eq!(first["rev"], 3);
        assert_eq!(first["reviewRequest"]["note"], "Check access");
        assert_eq!(first["reviewRequest"]["at"], 100.0);
        let again = request_review(&mut store, &id, "Check access", Some(3.0), 120.0).unwrap();
        assert_eq!(again["rev"], 3);
        assert_eq!(again["reviewRequest"]["at"], 100.0);
    }

    #[test]
    fn rejects_bad_note_state_and_stale_rev() {
        let (_dir, mut store, id) = seed(50.0);
        assert!(matches!(
            request_review(&mut store, &id, "   ", None, 50.0),
            Err(RequestReviewError::InvalidInput(_))
        ));
        request_review(&mut store, &id, "Check", None, 50.0).unwrap();
        let conflict = request_review(&mut store, &id, "Check", Some(2.0), 60.0).unwrap_err();
        assert!(matches!(conflict, RequestReviewError::Conflict { .. }));
        store
            .update(&id, 3, 70.0, |t| t["state"] = json!("failed"))
            .unwrap();
        assert!(matches!(
            request_review(&mut store, &id, "Check", None, 70.0),
            Err(RequestReviewError::Conflict { .. })
        ));
        assert!(matches!(
            request_review(&mut store, "missing", "Check", None, 70.0),
            Err(RequestReviewError::UnknownTask(_))
        ));
    }
}
