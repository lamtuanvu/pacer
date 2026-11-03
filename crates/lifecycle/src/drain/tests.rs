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

/// A TS-written stored record: replace the SQLite record bytes directly, as a
/// TypeScript writer may publish them. The compatibility file keeps its mtime,
/// so the next refresh does not re-import over this row. The row is re-inserted
/// rather than updated: work-node UPDATE triggers evaluate SQLite json_extract,
/// which rejects about 1,000 nesting levels in both runtimes (row 9), while a
/// fresh import INSERT does not.
fn store_record(home: &std::path::Path, id: &str, state: &str, record: &str) {
    let db = rusqlite::Connection::open(home.join("state/tasks.db")).unwrap();
    db.execute(
        "INSERT OR REPLACE INTO tasks(id,rev,state,created_at,updated_at,settled_at,repo,record,archived,json_mtime) SELECT id,rev,?2,created_at,updated_at,settled_at,repo,?1,archived,json_mtime FROM tasks WHERE id=?3",
        rusqlite::params![record, state, id],
    )
    .unwrap();
}

fn stored(home: &std::path::Path, id: &str) -> (i64, String) {
    let db = rusqlite::Connection::open(home.join("state/tasks.db")).unwrap();
    db.query_row("SELECT rev, record FROM tasks WHERE id=?", [id], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })
    .unwrap()
}

fn queued_record(id: &str, queue: &str) -> String {
    format!(
        r#"{{"id":"{id}","rev":1,"brief":{{"repo":"/repo","goal":"work"}},"state":"queued","createdAt":1,"attempts":[],"timeoutS":60,"requestedExecutor":null,"queue":{queue}}}"#
    )
}

fn nest(n: usize, leaf: &str) -> String {
    format!("{}{leaf}{}", "[".repeat(n), "]".repeat(n))
}

fn machine_admission() -> RouteAdmission<'static> {
    let mut route = DrainRoute::local("codex", 1);
    route.machine_guard =
        Some(json!({"reason":"machine_load","detail":"�","machine":{"a":1,"b":2}}));
    RouteAdmission::unrestricted(vec![route])
}

fn machine_queue(since: &str, detail: &str, extra: &str) -> String {
    format!(
        r#"{{{extra}"position":9,"since":{since},"machine":{{"b":2,"a":1}},"detail":{detail},"limit":"machine","reason":"machine_load"}}"#
    )
}

/// Q5/Q6: reserve over a stored queue whose `since` is `depth` arrays deep.
fn reserve_deep_queue(
    depth: usize,
    detail: &str,
) -> (Result<WireReply, StoreError>, i64, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let id = "t-20261102-000000-0001";
    let mut state = AdmissionState::open(dir.path()).unwrap();
    state.create(&task(id), None, None, 1.0).unwrap();
    let since = nest(depth, "1");
    let record = queued_record(id, &machine_queue(&since, detail, ""));
    store_record(dir.path(), id, "queued", &record);
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        2.0,
    );
    let mut admission = machine_admission();
    let result = reserve(&mut state.tasks, &ctx, id, 1, 2.0, false, &mut admission).map(|(w, _)| w);
    let (rev, after) = stored(dir.path(), id);
    (result, rev, after, record)
}

