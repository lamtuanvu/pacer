#![allow(clippy::unwrap_used)]
use pacer_store::{StoreError, TaskFilter, TaskStore, is_task_id, retention_eligible};
use serde_json::{Value, json};
use std::{fs, thread, time::Duration, time::Instant};

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
fn list_active_and_recent_keeps_stale_needs_input() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let mut old = task();
    old["id"] = json!("t-20261101-000000-abcd");
    old["state"] = json!("needs_input");
    old["createdAt"] = json!(100.0);
    old["question"] = json!({"text":"Which?","answer":Value::Null,"at":100.0});
    store.insert(&old, 100.0).unwrap();
    // A purely done task far outside the recency window must not be selected.
    let mut settled = task();
    settled["id"] = json!("t-20261101-000000-ef01");
    settled["state"] = json!("done");
    settled["createdAt"] = json!(50.0);
    store.insert(&settled, 50.0).unwrap();
    // Well after 24h: the needs_input task is still selected, the done one is not.
    let rows = store.list_active_and_recent(1_000_000.0).unwrap();
    let ids: Vec<_> = rows.iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"t-20261101-000000-abcd"), "{ids:?}");
    assert!(!ids.contains(&"t-20261101-000000-ef01"), "{ids:?}");
}

#[test]
fn update_without_change_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    store.insert(&task(), 1000.0).unwrap();
    let json_path = dir.path().join(format!("tasks/{ID}.json"));
    let before_mtime = fs::metadata(&json_path).unwrap().modified().unwrap();
    let before_version = store.version().unwrap();
    let state = task()["state"].as_str().unwrap().to_owned();
    let returned = store
        .update(ID, 1, 2000.0, |v| v["state"] = json!(state.clone()))
        .unwrap();
    assert_eq!(returned["rev"], 1);
    let after = store.read(ID).unwrap().unwrap();
    assert_eq!(after["rev"], 1);
    assert_eq!(
        fs::metadata(&json_path).unwrap().modified().unwrap(),
        before_mtime
    );
    assert_eq!(store.version().unwrap(), before_version);

    // A real change still writes and bumps the revision as before.
    let changed = store
        .update(ID, 1, 2001.0, |v| v["state"] = json!("done"))
        .unwrap();
    assert_eq!(changed["rev"], 2);
}

#[test]
fn update_without_record_change_keeps_side_writes_and_runs_after() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    store.insert(&task(), 1000.0).unwrap();
    let mut after_ran = false;
    let returned = store
        .update_admitted_then(
            ID,
            1,
            2000.0,
            |db, _| {
                db.execute_batch("CREATE TABLE side(x INTEGER); INSERT INTO side VALUES (7);")?;
                Ok(())
            },
            |_, _| {
                after_ran = true;
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(returned["rev"], 1);
    assert!(after_ran);
    let db = rusqlite::Connection::open(dir.path().join("state/tasks.db")).unwrap();
    let x: i64 = db
        .query_row("SELECT x FROM side", [], |r| r.get(0))
        .unwrap();
    assert_eq!(x, 7);
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
    // Request paths no longer import JSON on every access (Task 5); an
    // explicit reconcile is required to observe another binary's JSON-only
    // write. The stale (lower) revision loses the SQL upsert's rev guard.
    assert_eq!(first.reconcile_json().unwrap(), 0);
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
    assert_eq!(first.reconcile_json().unwrap(), 1);
    assert_eq!(first.read(ID).unwrap().unwrap()["unknown"], "imported");
    fs::write(dir.path().join("tasks/t-20261101-184224-ea3b.json"), b"{").unwrap();
    first.reconcile_json().unwrap();
    assert_eq!(first.list(&TaskFilter::default()).unwrap().len(), 1);
}

#[test]
fn open_does_not_wait_for_a_writer_when_schema_is_ready() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_path_buf();
    // First open: creates the schema and runs the process's one import.
    TaskStore::open(&home).unwrap();
    let db_path = home.join("state/tasks.db");
    let writer = rusqlite::Connection::open(&db_path).unwrap();
    writer.busy_timeout(Duration::from_millis(5000)).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    let opened = {
        let home = home.clone();
        let start = Instant::now();
        let handle = thread::spawn(move || TaskStore::open(&home).map(|_| ()));
        let result = handle.join().unwrap();
        (result, start.elapsed())
    };
    writer.execute_batch("ROLLBACK").unwrap();
    let (result, elapsed) = opened;
    result.unwrap();
    assert!(
        elapsed < Duration::from_secs(1),
        "open took {elapsed:?} while a writer held an IMMEDIATE transaction"
    );
}

