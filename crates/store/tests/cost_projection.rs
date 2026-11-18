#![allow(clippy::unwrap_used)]
use pacer_store::TaskStore;
use rusqlite::{Connection, params};
use serde_json::json;
use std::process::Command;

fn put(db: &Connection, id: &str, start: f64, end: f64) {
    let record = json!({"id":id,"attempts":[{"startedAt":start,"endedAt":end,"usageAtStart":{"account":"x"}}]});
    db.execute(
        "INSERT OR REPLACE INTO tasks(id,record) VALUES(?1,?2)",
        params![id, record.to_string()],
    )
    .unwrap();
}
#[test]
fn repair_rebuilds_every_row_after_trigger_table_index_or_marker_loss() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let db = Connection::open(dir.path().join("state/tasks.db")).unwrap();
    for damage in [
        "DROP TRIGGER task_cost_insert_v1",
        "DROP TRIGGER task_cost_update_v1",
        "DROP TRIGGER task_cost_delete_v1",
        "DROP TABLE task_cost_intervals_v1",
        "DROP TABLE task_cost_invalid_v1",
        "DROP TABLE task_cost_meta_v1",
        "DROP INDEX task_cost_exact_v1",
        "DELETE FROM task_cost_meta_v1",
    ] {
        db.execute("DELETE FROM tasks", []).unwrap();
        put(&db, "old", 10., 20.);
        assert!(store.cost_overlap("target", 10., 20., 100.).unwrap());
        db.execute_batch(damage).unwrap();
        // Simulate writes during a period without maintenance (including an
        // invalid row later deleted). Recreating DDL alone leaves stale data.
        db.execute_batch("DROP TRIGGER IF EXISTS task_cost_insert_v1; DROP TRIGGER IF EXISTS task_cost_update_v1; DROP TRIGGER IF EXISTS task_cost_delete_v1; DELETE FROM tasks;").unwrap();
        put(&db, "new", 30., 40.);
        assert!(
            !store.cost_overlap("target", 10., 20., 100.).unwrap(),
            "{damage}"
        );
        assert!(
            store.cost_overlap("target", 30., 40., 100.).unwrap(),
            "{damage}"
        );
        assert!(!store.cost_overlap("new", 30., 40., 100.).unwrap());
    }
}
#[test]
fn duplicates_fail_closed_and_canonical_rewrite_recovers() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let db = Connection::open(dir.path().join("state/tasks.db")).unwrap();
    for record in [
        r#"{"id":"peer","attempts":[],"attempts":[{"startedAt":10,"endedAt":20,"usageAtStart":{"account":"x"}}]}"#,
        r#"{"id":"peer","extra":{"a":1,"\u0061":2},"attempts":[]}"#,
        r#"{"id":"peer","attempts":[{"startedAt":10,"startedAt":30,"endedAt":20,"usageAtStart":{"account":"x"}}]}"#,
        r#"{"id":"peer","extra":1e999,"attempts":[]}"#,
        "malformed",
    ] {
        db.execute(
            "INSERT OR REPLACE INTO tasks(id,record) VALUES('peer',?1)",
            [record],
        )
        .unwrap();
        assert!(
            store.cost_overlap("target", 10., 20., 100.).is_err(),
            "{record}"
        );
        // Both existing canonical writers parse then serialize JSON: duplicate
        // fields disappear before they reach SQL. The same trigger clears error.
        let canonical = serde_json::from_str::<serde_json::Value>(record)
            .unwrap_or(json!({"id":"peer","attempts":[]}));
        db.execute(
            "UPDATE tasks SET record=?1 WHERE id='peer'",
            [canonical.to_string()],
        )
        .unwrap();
        assert!(store.cost_overlap("target", 10., 20., 100.).is_ok());
    }
}
#[test]
fn replacement_same_revision_update_id_delete_and_rollback_are_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let db = Connection::open(dir.path().join("state/tasks.db")).unwrap();
    assert!(!store.cost_overlap("target", 10., 20., 100.).unwrap());
    put(&db, "peer", 10., 20.);
    assert!(store.cost_overlap("target", 10., 20., 100.).unwrap());
    db.execute_batch("BEGIN IMMEDIATE; DELETE FROM tasks;")
        .unwrap();
    assert!(store.cost_overlap("target", 10., 20., 100.).unwrap());
    db.execute_batch("ROLLBACK").unwrap();
    put(&db, "peer", 30., 40.); // REPLACE, recursive_triggers defaults off
    assert!(!store.cost_overlap("target", 10., 20., 100.).unwrap());
    db.execute("UPDATE tasks SET record=?1,id='other' WHERE id='peer'",[json!({"id":"renamed","attempts":[{"startedAt":10,"endedAt":20,"usageAtEnd":{"account":"x"}}]}).to_string()]).unwrap();
    assert!(store.cost_overlap("target", 10., 20., 100.).unwrap());
    assert!(!store.cost_overlap("renamed", 10., 20., 100.).unwrap());
    let old: i64 = db
        .query_row(
            "SELECT count(*) FROM task_cost_intervals_v1 WHERE owner='peer'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(old, 0);
    db.execute("DELETE FROM tasks", []).unwrap();
    assert!(!store.cost_overlap("target", 10., 20., 100.).unwrap());
}
#[test]
fn bun_writer_uses_triggers_without_native_functions_or_connection_flags() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    assert!(!store.cost_overlap("target", 10., 20., 100.).unwrap());
    let path = dir.path().join("state/tasks.db");
    let script = r#"import {Database} from 'bun:sqlite';
