//! Reconciliation-fence tests, porting the in-scope rationales of
//! `test/desktop-reconciliation-admission.test.ts` that exercise the Rust
//! library (`read_fence`, `reserve_fence`, `release_fence`). The
//! two-process race is represented by its single-process CAS invariants: a
//! fence can be taken exactly once at an epoch, a stale or foreign hold is
//! rejected, and a lost or unversioned fence fails closed across a restart.
#![allow(clippy::unwrap_used, clippy::expect_used)]
mod common;
use common::Home;
use pacer_desktop_admission::{AdmissionError, coordinator, fence};
use serde_json::json;
use std::path::Path;

fn exec(home: &Path, sql: &str) {
    coordinator::with_coordinator(home, |tx| {
        tx.execute_batch(sql)
            .map(|_| ())
            .map_err(AdmissionError::from)
    })
    .expect("exec sql");
}

/// A fresh, empty home reserves once, then rejects a stale re-reserve.
#[test]
fn reserve_then_stale_cas_rejected() {
    let home = Home::new();
    let held = fence::reserve_fence(home.path(), 0, "tx-a").unwrap();
    assert_eq!(held.epoch, 1, "reserve advances the epoch");
    assert_eq!(held.transaction.as_deref(), Some("tx-a"));
    assert!(held.owner.is_some(), "fence records its process owner");

    // A second process at the same epoch loses the CAS.
    let err = fence::reserve_fence(home.path(), 0, "stale").unwrap_err();
    assert!(
        err.to_string().contains("fence conflict"),
        "stale CAS fails: {err}"
    );

    // The winning owner releases itself, returning a free fetch slot.
    let free = fence::release_fence(home.path(), &held).unwrap();
    assert!(free.owner.is_none());
    assert_eq!(free.epoch, 2);
    // Re-reserving at the released epoch works; at an already-passed epoch no.
    fence::reserve_fence(home.path(), 2, "tx-b").unwrap();
}

#[test]
fn release_rejects_a_rewritten_or_foreign_hold() {
    let home = Home::new();
    let held = fence::reserve_fence(home.path(), 0, "tx-a").unwrap();
    // Rewriting the held transaction changes the current fence; the original
    // snapshot is then stale and cannot be released.
    exec(
        home.path(),
        "UPDATE reconciliation_fence SET transaction_id = 'bogus' WHERE id = 1",
    );
    let now = fence::read_fence(home.path()).unwrap();
    assert_eq!(now.transaction.as_deref(), Some("bogus"));
    let err = fence::release_fence(home.path(), &held).unwrap_err();
    assert!(err.to_string().contains("fence conflict"));
    // Releasing the current snapshot works (the fence simply frees).
    fence::release_fence(home.path(), &now).unwrap();
}

#[test]
fn fence_and_work_are_mutually_exclusive() {
    // A held lease stops the fence being taken.
    let leased = Home::new();
    write_lease(&leased);
    let err = fence::reserve_fence(leased.path(), 0, "tx").unwrap_err();
    assert!(err.to_string().contains("active or reserved"));
    // Once the lease is gone, a reservation also stops the fence.
    write_state(&leased, Some("ota"));
    let err = fence::reserve_fence(leased.path(), 0, "tx").unwrap_err();
    assert!(err.to_string().contains("active or reserved"));
    // Clearing the reservation lets the fence be taken.
    write_state(&leased, None);
    fence::reserve_fence(leased.path(), 0, "tx").unwrap();
}

#[test]
fn held_fence_blocks_reservation_and_work() {
    let home = Home::new();
    let held = fence::reserve_fence(home.path(), 0, "tx").unwrap();
    // A reservation while the fence is held refuses with the maintenance
    // message.
    let err = reservation_reserve(home.path(), "ota");
    assert!(err.is_err());
    let err = err.unwrap_err();
    assert!(
        err.to_string()
            .contains("Reconciliation maintenance is reserved"),
        "held fence blocks reservation: {err}"
    );
    // A new fence re-reserve at the same epoch is refused (maintenance held).
    let err = fence::reserve_fence(home.path(), 1, "again").unwrap_err();
    assert!(err.to_string().contains("fence conflict"));
    fence::release_fence(home.path(), &held).unwrap();
}

#[test]
fn orca_state_present_prevents_fence_acquisition() {
    // Orca state requires asynchronous inspection, so its presence makes a
    // synchronous fence acquisition unprovable.
    for value in [
        json!({}),
        json!({ "coordinator": "c", "run": "r", "workers": {} }),
    ] {
        let home = Home::new();
        write_json(&home, "orca.json", &value);
        let err = fence::reserve_fence(home.path(), 0, "tx").unwrap_err();
        assert!(err.to_string().contains("fence conflict"));
    }
}

#[test]
fn lost_fence_table_fails_closed_across_restart() {
    let home = Home::new();
    let _held = fence::reserve_fence(home.path(), 0, "held").unwrap();
    exec(home.path(), "DROP TABLE reconciliation_fence");
    // user_version still marks the fence as shipped, so the missing table is
    // an ambiguity that fails closed.
    assert!(fence::read_fence(home.path()).is_err());
    assert!(fence::reserve_fence(home.path(), 0, "new").is_err());
}

#[test]
fn lost_fence_row_fails_closed_across_restart() {
    let home = Home::new();
    let _held = fence::reserve_fence(home.path(), 0, "held").unwrap();
    exec(home.path(), "DELETE FROM reconciliation_fence");
    assert!(fence::read_fence(home.path()).is_err());
}