#[test]
fn opening_an_unrelated_home_is_not_blocked_by_a_busy_import() {
    // Seed home A elsewhere and copy its database and a newer JSON copy in,
    // so the open below is this process's first open of A: its import runs,
    // and the external writer makes it wait on SQLite's busy timeout.
    let seed = tempfile::tempdir().unwrap();
    let mut seed_store = TaskStore::open(seed.path()).unwrap();
    seed_store.insert(&task(), 1000.0).unwrap();
    drop(seed_store);
    let dir = tempfile::tempdir().unwrap();
    let home_a = dir.path().join("a");
    fs::create_dir_all(home_a.join("state")).unwrap();
    fs::create_dir_all(home_a.join("tasks")).unwrap();
    fs::copy(
        seed.path().join("state/tasks.db"),
        home_a.join("state/tasks.db"),
    )
    .unwrap();
    let mut newer = task();
    newer["rev"] = json!(5);
    fs::write(
        home_a.join(format!("tasks/{ID}.json")),
        serde_json::to_vec(&newer).unwrap(),
    )
    .unwrap();
    let mut blocker = rusqlite::Connection::open(home_a.join("state/tasks.db")).unwrap();
    blocker.busy_timeout(Duration::from_millis(5000)).unwrap();
    let hold = blocker
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    // First open of A in this process: its JSON import waits for the writer.
    let waiting = {
        let home = home_a.clone();
        thread::spawn(move || {
            TaskStore::open(&home)
                .map(|mut store| store.read(ID).unwrap().map(|task| task["rev"].clone()))
        })
    };
    // Let the import reach its transaction, then exercise an unrelated home:
    // open it and write to it, each of which touches the signature memory.
    // Holding the process-global mutex across the busy wait would stall both.
    thread::sleep(Duration::from_millis(300));
    let start = Instant::now();
    let mut other = TaskStore::open(dir.path().join("b")).unwrap();
    other.insert(&task(), 1000.0).unwrap();
    let elapsed = start.elapsed();
    // The unrelated home was never delayed by the waiting import.
    assert!(
        elapsed < Duration::from_secs(1),
        "open and write of an unrelated home took {elapsed:?} while another \
         import waited on a busy writer"
    );
    // The waiter completes normally once the writer releases.
    hold.rollback().unwrap();
    drop(blocker);
    let imported = waiting.join().unwrap().unwrap();
    assert_eq!(imported, Some(json!(5)));
}

#[test]
fn second_open_in_process_skips_import() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_path_buf();
    let mut first = TaskStore::open(&home).unwrap();
    first.insert(&task(), 1000.0).unwrap();
    // Write a newer revision straight to disk, bypassing TaskStore entirely
    // (stands in for an older binary writing JSON only).
    let mut newer = task();
    newer["rev"] = json!(5);
    newer["unknown"] = json!("second-open");
    let temp = home.join("tasks/second-open.tmp");
    fs::write(&temp, serde_json::to_vec(&newer).unwrap()).unwrap();
    // Capture the original file's timestamp before overwriting so it can be
    // restored on the replacement below.
    let original_mtime = fs::metadata(home.join(format!("tasks/{ID}.json")))
        .unwrap()
        .modified()
        .unwrap();
    fs::rename(&temp, home.join(format!("tasks/{ID}.json"))).unwrap();
    // A replacement written within the same clock tick keeps the replaced
    // file's coarse mtime (a few ms on Linux), so pin it exactly: only the
    // changed inode may reveal the rewrite.
    fs::File::options()
        .write(true)
        .open(home.join(format!("tasks/{ID}.json")))
        .unwrap()
        .set_modified(original_mtime)
        .unwrap();
    // A second open in this process, same (path, inode): no import runs, so
    // the stale SQL row (rev 1) is still what is read.
    let mut second = TaskStore::open(&home).unwrap();
    assert_eq!(second.read(ID).unwrap().unwrap()["rev"], 1);
    assert_eq!(second.reconcile_json().unwrap(), 1);
    assert_eq!(second.read(ID).unwrap().unwrap()["rev"], 5);
    assert_eq!(second.read(ID).unwrap().unwrap()["unknown"], "second-open");
}

