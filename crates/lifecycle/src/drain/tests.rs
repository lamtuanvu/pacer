#![allow(clippy::unwrap_used)]
use super::*;

fn task(id: &str) -> Value {
    json!({"id":id,"rev":1,"brief":{"repo":"/repo","goal":"work"},"state":"queued","createdAt":1,"attempts":[],"timeoutS":60,"requestedExecutor":null,"queue":{"reason":"no_slot","since":1,"position":9}})
}

#[test]
fn expiry_and_final_positions_reload_after_a_concurrent_writer() {
    for expiry in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let ctx = Ctx::with(home.clone(), home.clone(), Default::default(), 1.0);
        let id = "t-20261102-000000-0001";
        let next = "t-20261102-000000-0002";
        let mut state = AdmissionState::open(&home).unwrap();
        state.create(&task(id), None, None, 1.0).unwrap();
        state.create(&task(next), None, None, 1.0).unwrap();
        // These are precisely the snapshots used by expiry/final-position code.
        let stale = vec![
            state.read(id).unwrap().unwrap(),
            state.read(next).unwrap().unwrap(),
        ];
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (go_tx, go_rx) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            let mut other = AdmissionState::open(home).unwrap();
            with_lock(&ctx, &format!("task-{id}"), LockOptions::default(), || {
                held_tx.send(()).unwrap();
                go_rx.recv().unwrap();
                // Publish as a TS writer does while owning the cross-runtime lock.
                let mut changed = other.read(id).unwrap().unwrap();
                changed["rev"] = json!(2);
                changed["title"] = json!("concurrent edit");
                pacer_foundation::fsutil::write_json_atomic(
                    &ctx.pacer_home.join("tasks").join(format!("{id}.json")),
                    &changed,
                )
                .unwrap();
            })
            .unwrap();
        });
        held_rx.recv().unwrap();
        go_tx.send(()).unwrap();
        if expiry {
            expire_task(&mut state.tasks, id, 2.0).unwrap();
            expire_task(&mut state.tasks, next, 2.0).unwrap();
        } else {
            update_positions(&mut state.tasks, &stale, 2.0).unwrap();
        }
        writer.join().unwrap();
        let current = state.read(id).unwrap().unwrap();
        assert_eq!(current["rev"], 3);
        assert_eq!(current["title"], "concurrent edit");
        if expiry {
            assert_eq!(current["state"], "failed");
            assert!(current.get("queue").is_none());
            assert_eq!(state.read(next).unwrap().unwrap()["state"], "failed");
        } else {
            assert_eq!(current["queue"]["position"], 1);
            assert_eq!(current["queue"]["since"].as_f64(), Some(1.0));
            assert_eq!(state.read(next).unwrap().unwrap()["queue"]["position"], 2);
        }
    }
}

#[test]
fn position_snapshot_does_not_recreate_a_removed_queue() {
    let dir = tempfile::tempdir().unwrap();
    let mut state = AdmissionState::open(dir.path()).unwrap();
    let id = "t-20261102-000000-0001";
    let stale = task(id);
    state.create(&stale, None, None, 1.0).unwrap();
    state
        .tasks
        .edit(id, 1, 2.0, |t| {
            t.put("/state", WireReply::new(json!("stopped")))?;
            remove(t, "queue")
        })
        .unwrap();
    update_positions(&mut state.tasks, &[stale], 2.0).unwrap();
    let current = state.read(id).unwrap().unwrap();
    assert_eq!(current["rev"], 2);
    assert!(current.get("queue").is_none());
}

