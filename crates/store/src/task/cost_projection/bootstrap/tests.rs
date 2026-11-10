#![allow(clippy::unwrap_used)]
use super::*;
use crate::TaskStore;
use serde_json::json;

fn put(db: &Connection, id: &str, start: i64, end: i64) {
    db.execute("INSERT INTO tasks(id,record) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET record=excluded.record",params![id,json!({"id":id,"attempts":[{"startedAt":start,"endedAt":end,"usageAtStart":{"account":"x"}}]}).to_string()]).unwrap();
}
fn fixture() -> (tempfile::TempDir, TaskStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = TaskStore::open(dir.path()).unwrap();
    for i in 0..50 {
        put(&store.db, &format!("peer-{i:03}"), 10, 20);
    }
    (dir, store)
}
fn finish(store: &mut TaskStore) {
    ensure(&mut store.db).unwrap();
    assert!(ready(&store.db).unwrap());
}

#[test]
fn each_phase_and_cursor_resumes_and_old_writes_cover_both_sides() {
    let (dir, mut store) = fixture();
    assert!(!step(&mut store.db).unwrap());
    assert_eq!(inspect(&store.db).unwrap(), State::Clearing);
    // Writes during clearing are deliberately not projected, but cannot be lost.
    put(&store.db, "a-before", 30, 40);
    let n: i64 = store
        .db
        .query_row("SELECT count(*) FROM task_cost_intervals_v1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 0);
    drop(store);
    let mut store = TaskStore::open(dir.path()).unwrap();
    assert!(!step(&mut store.db).unwrap());
    assert_eq!(inspect(&store.db).unwrap(), State::Building(None));
    step(&mut store.db).unwrap();
    let State::Building(Some(_)) = inspect(&store.db).unwrap() else {
        panic!("expected committed cursor")
    };
    put(&store.db, "a-before", 50, 60); // update behind cursor
    put(&store.db, "0-insert-before", 70, 80);
    put(&store.db, "z-insert-after", 90, 100);
    store
        .db
        .execute("DELETE FROM tasks WHERE id='peer-000'", [])
        .unwrap();
    drop(store);
    let mut store = TaskStore::open(dir.path()).unwrap();
    finish(&mut store);
    for (a, b) in [(50., 60.), (70., 80.), (90., 100.)] {
        assert!(store.cost_overlap("target", a, b, 200.).unwrap());
    }
    assert!(!store.cost_overlap("target", 30., 40., 200.).unwrap());
    let stale: i64 = store
        .db
        .query_row(
            "SELECT count(*) FROM task_cost_intervals_v1 WHERE owner='peer-000'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stale, 0);
}

#[test]
fn damage_after_cursor_never_advances_stale_build() {
    for damage in [
        "DROP TRIGGER task_cost_insert_v1",
        "DROP TABLE task_cost_invalid_v1",
        "DROP INDEX task_cost_exact_v1",
        "DELETE FROM task_cost_meta_v1",
    ] {
        let (_dir, mut store) = fixture();
        step(&mut store.db).unwrap();
        step(&mut store.db).unwrap();
        step(&mut store.db).unwrap();
        store.db.execute_batch(damage).unwrap();
        store.db.execute_batch("DROP TRIGGER IF EXISTS task_cost_insert_v1; DROP TRIGGER IF EXISTS task_cost_update_v1; DROP TRIGGER IF EXISTS task_cost_delete_v1;").unwrap();
        put(&store.db, "0-missed-behind", 300, 400);
        store
            .db
            .execute("DELETE FROM tasks WHERE id='peer-000'", [])
            .unwrap();
        step(&mut store.db).unwrap();
        assert_eq!(inspect(&store.db).unwrap(), State::Clearing, "{damage}");
        finish(&mut store);
        assert!(store.cost_overlap("target", 300., 400., 1000.).unwrap());
        let stale: i64 = store
            .db
            .query_row(
                "SELECT count(*) FROM task_cost_intervals_v1 WHERE owner='peer-000'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stale, 0);
    }
}

#[test]
fn clearing_limits_rows_even_when_one_owner_has_many_attempts() {
    let (_dir, mut store) = fixture();
    finish(&mut store);
    store.db.execute_batch("WITH RECURSIVE n(i) AS (SELECT 100 UNION ALL SELECT i+1 FROM n WHERE i<1100) INSERT INTO task_cost_intervals_v1(owner,record_id,kind,ordinal) SELECT 'huge','huge',0,i FROM n; DROP TRIGGER task_cost_update_v1;").unwrap();
    step(&mut store.db).unwrap();
    assert_eq!(inspect(&store.db).unwrap(), State::Clearing);
    let before: i64 = store
        .db
        .query_row("SELECT count(*) FROM task_cost_intervals_v1", [], |r| {
            r.get(0)
        })
        .unwrap();
    step(&mut store.db).unwrap();
    let after: i64 = store
        .db
        .query_row("SELECT count(*) FROM task_cost_intervals_v1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(before - after, ROW_BATCH);
    finish(&mut store);
    let stale: i64 = store
        .db
        .query_row(
            "SELECT count(*) FROM task_cost_intervals_v1 WHERE owner='huge'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stale, 0);
}

#[test]
fn batch_failure_rolls_back_cursor_and_projected_rows_together() {
    let (_dir, mut store) = fixture();
    step(&mut store.db).unwrap();
    step(&mut store.db).unwrap();
    store.db.execute_batch("CREATE TRIGGER fail_batch BEFORE INSERT ON task_cost_intervals_v1 WHEN NEW.owner='peer-000' BEGIN SELECT RAISE(ABORT,'fixture failure'); END").unwrap();
    assert!(step(&mut store.db).is_err());
    assert_eq!(inspect(&store.db).unwrap(), State::Building(None));
    let n: i64 = store
        .db
        .query_row("SELECT count(*) FROM task_cost_intervals_v1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 0);
    store.db.execute_batch("DROP TRIGGER fail_batch").unwrap();
    finish(&mut store);
}

#[test]
fn legacy_metadata_rebuilds_but_future_and_inconsistent_metadata_fail_closed() {
    let (_dir, mut store) = fixture();
    store.db.execute_batch("CREATE TABLE task_cost_meta_v1(version INTEGER NOT NULL); INSERT INTO task_cost_meta_v1 VALUES(1)").unwrap();
    finish(&mut store);
    for mutation in [
        "UPDATE task_cost_meta_v1 SET version=3",
        "UPDATE task_cost_meta_v1 SET phase='ready',cursor='stale'",
        "UPDATE task_cost_meta_v1 SET phase='clearing',cursor='stale'",
        "UPDATE task_cost_meta_v1 SET phase='unknown'",
        "UPDATE task_cost_meta_v1 SET phase='building',cursor=x'00'",
        "INSERT INTO task_cost_meta_v1 VALUES(2,'ready',NULL)",
    ] {
        store.db.execute_batch(mutation).unwrap();
        assert!(step(&mut store.db).is_err(), "{mutation}");
        store.db.execute_batch("DELETE FROM task_cost_meta_v1; INSERT INTO task_cost_meta_v1 VALUES(2,'ready',NULL)").unwrap();
    }
    store.db.execute_batch("DROP TABLE task_cost_meta_v1; CREATE TABLE task_cost_meta_v1(version INTEGER NOT NULL); INSERT INTO task_cost_meta_v1 VALUES(99)").unwrap();
    assert!(step(&mut store.db).is_err());
}

#[test]
fn bun_connection_spans_clearing_building_and_ready() {
    use std::{
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
    };
    let (dir, mut store) = fixture();
    let script = r#"import {Database} from 'bun:sqlite'; import {createInterface} from 'node:readline';
const db=new Database(process.argv[1]);console.log('ready');
const input=createInterface({input:process.stdin}); input.on('line',line=>{try{const [id,start,end]=JSON.parse(line);db.query('INSERT INTO tasks(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(id,JSON.stringify({id,attempts:[{startedAt:start,endedAt:end,usageAtEnd:{account:'x'}}]}));console.log('ok')}catch(e){console.log(String(e))}});
input.on('close',()=>db.close());"#;
    let mut child = Command::new("bun")
        .args(["-e", script])
        .arg(dir.path().join("state/tasks.db"))
        .env("HOME", dir.path())
        .env("PACER_HOME", dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "ready");
    let mut write = |id: &str, a: i64, b: i64| {
        writeln!(input, "{}", json!([id, a, b])).unwrap();
        input.flush().unwrap();
        line.clear();
        output.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "ok");
    };
    step(&mut store.db).unwrap();
    write("0-behind", 30, 40);
    step(&mut store.db).unwrap();
    step(&mut store.db).unwrap();
    write("0-behind", 50, 60);
    write("z-ahead", 70, 80);
    finish(&mut store);
    write("z-ahead", 90, 100);
    drop(input);
    assert!(child.wait().unwrap().success());
    assert!(store.cost_overlap("target", 50., 60., 200.).unwrap());
    assert!(store.cost_overlap("target", 90., 100., 200.).unwrap());
    assert!(!store.cost_overlap("target", 30., 40., 200.).unwrap());
    assert!(!store.cost_overlap("target", 70., 80., 200.).unwrap());
}

#[test]
#[ignore = "child process of kill_and_reopen_resumes_committed_progress"]
fn crash_child() {
    let Ok(home) = std::env::var("PACER_COST_CRASH_HOME") else {
        return;
    };
    let stage = std::env::var("PACER_COST_CRASH_STAGE").unwrap();
    let mut store = TaskStore::open(&home).unwrap();
    step(&mut store.db).unwrap();
    if stage != "clearing" {
        step(&mut store.db).unwrap();
    }
    if stage == "cursor" || stage == "uncommitted" {
        step(&mut store.db).unwrap();
    }
    if stage == "uncommitted" {
        store.db.execute_batch("BEGIN IMMEDIATE; DELETE FROM task_cost_intervals_v1; UPDATE task_cost_meta_v1 SET cursor='zzzz-uncommitted';").unwrap();
    }
    std::fs::write(std::path::Path::new(&home).join("kill-boundary"), b"ready").unwrap();
    loop {
        thread::park();
    }
}

#[test]
fn kill_and_reopen_resumes_committed_progress() {
    use std::process::{Command, Stdio};
    for stage in ["clearing", "building", "cursor", "uncommitted"] {
        let (dir, store) = fixture();
        drop(store);
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "task::cost_projection::bootstrap::tests::crash_child",
                "--ignored",
            ])
            .env("HOME", dir.path())
            .env("PACER_HOME", dir.path())
            .env("PACER_COST_CRASH_HOME", dir.path())
            .env("PACER_COST_CRASH_STAGE", stage)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let start = Instant::now();
        while !dir.path().join("kill-boundary").exists()
            && start.elapsed() < Duration::from_secs(10)
        {
            thread::sleep(Duration::from_millis(10));
        }
        let reached = dir.path().join("kill-boundary").exists();
        let _ = child.kill();
        child.wait().unwrap();
        assert!(reached, "child did not reach {stage}");
        let mut store = TaskStore::open(dir.path()).unwrap();
        finish(&mut store);
        assert!(store.cost_overlap("target", 10., 20., 100.).unwrap());
        let count: i64 = store
            .db
            .query_row("SELECT count(*) FROM task_cost_intervals_v1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 50, "{stage}");
    }
}
