//! Cross-runtime parity tests for the SQLite task store.
//! These tests verify that the Rust implementation produces identical results
//! to the TypeScript implementation.
use crate::lock::{with_task_lock, with_task_lock_async, TaskLockOptions};
use crate::task::{CreateTaskInput, TaskStore, TaskStoreError};
use crate::types::{Brief, InteractionMode, TaskFilter, TaskRecord, TaskState};
use pacer_foundation::Ctx;
use std::mem;
use std::time::Duration;
use tempfile::tempdir;
use tokio::task;

fn test_ctx() -> Ctx {
    let dir = tempdir().unwrap();
    let path = dir.path().to_path_buf();
    mem::forget(dir); // Leak the TempDir to keep the directory alive
    Ctx::with(
        path.clone(),
        path,
        Default::default(),
        1000.0,
    )
}

fn sample_input() -> CreateTaskInput {
    CreateTaskInput {
        brief: Brief {
            goal: "test goal".into(),
            repo: "/tmp/repo".into(),
            scope: Some("test scope".into()),
            acceptance: Some("test acceptance".into()),
            constraints: None,
            context: None,
            feedback: None,
            qa: None,
            base: None,
            worktree_base: None,
        },
        kind: Some("feature".into()),
        requested_executor: Some("claude".into()),
        timeout_s: 1800,
        title: Some("Test Task".into()),
        source: Some("planner".into()),
        request_id: Some("req-123".into()),
        repo: None,
        client: None,
        placement: None,
        base_branch: None,
        base_sha: None,
        interaction_mode: Some(InteractionMode::Delegated),
        conversation: None,
        session_draft_id: None,
    }
}

#[test]
fn test_task_creation_parity() {
    let ctx = test_ctx();
    let mut store = TaskStore::open(ctx.clone()).unwrap();

    let input = sample_input();
    let task = store.create_task(input.clone(), None).unwrap();

    // Verify task ID format
    assert!(task.id.starts_with("t-"));
    assert_eq!(task.rev, 1);
    assert_eq!(task.state, "queued");
    assert_eq!(task.title, Some("Test Task".into()));
    assert_eq!(task.kind, Some("feature".into()));
    assert_eq!(task.requested_executor, Some("claude".into()));
    assert_eq!(task.timeout_s, 1800);
    assert_eq!(task.brief.goal, "test goal");
    assert_eq!(task.brief.repo, "/tmp/repo");
    assert_eq!(task.source, Some("planner".into()));
    assert_eq!(task.request_id, Some("req-123".into()));
    assert_eq!(task.interaction_mode, Some(InteractionMode::Delegated));
}

#[test]
fn test_task_update_parity() {
    let ctx = test_ctx();
    let mut store = TaskStore::open(ctx.clone()).unwrap();

    let input = sample_input();
    let task = store.create_task(input, None).unwrap();

    // Update task state to running
    let updated = store.update_task(&task.id, |t| {
        t.state = "running".into();
        t.executor = Some("claude".into());
        t.attempt_started_at = Some(2000);
    }).unwrap();

    assert_eq!(updated.state, "running");
    assert_eq!(updated.rev, 2);
    assert_eq!(updated.executor, Some("claude".into()));
    assert_eq!(updated.attempt_started_at, Some(2000));
    assert!(updated.settled_at.is_none());

    // Update to terminal state
    let updated = store.update_task(&task.id, |t| {
        t.state = "done".into();
        t.result = Some(crate::types::TaskResult {
            status: "done".into(),
            executor: Some("claude".into()),
            model: Some("claude-3".into()),
            report: "completed".into(),
            backend: "direct".into(),
            worktree: None,
            broken_executor: None,
            broken_reason: None,
            check: None,
            verification: crate::types::Verification {
                files: "".into(),
                acceptance: None,
            },
        });
    }).unwrap();

    assert_eq!(updated.state, "done");
    assert_eq!(updated.rev, 3);
    assert!(updated.settled_at.is_some());
    assert!(updated.result.is_some());
}