#[test]
fn admission_row_loss_and_table_loss_fail_closed() {
    // A held fence plus a lost admission row or table must never permit a new
    // fence or reservation: the dispatch gate depends on the admission being
    // decodable, so its loss is an ambiguity that fails closed.
    for sql in ["DELETE FROM admission", "DROP TABLE admission"] {
        let home = Home::new();
        let _held = fence::reserve_fence(home.path(), 0, "tx").unwrap();
        exec(home.path(), sql);
        // Fence acquisition re-checks the admission row (mutual exclusion), so
        // the loss is visible and fails the take closed.
        let err = fence::reserve_fence(home.path(), 1, "again").unwrap_err();
        assert!(
            err.to_string().contains("admission"),
            "lost admission ({sql}) fails the fence close: {err}"
        );
        // A fresh reservation must also be refused.
        let err = reservation(home.path(), "ota").unwrap_err();
        assert!(
            err.to_string().contains("admission"),
            "lost admission ({sql}) fails reservation close: {err}"
        );
    }
}

#[test]
fn unversioned_fence_is_ambiguous() {
    let home = Home::new();
    fence::reserve_fence(home.path(), 0, "old").unwrap();
    // Dropping the version stamp while the row survives is ambiguous.
    exec(home.path(), "PRAGMA user_version = 0");
    assert!(fence::read_fence(home.path()).is_err());
}

#[test]
fn out_of_range_stored_epoch_fails_closed() {
    // A stored epoch outside the TS `rowSchema` bounds (non-negative safe
    // integer) must fail closed on read, not be accepted as evidence.
    for bad in ["-1", "9007199254740992", "9223372036854775807"] {
        let home = Home::new();
        fence::reserve_fence(home.path(), 0, "tx").unwrap();
        // Clamp the stored epoch to a corrupt value; the parsed struct below
        // is only a scalar write, so use SQL directly.
        exec(
            home.path(),
            &format!("UPDATE reconciliation_fence SET epoch = {bad} WHERE id = 1"),
        );
        assert!(
            fence::read_fence(home.path()).is_err(),
            "epoch {bad} must fail closed on read"
        );
    }
    // A valid stored epoch (0, and MAX_SAFE) still reads back.
    for good in ["0", "9007199254740991"] {
        let home = Home::new();
        fence::reserve_fence(home.path(), 0, "tx").unwrap();
        exec(
            home.path(),
            &format!("UPDATE reconciliation_fence SET epoch = {good} WHERE id = 1"),
        );
        assert!(
            fence::read_fence(home.path()).is_ok(),
            "epoch {good} must read back as valid"
        );
    }
}

#[test]
fn empty_unversioned_fence_table_is_ambiguous() {
    let home = Home::new();
    // A fence table with no row and never-advanced version is ambiguous.
    exec(
        home.path(),
        "CREATE TABLE reconciliation_fence (id INTEGER PRIMARY KEY)",
    );
    assert!(fence::read_fence(home.path()).is_err());
}

#[test]
fn legacy_fresh_admission_preserved_by_explicit_fence_init() {
    // A legacy home (bare admission row, no fence) is initialized on demand;
    // the fence starts free and preserves the admission row.
    let home = Home::new();
    coordinator::with_coordinator(home.path(), |tx| {
        tx.execute_batch("CREATE TABLE admission (id INTEGER PRIMARY KEY, state TEXT NOT NULL)")
            .map_err(AdmissionError::from)?;
        tx.execute(
            "INSERT INTO admission VALUES (1, ?)",
            [
                json!({ "schema": 1, "reservation": serde_json::Value::Null, "leases": [] })
                    .to_string(),
            ],
        )
        .map(|_| ())
        .map_err(AdmissionError::from)
    })
    .expect("seed legacy admission");
    let free = fence::read_fence(home.path()).unwrap();
    assert!(free.owner.is_none());
    assert_eq!(free.transaction, None);
    assert_eq!(free.epoch, 0);
}

/// Seed a single active lease into `home`.
fn write_lease(home: &Home) {
    use pacer_desktop_admission::state;
    coordinator::with_coordinator(home.path(), |tx| {
        let mut state = state::read_admission(tx, true).expect("read");
        state.leases = vec![json!({
            "id": "lease-1",
            "blocker": { "kind": "launch", "id": "lease-1", "label": "Lease" },
            "owner": "inc0", "state": "active"
        })];
        state::write_admission(tx, &state)
    })
    .expect("seed lease");
}

/// Seed the reservation field to `owner` and no leases.
fn write_state(home: &Home, owner: Option<&str>) {
    use pacer_desktop_admission::state;
    coordinator::with_coordinator(home.path(), |tx| {
        let mut state = state::read_admission(tx, true).expect("read");
        state.reservation = owner.map(str::to_owned);
        state.leases.clear();
        state::write_admission(tx, &state)
    })
    .expect("seed reservation");
}

/// Call `reserve_idle`, returning its error (it refuses while the fence is
/// held).
fn reservation_reserve(home: &Path, owner: &str) -> Result<(), AdmissionError> {
    reservation(home, owner).map(|_| ())
}

fn reservation(home: &Path, owner: &str) -> Result<bool, AdmissionError> {
    use pacer_desktop_admission::reservation;
    let result = reservation::reserve_idle(home, owner, std::time::Duration::from_millis(200))?;
    Ok(result.reserved)
}

fn write_json(home: &Home, path: &str, value: &serde_json::Value) {
    common::write_json(home.path(), path, value);
}