#[test]
fn q5_unchanged_deep_queue_is_a_no_op() {
    let (result, rev, after, before) = reserve_deep_queue(140, r#""�""#);
    assert!(
        matches!(result, Err(StoreError::Unchanged)),
        "{:?}",
        result.err()
    );
    assert_eq!(rev, 1);
    assert_eq!(after, before);
}

fn q5_deep_body() {
    let (result, rev, after, before) = reserve_deep_queue(20_000, r#""�""#);
    assert!(
        matches!(result, Err(StoreError::Unchanged)),
        "{:?}",
        result.err()
    );
    assert_eq!(rev, 1);
    assert_eq!(after.len(), before.len());
    assert!(after == before);
}

/// Q5 at depth 20,000, on a 2 MiB stack in a re-executed child.
#[test]
fn q5_unchanged_depth_20000_queue_is_a_no_op() {
    isolated(
        "drain::tests::q5_unchanged_depth_20000_queue_is_a_no_op",
        q5_deep_body,
    );
}

#[test]
fn q6_deep_queue_with_a_shallow_change_publishes_a_revision() {
    let (result, rev, after, _) = reserve_deep_queue(140, r#""\ud800""#);
    let wire = result.unwrap();
    assert_eq!(rev, 2);
    assert_eq!(
        wire.subtree("/queue/detail").unwrap().to_json().unwrap(),
        r#""�""#
    );
    assert_eq!(
        wire.subtree("/queue/since").unwrap().to_json().unwrap(),
        nest(140, "1")
    );
    assert_eq!(after, wire.to_json().unwrap());
}

/// Q7: reserve while another stored `running` record is newly accepted input.
fn reserve_beside_running(running: &str) {
    let dir = tempfile::tempdir().unwrap();
    let id = "t-20261102-000000-0001";
    let other = "t-20261102-000000-0002";
    let mut state = AdmissionState::open(dir.path()).unwrap();
    state.create(&task(id), None, None, 1.0).unwrap();
    state.create(&task(other), None, None, 1.0).unwrap();
    store_record(dir.path(), other, "running", running);
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        2.0,
    );
    let mut admission = RouteAdmission::unrestricted(vec![DrainRoute::local("codex", 1)]);
    let (wire, _) = reserve(&mut state.tasks, &ctx, id, 1, 2.0, false, &mut admission)
        .unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(wire.preview()["state"], "running");
    assert_eq!(wire.preview()["executor"], "codex");
}

#[test]
fn q7_hidden_key_running_record_counts_toward_capacity() {
    reserve_beside_running(
        r#"{"id":"t-20261102-000000-0002","rev":1,"brief":{"repo":"/repo"},"state":"running","executor":"other","createdAt":1,"attempts":[],"\ud800":1}"#,
    );
}

#[test]
fn q7_deep_running_record_counts_toward_capacity() {
    reserve_beside_running(&format!(
        r#"{{"id":"t-20261102-000000-0002","rev":1,"brief":{{"repo":"/repo"}},"state":"running","executor":"other","createdAt":1,"attempts":[],"deep":{}}}"#,
        nest(140, "1")
    ));
}

#[test]
fn q8_hidden_key_queue_change_with_coinciding_previews_is_not_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let id = "t-20261102-000000-0001";
    let mut state = AdmissionState::open(dir.path()).unwrap();
    state.create(&task(id), None, None, 1.0).unwrap();
    let queue = machine_queue("1", r#""�""#, r#""\ud800":"hidden","#);
    store_record(dir.path(), id, "queued", &queued_record(id, &queue));
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        2.0,
    );
    let mut admission = machine_admission();
    let (wire, _) = reserve(&mut state.tasks, &ctx, id, 1, 2.0, false, &mut admission)
        .unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(wire.preview()["rev"], 2);
    let queue = wire.subtree("/queue").unwrap().to_json().unwrap();
    assert!(!queue.contains(r"\ud800"), "{queue}");
    assert_eq!(stored(dir.path(), id).0, 2);
}

/// `n` nested arrays around `leaf`, built without recursion.
fn deep_value(n: usize, leaf: Value) -> Value {
    let mut value = leaf;
    for _ in 0..n {
        value = Value::Array(vec![value]);
    }
    value
}

/// Q6 (F2): the stored queue holds depth-140 `detail`, `machine.a` and `since`;
/// the route's machine guard changes the deep `detail`/`machine` leaves from 1
/// to 2. `queue_capacity` forwards the guard, and `replace_capacity_queue`
/// keeps only `since`/`position`. The fresh guard preview may differ from the
/// parsed queue preview, so the outer preview gate can decide this case; the
/// comparator alone is isolated in `tests/admission_json_eq.rs`.
#[test]
fn q6_deep_machine_guard_change_below_the_boundary_publishes_a_revision() {
    let dir = tempfile::tempdir().unwrap();
    let id = "t-20261102-000000-0001";
    let mut state = AdmissionState::open(dir.path()).unwrap();
    state.create(&task(id), None, None, 1.0).unwrap();
    let (old, since) = (nest(140, "1"), nest(140, "7"));
    let queue = format!(
        r#"{{"position":9,"since":{since},"machine":{{"a":{old},"b":2}},"detail":{old},"limit":"machine","reason":"machine_load"}}"#
    );
    store_record(dir.path(), id, "queued", &queued_record(id, &queue));
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        2.0,
    );
    let mut route = DrainRoute::local("codex", 1);
    route.machine_guard = Some(json!({
        "reason":"machine_load",
        "detail":deep_value(140, json!(2)),
        "machine":{"a":deep_value(140, json!(2)),"b":2}
    }));
    let mut admission = RouteAdmission::unrestricted(vec![route]);
    let (wire, _) = reserve(&mut state.tasks, &ctx, id, 1, 2.0, false, &mut admission)
        .unwrap_or_else(|e| panic!("{e:?}"));
    let (rev, persisted) = stored(dir.path(), id);
    assert_eq!(rev, 2);
    assert_eq!(wire.preview()["state"], "queued");
    let leaf = "/0".repeat(140);
    for path in ["/queue/detail", "/queue/machine/a"] {
        let changed = wire.subtree(&format!("{path}{leaf}")).unwrap();
        assert_eq!(changed.to_json().unwrap(), "2", "{path}");
    }
    assert_eq!(
        wire.subtree("/queue/since").unwrap().to_json().unwrap(),
        since
    );
    assert_eq!(
        wire.subtree("/queue/position").unwrap().to_json().unwrap(),
        "9"
    );
    let new = nest(140, "2");
    assert_eq!(
        wire.subtree("/queue").unwrap().to_json().unwrap(),
        format!(
            r#"{{"reason":"machine_load","limit":"machine","detail":{new},"machine":{{"a":{new},"b":2}},"since":{since},"position":9}}"#
        )
    );
    assert_eq!(persisted, wire.to_json().unwrap());
}

