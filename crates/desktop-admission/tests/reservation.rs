//! Idle reservation and work-blocker gate, porting the in-scope rationales of
//! `test/desktop-update-admission.test.ts` that exercise the Rust library
//! (`reserve_idle`, `release_reservation`, `reconcile_admission`,
//! `enrolled_work_processes`). TypeScript-only mechanics (task store, jobs
//! daemon, remote runs) are replaced by raw persisted fixtures written to a
//! temp home, which is exactly the evidence the library reads.
#![allow(clippy::unwrap_used, clippy::expect_used)]
mod common;
use common::{Home, job, lease, mkdir, reservation_of, task, write_json, write_state, write_str};
use pacer_desktop_admission::reservation;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const DEADLINE: Duration = Duration::from_millis(200);

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn find_bun() -> String {
    std::env::var("BUN")
        .ok()
        .filter(|p| Path::new(p).exists())
        .unwrap_or_else(|| "bun".to_string())
}

/// A holder of a TS reservation or lease in `admission-worker.ts` (`launch`
/// mode calls `beginWorkSync`). A lease left behind stands in the way; a
/// finished launch records that `beginWorkSync` either started a launch or was
/// refused (`started` true when it held the gate).
fn worker_started(home: &Path) -> bool {
    let bun = find_bun();
    let output = Command::new(&bun)
        .args([
            "test/fixtures/desktop-update/admission-worker.ts",
            home.to_str().unwrap(),
            "launch",
        ])
        .current_dir(repo_root())
        .output()
        .expect("spawn admission worker");
    assert!(
        output.status.success(),
        "worker failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("worker stdout parses as JSON");
    value["started"].as_bool().unwrap_or(false)
}

fn blocking_kinds(res: &reservation::Reservation) -> Vec<(String, String)> {
    res.blockers
        .iter()
        .map(|b| (b.kind.clone(), b.id.clone()))
        .collect()
}

#[test]
fn idle_reserve_and_release_round_trip() {
    let home = Home::new();
    let reserved = reservation::reserve_idle(home.path(), "tx-a", DEADLINE).unwrap();
    assert!(reserved.reserved, "fresh home reserves");
    assert_eq!(reserved.owner.as_deref(), Some("tx-a"));
    assert_eq!(blocking_kinds(&reserved), Vec::<(String, String)>::new());

    // Same owner may re-entrantly observe its own reservation.
    let again = reservation::reserve_idle(home.path(), "tx-a", DEADLINE).unwrap();
    assert!(again.reserved);

    // A different owner conflicts while tx-a holds the reservation.
    let err = reservation::reserve_idle(home.path(), "tx-b", DEADLINE).unwrap_err();
    assert!(err.to_string().contains("Desktop reservation conflict"));
    assert_eq!(reservation_of(home.path()).as_deref(), Some("tx-a"));

    // Releasing tx-a clears it; the home is idle again.
    reservation::release_reservation(home.path(), &reserved).unwrap();
    assert_eq!(reservation_of(home.path()), None);
    let after = reservation::reserve_idle(home.path(), "tx-b", DEADLINE).unwrap();
    assert!(after.reserved);
}

#[test]
fn pending_lease_blocks_reservation_until_cleared() {
    let home = Home::new();
    write_state(home.path(), None, vec![lease("lease-1")]);
    let res = reservation::reserve_idle(home.path(), "tx-a", DEADLINE).unwrap();
    assert!(!res.reserved, "an outstanding lease blocks");
    assert!(
        res.blockers
            .iter()
            .any(|b| b.kind == "launch" && b.id == "lease-1")
    );

    // Reconciliation without positive completion evidence keeps the lease, so a
    // parent crash stays blocking (the lease is not orca-bound and never
    // dropped).
    reservation::reconcile_admission(home.path(), 0.0).unwrap();
    let still = reservation::reserve_idle(home.path(), "tx-a", DEADLINE).unwrap();
    assert!(!still.reserved);

    // Clearing the lease restores idle.
    write_state(home.path(), None, vec![]);
    let clear = reservation::reserve_idle(home.path(), "tx-a", DEADLINE).unwrap();
    assert!(clear.reserved);
}

#[test]
fn reservation_survives_reconciliation() {
    let home = Home::new();
    let reserved = reservation::reserve_idle(home.path(), "tx-a", DEADLINE).unwrap();
    assert!(reserved.reserved);
    // Reconciliation must not clear a reservation.
    reservation::reconcile_admission(home.path(), 0.0).unwrap();
    assert_eq!(reservation_of(home.path()).as_deref(), Some("tx-a"));
    // A lease started afterwards still sees the reservation held.
    write_state(home.path(), Some("tx-a"), vec![]);
    let err = reservation::reserve_idle(home.path(), "tx-other", DEADLINE).unwrap_err();
    assert!(err.to_string().contains("Desktop reservation conflict"));
}

#[test]
fn completed_finished_and_queued_tasks_permit_idle_but_running_blocks() {
    let home = Home::new();
    // A running task blocks.
    write_json(home.path(), "tasks/run-1.json", &task("run-1", "running"));
    let res = reservation::reserve_idle(home.path(), "tx-a", DEADLINE).unwrap();
    assert!(!res.reserved);
    assert!(
        res.blockers
            .iter()
            .any(|b| b.kind == "task" && b.id == "run-1")
    );

    // A done task (awaiting review) permits idle.
    let clean = Home::new();
    write_json(
        clean.path(),
        "tasks/record-a.json",
        &task("record-a", "done"),
    );
    let allowed = reservation::reserve_idle(clean.path(), "tx-a", DEADLINE).unwrap();
    assert!(allowed.reserved, "settled task leaves the gate open");
}

#[test]
fn queued_work_rules_block_without_reason_but_permit_with_valid_reason() {
    // A queued task with no queue object (or a null one) is not resumable
    // and blocks idle, matching TS `state === "queued" && !task.queue`.
    let no_reason = Home::new();
    write_json(
        no_reason.path(),
        "tasks/base.json",
        &queued_task("base", serde_json::Value::Null),
    );
    let res = reservation::reserve_idle(no_reason.path(), "tx-a", DEADLINE).unwrap();
    assert!(!res.reserved, "queued task without a reason blocks");
    assert!(
        res.blockers
            .iter()
            .any(|b| b.kind == "task" && b.id == "base")
    );

    // A queued task with a valid queue reason (paused, since, position) is on
    // the resume path and leaves the gate open.
    let with_reason = Home::new();
    write_json(
        with_reason.path(),
        "tasks/should-pass.json",
        &queued_task(
            "should-pass",
            json!({ "reason": "paused", "since": 100.0, "position": 1 }),
        ),
    );
    let allowed = reservation::reserve_idle(with_reason.path(), "tx-a", DEADLINE).unwrap();
    assert!(
        allowed.reserved,
        "queued task with a valid reason permits idle"
    );

    // A queued task with an unsupported queue reason fails validation and
    // needs recovery (a blocker), like the TS parse.
    let bad_reason = Home::new();
    write_json(
        bad_reason.path(),
        "tasks/future.json",
        &queued_task(
            "future",
            json!({ "reason": "future-state", "since": 100.0, "position": 1 }),
        ),
    );
    let res = reservation::reserve_idle(bad_reason.path(), "tx-a", DEADLINE).unwrap();
    assert!(
        !res.reserved,
        "unsupported queue reason needs recovery and blocks"
    );
}

/// A stored task in the `queued` state with an optional `queue` object. The
/// `id` must match the fixture file stem (`parse_stored_task` requires it).
fn queued_task(id: &str, queue: serde_json::Value) -> serde_json::Value {
    json!({
        "id": id,
        "state": "queued",
        "brief": { "goal": "Work", "repo": "/repo" },
        "title": "Queued",
        "attempts": [],
        "queue": queue
    })
}

#[test]
fn terminal_closure_proof_requires_explicit_closed_evidence() {
    use pacer_desktop_admission::blockers::terminal_closure_proof;

    // Positive evidence: connected=false, writable=false, operator_close.
    let closed = json!({
        "ok": true,
        "result": {
            "terminal": {
                "handle": "term-1",
                "incarnationId": "inc-1",
                "connected": false,
                "writable": false,
                "exitCause": { "kind": "operator_close" }
            }
        }
    });
    assert!(terminal_closure_proof(&closed, "term-1", "inc-1"));

    // A still-connected terminal is not proof of closure.
    let live = json!({
        "ok": true,
        "result": {
            "terminal": {
                "handle": "term-1",
                "incarnationId": "inc-1",
                "connected": true,
                "writable": false,
                "exitCause": { "kind": "operator_close" }
            }
        }
    });
    assert!(!terminal_closure_proof(&live, "term-1", "inc-1"));

    // A closure proof for a different handle or incarnation must be rejected.
    assert!(!terminal_closure_proof(&closed, "term-other", "inc-1"));
    assert!(!terminal_closure_proof(&closed, "term-1", "inc-other"));

    // Missing connected/writable (null or absent) is not explicit false and
    // must fail closed rather than proving closure.
    let null_flags = json!({
        "ok": true,
        "result": {
            "terminal": {
                "handle": "term-1",
                "incarnationId": "inc-1",
                "connected": serde_json::Value::Null,
                "writable": serde_json::Value::Null,
                "exitCause": { "kind": "operator_close" }
            }
        }
    });
    assert!(!terminal_closure_proof(&null_flags, "term-1", "inc-1"));

    // An empty incarnation is a degenerate proof (no identity).
    assert!(!terminal_closure_proof(&closed, "term-1", ""));
}

#[test]
fn surviving_run_pty_blocks_even_without_viewers() {
    let home = Home::new();
    // A run attempt with a PID and no completion receipt is an unclosed session.
    mkdir(home.path(), "runs/task-a/1");
    write_str(home.path(), "runs/task-a/1/pid", "1234");
    write_str(
        home.path(),
        "runs/task-a/1/session.state",
        r#"{"viewers": 0}"#,
    );
    let res = reservation::reserve_idle(home.path(), "tx-a", DEADLINE).unwrap();
    assert!(!res.reserved);
    assert!(
        res.blockers
            .iter()
            .any(|b| b.kind == "session" && b.id == "task-a/1")
    );
}

#[test]
fn finished_run_with_exit_file_is_not_a_blocker() {
    let home = Home::new();
    mkdir(home.path(), "runs/task-a/1");
    write_str(home.path(), "runs/task-a/1/exit", "0\n");
    let res = reservation::reserve_idle(home.path(), "tx-a", DEADLINE).unwrap();
    assert!(res.reserved, "a completed run is not a blocker");
}

#[test]
fn malformed_or_unsupported_records_never_establish_idle() {
    for (path, value) in [
        ("tasks/malformed.json", json!({})),
        ("tasks/future.json", json!({ "state": "unexpected" })),
        ("state/jobs/malformed.json", json!({})),
        ("state/jobs/future.json", json!({ "state": "future" })),
    ] {
        let home = Home::new();
        write_json(home.path(), path, &value);
        let res = reservation::reserve_idle(home.path(), "tx-a", DEADLINE).unwrap();
        assert!(!res.reserved, "{path} must block idle");
    }
}

#[test]
fn running_operation_blocks_and_settled_operation_permits() {
    // Running job blocks.
    let running = Home::new();
    write_json(
        running.path(),
        "state/jobs/op-1.json",
        &job("op-1", "host.check", "running"),
    );
    let res = reservation::reserve_idle(running.path(), "tx-a", DEADLINE).unwrap();
    assert!(!res.reserved);
    assert!(
        res.blockers
            .iter()
            .any(|b| b.kind == "operation" && b.id == "op-1")
    );

    // A passed job leaves the gate open.
    let settled = Home::new();
    write_json(
        settled.path(),
        "state/jobs/op-2.json",
        &job("op-2", "host.check", "passed"),
    );
    let allowed = reservation::reserve_idle(settled.path(), "tx-a", DEADLINE).unwrap();
    assert!(allowed.reserved);
}

#[test]
fn malformed_orca_state_cannot_establish_idle() {
    for value in [
        json!({}),
        json!({ "workers": [] }),
        json!({ "coordinator": null, "run": null, "workers": { "worker": {} } }),
    ] {
        let home = Home::new();
        write_json(home.path(), "orca.json", &value);
        let res = reservation::reserve_idle(home.path(), "tx-a", DEADLINE).unwrap();
        assert!(!res.reserved, "malformed orca state must block");
    }
}

#[test]
fn old_completion_cannot_release_a_new_lease_in_a_reused_directory() {
    // A lease bound to a run directory is cleared only on its exact receipt.
    let home = Home::new();
    mkdir(home.path(), "runs/reuse/1");
    let dir = home.path().join("runs").join("reuse").join("1");
    // The run finished but carries the wrong receipt, so the lease survives.
    write_str(home.path(), "runs/reuse/1/exit", "0\n");
    write_str(home.path(), "runs/reuse/1/admission.complete", "old\n");
    write_state(
        home.path(),
        None,
        vec![json!({
            "id": "current",
            "blocker": { "kind": "launch", "id": "current", "label": "Current" },
            "owner": "inc0", "state": "active",
            "runDir": dir.to_string_lossy()
        })],
    );
    let res = reservation::reserve_idle(home.path(), "tx-a", DEADLINE).unwrap();
    assert!(!res.reserved, "stale receipt keeps the current lease");

    // The matching receipt clears it.
    write_str(home.path(), "runs/reuse/1/admission.complete", "current\n");
    let clear = reservation::reserve_idle(home.path(), "tx-a", DEADLINE).unwrap();
    assert!(clear.reserved);
}

#[test]
fn enrolled_work_processes_lists_only_lease_incarnations() {
    let empty = Home::new();
    assert_eq!(reservation::enrolled_work_processes(empty.path()).len(), 0);

    let home = Home::new();
    write_state(
        home.path(),
        None,
        vec![
            lease("a"),
            json!({
                "id": "b",
                "blocker": { "kind": "launch", "id": "b", "label": "B" },
                "owner": "inc0",
                "process": { "pid": 999, "bootId": "boot-2", "birth": "1:1" },
                "state": "active"
            }),
            json!({ "id": "no-process", "blocker": { "kind": "launch", "id": "x", "label": "X" }, "owner": "inc0", "state": "pending" }),
        ],
    );
    let identities = reservation::enrolled_work_processes(home.path());
    assert_eq!(identities.len(), 2, "process-less leases are skipped");
    let pids: Vec<i64> = identities.iter().map(|i| i.pid).collect();
    assert!(pids.contains(&1234));
    assert!(pids.contains(&999));
}

#[test]
fn cross_runtime_ts_lease_refuses_rust_reservation_with_ts_message() {
    // A TypeScript process begins a launch via `beginWorkSync`, leaving a
    // lease on disk. The Rust gate must see that exact lease and refuse.
    let home = Home::new();
    assert!(worker_started(home.path()), "TS launch holds the gate");
    let res = reservation::reserve_idle(home.path(), "tx-rust", DEADLINE).unwrap();
    assert!(!res.reserved, "a TS-held lease blocks the Rust reservation");
    // "TS's message" is the blocker the lease carries (kind launch, id worker).
    assert!(
        res.blockers
            .iter()
            .any(|b| b.kind == "launch" && b.id == "worker"),
        "blockers must surface the TS lease: {:?}",
        res.blockers
    );
}