#[test]
fn scan_over_unchanged_files_writes_nothing() {
    // A store whose SQL row, like TypeScript's, records only the copy's
    // json_mtime: from a fresh Rust process's point of view every file is an
    // unseen copy trusted through the json_mtime shortcut.
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_path_buf();
    {
        let mut first = TaskStore::open(&home).unwrap();
        first.insert(&task(), 1000.0).unwrap();
    }
    // Replace the database file (as a reset or restore would, new inode) so
    // the store below must rebuild its per-file memory from scratch.
    fs::copy(
        home.join("state/tasks.db"),
        home.join("state/replacement.tmp"),
    )
    .unwrap();
    fs::remove_file(home.join("state/tasks.db")).unwrap();
    for suffix in ["-wal", "-shm"] {
        let _ = fs::remove_file(home.join(format!("state/tasks.db{suffix}")));
    }
    fs::rename(
        home.join("state/replacement.tmp"),
        home.join("state/tasks.db"),
    )
    .unwrap();
    // A read-only onlooker distinguishes real SQLite writes from reads.
    let onlooker = rusqlite::Connection::open(home.join("state/tasks.db")).unwrap();
    let data_version_before: i64 = onlooker
        .query_row("PRAGMA data_version", [], |r| r.get(0))
        .unwrap();
    let mut store = TaskStore::open(&home).unwrap();
    // The first open's scan trusted every unseen copy whose mtime the row
    // records: it parsed no JSON and wrote no ALTER, no marker update, nothing.
    let writes_before: i64 = store
        .connection()
        .unwrap()
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap();
    assert_eq!(writes_before, 0);
    // An explicit full scan over the unchanged copies reconciles nothing and
    // still writes nothing.
    assert_eq!(store.reconcile_json().unwrap(), 0);
    let writes_after: i64 = store
        .connection()
        .unwrap()
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap();
    assert_eq!(writes_after, writes_before);
    let data_version_after: i64 = onlooker
        .query_row("PRAGMA data_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(data_version_after, data_version_before);
    assert_eq!(store.read(ID).unwrap().unwrap()["rev"], 1);

    // The same-tick rewrite that round #825 missed: a replacement pinned to
    // the recorded mtime looks reconciled to the row alone, but the file's
    // remembered (mtime, inode) signature reveals it and the next scan
    // imports it. The import is real work: only now does the store write.
    let original_mtime = fs::metadata(home.join(format!("tasks/{ID}.json")))
        .unwrap()
        .modified()
        .unwrap();
    let mut newer = task();
    newer["rev"] = json!(2);
    let temp = home.join("tasks/scan.tmp");
    fs::write(&temp, serde_json::to_vec(&newer).unwrap()).unwrap();
    fs::rename(&temp, home.join(format!("tasks/{ID}.json"))).unwrap();
    fs::File::options()
        .write(true)
        .open(home.join(format!("tasks/{ID}.json")))
        .unwrap()
        .set_modified(original_mtime)
        .unwrap();
    assert_eq!(store.reconcile_json().unwrap(), 1);
    assert_eq!(store.read(ID).unwrap().unwrap()["rev"], 2);
}

#[test]
fn guard_rejected_file_is_remembered_and_not_reread() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_path_buf();
    let mut store = TaskStore::open(&home).unwrap();
    store.insert(&task(), 1000.0).unwrap();
    // A replacement carrying the same revision, pinned to the row's exact
    // json_mtime: the upsert's guard rejects it (no newer revision, no newer
    // mtime), but the scan must still remember the file it opened.
    let json_path = home.join(format!("tasks/{ID}.json"));
    let recorded_mtime = fs::metadata(&json_path).unwrap().modified().unwrap();
    let mut same = task();
    same["unknown"] = json!("same-revision");
    let temp = home.join("tasks/reject.tmp");
    fs::write(&temp, serde_json::to_vec(&same).unwrap()).unwrap();
    fs::rename(&temp, &json_path).unwrap();
    fs::File::options()
        .write(true)
        .open(&json_path)
        .unwrap()
        .set_modified(recorded_mtime)
        .unwrap();
    assert_eq!(store.reconcile_json().unwrap(), 0);
    assert!(store.read(ID).unwrap().unwrap().get("unknown").is_none());
    // Age the row's json_mtime with plain SQL: if the next scan reread the
    // file, the guard would now accept it and upgrade the row's json_mtime.
    let onlooker = rusqlite::Connection::open(home.join("state/tasks.db")).unwrap();
    onlooker
        .execute(
            "UPDATE tasks SET json_mtime=? WHERE id=?",
            rusqlite::params![0.0f64, ID],
        )
        .unwrap();
    store.reconcile_json().unwrap();
    let json_mtime: Option<f64> = onlooker
        .query_row("SELECT json_mtime FROM tasks WHERE id=?", [ID], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        json_mtime,
        Some(0.0),
        "the scan reread a file whose rejection it already remembered"
    );
}

