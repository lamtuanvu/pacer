#![allow(clippy::unwrap_used)]
use pacer_store::{StoreError, TaskFilter, TaskStore, is_task_id, retention_eligible};
use serde_json::{Value, json};
use std::{fs, time::Duration};

const ID: &str = "t-20261101-184223-ea3b";
fn task() -> Value {
    json!({"id":ID,"rev":1,"state":"queued","createdAt":1000.0,"brief":{"repo":"/tmp/repo"},"attempts":[],"futureField":{"nested":[1,2]}})
}

#[test]
fn schema_write_read_filters_and_cas() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(dir.path().join("state/tasks.db"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(dir.path().join("state"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(dir.path().join("tasks"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    assert!(is_task_id(ID));
    assert!(!is_task_id("t-20261101-184223-ea3g"));
    let schema: i64 = store.connection().unwrap().query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('tasks','task_first_settle','tasks_state','tasks_updated_at','tasks_created_at','tasks_retention')", [], |r| r.get(0)).unwrap();
    assert_eq!(schema, 6);
    store.insert(&task(), 1000.0).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for suffix in ["-wal", "-shm"] {
            let path = dir.path().join(format!("state/tasks.db{suffix}"));
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    assert_eq!(store.list_active_and_recent(2000.0).unwrap().len(), 1);
    assert!(store.list_live().unwrap().is_empty());
    assert_eq!(
        store.insert(&task(), 1000.0).unwrap_err().to_string(),
        "task id collision"
    );
    assert_eq!(
        store.read(ID).unwrap().unwrap()["futureField"],
        task()["futureField"]
    );
    assert_eq!(
        store
            .list(&TaskFilter {
                states: Some(&["queued"]),
                ..Default::default()
            })
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .list(&TaskFilter {
                states: Some(&[]),
                ..Default::default()
            })
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list(&TaskFilter {
                before: Some(ID),
                ..Default::default()
            })
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list(&TaskFilter {
                updated_since: Some(2000.0),
                ..Default::default()
            })
            .unwrap()
            .is_empty()
    );
    let version = store.version().unwrap();
    let changed = store
        .update(ID, 1, 2000.0, |v| {
            v["state"] = json!("done");
            v["review"] = json!({"at":2001.0});
            v["live"] = json!({"pid":42});
        })
        .unwrap();
    assert_eq!(store.list_live().unwrap().len(), 1);
    assert_eq!(changed["rev"], 2);
    assert_eq!(changed["settledAt"], 2000.0);
    assert_eq!(
        store.read(ID).unwrap().unwrap()["futureField"],
        task()["futureField"]
    );
    assert_ne!(store.version().unwrap(), version);
    assert!(matches!(
        store.update(ID, 1, 2002.0, |_| {}),
        Err(StoreError::Conflict)
    ));
    let first: f64 = store
        .connection()
        .unwrap()
        .query_row(
            "SELECT at FROM task_first_settle WHERE task_id=?",
            [ID],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(first, 2000.0);
    let reopened = store
        .update(ID, 2, 2003.0, |v| v["state"] = json!("running"))
        .unwrap();
    assert!(reopened.get("settledAt").is_none());
    let resettled = store
        .update(ID, 3, 2004.0, |v| v["state"] = json!("failed"))
        .unwrap();
    assert_eq!(resettled["settledAt"], 2004.0);
    let first: f64 = store
        .connection()
        .unwrap()
        .query_row(
            "SELECT at FROM task_first_settle WHERE task_id=?",
            [ID],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(first, 2000.0);
    assert_eq!(
        store
            .list(&TaskFilter {
                states: Some(&["failed"]),
                settled_before: Some(2005.0),
                limit: Some(1),
                ..Default::default()
            })
            .unwrap()
            .len(),
        1
    );
    let json: Value =
        serde_json::from_slice(&fs::read(dir.path().join(format!("tasks/{ID}.json"))).unwrap())
            .unwrap();
    assert_eq!(json, resettled);
}

#[test]
fn json_import_revision_and_external_invalidation() {
    let dir = tempfile::tempdir().unwrap();
    let mut first = TaskStore::open(dir.path()).unwrap();
    first.insert(&task(), 1000.0).unwrap();
    let version = first.version().unwrap();
    let mut second = TaskStore::open(dir.path()).unwrap();
    second
        .update(ID, 1, 1010.0, |v| v["unknown"] = json!("kept"))
        .unwrap();
    assert_ne!(first.version().unwrap(), version);
    assert_eq!(first.read(ID).unwrap().unwrap()["unknown"], "kept");
    std::thread::sleep(Duration::from_millis(2));
    let mut older = task();
    older["rev"] = json!(1);
    older["unknown"] = json!("stale");
    fs::write(
        dir.path().join("tasks/stale.tmp"),
        serde_json::to_vec(&older).unwrap(),
    )
    .unwrap();
    fs::rename(
        dir.path().join("tasks/stale.tmp"),
        dir.path().join(format!("tasks/{ID}.json")),
    )
    .unwrap();
    assert_eq!(first.read(ID).unwrap().unwrap()["unknown"], "kept");
    std::thread::sleep(Duration::from_millis(2));
    let mut newer = task();
    newer["rev"] = json!(3);
    newer["unknown"] = json!("imported");
    fs::write(
        dir.path().join("tasks/newer.tmp"),
        serde_json::to_vec(&newer).unwrap(),
    )
    .unwrap();
    fs::rename(
        dir.path().join("tasks/newer.tmp"),
        dir.path().join(format!("tasks/{ID}.json")),
    )
    .unwrap();
    assert_eq!(first.read(ID).unwrap().unwrap()["unknown"], "imported");
    fs::write(dir.path().join("tasks/t-20261101-184224-ea3b.json"), b"{").unwrap();
    assert_eq!(first.list(&TaskFilter::default()).unwrap().len(), 1);
}

#[test]
fn retention_predicate_matches_terminal_review_remote_and_paths() {
    let mut t = task();
    t["state"] = json!("done");
    t["settledAt"] = json!(1100.0);
    t["review"] = json!({"at":1100.0});
    assert!(retention_eligible(&t, 1, 100_000.0));
    for review in [json!(false), json!(null), json!(0), json!("")] {
        t["review"] = review;
        assert!(!retention_eligible(&t, 1, 100_000.0));
    }
    t["review"] = json!({"at":1100.0});
    assert!(!retention_eligible(&t, 0, 100_000.0));
    t["run"] = json!({"remoteWorktree":"/remote/worktree"});
    assert!(!retention_eligible(&t, 1, 100_000.0));
    t["run"] = json!({"mode":"new","workdir":"/"});
    assert!(!retention_eligible(&t, 1, 100_000.0));
}

#[test]
fn retention_rejects_days_above_typescript_safe_integer_limit() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    assert!(matches!(
        store.prune(9_007_199_254_740_992, true, 100_000.0),
        Err(StoreError::InvalidRecord)
    ));
}

#[test]
fn old_schema_migrates_and_replaced_database_reopens() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("state")).unwrap();
    let old = rusqlite::Connection::open(dir.path().join("state/tasks.db")).unwrap();
    old.execute_batch("CREATE TABLE tasks(id TEXT PRIMARY KEY, rev INTEGER, state TEXT, created_at REAL, updated_at REAL, settled_at REAL, repo TEXT, record TEXT NOT NULL)").unwrap();
    drop(old);
    let mut store = TaskStore::open(dir.path()).unwrap();
    store.insert(&task(), 1000.0).unwrap();
    let first = store.version().unwrap();
    let other = tempfile::tempdir().unwrap();
    let mut replacement = TaskStore::open(other.path()).unwrap();
    replacement.insert(&task(), 1000.0).unwrap();
    drop(replacement);
    fs::rename(dir.path().join("state"), dir.path().join("old-state")).unwrap();
    fs::rename(other.path().join("state"), dir.path().join("state")).unwrap();
    assert_eq!(store.read(ID).unwrap().unwrap()["rev"], 1);
    assert_ne!(store.version().unwrap(), first);
}

#[test]
fn import_rejects_each_invalid_record_branch_and_defaults_missing_revision() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let variants: Vec<Value> = vec![
        json!({"id":"wrong"}),
        {
            let mut v = task();
            v["createdAt"] = json!("bad");
            v
        },
        {
            let mut v = task();
            v["attempts"] = json!(null);
            v
        },
        {
            let mut v = task();
            v["attempts"] = json!([{"startedAt":"bad","endedAt":2}]);
            v
        },
        {
            let mut v = task();
            v["attempts"] = json!([{"startedAt":1,"endedAt":"bad"}]);
            v
        },
        {
            let mut v = task();
            v["state"] = json!("unknown");
            v
        },
        {
            let mut v = task();
            v["brief"]["repo"] = json!(null);
            v
        },
        {
            let mut v = task();
            v["rev"] = json!(0);
            v
        },
        {
            let mut v = task();
            v["rev"] = json!(1.5);
            v
        },
    ];
    for (index, mut value) in variants.into_iter().enumerate() {
        let id = format!("t-20261101-184223-{:04x}", index + 1);
        if index != 0 {
            value["id"] = json!(id);
        }
        let temp = dir.path().join(format!("tasks/{id}.tmp"));
        fs::write(&temp, serde_json::to_vec(&value).unwrap()).unwrap();
        fs::rename(temp, dir.path().join(format!("tasks/{id}.json"))).unwrap();
        assert!(
            store.read(&id).unwrap().is_none(),
            "invalid variant {index}"
        );
    }
    let id = "t-20261101-184223-000a";
    let mut valid = task();
    valid["id"] = json!(id);
    valid.as_object_mut().unwrap().remove("rev");
    let temp = dir.path().join("tasks/default.tmp");
    fs::write(&temp, serde_json::to_vec(&valid).unwrap()).unwrap();
    fs::rename(temp, dir.path().join(format!("tasks/{id}.json"))).unwrap();
    assert_eq!(store.read(id).unwrap().unwrap()["rev"], 1);
}

#[test]
fn archive_restore_round_trip_collision_and_private_modes() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let mut settled = task();
    settled["state"] = json!("done");
    settled["settledAt"] = json!(1100.0);
    settled["review"] = json!({"at":1100.0});
    store.insert(&settled, 1100.0).unwrap();
    let log = dir.path().join(format!("tasks/{ID}.log"));
    let note = dir.path().join(format!("tasks/{ID}.md"));
    fs::write(&log, b"log text\nlog text\n").unwrap();
    fs::write(&note, b"notes").unwrap();

    let dry = store.prune(1, true, 100_000.0).unwrap();
    assert_eq!(dry.tasks.len(), 1);
    assert!(log.exists());
    assert_eq!(store.read(ID).unwrap().unwrap()["rev"], 1);

    let result = store.prune(1, false, 100_000.0).unwrap();
    assert_eq!(result.tasks.len(), 1);
    let archive = &result.tasks[0].archive_path;
    assert!(!log.exists());
    assert!(!note.exists());
    assert!(archive.join(format!("{ID}.log.gz")).exists());
    assert_eq!(store.read(ID).unwrap().unwrap()["archived"], true);
    assert!(store.list(&TaskFilter::default()).unwrap().is_empty());
    assert_eq!(
        store
            .list(&TaskFilter {
                all: true,
                ..Default::default()
            })
            .unwrap()
            .len(),
        1
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [
            archive.clone(),
            archive.join(format!("{ID}.log.gz")),
            archive.join(format!("{ID}.md")),
            archive.join(format!("{ID}.json")),
        ] {
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode,
                if path.is_dir() { 0o700 } else { 0o600 },
                "{}",
                path.display()
            );
        }
    }

    fs::write(&note, b"collision").unwrap();
    assert!(matches!(
        store.restore(ID, 100_001.0),
        Err(StoreError::Conflict)
    ));
    assert_eq!(fs::read(&note).unwrap(), b"collision");
    assert!(archive.join(format!("{ID}.log.gz")).exists());
    fs::remove_file(&note).unwrap();
    fs::write(archive.join("unrelated"), b"keep").unwrap();
    let restored = store.restore(ID, 100_002.0).unwrap();
    assert_eq!(restored["rev"], 3);
    assert!(restored.get("archived").is_none());
    assert_eq!(fs::read(&log).unwrap(), b"log text\nlog text\n");
    assert_eq!(fs::read(&note).unwrap(), b"notes");
    assert_eq!(fs::read(archive.join("unrelated")).unwrap(), b"keep");
    assert_eq!(store.restore(ID, 100_003.0).unwrap()["rev"], 3);
}

#[test]
fn retention_keeps_live_worktree_and_rejects_archive_collision() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let mut settled = task();
    settled["state"] = json!("done");
    settled["settledAt"] = json!(1100.0);
    settled["dismissed"] = json!(true);
    settled["worktree"] = json!(dir.path().to_str().unwrap());
    store.insert(&settled, 1100.0).unwrap();
    assert!(store.prune(1, false, 100_000.0).unwrap().tasks.is_empty());
    store
        .update(ID, 1, 2000.0, |v| {
            v.as_object_mut().unwrap().remove("worktree");
        })
        .unwrap();
    let archive = dir.path().join(format!("archive/1970-01/{ID}"));
    fs::create_dir_all(&archive).unwrap();
    assert!(matches!(
        store.prune(1, false, 100_000.0),
        Err(StoreError::Conflict)
    ));
    assert!(dir.path().join(format!("tasks/{ID}.json")).exists());
    assert_eq!(store.read(ID).unwrap().unwrap()["archived"], Value::Null);
}

#[test]
fn failed_sql_commit_after_archive_rename_keeps_both_copies() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let mut settled = task();
    settled["state"] = json!("done");
    settled["settledAt"] = json!(1100.0);
    settled["dismissed"] = json!(true);
    store.insert(&settled, 1100.0).unwrap();
    let log = dir.path().join(format!("tasks/{ID}.log"));
    fs::write(&log, b"survives failure").unwrap();
    store.connection().unwrap().execute_batch("CREATE TRIGGER block_archive BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'injected failure'); END;").unwrap();
    assert!(matches!(
        store.prune(1, false, 100_000.0),
        Err(StoreError::Sql(_))
    ));
    let archive = dir.path().join(format!("archive/1970-01/{ID}"));
    assert_eq!(fs::read(&log).unwrap(), b"survives failure");
    assert!(archive.join(format!("{ID}.log.gz")).exists());
    assert_eq!(store.read(ID).unwrap().unwrap()["archived"], Value::Null);
}