#[test]
fn test_task_list_filters_parity() {
    let ctx = test_ctx();
    let mut store = TaskStore::open(ctx.clone()).unwrap();

    let input = sample_input();
    let t1 = store.create_task(input.clone(), None).unwrap();
    let t2 = store.create_task(input.clone(), None).unwrap();
    let t3 = store.create_task(input, None).unwrap();

    store.update_task(&t1.id, |t| t.state = "running".into()).unwrap();
    store.update_task(&t2.id, |t| t.state = "done".into()).unwrap();
    // t3 remains "queued"

    // Filter by state
    let running = store.list_tasks(TaskFilter {
        states: Some(vec!["running".into()]),
        ..Default::default()
    }).unwrap();
    assert_eq!(running.len(), 1);
    assert_eq!(running[0].id, t1.id);

    let terminal = store.list_tasks(TaskFilter {
        states: Some(vec!["done".into(), "failed".into()]),
        ..Default::default()
    }).unwrap();
    assert_eq!(terminal.len(), 1);
    assert_eq!(terminal[0].id, t2.id);

    // Filter by updated_since
    let recent = store.list_tasks(TaskFilter {
        updated_since: Some(1500),
        ..Default::default()
    }).unwrap();
    assert_eq!(recent.len(), 2); // t1 and t2 updated

    // Limit
    let limited = store.list_tasks(TaskFilter {
        limit: Some(1),
        ..Default::default()
    }).unwrap();
    assert_eq!(limited.len(), 1);

    // Newest first ordering
    let all = store.list_tasks(TaskFilter::default()).unwrap();
    assert_eq!(all.len(), 3);
    assert_eq!(all[0].id, t3.id); // newest first
    assert_eq!(all[1].id, t2.id);
    assert_eq!(all[2].id, t1.id);
}

#[test]
fn test_task_lock_parity() {
    let ctx = test_ctx();
    let mut store = TaskStore::open(ctx.clone()).unwrap();

    let input = sample_input();
    let task = store.create_task(input, None).unwrap();

    // Test synchronous lock
    let result = with_task_lock(&ctx, &task.id, || {
        let mut store2 = TaskStore::open(ctx.clone()).unwrap();
        store2.update_task(&task.id, |t| t.title = Some("locked update".into())).unwrap()
    }).unwrap();

    assert_eq!(result.title, Some("locked update".into()));

    // Test async lock
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let ctx = ctx.clone();
        let task_id = task.id.clone();
        let result = with_task_lock_async(&ctx.clone(), &task_id.clone(), move || {
            let ctx = ctx.clone();
            let task_id = task_id.clone();
            async move {
                let mut store2 = TaskStore::open(ctx).unwrap();
                store2.update_task(&task_id, |t| t.title = Some("async locked update".into())).unwrap()
            }
        }).await.unwrap();
        assert_eq!(result.title, Some("async locked update".into()));
    });
}

