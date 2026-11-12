#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{Blocker, BlockerKind, WorkLease, begin_blocker};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("pacer-lease-guards-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        Self(p)
    }
    fn database(&self) -> PathBuf {
        self.0.join("desktop-updates/admission.sqlite")
    }
    fn state(&self) -> Value {
        let db = rusqlite::Connection::open(self.database()).unwrap();
        let raw: String = db
            .query_row("SELECT state FROM admission WHERE id=1", [], |r| r.get(0))
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }
    fn write_state(&self, state: &Value) {
        rusqlite::Connection::open(self.database())
            .unwrap()
            .execute(
                "UPDATE admission SET state=? WHERE id=1",
                [state.to_string()],
            )
            .unwrap();
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn oracle(input: Value) -> Value {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut child = Command::new("bun")
        .arg("test/fixtures/work-lease-oracle.ts")
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn closure_truthiness_and_handle_presence_match_actual_typescript_and_persist() {
    let closes = [
        None,
        Some(Value::Null),
        Some(json!(false)),
        Some(json!(0)),
        Some(json!(-0.0)),
        Some(json!("")),
        Some(json!(true)),
        Some(json!(1)),
        Some(json!("close")),
        Some(json!([])),
        Some(json!({})),
        Some(json!({"ptyKilled":true})),
        Some(json!({"handle":null,"ptyKilled":true})),
        Some(json!({"handle":"terminal","ptyKilled":true})),
        Some(json!({"handle":"foreign","ptyKilled":true})),
        Some(json!({"handle":"terminal","ptyKilled":1})),
        Some(json!({"handle":"terminal","ptyKilled":false})),
        Some(json!({"handle":"terminal"})),
    ];
    let mut cases = vec![];
    for terminal in [None, Some("terminal")] {
        for close in &closes {
            let mut reply = json!({"ok":true,"result":{"dispatchId":"dispatch","state":"stopped","processAction":"closed_agent_terminal"}});
            if let Some(close) = close {
                reply["result"]["close"] = close.clone();
            }
            cases.push(json!({"reply":reply,"dispatchId":"dispatch","terminal":terminal}));
        }
        for (field, value) in [
            ("dispatchId", json!("foreign")),
            ("state", json!("running")),
            ("processAction", json!("kept_terminal")),
        ] {
            let mut reply = json!({"ok":true,"result":{"dispatchId":"dispatch","state":"released","processAction":"closed_agent_terminal"}});
            reply["result"][field] = value;
            cases.push(json!({"reply":reply,"dispatchId":"dispatch","terminal":terminal}));
        }
        cases.push(json!({"reply":{"ok":false,"result":{"dispatchId":"dispatch","state":"released","processAction":"closed_agent_terminal"}},"dispatchId":"dispatch","terminal":terminal}));
        cases.push(json!({"reply":{"ok":true,"result":{"dispatchId":"dispatch","state":"released","processAction":"closed_agent_terminal"}},"dispatchId":"dispatch","terminal":terminal}));
    }
    let expected = oracle(json!({"proofs":cases}));
    let mut mismatches = vec![];
    for (index, case) in cases.iter().enumerate() {
        let home = Home::new();
        let lease = WorkLease::begin(&home.0, "task", "fixture").unwrap();
        lease
            .bind_orca("dispatch", case["terminal"].as_str(), Some("birth"))
            .unwrap();
        let before = home.state();
        let want = expected["proofs"][index].as_bool().unwrap();
        let actual = lease.finish_orca(&case["reply"]).unwrap();
        let after = home.state();
        if actual != want
            || (want && !after["leases"].as_array().unwrap().is_empty())
            || (!want && after != before)
        {
            mismatches.push(json!({"index":index,"case":case,"expected":want,"actual":actual,"persisted":after}));
        }
    }
    assert!(mismatches.is_empty(), "{}", json!(mismatches));
}

#[test]
fn uuid_sentinel_case_matches_pinned_zod_without_rejecting_normal_uppercase() {
    let values = [
        "00000000-0000-0000-0000-000000000000",
        "ffffffff-ffff-ffff-ffff-ffffffffffff",
        "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
        "fFFFFFFF-ffff-ffff-ffff-ffffffffffff",
        "ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF",
        "abcdefab-cdef-4abc-8abc-abcdefabcdef",
        "abcdefab-cdef-0abc-8abc-abcdefabcdef",
    ];
    let expected = oracle(json!({"uuids":values}));
    let mut mismatches = vec![];
    for field in ["id", "owner"] {
        for (index, value) in values.iter().enumerate() {
            let home = Home::new();
            WorkLease::begin(&home.0, "task", "fixture").unwrap();
            let mut state = home.state();
            state["leases"][0][field] = json!(value);
            home.write_state(&state);
            let accepted = WorkLease::begin(&home.0, "next", "fixture").is_ok();
            let want = expected["uuids"][index].as_bool().unwrap();
            if accepted != want {
                mismatches
                    .push(json!({"field":field,"uuid":value,"expected":want,"actual":accepted}));
            }
            if !want {
                assert_eq!(home.state(), state);
            }
        }
    }
    assert!(mismatches.is_empty(), "{}", json!(mismatches));
}

#[test]
fn empty_blocker_is_rejected_before_any_new_or_existing_admission_write() {
    let ts_home = Home::new();
    assert_eq!(
        oracle(json!({"emptyBlockerHome":ts_home.0}))["emptyBlocker"],
        json!({"code":"invalid_input","created":false})
    );
    let invalid = || Blocker {
        kind: BlockerKind::Session,
        id: String::new(),
        label: "invalid".into(),
    };
    let fresh = Home::new();
    assert!(begin_blocker(&fresh.0, invalid()).is_err());
    assert_eq!(fs::read_dir(&fresh.0).unwrap().count(), 0);
    let existing = Home::new();
    WorkLease::begin(&existing.0, "task", "kept").unwrap();
    let before = fs::read(existing.database()).unwrap();
    assert!(begin_blocker(&existing.0, invalid()).is_err());
    assert_eq!(fs::read(existing.database()).unwrap(), before);
}

#[test]
fn dangling_sidecars_are_rejected_without_committing_a_lease_or_touching_target() {
    let mut accepted = vec![];
    for suffix in ["-journal", "-wal", "-shm"] {
        let home = Home::new();
        WorkLease::begin(&home.0, "task", "kept").unwrap();
        let state = home.state();
        let target = home.0.join("missing-target");
        let sidecar = PathBuf::from(format!("{}{suffix}", home.database().display()));
        symlink(&target, &sidecar).unwrap();
        if WorkLease::begin(&home.0, "next", "must reject").is_ok() {
            accepted.push(suffix);
        }
        assert!(!target.exists());
        assert!(
            fs::symlink_metadata(&sidecar)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        fs::remove_file(&sidecar).unwrap();
        assert_eq!(
            home.state(),
            state,
            "sidecar {suffix} changed durable leases"
        );
    }
    assert!(
        accepted.is_empty(),
        "dangling sidecars accepted: {accepted:?}"
    );
}

#[test]
fn sidecar_preflight_keeps_live_foreign_links_and_public_files_out() {
    for suffix in ["-journal", "-wal", "-shm"] {
        for link in [false, true] {
            let home = Home::new();
            let foreign = Home::new();
            WorkLease::begin(&home.0, "task", "kept").unwrap();
            let state = home.state();
            let sidecar = PathBuf::from(format!("{}{suffix}", home.database().display()));
            let target = foreign.0.join("untouched");
            fs::write(&target, b"foreign fixture").unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
            if link {
                symlink(&target, &sidecar).unwrap();
            } else {
                fs::write(&sidecar, b"").unwrap();
                fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o644)).unwrap();
            }
            assert!(WorkLease::begin(&home.0, "next", "must reject").is_err());
            assert_eq!(fs::read(&target).unwrap(), b"foreign fixture");
            fs::remove_file(&sidecar).unwrap();
            assert_eq!(home.state(), state);
        }
    }
}

#[test]
fn regular_private_sidecar_is_admitted() {
    for suffix in ["-journal", "-wal", "-shm"] {
        let home = Home::new();
        WorkLease::begin(&home.0, "task", "first").unwrap();
        let sidecar = PathBuf::from(format!("{}{suffix}", home.database().display()));
        fs::write(&sidecar, b"").unwrap();
        fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o600)).unwrap();
        WorkLease::begin(&home.0, "next", "allowed").unwrap();
        assert_eq!(home.state()["leases"].as_array().unwrap().len(), 2);
    }
}