#[test]
fn failed_first_import_is_retried_on_the_next_open() {
    // A database this process has never opened (a new inode) that already
    // holds the task at revision 1, plus a newer JSON-only revision on disk.
    let seed = tempfile::tempdir().unwrap();
    let mut source = TaskStore::open(seed.path()).unwrap();
    source.insert(&task(), 1000.0).unwrap();
    drop(source);
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_path_buf();
    fs::create_dir_all(home.join("state")).unwrap();
    fs::create_dir_all(home.join("tasks")).unwrap();
    fs::copy(
        seed.path().join("state/tasks.db"),
        home.join("state/tasks.db"),
    )
    .unwrap();
    let mut newer = task();
    newer["rev"] = json!(5);
    fs::write(
        home.join(format!("tasks/{ID}.json")),
        serde_json::to_vec(&newer).unwrap(),
    )
    .unwrap();
    // The first open's import meets a writer that holds the database past the
    // busy timeout, as during the TypeScript core's own startup import.
    let mut blocker = rusqlite::Connection::open(home.join("state/tasks.db")).unwrap();
    let hold = blocker
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let failed = TaskStore::open(&home);
    hold.rollback().unwrap();
    assert!(failed.is_err());
    // The failed import was not recorded, so the next open imports revision 5.
    let mut store = TaskStore::open(&home).unwrap();
    assert_eq!(store.read(ID).unwrap().unwrap()["rev"], 5);
}

#[test]
fn an_empty_database_imports_even_when_its_path_and_inode_were_seen() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_path_buf();
    TaskStore::open(&home).unwrap();
    // Stands in for a database recreated at a reused inode (common on Linux):
    // the (path, inode) pair is already known but the table holds no tasks.
    fs::write(
        home.join("tasks/empty.tmp"),
        serde_json::to_vec(&task()).unwrap(),
    )
    .unwrap();
    fs::rename(
        home.join("tasks/empty.tmp"),
        home.join(format!("tasks/{ID}.json")),
    )
    .unwrap();
    let mut store = TaskStore::open(&home).unwrap();
    assert_eq!(store.read(ID).unwrap().unwrap()["rev"], 1);
}

#[test]
fn open_after_inode_change_imports() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_path_buf();
    TaskStore::open(&home).unwrap();
    // A JSON-only task, written directly (no SQL row at all yet).
    fs::write(
        home.join("tasks/new.tmp"),
        serde_json::to_vec(&task()).unwrap(),
    )
    .unwrap();
    fs::rename(
        home.join("tasks/new.tmp"),
        home.join(format!("tasks/{ID}.json")),
    )
    .unwrap();
    // Replace state/tasks.db with a fresh file (new inode), as a reset or
    // restore would while this process is alive.
    fs::remove_file(home.join("state/tasks.db")).unwrap();
    let _ = fs::remove_file(home.join("state/tasks.db-wal"));
    let _ = fs::remove_file(home.join("state/tasks.db-shm"));
    let mut reopened = TaskStore::open(&home).unwrap();
    assert_eq!(reopened.read(ID).unwrap().unwrap()["rev"], 1);
}

