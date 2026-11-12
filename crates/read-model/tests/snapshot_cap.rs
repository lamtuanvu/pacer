#![allow(clippy::unwrap_used)]
use pacer_foundation::Ctx;
use pacer_read_model::{ActiveCounts, tasks::snapshot_tasks};
use pacer_store::TaskStore;
use serde_json::{Value, json};
use std::collections::HashMap;

fn alive(_: i64) -> bool {
    true
}

fn task(id: &str, state: &str, created: f64) -> Value {
    json!({
        "id": id,
        "rev": 1,
        "state": state,
        "createdAt": created,
        "title": id,
        "brief": {"goal": format!("goal for {id}"), "repo": "/tmp/repo"},
        "repo": {"key": "acme", "path": "/tmp/repo", "label": "acme"},
        "attempts": [],
        "kind": null,
        "requestedExecutor": "codex"
    })
}

/// The recent-window cap (200 rows, sorted by updatedAt) must never drop a task
/// that still awaits an answer, even when 205 newer tasks fill the window.
#[test]
fn snapshot_tasks_keeps_old_open_question_over_recent_cap() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_path_buf();
    let mut store = TaskStore::open(&home).unwrap();
    let now = 1_000_000.0;
    let open_at = now - 3.0 * 86400.0;
    let ctx = Ctx::with(home.clone(), home.clone(), HashMap::new(), now);

    // 205 newer settled tasks, all inside the 24h window.
    for i in 0..205 {
        let id = format!("t-20261112-000100-{:04x}", i);
        let t = task(&id, "done", now);
        store.insert(&t, now).unwrap();
    }

    // An old, still-unanswered question well outside the window.
    let open_id = "t-20261111-000000-abcd";
    let mut open = task(open_id, "needs_input", open_at);
    open["question"] = json!({"text":"Which?","at":open_at});
    store.insert(&open, now).unwrap();

    // The answered / retried / dismissed old needs_input must not resurface.
    let answered_id = "t-20261111-000000-ef01";
    let mut answered = task(answered_id, "needs_input", open_at);
    answered["question"] = json!({"text":"Which?","answer":"postgres","at":open_at});
    store.insert(&answered, now).unwrap();
    let retried_id = "t-20261111-000000-face";
    let mut retried = task(retried_id, "needs_input", open_at);
    retried["question"] = json!({"text":"Which?","at":open_at});
    retried["retriedBy"] = json!("t-20261111-000000-abcd");
    store.insert(&retried, now).unwrap();
    let dismissed_id = "t-20261111-000000-1ce5";
    let mut dismissed = task(dismissed_id, "needs_input", open_at);
    dismissed["question"] = json!({"text":"Which?","at":open_at});
    dismissed["dismissed"] = json!(true);
    store.insert(&dismissed, now).unwrap();

    let records = store.list_active_and_recent(now - 86400.0).unwrap();
    let rows =
        snapshot_tasks(&ctx, &ActiveCounts::default(), &records, &mut store, &alive).unwrap();
    let ids: Vec<_> = rows.iter().map(|t| t["id"].as_str().unwrap()).collect();

    // The old question survives the 200-row cap (in addition to the newest 200).
    assert!(ids.contains(&open_id), "{ids:?}");
    assert!(
        ids.len() > 200,
        "cap must not drop an awaiting question: {}",
        ids.len()
    );
    // Answered / retried / dismissed old needs_input tasks are not kept by state.
    assert!(!ids.contains(&answered_id), "{ids:?}");
    assert!(!ids.contains(&retried_id), "{ids:?}");
    assert!(!ids.contains(&dismissed_id), "{ids:?}");
}
