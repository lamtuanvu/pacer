#![allow(clippy::unwrap_used)]
use super::*;
const ID: &str = "t-20261102-101125-16a9";
fn record(rev: Value, state: &str) -> Value {
    json!({"id":ID,"rev":rev,"state":state,"createdAt":1000,"brief":{"repo":"/tmp/repo"},"attempts":[]})
}
fn write(home: &Path, value: &Value) {
    let dir = home.join("tasks");
    fs::create_dir_all(&dir).unwrap();
    let tmp = dir.join("new.tmp");
    fs::write(&tmp, serde_json::to_vec(value).unwrap()).unwrap();
    fs::rename(tmp, dir.join(format!("{ID}.json"))).unwrap();
}
#[test]
fn json_only_home_requires_shared_import_without_creating_state() {
    let home = tempfile::tempdir().unwrap();
    write(home.path(), &record(Value::Null, "running"));
    let reader = TaskLogReader::open(home.path()).unwrap();
    assert!(matches!(
        reader.read(ID),
        Err(StoreError::CompatibilityRequired)
    ));
    assert!(!home.path().join("state").exists());
}
#[test]
fn unchanged_sqlite_reads_avoid_writers_but_changed_json_requires_compatibility() {
    let home = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(home.path()).unwrap();
    store.insert(&record(json!(2), "running"), 1000.0).unwrap();
    let reader = TaskLogReader::open(home.path()).unwrap();
    assert_eq!(reader.read(ID).unwrap().unwrap()["state"], "running");
    store
        .connection()
        .unwrap()
        .execute_batch("BEGIN IMMEDIATE")
        .unwrap();
    assert_eq!(reader.read(ID).unwrap().unwrap()["state"], "running");
    store
        .connection()
        .unwrap()
        .execute_batch("ROLLBACK")
        .unwrap();
    write(home.path(), &record(json!(3), "done"));
    assert!(matches!(
        reader.read(ID),
        Err(StoreError::CompatibilityRequired)
    ));
    assert_eq!(store.read(ID).unwrap().unwrap()["state"], "done");
    assert_eq!(reader.read(ID).unwrap().unwrap()["state"], "done");
}
#[test]
fn linked_state_directory_and_sqlite_companions_are_refused() {
    use std::os::unix::fs::symlink;
    for name in [
        "state",
        "state/tasks.db-wal",
        "state/tasks.db-shm",
        "state/tasks.db-journal",
    ] {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        if name != "state" {
            fs::create_dir(home.path().join("state")).unwrap();
        }
        symlink(outside.path(), home.path().join(name)).unwrap();
        assert!(TaskLogReader::open(home.path()).is_err(), "{name}");
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }
}

#[test]
fn native_store_import_accepts_bun_negative_mtime_and_untyped_sqlite_mtime() {
    let home = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(home.path()).unwrap();
    store.insert(&record(json!(2), "done"), 1000.0).unwrap();
    store
        .connection()
        .unwrap()
        .execute_batch("UPDATE tasks SET json_mtime='legacy'")
        .unwrap();
    drop(store);
    assert_eq!(
        TaskStore::open(home.path())
            .unwrap()
            .read(ID)
            .unwrap()
            .unwrap()["rev"],
        2
    );
    let path = home.path().join(format!("tasks/{ID}.json"));
    File::open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH - Duration::from_secs(1)))
        .unwrap();
    let code = "import {statSync} from 'node:fs'; console.log(statSync(process.argv[1]).mtimeMs)";
    let output = std::process::Command::new("bun")
        .args(["-e", code])
        .arg(&path)
        .env("HOME", home.path())
        .env("PACER_HOME", home.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    let expected = String::from_utf8(output.stdout)
        .unwrap()
        .trim()
        .parse::<f64>()
        .unwrap();
    assert_eq!(mtime_ms(&path).unwrap(), expected);
    assert_eq!(
        TaskStore::open(home.path())
            .unwrap()
            .read(ID)
            .unwrap()
            .unwrap()["rev"],
        2
    );
}
