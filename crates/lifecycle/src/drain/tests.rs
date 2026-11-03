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
        .update(id, 1, 2.0, |t| {
            t["state"] = json!("stopped");
            remove(t, "queue");
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