const db=new Database(process.argv[1]);
const row=JSON.parse('{"id":"peer","attempts":[],"attempts":[{"startedAt":10.5,"endedAt":20.5,"usageAtStart":{"account":"x"}}]}');
db.query('INSERT INTO tasks(id,record) VALUES(?,?)').run('peer',JSON.stringify(row));
db.close();"#;
    let result = Command::new("bun")
        .args(["-e", script])
        .arg(&path)
        .env("HOME", dir.path())
        .env("PACER_HOME", dir.path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(store.cost_overlap("target", 10., 20., 100.).unwrap());
    let update = r#"import {Database} from 'bun:sqlite'; const db=new Database(process.argv[1]);
db.transaction(()=>{db.query('UPDATE tasks SET record=? WHERE id=?').run(JSON.stringify({id:'peer',attempts:[]}), 'peer')})(); db.close();"#;
    let result = Command::new("bun")
        .args(["-e", update])
        .arg(&path)
        .env("HOME", dir.path())
        .env("PACER_HOME", dir.path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!store.cost_overlap("target", 10., 20., 100.).unwrap());
}
#[test]
fn installation_failure_rolls_back_and_unknown_version_is_not_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let db = Connection::open(dir.path().join("state/tasks.db")).unwrap();
    // A name collision forces installation to fail midway; no ready marker or
    // partial projection may escape the transaction.
    db.execute_batch("CREATE VIEW task_cost_pending_v1 AS SELECT 1")
        .unwrap();
    assert!(store.cost_overlap("target", 10., 20., 100.).is_err());
    let n: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='task_cost_intervals_v1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
    db.execute_batch("DROP VIEW task_cost_pending_v1").unwrap();
    assert!(!store.cost_overlap("target", 10., 20., 100.).unwrap());
    db.execute_batch("UPDATE task_cost_meta_v1 SET version=99; DROP TRIGGER task_cost_insert_v1")
        .unwrap();
    assert!(store.cost_overlap("target", 10., 20., 100.).is_err());
    let version: i64 = db
        .query_row("SELECT version FROM task_cost_meta_v1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 99);
}

