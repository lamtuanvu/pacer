#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{Blocker, BlockerKind, WorkLease, begin_blocker};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
};

struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("pacer-work-lease-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        Self(p)
    }
    fn state(&self) -> Value {
        let db =
            rusqlite::Connection::open(self.0.join("desktop-updates/admission.sqlite")).unwrap();
        let s: String = db
            .query_row("SELECT state FROM admission WHERE id=1", [], |r| r.get(0))
            .unwrap();
        serde_json::from_str(&s).unwrap()
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn lease_uses_ts_schema_and_requires_exact_dispatch_terminal_closure_proof() {
    let home = Home::new();
    let lease = WorkLease::begin(&home.0, "task", "Orca task").unwrap();
    lease
        .bind_orca("dispatch", Some("terminal"), Some("incarnation"))
        .unwrap();
    let state = home.state();
    assert_eq!(state["schema"], 1);
    assert_eq!(state["leases"][0]["state"], "pending");
    for proof in [
        json!({"ok":false}),
        json!({"ok":true,"result":{"dispatchId":"dispatch","state":"succeeded"}}),
        json!({"ok":true,"result":{"dispatchId":"foreign","state":"released","processAction":"closed_agent_terminal"}}),
        json!({"ok":true,"result":{"dispatchId":"dispatch","state":"released","processAction":"closed_agent_terminal","close":{"handle":"foreign","ptyKilled":true}}}),
    ] {
        assert!(!lease.finish_orca(&proof).unwrap());
        assert_eq!(home.state()["leases"].as_array().unwrap().len(), 1);
    }
    assert!(lease.finish_orca(&json!({"ok":true,"result":{"dispatchId":"dispatch","state":"released","processAction":"closed_agent_terminal","close":{"handle":"terminal","ptyKilled":true}}})).unwrap());
    assert!(home.state()["leases"].as_array().unwrap().is_empty());
    assert_eq!(
        fs::metadata(home.0.join("desktop-updates/admission.sqlite"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn reservation_and_corrupt_state_never_reset_pending_work() {
    let home = Home::new();
    let lease = WorkLease::begin(&home.0, "task", "pending").unwrap();
    let mut state = home.state();
    state["reservation"] = json!("maintenance");
    let db = rusqlite::Connection::open(home.0.join("desktop-updates/admission.sqlite")).unwrap();
    db.execute("UPDATE admission SET state=?", [state.to_string()])
        .unwrap();
    assert!(WorkLease::begin(&home.0, "second", "no").is_err());
    assert_eq!(home.state(), state);
    db.execute("UPDATE admission SET state='bad'", []).unwrap();
    assert!(lease.finish().is_err());
    let raw: String = db
        .query_row("SELECT state FROM admission", [], |r| r.get(0))
        .unwrap();
    assert_eq!(raw, "bad");
}

#[test]
fn coordinator_never_follows_a_foreign_directory_or_state_symlink() {
    let home = Home::new();
    let outside = home.0.join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, home.0.join("desktop-updates")).unwrap();
    assert!(WorkLease::begin(&home.0, "task", "label").is_err());
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
}

#[test]
fn explicit_blocker_is_stored_exactly_and_begin_keeps_session() {
    let home = Home::new();
    for kind in [
        BlockerKind::Task,
        BlockerKind::Session,
        BlockerKind::Launch,
        BlockerKind::Operation,
    ] {
        let lease = begin_blocker(
            &home.0,
            Blocker {
                kind,
                id: format!("blocker-{}", kind.as_str()),
                label: "test".into(),
            },
        )
        .unwrap();
        let state = home.state();
        let stored = &state["leases"][0]["blocker"];
        assert_eq!(stored["kind"], kind.as_str());
        assert_eq!(stored["id"], format!("blocker-{}", kind.as_str()));
        lease.finish().unwrap();
    }
    let lease = WorkLease::begin(&home.0, "session-task", "label").unwrap();
    let state = home.state();
    assert_eq!(state["leases"][0]["blocker"]["kind"], "session");
    lease.finish().unwrap();
}

#[test]
fn finish_preserves_unrelated_and_foreign_leases() {
    let home = Home::new();
    let lease1 = WorkLease::begin(&home.0, "task-1", "first").unwrap();
    let lease2 = WorkLease::begin(&home.0, "task-2", "second").unwrap();
    let state = home.state();
    assert_eq!(state["leases"].as_array().unwrap().len(), 2);
    lease1.finish().unwrap();
    let state = home.state();
    let leases = state["leases"].as_array().unwrap();
    assert_eq!(leases.len(), 1);
    assert_eq!(leases[0]["id"], lease2.id());
    let mut state = home.state();
    state["leases"].as_array_mut().unwrap().push(json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "blocker": {"kind": "task", "id": "foreign", "label": "foreign"},
        "owner": "different-owner",
        "process": null,
        "state": "pending",
    }));
    let db = rusqlite::Connection::open(home.0.join("desktop-updates/admission.sqlite")).unwrap();
    db.execute("UPDATE admission SET state=?", [state.to_string()])
        .unwrap();
    assert_eq!(home.state()["leases"].as_array().unwrap().len(), 2);
}
