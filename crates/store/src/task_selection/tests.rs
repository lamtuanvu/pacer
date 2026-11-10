#![allow(clippy::unwrap_used)]
use super::*;
use crate::TaskStore;
use rusqlite::{StatementStatus, params, params_from_iter};
use serde_json::{Value, json};

fn fixture(count: usize) -> (tempfile::TempDir, TaskStore) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let db = store.connection().unwrap();
    db.execute_batch("BEGIN").unwrap();
    for n in 0..count {
        let id = format!("t-20261101-000000-{n:04x}");
        let state = if n < 2 { "running" } else { "done" };
        let at = if n < 3 { 100.0 } else { 1.0 };
        let record = json!({"id":id,"rev":1,"state":state,"createdAt":at,
            "brief":{"repo":"/fixture"},"attempts":[]});
        db.execute("INSERT INTO tasks(id,rev,state,created_at,updated_at,settled_at,archived,record) VALUES(?,1,?,?,?,1,0,?)",
            params![id, state, at, at, record.to_string()]).unwrap();
    }
    db.execute_batch("COMMIT").unwrap();
    (dir, store)
}

fn measure(store: &mut TaskStore, filter: &TaskFilter<'_>) -> (Vec<Value>, String, i32) {
    let (sql, bind) = query(filter);
    let db = store.connection().unwrap();
    let plan = db
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .unwrap()
        .query_map(params_from_iter(&bind), |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
        .join("; ");
    let mut stmt = db.prepare(&sql).unwrap();
    let records = stmt
        .query_map(params_from_iter(&bind), |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let steps = stmt.get_status(StatementStatus::VmStep);
    drop(stmt);
    // Exercise the actual public decode path too, not merely a hand-written SQL facsimile.
    let actual = store.list(filter).unwrap();
    assert_eq!(
        actual,
        records
            .iter()
            .map(|s| serde_json::from_str::<Value>(s).unwrap())
            .collect::<Vec<_>>()
    );
    (actual, plan, steps)
}

#[test]
fn production_queries_bound_work_despite_irrelevant_history() {
    for count in [5_000, 50_000] {
        let (_dir, mut store) = fixture(count);
        for (filter, index, expected) in [
            (
                TaskFilter {
                    limit: Some(21),
                    ..Default::default()
                },
                "tasks_native_unarchived_id",
                21,
            ),
            (
                TaskFilter {
                    updated_since: Some(100.0),
                    ..Default::default()
                },
                "tasks_updated_at",
                3,
            ),
            (
                TaskFilter {
                    states: Some(&["queued", "running"]),
                    ..Default::default()
                },
                "tasks_state",
                2,
            ),
            (
                TaskFilter {
                    created_since: Some(100.0),
                    limit: Some(21),
                    ..Default::default()
                },
                "tasks_created_at",
                3,
            ),
            (
                TaskFilter {
                    updated_since: Some(101.0),
                    ..Default::default()
                },
                "tasks_updated_at",
                0,
            ),
            (
                TaskFilter {
                    states: Some(&["queued"]),
                    ..Default::default()
                },
                "tasks_state",
                0,
            ),
        ] {
            let (rows, plan, steps) = measure(&mut store, &filter);
            assert_eq!(rows.len(), expected);
            assert!(plan.contains(index), "{plan}");
            assert!(steps < 1000, "{count} rows: {plan}: {steps} VM steps");
            if index == "tasks_native_unarchived_id" {
                assert!(!plan.contains("TEMP B-TREE"), "{plan}");
                assert_eq!(
                    rows[0]["id"],
                    format!("t-20261101-000000-{:04x}", count - 1)
                );
                assert_eq!(
                    rows[20]["id"],
                    format!("t-20261101-000000-{:04x}", count - 21)
                );
            }
            eprintln!(
                "history={count} rows={} steps={steps} plan={plan}",
                rows.len()
            );
        }
        // Malformed irrelevant records must never reach the decoder in a first page.
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE tasks SET record='invalid json' WHERE id='t-20261101-000000-0000'",
                [],
            )
            .unwrap();
        assert_eq!(
            store
                .list(&TaskFilter {
                    limit: Some(21),
                    ..Default::default()
                })
                .unwrap()
                .len(),
            21
        );
        for filter in [
            TaskFilter {
                states: Some(&[]),
                ..Default::default()
            },
            TaskFilter {
                visible_states: Some(&[]),
                ..Default::default()
            },
            TaskFilter {
                limit: Some(0),
                ..Default::default()
            },
        ] {
            assert!(store.list(&filter).unwrap().is_empty());
        }
    }
}

#[test]
fn archived_cursor_and_index_maintenance_preserve_selection() {
    let (dir, mut store) = fixture(5000);
    // Another runtime's SQL writes automatically maintain the private index.
    let external = Connection::open(dir.path().join("state/tasks.db")).unwrap();
    external
        .execute(
            "UPDATE tasks SET archived=1 WHERE id>='t-20261101-000000-0010'",
            [],
        )
        .unwrap();
    let filter = TaskFilter {
        limit: Some(3),
        before: Some("t-20261101-000000-000f"),
        ..Default::default()
    };
    let (rows, plan, steps) = measure(&mut store, &filter);
    assert!(plan.contains("tasks_native_unarchived_id"));
    assert!(steps < 100);
    assert_eq!(
        rows.iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "t-20261101-000000-000e",
            "t-20261101-000000-000d",
            "t-20261101-000000-000c"
        ]
    );
    let (rows, plan, steps) = measure(
        &mut store,
        &TaskFilter {
            all: true,
            limit: Some(21),
            ..Default::default()
        },
    );
    assert_eq!(rows.len(), 21);
    assert!(plan.contains("sqlite_autoindex_tasks_1"));
    assert!(steps < 300);
    external.execute_batch("BEGIN IMMEDIATE").unwrap();
    // Ready opens must not attempt an index write while another writer holds a lock.
    let mut reopened = TaskStore::open(dir.path()).unwrap();
    assert_eq!(
        reopened.list(&filter).unwrap(),
        store.list(&filter).unwrap()
    );
    external
        .execute_batch("ROLLBACK; DROP INDEX tasks_native_unarchived_id")
        .unwrap();
    drop(reopened);
    let mut reopened = TaskStore::open(dir.path()).unwrap();
    assert_eq!(
        reopened.list(&filter).unwrap(),
        store.list(&filter).unwrap()
    );
}

#[test]
fn competing_filters_keep_planner_choice() {
    for filter in [
        TaskFilter {
            repo: Some(""),
            ..Default::default()
        },
        TaskFilter {
            executor: Some(""),
            ..Default::default()
        },
        TaskFilter {
            visible_states: Some(&["running"]),
            ..Default::default()
        },
        TaskFilter {
            states: Some(&["running"]),
            updated_since: Some(100.0),
            ..Default::default()
        },
        TaskFilter {
            settled_before: Some(2.0),
            ..Default::default()
        },
    ] {
        assert!(!query(&filter).0.contains("INDEXED BY"));
    }
}
