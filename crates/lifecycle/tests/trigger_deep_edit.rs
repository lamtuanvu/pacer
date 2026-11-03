//! Row 24 on row 7, trigger-installed configuration (F1 and the coordinator
//! SQLite ruling). Once `AdmissionState::open` installs the dispatch `work_*`
//! triggers, an edit of a depth-20,000 record fails in SQLite JSON1. Expected
//! values come from actual TS `updateTask` after `dispatchDatabase`
//! (`.work/reviews/task-json-t1-revision/ts-deep-edit-oracle.json`,
//! `trigger-installed`). This pins an inherited failure mode. It is not an
//! atomic rollback: SQLite keeps rev 2 while the compatibility file, written
//! first, already holds rev 3, and the next read fails the same way.
#![allow(clippy::unwrap_used)]
#[path = "support/isolation.rs"]
mod isolation;
use isolation::{isolated, js_canonical};
use pacer_js_json::WireReply;
use pacer_lifecycle::AdmissionState;
use pacer_store::{StoreError, TaskStore};
use serde_json::json;
use std::path::Path;

const ID: &str = "t-20261103-070000-2408";

fn deep_text(rev: i64, title: Option<&str>) -> String {
    let deep = format!("{}1{}", "[".repeat(19_999), "]".repeat(19_999));
    let title = title.map_or(String::new(), |t| format!(r#","title":"{t}""#));
    format!(
        r#"{{"id":"{ID}","rev":{rev},"state":"queued","createdAt":1,"brief":{{"repo":"/tmp/repo"}},"attempts":[],"deep":{deep}{title}}}"#
    )
}

fn row(home: &Path) -> (i64, f64, String) {
    let db = rusqlite::Connection::open(home.join("state/tasks.db")).unwrap();
    db.query_row(
        "SELECT rev,updated_at,record FROM tasks WHERE id=?",
        [ID],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .unwrap()
}

fn malformed_json(result: &Result<impl std::fmt::Debug, StoreError>) -> bool {
    matches!(result, Err(StoreError::Sql(e)) if e.to_string().contains("malformed JSON"))
}

fn body() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    std::fs::create_dir_all(home.join("tasks")).unwrap();
    let compat = home.join(format!("tasks/{ID}.json"));
    std::fs::write(&compat, deep_text(1, None)).unwrap();

    // Plain store: no triggers yet, so the deep edit publishes (TS: rev 1 -> 2).
    let mut store = TaskStore::open(home).unwrap();
    store
        .edit(ID, 1, 2000.0, |t| {
            t.put("/title", WireReply::new(json!("plain")))
        })
        .unwrap_or_else(|e| panic!("plain edit: {e:?}"));
    drop(store);
    let (rev, updated_at, before) = row(home);
    assert_eq!((rev, updated_at), (2, 2000.0));
    assert_eq!(
        js_canonical(&before),
        js_canonical(&deep_text(2, Some("plain")))
    );

    let mut state = AdmissionState::open(home).unwrap();
    let db = rusqlite::Connection::open(home.join("state/tasks.db")).unwrap();
    let triggers: Vec<String> = db
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        triggers,
        [
            "work_capacity_close",
            "work_capacity_open",
            "work_queue_close",
            "work_queue_open",
            "work_task_changed"
        ]
    );
    let nodes: i64 = db
        .query_row(
            "SELECT count(*) FROM work_nodes WHERE task_id=?",
            [ID],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(nodes, 0, "TS oracle: no work node for this task");
    drop(db);

    // TS: `SQLiteError: malformed JSON`.
    let failed = state.tasks.edit(ID, 2, 3000.0, |t| {
        t.put("/title", WireReply::new(json!("after-triggers")))
    });
    assert!(malformed_json(&failed), "{:?}", failed.err());
    let (rev, updated_at, after) = row(home);
    assert_eq!((rev, updated_at), (2, 2000.0), "SQLite keeps rev 2");
    assert!(after == before, "SQLite record bytes unchanged");

    // TS: the compatibility file was written first and holds rev 3.
    let file = std::fs::read_to_string(&compat).unwrap();
    assert_eq!(
        js_canonical(&file),
        js_canonical(&deep_text(3, Some("after-triggers")))
    );
    let temps = std::fs::read_dir(home.join("tasks"))
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|x| x == "tmp")
        })
        .count();
    assert_eq!(temps, 0);

    // TS: the next `readTask` re-imports the rev 3 file and fails the same way;
    // SQLite still holds rev 2.
    let next = state.tasks.read(ID);
    assert!(malformed_json(&next), "{:?}", next.err());
    let (rev, _, still) = row(home);
    assert_eq!(rev, 2);
    assert!(still == before);
}

#[test]
fn row24_depth_20000_edit_after_dispatch_triggers_fails_like_ts_without_rollback() {
    isolated(
        "row24_depth_20000_edit_after_dispatch_triggers_fails_like_ts_without_rollback",
        body,
    );
}
