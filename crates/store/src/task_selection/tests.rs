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
                // The attention/snapshot active set (queued, running, needs_input)
                // must stay one indexed seek even with a large need*_input set.
                TaskFilter {
                    states: Some(&["queued", "running", "needs_input"]),
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

/// Unicode rows (Ü, Đ, É) on top of the plain fixture history.
fn unicode_fixture(count: usize) -> (tempfile::TempDir, TaskStore, Vec<&'static str>) {
    let (dir, mut store) = fixture(count);
    let db = store.connection().unwrap();
    db.execute_batch("BEGIN").unwrap();
    for (id, title, goal) in [
        ("t-20261101-093000-aa01", "Überprüfung der Gateways", ""),
        ("t-20261101-093000-aa02", "", "Đồng bộ cache"),
        ("t-20261101-093000-aa03", "Élan for the launch", "Đồng nhất"),
    ] {
        let record = json!({"id":id,"rev":1,"state":"done","createdAt":1.0,
            "brief":{"repo":"/fixture","goal":goal},"title":title,"attempts":[]});
        db.execute(
            "INSERT INTO tasks(id,rev,state,created_at,updated_at,settled_at,archived,record) VALUES(?,1,'done',1,1,1,0,?)",
            params![id, record.to_string()],
        )
        .unwrap();
    }
    db.execute_batch("COMMIT").unwrap();
    (
        dir,
        store,
        vec![
            "t-20261101-093000-aa01",
            "t-20261101-093000-aa02",
            "t-20261101-093000-aa03",
        ],
    )
}

#[test]
fn unicode_words_are_folded_the_same_way_after_decode() {
    let (_dir, mut store, ids) = unicode_fixture(1_000);
    let (review, sync, flair) = (ids[0], ids[1], ids[2]);
    // SQLite's lower() cannot fold these; both runtimes check the decoded
    // records with per-character Unicode lowercase, in either direction.
    for (word, expected) in [
        ("überprüfung", vec![review]),
        ("Über", vec![review]),
        ("ÜBER", vec![review]),
        ("đồng bộ", vec![sync]),
        ("ĐỒNG", vec![flair, sync]),
        ("élan", vec![flair]),
        ("ÉLAN", vec![flair]),
    ] {
        let rows = store
            .list(&TaskFilter {
                query: Some(word),
                limit: Some(21),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            rows.iter()
                .map(|r| r["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            expected,
            "word {word}"
        );
    }
    // The limit and newest-first order hold while pages are decoded and filtered.
    let rows = store
        .list(&TaskFilter {
            query: Some("đồng"),
            limit: Some(2),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [ids[2], ids[1]]
    );
    // An id-shaped word rides the primary-key range while the Unicode word is
    // still folded after decoding.
    let filter = TaskFilter {
        query: Some("über t-2026"),
        limit: Some(21),
        ..Default::default()
    };
    let rows = store.list(&filter).unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [review]
    );
    let (sql, bind) = query(&filter);
    let plan = store
        .connection()
        .unwrap()
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .unwrap()
        .query_map(params_from_iter(&bind), |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
        .join("; ");
    assert!(plan.contains("sqlite_autoindex_tasks_1"), "{plan}");
}

#[test]
fn an_id_shaped_query_rides_a_primary_key_range() {
    let (_dir, mut store, ids) = unicode_fixture(50_000);
    let full = ids[0];
    let date = &full[..10.min(full.len())];
    for (word, expected) in [
        (full, vec![full]),
        // The date prefix matches the whole fixture history, so a limit of 3
        // returns the three unicode rows on top of it, newest first.
        (date, vec![ids[2], ids[1], ids[0]]),
        // A partial time prefix stays inside the range seek.
        (&full[..17], vec![ids[2], ids[1], ids[0]]),
    ] {
        let filter = TaskFilter {
            query: Some(word),
            limit: Some(3),
            ..Default::default()
        };
        let (rows, plan, steps) = measure(&mut store, &filter);
        assert_eq!(
            rows.iter()
                .map(|r| r["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            expected,
            "word {word}"
        );
        assert!(plan.contains("sqlite_autoindex_tasks_1"), "{plan}");
        assert!(!plan.contains("TEMP B-TREE"), "{plan}");
        assert!(steps < 1_000, "{plan}: {steps} VM steps");
    }
    // An id-shaped word never matches the goal that quotes it.
    let db = store.connection().unwrap();
    let quoted = json!({"id":"t-20261101-093000-aa04","rev":1,"state":"done","createdAt":1.0,
        "brief":{"repo":"/fixture","goal":format!("see {full} for the plan")},"attempts":[]});
    db.execute(
        "INSERT INTO tasks(id,rev,state,created_at,updated_at,settled_at,archived,record) VALUES('t-20261101-093000-aa04',1,'done',1,1,1,0,?)",
        params![quoted.to_string()],
    )
    .unwrap();
    let rows = store
        .list(&TaskFilter {
            query: Some(full),
            limit: Some(21),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [full]
    );
}

/// The probe for the reported timings: `cargo test -p pacer-store --lib -- --ignored --nocapture report_search_timings`.
/// It asserts nothing and takes seconds, so it stays out of the default run.
#[test]
#[ignore = "timing probe; run on demand"]
fn report_search_timings_over_50k_tasks() {
    let (_dir, mut store, ids) = unicode_fixture(50_000);
    for (label, filter) in [
        (
            "no-hit word 'zzznope'",
            TaskFilter {
                query: Some("zzznope"),
                limit: Some(21),
                ..Default::default()
            },
        ),
        (
            "date prefix 't-20261101'",
            TaskFilter {
                query: Some("t-20261101"),
                limit: Some(21),
                ..Default::default()
            },
        ),
        (
            "full id",
            TaskFilter {
                query: Some(ids[0]),
                limit: Some(21),
                ..Default::default()
            },
        ),
        (
            "4-hex suffix",
            TaskFilter {
                query: Some(&ids[0][ids[0].len() - 4..]),
                limit: Some(21),
                ..Default::default()
            },
        ),
        (
            "unicode word 'über'",
            TaskFilter {
                query: Some("über"),
                limit: Some(21),
                ..Default::default()
            },
        ),
    ] {
        let start = std::time::Instant::now();
        let rows = store.list(&filter).unwrap();
        eprintln!("{label}: {:?} -> {} rows", start.elapsed(), rows.len());
    }
}

#[test]
fn a_match_is_still_found_when_the_record_is_large_and_the_word_is_only_in_the_goal() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let db = store.connection().unwrap();
    let id = "t-20261101-000000-aa99";
    let goal = format!("über {}", "y".repeat(8000));
    let record = json!({"id":id,"rev":1,"state":"done","createdAt":1.0,
        "title":"","brief":{"repo":"/fixture","goal":goal},"attempts":[]});
    db.execute(
        "INSERT INTO tasks(id,rev,state,created_at,updated_at,settled_at,archived,record) VALUES(?,1,'done',1,1,1,0,?)",
        params![id, record.to_string()],
    )
    .unwrap();
    let rows = store
        .list(&TaskFilter {
            query: Some("Über"),
            limit: Some(21),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"].as_str().unwrap(), id);
}
