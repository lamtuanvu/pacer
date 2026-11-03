#![allow(clippy::unwrap_used)]
use pacer_plugin_runtime::WorkLease;
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
fn commits(home: &Home) -> u32 {
    fs::read(home.0.join("desktop-updates/admission.sqlite"))
        .ok()
        .filter(|b| b.len() >= 28)
        .map_or(0, |b| u32::from_be_bytes([b[24], b[25], b[26], b[27]]))
}
fn seed_foreign(home: &Home, row: Value) {
    let mut state = home.state();
    state["leases"].as_array_mut().unwrap().push(row);
    let mut db =
        rusqlite::Connection::open(home.0.join("desktop-updates/admission.sqlite")).unwrap();
    let tx = db.transaction().unwrap();
    tx.execute(
        "UPDATE admission SET state=? WHERE id=1",
        [state.to_string()],
    )
    .unwrap();
    tx.commit().unwrap();
}
#[test]
fn explicit_blocker_is_stored_exactly_and_begin_keeps_session() {
    use pacer_plugin_runtime::{Blocker, BlockerKind};
    let home = Home::new();
    let kinds = [
        (BlockerKind::Task, "task"),
        (BlockerKind::Session, "session"),
        (BlockerKind::Launch, "launch"),
        (BlockerKind::Operation, "operation"),
    ];
    let mut owner = None;
    for (index, (kind, text)) in kinds.into_iter().enumerate() {
        assert_eq!(kind.as_str(), text);
        let id = format!("blocker-{text}");
        let label = format!("Label {text}");
        let lease = WorkLease::begin_blocker(
            &home.0,
            Blocker {
                kind,
                id: &id,
                label: &label,
            },
        )
        .unwrap();
        let row = home.state()["leases"][index].clone();
        assert_eq!(row["blocker"], json!({"kind":text,"id":id,"label":label}));
        assert_eq!(row["id"], lease.id());
        assert_ne!(row["id"], json!(id));
        assert!(uuid::Uuid::parse_str(lease.id()).is_ok());
        assert_eq!(row["state"], "pending");
        assert_eq!(row["process"], Value::Null);
        assert_eq!(*owner.get_or_insert(row["owner"].clone()), row["owner"]);
    }
    WorkLease::begin(&home.0, "task", "Orca task").unwrap();
    let state = home.state();
    assert_eq!(
        state["leases"][4]["blocker"],
        json!({"kind":"session","id":"task","label":"Orca task"})
    );
    let c0 = commits(&home);
    assert!(
        WorkLease::begin_blocker(
            &home.0,
            Blocker {
                kind: BlockerKind::Operation,
                id: "",
                label: "x"
            }
        )
        .is_err()
    );
    assert_eq!(commits(&home), c0);
    assert_eq!(home.state(), state);
}
#[test]
fn finish_preserves_unrelated_and_foreign_leases() {
    let home = Home::new();
    let u1 = WorkLease::begin(&home.0, "unrelated-task", "Unrelated session").unwrap();
    let foreign_owner = uuid::Uuid::new_v4().to_string();
    let u2 = json!({"id":uuid::Uuid::new_v4().to_string(),"blocker":{"kind":"task","id":"foreign","label":"Foreign"},"owner":foreign_owner,"process":null,"state":"pending"});
    seed_foreign(&home, u2.clone());
    let before = home.state();
    let a = WorkLease::begin(&home.0, "lease-a", "Lease A").unwrap();
    a.finish().unwrap();
    assert_eq!(home.state(), before);
    assert_eq!(before["leases"][0]["id"], u1.id());
    assert_eq!(before["leases"][1], u2);
    let mut impostor = u2.clone();
    impostor["id"] = json!(a.id());
    seed_foreign(&home, impostor);
    let seeded = home.state();
    assert!(a.finish().is_err());
    assert_eq!(home.state(), seeded);
}