#[test]
fn test_concurrent_writers_parity() {
    let ctx = test_ctx();
    let mut store = TaskStore::open(ctx.clone()).unwrap();

    let input = sample_input();
    let task = store.create_task(input, None).unwrap();

    // Spawn multiple writer threads
    let handles: Vec<_> = (0..4).map(|_i| {
        let ctx = ctx.clone();
        let task_id = task.id.clone();
        std::thread::spawn(move || {
            let mut store = TaskStore::open(ctx.clone()).unwrap();
            for _j in 0..25 {
                with_task_lock(&ctx, &task_id, || {
                    store.update_task(&task_id, |t| {
                        let n = t.title.as_ref().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
                        t.title = Some((n + 1).to_string());
                    }).unwrap()
                }).unwrap();
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    }).collect();

    for h in handles {
        h.join().unwrap();
    }

    // All 100 updates should be applied
    let final_task = store.read_task(&task.id).unwrap().unwrap();
    assert_eq!(final_task.title, Some("100".into()));
    assert_eq!(final_task.rev, 101); // 1 initial + 100 updates
}

#[test]
fn test_version_token_parity() {
    let ctx = test_ctx();
    let mut store = TaskStore::open(ctx.clone()).unwrap();

    let v1 = store.version().unwrap();

    let input = sample_input();
    let task = store.create_task(input, None).unwrap();
    let v2 = store.version().unwrap();
    assert_ne!(v1, v2);

    store.update_task(&task.id, |t| t.title = Some("x".into())).unwrap();
    let v3 = store.version().unwrap();
    assert_ne!(v2, v3);

    // Reading should not change version
    let _ = store.read_task(&task.id).unwrap();
    let v4 = store.version().unwrap();
    assert_eq!(v3, v4);
}

#[test]
fn test_dismiss_task_parity() {
    let ctx = test_ctx();
    let mut store = TaskStore::open(ctx.clone()).unwrap();

    let input = sample_input();
    let task = store.create_task(input, None).unwrap();

    let dismissed = store.dismiss_task(&task.id).unwrap().unwrap();
    assert_eq!(dismissed.dismissed, Some(true));
    assert_eq!(dismissed.rev, 2);

    // Dismiss non-existent
    let not_found = store.dismiss_task("t-invalid").unwrap();
    assert!(not_found.is_none());
}

#[test]
fn test_archived_filter_parity() {
    let ctx = test_ctx();
    let mut store = TaskStore::open(ctx.clone()).unwrap();

    let input = sample_input();
    let t1 = store.create_task(input.clone(), None).unwrap();
    let t2 = store.create_task(input.clone(), None).unwrap();
    store.update_task(&t1.id, |t| {
        t.state = "done".into();
        t.archived = Some(true);
    }).unwrap();

    // Default list should exclude archived
    let active = store.list_tasks(TaskFilter::default()).unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].id, t2.id);

    // With all=true should include archived
    let all = store.list_tasks(TaskFilter { all: Some(true), ..Default::default() }).unwrap();
    assert_eq!(all.len(), 2);
}

#[test]
fn test_settled_before_filter_parity() {
    let ctx = test_ctx();
    let mut store = TaskStore::open(ctx.clone()).unwrap();

    let input = sample_input();
    let t1 = store.create_task(input.clone(), None).unwrap();
    store.update_task(&t1.id, |t| {
        t.state = "done".into();
        t.settled_at = Some(500);
    }).unwrap();

    let t2 = store.create_task(input, None).unwrap();
    store.update_task(&t2.id, |t| {
        t.state = "done".into();
        t.settled_at = Some(2000);
    }).unwrap();

    let old = store.list_tasks(TaskFilter {
        settled_before: Some(1000),
        all: Some(true),
        ..Default::default()
    }).unwrap();
    assert_eq!(old.len(), 1);
    assert_eq!(old[0].id, t1.id);
}

#[test]
fn test_before_filter_parity() {
    let ctx = test_ctx();
    let mut store = TaskStore::open(ctx.clone()).unwrap();

    let input = sample_input();
    let t1 = store.create_task(input.clone(), None).unwrap();
    let t2 = store.create_task(input.clone(), None).unwrap();
    let t3 = store.create_task(input, None).unwrap();

    // IDs are ordered newest first, so t3 > t2 > t1
    let before_t2 = store.list_tasks(TaskFilter {
        before: Some(t2.id.clone()),
        ..Default::default()
    }).unwrap();
    assert_eq!(before_t2.len(), 1);
    assert_eq!(before_t2[0].id, t1.id);
}

#[test]
fn test_compatibility_json_write_through() {
    let ctx = test_ctx();
    let mut store = TaskStore::open(ctx.clone()).unwrap();

    let input = sample_input();
    let task = store.create_task(input, None).unwrap();

    // Check JSON file was created
    let json_path = ctx.pacer_home.join("tasks").join(format!("{}.json", task.id));
    assert!(json_path.exists());

    let json_content = std::fs::read_to_string(&json_path).unwrap();
    let json_task: TaskRecord = serde_json::from_str(&json_content).unwrap();
    assert_eq!(json_task.id, task.id);
    assert_eq!(json_task.title, task.title);

    // Update and check JSON updated
    store.update_task(&task.id, |t| t.title = Some("updated".into())).unwrap();
    let json_content2 = std::fs::read_to_string(&json_path).unwrap();
    let json_task2: TaskRecord = serde_json::from_str(&json_content2).unwrap();
    assert_eq!(json_task2.title, Some("updated".into()));
    assert_eq!(json_task2.rev, 2);
}

#[test]
fn test_import_legacy_json() {
    let ctx = test_ctx();
    let tasks_dir = ctx.pacer_home.join("tasks");
    std::fs::create_dir_all(&tasks_dir).unwrap();

    // Write a legacy JSON task file
    let legacy_task = TaskRecord {
        id: "t-20261019-120000-abcd".into(),
        rev: 1,
        created_at: 1000,
        state: "queued".into(),
        attempts: vec![],
        brief: Brief {
            goal: "legacy".into(),
            repo: "/tmp/repo".into(),
            ..Default::default()
        },
        kind: None,
        requested_executor: None,
        timeout_s: 60,
        title: Some("legacy".into()),
        ..Default::default()
    };

    std::fs::write(
        tasks_dir.join("t-20261019-120000-abcd.json"),
        serde_json::to_string(&legacy_task).unwrap()
    ).unwrap();

    // Open store - should import
    let mut store = TaskStore::open(ctx.clone()).unwrap();
    let imported = store.read_task("t-20261019-120000-abcd").unwrap().unwrap();

    assert_eq!(imported.id, "t-20261019-120000-abcd");
    assert_eq!(imported.title, Some("legacy".into()));
    assert_eq!(imported.brief.goal, "legacy");

    // Original JSON should remain untouched
    assert!(tasks_dir.join("t-20261019-120000-abcd.json").exists());
}

#[test]
fn test_import_idempotent() {
    let ctx = test_ctx();
    let tasks_dir = ctx.pacer_home.join("tasks");
    std::fs::create_dir_all(&tasks_dir).unwrap();

    let legacy_task = TaskRecord {
        id: "t-20261019-120000-abcd".into(),
        rev: 1,
        created_at: 1000,
        state: "queued".into(),
        attempts: vec![],
        brief: Brief {
            goal: "legacy".into(),
            repo: "/tmp/repo".into(),
            ..Default::default()
        },
        kind: None,
        requested_executor: None,
        timeout_s: 60,
        title: Some("legacy".into()),
        ..Default::default()
    };

    std::fs::write(
        tasks_dir.join("t-20261019-120000-abcd.json"),
        serde_json::to_string(&legacy_task).unwrap()
    ).unwrap();

    // Open store multiple times
    for _ in 0..3 {
        let mut store = TaskStore::open(ctx.clone()).unwrap();
        let imported = store.read_task("t-20261019-120000-abcd").unwrap().unwrap();
        assert_eq!(imported.rev, 1);
    }

    // JSON file should still exist
    assert!(tasks_dir.join("t-20261019-120000-abcd.json").exists());
}

#[test]
fn test_legacy_json_newer_mtime_wins() {
    let ctx = test_ctx();
    let tasks_dir = ctx.pacer_home.join("tasks");
    std::fs::create_dir_all(&tasks_dir).unwrap();

    let legacy_task = TaskRecord {
        id: "t-20261019-120000-abcd".into(),
        rev: 1,
        created_at: 1000,
        state: "queued".into(),
        attempts: vec![],
        brief: Brief {
            goal: "legacy".into(),
            repo: "/tmp/repo".into(),
            ..Default::default()
        },
        kind: None,
        requested_executor: None,
        timeout_s: 60,
        title: Some("legacy".into()),
        ..Default::default()
    };

    std::fs::write(
        tasks_dir.join("t-20261019-120000-abcd.json"),
        serde_json::to_string(&legacy_task).unwrap()
    ).unwrap();

    let mut store = TaskStore::open(ctx.clone()).unwrap();
    store.update_task("t-20261019-120000-abcd", |t| t.title = Some("sqlite".into())).unwrap();

    // Now write a newer JSON with older revision but newer mtime
    let mut legacy_task2 = legacy_task.clone();
    legacy_task2.title = Some("json newer mtime".into());
    legacy_task2.rev = 1; // Same revision
    std::thread::sleep(Duration::from_millis(10));
    std::fs::write(
        tasks_dir.join("t-20261019-120000-abcd.json"),
        serde_json::to_string(&legacy_task2).unwrap()
    ).unwrap();

    // Re-open store - should import the newer mtime
    let mut store2 = TaskStore::open(ctx.clone()).unwrap();
    let imported = store2.read_task("t-20261019-120000-abcd").unwrap().unwrap();
    assert_eq!(imported.title, Some("json newer mtime".into()));
    assert_eq!(imported.rev, 1); // Same revision, newer mtime wins
}

#[test]
fn test_legacy_json_older_rev_loses() {
    let ctx = test_ctx();
    let tasks_dir = ctx.pacer_home.join("tasks");
    std::fs::create_dir_all(&tasks_dir).unwrap();

    let legacy_task = TaskRecord {
        id: "t-20261019-120000-abcd".into(),
        rev: 1,
        created_at: 1000,
        state: "queued".into(),
        attempts: vec![],
        brief: Brief {
            goal: "legacy".into(),
            repo: "/tmp/repo".into(),
            ..Default::default()
        },
        kind: None,
        requested_executor: None,
        timeout_s: 60,
        title: Some("legacy".into()),
        ..Default::default()
    };

    std::fs::write(
        tasks_dir.join("t-20261019-120000-abcd.json"),
        serde_json::to_string(&legacy_task).unwrap()
    ).unwrap();

    let mut store = TaskStore::open(ctx.clone()).unwrap();
    store.update_task("t-20261019-120000-abcd", |t| {
        t.title = Some("sqlite rev 2".into());
        t.state = "done".into();
    }).unwrap();

    // Now write a JSON with older revision
    let mut legacy_task2 = legacy_task.clone();
    legacy_task2.title = Some("older rev".into());
    legacy_task2.rev = 1;
    std::thread::sleep(Duration::from_millis(10));
    std::fs::write(
        tasks_dir.join("t-20261019-120000-abcd.json"),
        serde_json::to_string(&legacy_task2).unwrap()
    ).unwrap();

    // Re-open store - should NOT import older revision
    let mut store2 = TaskStore::open(ctx.clone()).unwrap();
    let imported = store2.read_task("t-20261019-120000-abcd").unwrap().unwrap();
    assert_eq!(imported.title, Some("sqlite rev 2".into()));
    assert_eq!(imported.rev, 2);
}

#[test]
fn test_rollback_on_panic() {
    let ctx = test_ctx();
    let mut store = TaskStore::open(ctx.clone()).unwrap();

    let input = sample_input();
    let task = store.create_task(input, None).unwrap();

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        store.update_task(&task.id, |t| {
            t.title = Some("will rollback".into());
            panic!("intentional panic");
        })
    }));

    assert!(result.is_err());

    // Task should be unchanged
    let task = store.read_task(&task.id).unwrap().unwrap();
    assert_ne!(task.title, Some("will rollback".into()));
}