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
fn json_only_home_does_not_create_state_and_keeps_imported_records() {
    let home = tempfile::tempdir().unwrap();
    write(home.path(), &record(Value::Null, "running"));
    let reader = TaskLogReader::open(home.path()).unwrap();
    assert_eq!(reader.read(ID).unwrap().unwrap()["rev"], 1);
    write(home.path(), &record(json!(2e0), "done"));
    assert_eq!(reader.read(ID).unwrap().unwrap()["state"], "done");
    write(home.path(), &record(json!(1), "running"));
    assert_eq!(reader.read(ID).unwrap().unwrap()["state"], "done");
    fs::remove_file(home.path().join(format!("tasks/{ID}.json"))).unwrap();
    assert_eq!(reader.read(ID).unwrap().unwrap()["state"], "done");
    assert!(!home.path().join("state").exists());
}
#[test]
fn compatibility_revisions_match_js_safe_integers_and_corrupt_files_are_skipped() {
    let home = tempfile::tempdir().unwrap();
    let reader = TaskLogReader::open(home.path()).unwrap();
    for value in [
        json!([]),
        json!("bad"),
        record(json!(0), "done"),
        record(json!(1.5), "done"),
        record(json!(9007199254740992u64), "done"),
    ] {
        write(home.path(), &value);
        assert!(reader.read(ID).unwrap().is_none());
    }
    write(home.path(), &record(json!(9007199254740991u64), "done"));
    assert_eq!(
        reader.read(ID).unwrap().unwrap()["rev"],
        json!(9007199254740991u64)
    );
}
#[test]
fn same_revision_uses_newer_mtime_and_database_revision_wins_over_old_json() {
    let home = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(home.path()).unwrap();
    store.insert(&record(json!(2), "running"), 1000.0).unwrap();
    let reader = TaskLogReader::open(home.path()).unwrap();
    assert_eq!(reader.read(ID).unwrap().unwrap()["state"], "running");
    // Explicit times keep equal-revision precedence deterministic on all filesystems.
    write(home.path(), &record(json!(2), "done"));
    File::open(home.path().join(format!("tasks/{ID}.json")))
        .unwrap()
        .set_times(
            fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(4_000_000_000)),
        )
        .unwrap();
    assert_eq!(reader.read(ID).unwrap().unwrap()["state"], "done");
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE tasks SET rev=3,record=? WHERE id=?",
            params![
                serde_json::to_string(&record(json!(3), "failed")).unwrap(),
                ID
            ],
        )
        .unwrap();
    assert_eq!(reader.read(ID).unwrap().unwrap()["state"], "failed");
}