#[test]
fn pause_state_accepts_js_strings_and_rejects_expired_or_malformed_values() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        2.0,
    );
    assert!(!read_pause(&ctx));
    for (text, paused) in [
        (r#"{"until":100,"reason":null,"by":null}"#, true),
        (r#"{"until":100,"reason":"\ud800","by":"\udfff"}"#, true),
        (r#"{"until":null,"reason":null,"by":null}"#, true),
        (r#"{"until":2,"reason":null,"by":null}"#, false),
        (r#"{"until":1e400,"reason":null,"by":null}"#, false),
        (r#"{"until":"100","reason":null,"by":null}"#, false),
        (r#"{"until":100,"reason":false,"by":null}"#, false),
        (r#"{"until":100,"reason":null}"#, false),
        (r#"{"until":100,}"#, false),
    ] {
        pacer_foundation::fsutil::write_private(
            &ctx.pacer_home.join("state/pause.json"),
            text.as_bytes(),
        )
        .unwrap();
        assert_eq!(read_pause(&ctx), paused, "{text}");
    }
}

#[test]
fn exact_expiry_and_capacity_queue_keep_arrays_and_missing_null_fields() {
    for expiry in [true, false] {
        for (retained, since, position) in [
            (
                r#"{"since":["\ud801"],"position":{"x":"\ud802"}}"#,
                r#"["\ud801"]"#,
                r#"{"x":"\ud802"}"#,
            ),
            (r#"{"since":null}"#, "null", "null"),
            ("{}", "null", "null"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let id = "t-20261102-000000-0001";
            let mut state = AdmissionState::open(dir.path()).unwrap();
            state.create(&task(id), None, None, 1.0).unwrap();
            let mut queue = WireReply::parse(retained).unwrap();
            queue
                .put("/reason", WireReply::new(json!("no_slot")))
                .unwrap();
            state
                .tasks
                .edit(id, 1, 1.0, |edit| {
                    edit.put("/items", WireReply::parse(r#"["\ud800"]"#)?)?;
                    edit.put("/queue", queue)
                })
                .unwrap();
            if expiry {
                expire_task(&mut state.tasks, id, 2.0).unwrap();
                let wire = state.tasks.read_wire(id).unwrap().unwrap();
                assert_eq!(wire.preview()["state"], "failed");
                assert!(wire.preview().get("queue").is_none());
                assert_eq!(wire.preview()["settledAt"], 2.0);
            } else {
                let ctx = Ctx::with(
                    dir.path().into(),
                    dir.path().into(),
                    Default::default(),
                    2.0,
                );
                let mut admission =
                    RouteAdmission::unrestricted(vec![DrainRoute::local("codex", 0)]);
                let (wire, _) =
                    reserve(&mut state.tasks, &ctx, id, 2, 2.0, false, &mut admission).unwrap();
                for (key, expected) in [("since", since), ("position", position)] {
                    assert_eq!(
                        wire.subtree(&format!("/queue/{key}"))
                            .unwrap()
                            .to_json()
                            .unwrap(),
                        expected
                    );
                }
            }
            let wire = state.tasks.read_wire(id).unwrap().unwrap();
            assert_eq!(
                wire.subtree("/items").unwrap().to_json().unwrap(),
                r#"["\ud800"]"#
            );
            let file =
                std::fs::read_to_string(dir.path().join(format!("tasks/{id}.json"))).unwrap();
            let db = rusqlite::Connection::open(dir.path().join("state/tasks.db")).unwrap();
            let record: String = db
                .query_row("SELECT record FROM tasks WHERE id=?", [id], |r| r.get(0))
                .unwrap();
            assert_eq!(file, record);
            assert_eq!(record, wire.to_json().unwrap());
        }
    }
}

#[test]
fn capacity_refresh_distinguishes_exact_text_but_keeps_equal_reordered_objects_unchanged() {
    for (detail, changed) in [(r#""\ud800""#, true), (r#""�""#, false)] {
        let dir = tempfile::tempdir().unwrap();
        let id = "t-20261102-000000-0001";
        let mut state = AdmissionState::open(dir.path()).unwrap();
        state.create(&task(id), None, None, 1.0).unwrap();
        // Deliberately different key order from queue_capacity's new object.
        let queue = format!(
            r#"{{"position":9,"since":-0,"machine":{{"b":2,"a":1}},"detail":{detail},"limit":"machine","reason":"machine_load"}}"#
        );
        state
            .tasks
            .edit(id, 1, 1.0, |edit| {
                edit.put("/queue", WireReply::parse(&queue)?)
            })
            .unwrap();
        let ctx = Ctx::with(
            dir.path().into(),
            dir.path().into(),
            Default::default(),
            2.0,
        );
        let mut route = DrainRoute::local("codex", 1);
        route.machine_guard =
            Some(json!({"reason":"machine_load","detail":"�","machine":{"a":1,"b":2}}));
        let mut admission = RouteAdmission::unrestricted(vec![route]);
        let result = reserve(&mut state.tasks, &ctx, id, 2, 2.0, false, &mut admission);
        if changed {
            let (wire, _) = result.unwrap();
            assert_eq!(
                wire.subtree("/queue/detail").unwrap().to_json().unwrap(),
                r#""�""#
            );
            assert_eq!(wire.preview()["rev"], 3);
        } else {
            assert!(matches!(result, Err(StoreError::Unchanged)));
            assert_eq!(state.read(id).unwrap().unwrap()["rev"], 2);
        }
    }
}