fn running_record(extra: &str) -> String {
    format!(
        r#"{{"id":"t-20261102-000000-0002","rev":1,"brief":{{"repo":"/repo"}},"state":"running","createdAt":1,"attempts":[]{extra}}}"#
    )
}

/// Q7 (F2): reserve the queued candidate with `route`, beside an optional
/// stored `running` record.
fn reserve_with_running(running: Option<&str>, route: DrainRoute) -> WireReply {
    let dir = tempfile::tempdir().unwrap();
    let id = "t-20261102-000000-0001";
    let other = "t-20261102-000000-0002";
    let mut state = AdmissionState::open(dir.path()).unwrap();
    state.create(&task(id), None, None, 1.0).unwrap();
    if let Some(record) = running {
        state.create(&task(other), None, None, 1.0).unwrap();
        store_record(dir.path(), other, "running", record);
    }
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        2.0,
    );
    let mut admission = RouteAdmission::unrestricted(vec![route]);
    let (wire, _) = reserve(&mut state.tasks, &ctx, id, 1, 2.0, false, &mut admission)
        .unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(stored(dir.path(), id).0, 2);
    wire
}

/// The running record holds the only slot, so the candidate stays queued with
/// a `no_slot` queue. Skipping the record would admit the candidate instead.
fn assert_occupied(running: &str, route: DrainRoute, limit: &str) {
    let wire = reserve_with_running(Some(running), route);
    let task = wire.preview();
    assert_eq!(task["state"], "queued", "{task}");
    assert!(task.get("executor").is_none(), "{task}");
    assert_eq!(task["queue"]["reason"], "no_slot");
    assert_eq!(task["queue"]["limit"], limit);
    assert_eq!(task["queue"]["capacity"], json!({"used":1,"max":1}));
    assert_eq!(
        (&task["queue"]["since"], &task["queue"]["position"]),
        (&json!(1), &json!(9))
    );
}