#[test]
fn open_creates_change_log_objects() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let count: i64 = store
        .connection()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name IN ('task_changes','task_changes_insert','task_changes_update')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 3);
    // The insert trigger logs a real change.
    store.insert(&task(), 1000.0).unwrap();
    let seq_after_insert: i64 = store
        .connection()
        .unwrap()
        .query_row("SELECT max(seq) FROM task_changes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(seq_after_insert, 1);
    // A real update (state change) logs a second row; a no-op does not.
    store
        .update(ID, 1, 1000.0, |v| v["state"] = json!("done"))
        .unwrap();
    let rows_after_update: i64 = store
        .connection()
        .unwrap()
        .query_row("SELECT count(*) FROM task_changes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows_after_update, 2);
    store
        .update(ID, 2, 1000.0, |v| v["state"] = json!("done"))
        .unwrap();
    let rows_after_noop: i64 = store
        .connection()
        .unwrap()
        .query_row("SELECT count(*) FROM task_changes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows_after_noop, 2);
}

#[test]
fn old_schema_without_change_log_gets_it_added_on_open() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("state")).unwrap();
    fs::create_dir_all(dir.path().join("tasks")).unwrap();
    let old = rusqlite::Connection::open(dir.path().join("state/tasks.db")).unwrap();
    old.execute_batch("CREATE TABLE tasks(id TEXT PRIMARY KEY, rev INTEGER, state TEXT, created_at REAL, updated_at REAL, settled_at REAL, repo TEXT, record TEXT NOT NULL, json_mtime REAL, archived INTEGER NOT NULL DEFAULT 0); CREATE INDEX tasks_state ON tasks(state); CREATE INDEX tasks_updated_at ON tasks(updated_at); CREATE INDEX tasks_created_at ON tasks(created_at); CREATE INDEX tasks_retention ON tasks(archived, settled_at); CREATE TABLE task_first_settle(task_id TEXT PRIMARY KEY, at REAL NOT NULL);").unwrap();
    let mut existing = task();
    existing["rev"] = json!(3);
    existing["state"] = json!("done");
    let record = serde_json::to_string(&existing).unwrap();
    old.execute(
        "INSERT INTO tasks(id,rev,state,created_at,updated_at,settled_at,repo,record,json_mtime,archived) VALUES(?,?,?,?,?,?,?,?,?,?)",
        rusqlite::params![ID, 3_i64, "done", 1000.0, 1000.0, 1000.0, "/tmp/repo", record, 1234.0, 0_i64],
    )
    .unwrap();
    drop(old);
    let mut store = TaskStore::open(dir.path()).unwrap();
    let count: i64 = store
        .connection()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name IN ('task_changes','task_changes_insert','task_changes_update')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 3);
    let (rev, record, json_mtime): (i64, String, f64) = store
        .connection()
        .unwrap()
        .query_row(
            "SELECT rev, record, json_mtime FROM tasks WHERE id=?",
            [ID],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(rev, 3);
    assert_eq!(record, serde_json::to_string(&existing).unwrap());
    assert_eq!(json_mtime, 1234.0);
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
        // Request paths no longer import on every access (Task 5); reconcile
        // explicitly to exercise each invalid-record rejection branch.
        store.reconcile_json().unwrap();
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
    store.reconcile_json().unwrap();
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
    match store.prune(1, false, 100_000.0) {
        Err(StoreError::Admission(message)) => {
            assert_eq!(message, "task retention is already running");
        }
        other => panic!("expected retention busy, got {other:?}"),
    }
    match store.restore(ID, 100_000.0) {
        Err(StoreError::Admission(message)) => {
            assert_eq!(message, "task retention is already running");
        }
        other => panic!("expected retention busy, got {other:?}"),
    }
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
    // Recovery from a crash between the JSON rename and the SQL commit is an
    // explicit reconcile now (Task 5), not an automatic import on every read:
    // the spec's recovery guarantee runs at the next process's open, and this
    // same-process store already claimed its one import.
    store.reconcile_json().unwrap();
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

#[test]
fn change_log_trigger_accepts_rows_with_missing_columns() {
    let dir = tempfile::tempdir().unwrap();
    drop(TaskStore::open(dir.path()).unwrap());
    // Older binaries could bind NaN (stored as NULL); the trigger must not reject the write.
    let db = rusqlite::Connection::open(dir.path().join("state/tasks.db")).unwrap();
    db.execute(
        "INSERT INTO tasks (id, rev, state, created_at, updated_at, record) VALUES ('t-20261101-120000-0bad', NULL, NULL, 5.0, NULL, '{}')",
        [],
    )
    .unwrap();
    let at: f64 = db
        .query_row(
            "SELECT at FROM task_changes WHERE task_id = 't-20261101-120000-0bad'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(at, 5.0);
}