#[test]
fn waiting_installer_includes_committed_old_writer_and_reopens_cleanly() {
    use std::{sync::mpsc, thread, time::Duration};
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let db = Connection::open(dir.path().join("state/tasks.db")).unwrap();
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    put(&db, "peer", 10., 20.);
    let (send, receive) = mpsc::channel();
    let handle = thread::spawn(move || {
        send.send(()).unwrap();
        store.cost_overlap("target", 10., 20., 100.)
    });
    receive.recv().unwrap();
    thread::sleep(Duration::from_millis(50));
    db.execute_batch("COMMIT").unwrap();
    assert!(handle.join().unwrap().unwrap());
    let mut reopened = TaskStore::open(dir.path()).unwrap();
    assert!(reopened.cost_overlap("target", 10., 20., 100.).unwrap());
}

#[test]
fn refresh_rebuilds_projection_after_database_file_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    assert!(!store.cost_overlap("target", 10., 20., 100.).unwrap());
    let replacement = tempfile::tempdir().unwrap();
    {
        let mut other = TaskStore::open(replacement.path()).unwrap();
        put(other.connection().unwrap(), "peer", 10., 20.);
    }
    // Removing test-only WAL companions prevents attaching an old WAL to the
    // replacement file. The original store stays alive to exercise inode refresh.
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(dir.path().join(format!("state/tasks.db{suffix}")));
    }
    std::fs::rename(
        replacement.path().join("state/tasks.db"),
        dir.path().join("state/tasks.db"),
    )
    .unwrap();
    assert!(store.cost_overlap("target", 10., 20., 100.).unwrap());
}

#[test]
fn wrong_type_or_owner_schema_never_answers_from_stale_intervals() {
    for replacement in [
        "CREATE VIEW task_cost_update_v1 AS SELECT 1",
        "CREATE TABLE unrelated(n); CREATE TRIGGER task_cost_update_v1 AFTER INSERT ON unrelated BEGIN SELECT 1; END",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TaskStore::open(dir.path()).unwrap();
        let db = Connection::open(dir.path().join("state/tasks.db")).unwrap();
        put(&db, "peer", 10., 20.);
        assert!(store.cost_overlap("target", 10., 20., 100.).unwrap());
        db.execute_batch("DROP TRIGGER task_cost_update_v1")
            .unwrap();
        db.execute_batch(replacement).unwrap();
        db.execute("UPDATE tasks SET record=?1 WHERE id='peer'",[json!({"id":"peer","attempts":[{"startedAt":30,"endedAt":40,"usageAtStart":{"account":"x"}}]}).to_string()]).unwrap();
        assert!(store.cost_overlap("target", 10., 20., 100.).is_err());
        drop(store);
        let mut reopened = TaskStore::open(dir.path()).unwrap();
        assert!(reopened.cost_overlap("target", 30., 40., 100.).is_err());
    }
}

#[test]
fn concurrent_builders_and_old_writer_preserve_every_committed_window() {
    use std::{
        sync::{Arc, Barrier},
        thread,
        time::{Duration, Instant},
    };
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    for i in 0..600 {
        put(store.connection().unwrap(), &format!("p-{i:04}"), 10., 20.);
    }
    let barrier = Arc::new(Barrier::new(3));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let barrier = barrier.clone();
            let home = dir.path().to_path_buf();
            thread::spawn(move || {
                let mut store = TaskStore::open(home).unwrap();
                barrier.wait();
                store.cost_overlap("target", 100., 200., 1000.)
            })
        })
        .collect();
    barrier.wait();
    let db = Connection::open(dir.path().join("state/tasks.db")).unwrap();
    db.busy_timeout(Duration::from_secs(5)).unwrap();
    for i in 0..30 {
        let started = Instant::now();
        put(&db, &format!("0-writer-{i:04}"), 300., 400.);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
    for worker in workers {
        assert!(!worker.join().unwrap().unwrap());
    }
    assert!(store.cost_overlap("target", 300., 400., 1000.).unwrap());
    let n: i64 = db
        .query_row(
            "SELECT count(*) FROM task_cost_intervals_v1 WHERE owner LIKE '0-writer-%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 30);
}