const HIDDEN: &str = r#","\ud800":1"#;

fn deep_member() -> String {
    format!(r#","deep":{}"#, nest(140, "1"))
}

fn executor_slot() -> DrainRoute {
    DrainRoute::local("codex", 1)
}

fn host_slot() -> DrainRoute {
    DrainRoute {
        host: Some("h1".into()),
        limits: SlotLimits {
            executor: 1,
            host: Some(1),
            local: None,
        },
        ..DrainRoute::local("codex", 1)
    }
}

fn local_pool() -> DrainRoute {
    DrainRoute {
        limits: SlotLimits {
            executor: 1,
            host: None,
            local: Some(1),
        },
        ..DrainRoute::local("codex", 1)
    }
}

const SAME_EXECUTOR: &str = r#","executor":"codex""#;
const SAME_HOST: &str = r#","executor":"other","run":{"host":"h1"}"#;
const LOCAL: &str = r#","executor":"other""#;

#[test]
fn q7_unoccupied_capacity_admits_the_candidate() {
    let wire = reserve_with_running(None, executor_slot());
    assert_eq!(wire.preview()["state"], "running");
    assert_eq!(wire.preview()["executor"], "codex");
    assert!(wire.preview().get("queue").is_none());
}

#[test]
fn q7_occupied_executor_slot_old_domain_record_blocks() {
    assert_occupied(&running_record(SAME_EXECUTOR), executor_slot(), "executor");
}

#[test]
fn q7_occupied_executor_slot_hidden_key_record_blocks() {
    assert_occupied(
        &running_record(&format!("{SAME_EXECUTOR}{HIDDEN}")),
        executor_slot(),
        "executor",
    );
}

#[test]
fn q7_occupied_executor_slot_deep_record_blocks() {
    assert_occupied(
        &running_record(&format!("{SAME_EXECUTOR}{}", deep_member())),
        executor_slot(),
        "executor",
    );
}

#[test]
fn q7_occupied_host_slot_old_domain_record_blocks() {
    assert_occupied(&running_record(SAME_HOST), host_slot(), "host");
}

#[test]
fn q7_occupied_host_slot_hidden_key_record_blocks() {
    assert_occupied(
        &running_record(&format!("{SAME_HOST}{HIDDEN}")),
        host_slot(),
        "host",
    );
}

#[test]
fn q7_occupied_host_slot_deep_record_blocks() {
    assert_occupied(
        &running_record(&format!("{SAME_HOST}{}", deep_member())),
        host_slot(),
        "host",
    );
}

#[test]
fn q7_occupied_local_pool_old_domain_record_blocks() {
    assert_occupied(&running_record(LOCAL), local_pool(), "machine");
}

#[test]
fn q7_occupied_local_pool_hidden_key_record_blocks() {
    assert_occupied(
        &running_record(&format!("{LOCAL}{HIDDEN}")),
        local_pool(),
        "machine",
    );
}

#[test]
fn q7_occupied_local_pool_deep_record_blocks() {
    assert_occupied(
        &running_record(&format!("{LOCAL}{}", deep_member())),
        local_pool(),
        "machine",
    );
}

const CHILD: &str = "PACER_LIFECYCLE_ISOLATED_TEST";

/// Run `body` on a 2 MiB thread in a re-executed copy of this test binary, so a
/// stack overflow aborts only the child and is reported as a failure here.
fn isolated(name: &str, body: fn()) {
    if std::env::var(CHILD).as_deref() == Ok(name) {
        let result = std::thread::Builder::new()
            .stack_size(2 << 20)
            .spawn(body)
            .unwrap()
            .join();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
        return;
    }
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args([name, "--exact", "--nocapture", "--test-threads=1"])
        .env(CHILD, name)
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    let start = (stderr.len().saturating_sub(1500)..)
        .find(|&i| stderr.is_char_boundary(i))
        .unwrap_or(0);
    let tail = &stderr[start..];
    assert!(
        out.status.success(),
        "isolated child `{name}` failed ({:?}):\n{tail}",
        out.status
    );
}
