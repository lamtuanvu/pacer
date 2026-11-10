#![allow(clippy::unwrap_used)]
use pacer_store::{TaskFilter, TaskStore};
use serde_json::json;

#[test]
fn history_filters_before_limit_with_visible_states_and_executor_precedence() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    for n in 0..1000 {
        let mut task = json!({"id":format!("t-20261101-000000-{n:04x}"),"rev":1,"state":"done",
            "createdAt":n,"brief":{"repo":"/repo"},"repo":{"key":"repo-a"},
            "attempts":[],"requestedExecutor":"codex"});
        if n % 2 == 0 {
            task["repo"]["key"] = json!("repo-b");
        }
        if n % 3 == 0 {
            task["result"] = json!({"executor":"claude"});
        }
        if n % 5 == 0 {
            task["state"] = json!("running");
            task["question"] = json!({"text":"help"});
        }
        store.insert(&task, 2000.0).unwrap();
    }
    let rows = store
        .list(&TaskFilter {
            repo: Some("repo-a"),
            executor: Some("codex"),
            visible_states: Some(&["needs_input"]),
            created_since: Some(900.0),
            before: Some("t-20261101-000000-03df"),
            limit: Some(2),
            ..TaskFilter::default()
        })
        .unwrap();
    assert_eq!(
        rows.iter()
            .map(|t| t["createdAt"].as_f64().unwrap())
            .collect::<Vec<_>>(),
        vec![985.0, 965.0]
    );
    // Creation time, not last update time: every row was updated at 2000.
    assert!(
        store
            .list(&TaskFilter {
                created_since: Some(1000.0),
                ..TaskFilter::default()
            })
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list(&TaskFilter {
                visible_states: Some(&[]),
                ..TaskFilter::default()
            })
            .unwrap()
            .is_empty()
    );
}

#[test]
fn history_executor_is_nullish_and_answered_questions_remain_running() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    for (n, extra) in [
        json!({"result":{"executor":"result"},"executor":"current"}),
        json!({"result":{"executor":null},"executor":"current"}),
        json!({"attempts":[{"executor":"attempt","startedAt":1,"endedAt":2}]}),
        json!({"result":{"executor":""}}),
        json!({"question":{"text":"help","answer":null}}),
        json!({"question":{"text":"help"}}),
    ]
    .iter()
    .enumerate()
    {
        let mut task = json!({"id":format!("t-20261101-000000-{n:04x}"),"rev":1,"state":"running",
            "createdAt":1,"brief":{"repo":"/repo"},"attempts":[],"requestedExecutor":"requested"});
        task.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        store.insert(&task, 1.0).unwrap();
    }
    for (executor, expected) in [
        ("result", 1),
        ("current", 1),
        ("attempt", 1),
        ("", 1),
        ("requested", 2),
    ] {
        assert_eq!(
            store
                .list(&TaskFilter {
                    executor: Some(executor),
                    ..TaskFilter::default()
                })
                .unwrap()
                .len(),
            expected
        );
    }
    assert_eq!(
        store
            .list(&TaskFilter {
                visible_states: Some(&["running"]),
                ..TaskFilter::default()
            })
            .unwrap()
            .len(),
        5
    );
    assert_eq!(
        store
            .list(&TaskFilter {
                visible_states: Some(&["needs_input"]),
                ..TaskFilter::default()
            })
            .unwrap()
            .len(),
        1
    );
    store
        .connection()
        .unwrap()
        .execute("DROP INDEX tasks_repo", [])
        .unwrap();
    drop(store);
    let mut store = TaskStore::open(dir.path()).unwrap();
    let count: i64 = store
        .connection()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='tasks_repo'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}
