#![allow(clippy::unwrap_used)]
use pacer_lifecycle::{AdmissionError, AdmissionState, DrainRoute};
use rusqlite::Connection;
use std::{cell::Cell, fs, path::Path};

const ID: &str = "t-20261102-000000-0001";
fn imported(queue: &str) -> (tempfile::TempDir, AdmissionState) {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("tasks")).unwrap();
    let record = format!(
        r#"{{"id":"{ID}","rev":1,"brief":{{"repo":"/repo","goal":"work"}},"state":"queued","createdAt":1,"attempts":[],"timeoutS":60,"items":["\ud800",{{"x":"\udfff"}}],"queue":{queue}}}"#
    );
    fs::write(dir.path().join(format!("tasks/{ID}.json")), record).unwrap();
    let state = AdmissionState::open(dir.path()).unwrap();
    (dir, state)
}
fn durable(home: &Path) -> (String, String) {
    let file = fs::read_to_string(home.join(format!("tasks/{ID}.json"))).unwrap();
    let record = Connection::open(home.join("state/tasks.db"))
        .unwrap()
        .query_row("SELECT record FROM tasks WHERE id=?", [ID], |r| r.get(0))
        .unwrap();
    (file, record)
}
fn exact_publication(home: &Path) {
    let (file, record) = durable(home);
    assert_eq!(file, record);
    assert!(
        file.contains(r#""items":["\ud800",{"x":"\udfff"}]"#),
        "{file}"
    );
}

#[test]
fn failed_launch_restores_the_exact_reserved_queue_and_unknown_fields() {
    let queue = r#"{"reason":"no_slot","since":["\ud801"],"position":null,"unknown":{"a/b":["\ud802","�"]}}"#;
    let (dir, mut state) = imported(queue);
    let launched = Cell::new(false);
    let result = state.drain(
        2.0,
        false,
        |_| Ok(vec![DrainRoute::local("codex", 1)]),
        |selected| {
            launched.set(true);
            assert_eq!(selected["state"], "running");
            assert_eq!(selected["rev"], 2);
            Err(AdmissionError("launch failed".into()))
        },
    );
    assert!(launched.get(), "{result:?}");
    assert_eq!(result.unwrap_err().to_string(), "launch failed");
    let wire = state.tasks.read_wire(ID).unwrap().unwrap();
    assert_eq!(wire.subtree("/queue").unwrap().to_json().unwrap(), queue);
    assert_eq!(wire.preview()["rev"], 3);
    assert_eq!(wire.preview()["state"], "queued");
    assert!(wire.preview().get("executor").is_none());
    assert!(wire.preview().get("runnerPid").is_none());
    exact_publication(dir.path());
    drop(state);
    let mut reopened = AdmissionState::open(dir.path()).unwrap();
    assert_eq!(
        reopened
            .tasks
            .read_wire(ID)
            .unwrap()
            .unwrap()
            .subtree("/queue")
            .unwrap()
            .to_json()
            .unwrap(),
        queue
    );
}

#[test]
fn paused_positions_and_policy_retry_preserve_exact_queue_descendants() {
    for paused in [true, false] {
        let (dir, mut state) =
            imported(r#"{"reason":"no_slot","since":"\ud801","unknown":["\ud802"]}"#);
        state
            .drain(
                2.0,
                paused,
                |_| Err(AdmissionError("denied".into())),
                |_| panic!("not eligible"),
            )
            .unwrap();
        let wire = state.tasks.read_wire(ID).unwrap().unwrap();
        assert_eq!(
            wire.subtree("/queue/unknown").unwrap().to_json().unwrap(),
            r#"["\ud802"]"#
        );
        assert_eq!(
            wire.subtree("/queue/since").unwrap().to_json().unwrap(),
            r#""\ud801""#
        );
        assert_eq!(wire.preview()["queue"]["position"], 1);
        if !paused {
            assert_eq!(wire.preview()["queue"]["reason"], "waiting_retry");
        }
        exact_publication(dir.path());
    }
}

#[test]
fn active_surrogate_records_count_toward_capacity() {
    let (dir, mut state) = imported(r#"{"reason":"no_slot","since":"\ud801"}"#);
    let running_id = "t-20261102-000000-0002";
    let mut active = state
        .tasks
        .read_wire(ID)
        .unwrap()
        .unwrap()
        .to_json()
        .unwrap()
        .replace(ID, running_id);
    active = active.replace(
        r#""state":"queued""#,
        r#""state":"running","executor":"wrong","executor":"codex""#,
    );
    fs::write(dir.path().join(format!("tasks/{running_id}.json")), active).unwrap();
    let spawned = state
        .drain(
            2.0,
            false,
            |_| Ok(vec![DrainRoute::local("codex", 1)]),
            |_| panic!("occupied slot launched"),
        )
        .unwrap();
    assert!(spawned.is_empty());
    let wire = state.tasks.read_wire(ID).unwrap().unwrap();
    assert_eq!(wire.preview()["state"], "queued");
    assert_eq!(
        wire.subtree("/queue/since").unwrap().to_json().unwrap(),
        r#""\ud801""#
    );
    exact_publication(dir.path());
}

#[test]
fn rollback_queue_comes_from_the_writer_snapshot_not_the_ranked_preview() {
    let (dir, mut state) = imported(r#"{"reason":"no_slot","unknown":["\ud801"]}"#);
    let home = dir.path();
    state
        .drain(
            2.0,
            false,
            |_| {
                // A compatibility writer may replace the record at the same revision.
                // The reservation must use the authoritative row, not the earlier list.
                let db = Connection::open(home.join("state/tasks.db"))?;
                let original: String =
                    db.query_row("SELECT record FROM tasks WHERE id=?", [ID], |r| r.get(0))?;
                db.execute(
                    "UPDATE tasks SET record=? WHERE id=?",
                    rusqlite::params![original.replace(r#"\ud801"#, r#"\ud802"#), ID],
                )?;
                Ok(vec![DrainRoute::local("codex", 1)])
            },
            |_| Err(AdmissionError("launch failed".into())),
        )
        .unwrap_err();
    let record = state.tasks.read_wire(ID).unwrap().unwrap();
    assert_eq!(
        record.subtree("/queue/unknown").unwrap().to_json().unwrap(),
        r#"["\ud802"]"#
    );
    exact_publication(home);
}

#[test]
fn null_queue_positions_keep_the_existing_object_initialization_behavior() {
    let (dir, mut state) = imported("null");
    state
        .drain(2.0, true, |_| panic!("paused"), |_| panic!("paused"))
        .unwrap();
    assert_eq!(
        state.read(ID).unwrap().unwrap()["queue"],
        serde_json::json!({"position":1})
    );
    exact_publication(dir.path());
}

#[test]
fn stale_reservation_skips_policy_guard_and_launch_without_restoring_old_queue() {
    let (dir, mut state) = imported(r#"{"reason":"no_slot","unknown":["\ud801"]}"#);
    let guarded = Cell::new(false);
    let mut writer = pacer_store::TaskStore::open(dir.path()).unwrap();
    let spawned = state
        .drain_admitted(
            2.0,
            false,
            |_| {
                writer.edit(ID, 1, 2.0, |edit| edit.remove("/queue"))?;
                let mut admission =
                    pacer_lifecycle::RouteAdmission::unrestricted(vec![DrainRoute::local(
                        "codex", 1,
                    )]);
                admission.revalidate = Box::new(|_, _| {
                    guarded.set(true);
                    Ok(())
                });
                Ok(admission)
            },
            |_| panic!("stale reservation launched"),
        )
        .unwrap();
    assert!(!guarded.get());
    assert!(spawned.is_empty());
    let record = state.tasks.read_wire(ID).unwrap().unwrap();
    assert_eq!(record.preview()["rev"], 2);
    assert!(record.preview().get("queue").is_none());
    exact_publication(dir.path());
}

#[test]
fn malformed_active_record_still_aborts_before_launch_or_task_publication() {
    let (dir, mut state) = imported(r#"{"reason":"no_slot"}"#);
    let other = "t-20261102-000000-0002";
    let mut active = state.read(ID).unwrap().unwrap();
    active["id"] = serde_json::json!(other);
    active["state"] = serde_json::json!("running");
    active["executor"] = serde_json::json!("codex");
    state.create(&active, None, None, 1.0).unwrap();
    // SQLite JSON functions accept JSON5; the task wire parser still requires JSON.
    state
        .tasks
        .connection()
        .unwrap()
        .execute("UPDATE tasks SET record='{bare:1}' WHERE id=?", [other])
        .unwrap();
    let before = durable(dir.path());
    let result = state.drain(
        2.0,
        false,
        |_| Ok(vec![DrainRoute::local("codex", 1)]),
        |_| panic!("malformed active record launched"),
    );
    assert!(result.is_err());
    assert_eq!(durable(dir.path()), before);
}