#[test]
fn retention_lock_contention_is_a_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    fs::create_dir_all(dir.path().join("orca")).unwrap();
    fs::write(dir.path().join("orca/task-retention.lock"), b"").unwrap();
    assert!(matches!(
        store.prune(1, false, 100_000.0),
        Err(StoreError::Conflict)
    ));
    assert!(matches!(
        store.restore(ID, 100_000.0),
        Err(StoreError::Conflict)
    ));
}

#[test]
fn failed_sql_commit_during_restore_keeps_archive_and_restored_files() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let mut settled = task();
    settled["state"] = json!("done");
    settled["settledAt"] = json!(1100.0);
    settled["dismissed"] = json!(true);
    store.insert(&settled, 1100.0).unwrap();
    let log = dir.path().join(format!("tasks/{ID}.log"));
    fs::write(&log, b"restore failure data").unwrap();
    let result = store.prune(1, false, 100_000.0).unwrap();
    let archive = &result.tasks[0].archive_path;
    store.connection().unwrap().execute_batch("CREATE TRIGGER block_restore BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'injected failure'); END;").unwrap();
    assert!(matches!(
        store.restore(ID, 100_001.0),
        Err(StoreError::Sql(_))
    ));
    assert_eq!(fs::read(&log).unwrap(), b"restore failure data");
    assert!(archive.join(format!("{ID}.log.gz")).exists());
    let raw = rusqlite::Connection::open(dir.path().join("state/tasks.db")).unwrap();
    let record: String = raw
        .query_row("SELECT record FROM tasks WHERE id=?", [ID], |r| r.get(0))
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&record).unwrap()["archived"],
        true
    );
    raw.execute_batch("DROP TRIGGER block_restore").unwrap();
    assert!(store.read(ID).unwrap().unwrap().get("archived").is_none());
}

#[test]
fn retention_pages_past_twenty_five_and_rejects_negative_days() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    assert!(matches!(
        store.prune(-1, true, 100_000.0),
        Err(StoreError::InvalidRecord)
    ));
    assert!(store.prune(0, false, 100_000.0).unwrap().tasks.is_empty());
    for index in 0..27 {
        let mut settled = task();
        settled["id"] = json!(format!("t-20261101-184223-{index:04x}"));
        settled["state"] = json!("done");
        settled["settledAt"] = json!(1100.0);
        settled["dismissed"] = json!(true);
        store.insert(&settled, 1100.0).unwrap();
    }
    let dry = store.prune(1, true, 100_000.0).unwrap();
    assert_eq!(dry.tasks.len(), 27);
    assert_eq!(store.list(&TaskFilter::default()).unwrap().len(), 27);
}
