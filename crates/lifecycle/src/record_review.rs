//! Store-only accept/reject slice of `task.review` (`taskReview` in `src/tasks/api.ts`).
//! Agent-session gates, policy, labels, activity, messaging and `autoCleanTask`
//! remain on the TypeScript core until a reviewed native supplier wires them.
use pacer_store::{StoreError, TaskStore, is_task_id};
use serde_json::{Value, json};

pub const TASK_KINDS: [&str; 11] = [
    "boilerplate",
    "tests",
    "docs",
    "rename",
    "migration",
    "feature",
    "debug",
    "refactor",
    "performance",
    "unfamiliar-code",
    "research",
];

const TERMINAL_STATES: [&str; 6] = [
    "done",
    "partial",
    "failed",
    "limit",
    "stopped",
    "needs_input",
];

#[derive(Debug, thiserror::Error)]
pub enum RecordReviewError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("unknown task {0}")]
    UnknownTask(String),
    #[error("{message}")]
    Conflict { message: String, task: Value },
    #[error(transparent)]
    Store(StoreError),
}

impl From<StoreError> for RecordReviewError {
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

fn review_note(note: Option<&str>) -> Value {
    match note {
        None => Value::Null,
        Some(raw) => Value::String(raw.to_owned()),
    }
}

fn kind_valid(kind: Option<&str>) -> Result<Option<&str>, RecordReviewError> {
    match kind {
        None => Ok(None),
        Some(k) if TASK_KINDS.contains(&k) => Ok(Some(k)),
        Some(k) => Err(RecordReviewError::InvalidInput(format!(
            "unknown kind \"{k}\""
        ))),
    }
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

/// Persist an accept/reject verdict on a terminal task. Matches the SQLite fields
/// written by `taskReview` without labels or outbox side effects.
pub fn record_review_verdict(
    store: &mut TaskStore,
    id: &str,
    accepted: bool,
    kind: Option<&str>,
    note: Option<&str>,
    expect_rev: Option<f64>,
    now: f64,
) -> Result<Value, RecordReviewError> {
    let kind = kind_valid(kind)?;
    let note = review_note(note);
    if id.is_empty() || utf16_len(id) > 128 {
        return Err(RecordReviewError::InvalidInput(
            "id: Invalid input: expected string length 1–128".into(),
        ));
    }
    if !is_task_id(id) {
        return Err(RecordReviewError::UnknownTask(id.into()));
    }
    store.with_task_lock(id, |locked| {
        let task = locked.read()?;
        if !expect_matches(&task, expect_rev) {
            return Err(RecordReviewError::Conflict {
                message: "task changed".into(),
                task,
            });
        }
        if !terminal(&task) {
            return Err(RecordReviewError::Conflict {
                message: "task state changed".into(),
                task,
            });
        }
        let rev = task
            .get("rev")
            .and_then(Value::as_i64)
            .or_else(|| task.get("rev").and_then(Value::as_f64).map(|n| n as i64))
            .ok_or(StoreError::InvalidRecord)?;
        let resolved_kind = kind
            .map(|k| k.to_owned())
            .or_else(|| task.get("kind").and_then(|v| v.as_str().map(str::to_owned)));
        locked
            .update(rev, now, |current| {
                current["review"] = json!({
                    "accepted": accepted,
                    "kind": resolved_kind,
                    "note": note.clone(),
                    "at": now,
                });
                current["resolved"] = json!("reviewed");
            })
            .map_err(RecordReviewError::from)
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use tempfile::tempdir;

    fn seed(now: f64, state: &str) -> (tempfile::TempDir, TaskStore, String) {
        let dir = tempdir().unwrap();
        let mut store = TaskStore::open(dir.path()).unwrap();
        let id = "t-20261106-000000-abcd";
        store
            .insert(
                &json!({
                    "id": id,
                    "rev": 1,
                    "brief": {"goal": "Review permissions", "repo": "/repo"},
                    "state": state,
                    "kind": "feature",
                    "createdAt": now,
                    "attempts": [],
                    "timeoutS": 60,
                    "requestedExecutor": null,
                }),
                now,
            )
            .unwrap();
        // Fixture baseline at rev 2: the store now skips no-op writes, so this
        // bump must change a real field rather than re-set the same state.
        let task = store
            .update(id, 1, now, |t| t["fixtureRev"] = json!(2))
            .unwrap();
        assert_eq!(task["rev"], 2);
        (dir, store, id.into())
    }

    #[test]
    fn persists_accept_and_reject() {
        let (_dir, mut store, id) = seed(100.0, "done");
        let accepted = record_review_verdict(
            &mut store,
            &id,
            true,
            None,
            Some("  ship it  "),
            Some(2.0),
            100.0,
        )
        .unwrap();
        assert_eq!(accepted["rev"], 3);
        assert_eq!(accepted["review"]["accepted"], true);
        assert_eq!(accepted["review"]["kind"], "feature");
        assert_eq!(accepted["review"]["note"], "  ship it  ");
        assert_eq!(accepted["resolved"], "reviewed");

        let rejected = record_review_verdict(
            &mut store,
            &id,
            false,
            Some("refactor"),
            None,
            Some(3.0),
            120.0,
        )
        .unwrap();
        assert_eq!(rejected["rev"], 4);
        assert_eq!(rejected["review"]["accepted"], false);
        assert_eq!(rejected["review"]["kind"], "refactor");
        assert!(rejected["review"]["note"].is_null());
    }

    #[test]
    fn rejects_non_terminal_stale_rev_and_bad_kind() {
        let (_dir, mut store, id) = seed(50.0, "running");
        assert!(matches!(
            record_review_verdict(&mut store, &id, true, None, None, None, 50.0),
            Err(RecordReviewError::Conflict { .. })
        ));
        store
            .update(&id, 2, 60.0, |t| t["state"] = json!("done"))
            .unwrap();
        assert!(matches!(
            record_review_verdict(&mut store, &id, true, None, None, Some(2.0), 60.0),
            Err(RecordReviewError::Conflict { .. })
        ));
        assert!(matches!(
            record_review_verdict(&mut store, &id, true, Some("nope"), None, None, 60.0),
            Err(RecordReviewError::InvalidInput(_))
        ));
    }
}
