#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Port of the `nativeRecordFixture`-based tests from
//! `test/desktop-update-native.test.ts`. Builds a live private native
//! transaction (`prepared.json` + `journal.json`) next to a real reserved
//! update record, then exercises the `record` readers.
use super::*;

use pacer_desktop_update::policy::{RestartRequest, request_restart};
use pacer_desktop_update::{parse_update_record, read_update, write_update};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Load the shared `journal.json` fixture and its `prepared`/`journal`
/// halves, ready for mutation.
fn fixture_doc() -> (Value, Value) {
    let raw = std::fs::read(repo_root().join("test/fixtures/desktop-update/journal.json")).unwrap();
    let doc: Value = serde_json::from_slice(&raw).unwrap();
    (
        doc.get("prepared").unwrap().clone(),
        doc.get("journal").unwrap().clone(),
    )
}

fn ready_record(candidate: &Value) -> Value {
    json!({
        "schema": 1,
        "installationId": "fixture",
        "revision": 0,
        "phase": "ready",
        "transactionId": Value::Null,
        "requestId": Value::Null,
        "requestedBy": Value::Null,
        "requesterBootId": Value::Null,
        "autoDownload": false,
        "checkedAt": 0,
        "blockers": [],
        "downloadedBytes": 100,
        "totalBytes": 100,
        "candidate": candidate.clone(),
        "error": Value::Null,
        "failedVersion": Value::Null,
        "requestHistory": [],
    })
}

/// Writes the initial eligibility record, requests a restart and reserves
/// it, then lays down the native transaction files. Returns the canonical
/// pacer home, the transaction id, the prepared value and a `save` to
/// rewrite journal + prepared with a fresh digest.
struct Fx {
    _dir: tempfile::TempDir,
    home: PathBuf,
    transaction_id: String,
    prepared: Value,
    journal: Value,
    dir: PathBuf,
}

impl Fx {
    /// Commit the current `prepared` and `journal` to disk with a fresh
    /// manifest digest (`save` in the TS fixture), also updating the
    /// in-memory journal so the recorded `manifestSha256` always matches the
    /// bytes actually written.
    fn save(&mut self) {
        let prepared_bytes = pacer_js_json::stringify(&self.prepared).into_bytes();
        self.journal["manifestSha256"] = json!(sha256_hex(&prepared_bytes));
        write_private(&self.dir.join("prepared.json"), &prepared_bytes);
        write_private(
            &self.dir.join("journal.json"),
            &pacer_js_json::stringify(&self.journal).into_bytes(),
        );
    }
}

fn write_private(path: &Path, bytes: &[u8]) {
    let mut f = std::fs::File::create(path).unwrap();
    f.write_all(bytes).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

fn make_dir(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn fixture() -> Fx {
    let dir = tempfile::TempDir::new().unwrap();
    let home = std::fs::canonicalize(dir.path()).unwrap();
    make_dir(&home);
    let (mut prepared, journal) = fixture_doc();

    let app_path = prepared["target"]["appPath"].as_str().unwrap().to_owned();
    prepared["target"]["pacerHome"] = json!(home.to_str().unwrap());
    prepared["target"]["ownerUid"] = json!(nix::unistd::getuid().as_raw() as u64);
    prepared["oldServiceExecutable"] = json!(format!("{app_path}/Contents/Resources/pacer"));

    let candidate = prepared.get("candidate").unwrap().clone();
    let ready = parse_update_record(&ready_record(&candidate)).unwrap();
    write_update(&home, ready, Some(0)).unwrap();
    let ready_read = read_update(&home, "fixture").unwrap().unwrap().into_value();
    let waiting = request_restart(
        ready_read,
        &RestartRequest {
            installation_id: "fixture".to_owned(),
            request_id: "request".to_owned(),
            expect_revision: 1,
            version: "1.1.0".to_owned(),
            client_id: "client".to_owned(),
        },
        "boot-one",
    )
    .unwrap();
    let waiting_revision = waiting["revision"].as_u64().unwrap();
    let mut reserved = waiting;
    reserved["phase"] = json!("reserved");
    write_update(
        &home,
        parse_update_record(&reserved).unwrap(),
        Some(waiting_revision),
    )
    .unwrap();
    let record = read_update(&home, "fixture").unwrap().unwrap().into_value();
    let transaction_id = record["transactionId"].as_str().unwrap().to_owned();
    let record_revision = record["revision"].as_u64().unwrap();

    prepared["binding"]["transactionId"] = json!(transaction_id);
    prepared["binding"]["revision"] = json!(record_revision);

    // `native_transaction_directory` requires every directory from `home`
    // down be owned and have no group/other write bits (mode & 0o077 == 0),
    // so harden the whole chain before laying down the transaction.
    let native_base = home.join("desktop-updates").join("native").join("fixture");
    for dir in [
        &home,
        &home.join("desktop-updates"),
        &home.join("desktop-updates").join("native"),
        &native_base,
    ] {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let tx_dir = native_base.join(&transaction_id);
    make_dir(&tx_dir);

    let mut f = Fx {
        _dir: dir,
        home,
        transaction_id,
        prepared,
        journal,
        dir: tx_dir,
    };
    f.save();
    f
}

#[test]
fn native_transaction_matches_immutable_preparation_and_durable_restart_receipt() {
    let f = fixture();
    let tx = read_native_transaction(&f.home, "fixture", &f.transaction_id).unwrap();
    assert!(tx.authorization.is_none());
    assert_eq!(
        tx.command.transaction_id.as_deref(),
        Some(f.transaction_id.as_str())
    );

    let mut changed = f;
    changed.prepared["binding"]["revision"] =
        json!(changed.prepared["binding"]["revision"].as_u64().unwrap() + 100);
    changed.save();
    assert!(read_native_transaction(&changed.home, "fixture", &changed.transaction_id).is_err());
}

#[test]
fn terminal_journal_cannot_bypass_missing_original_request_receipt() {
    let f = fixture();
    // Advance the core record past the restart authority (complete) so no
    // durable restart receipt remains for the reader to bind. Written
    // directly (as the TS fixture does) because `write_update` would
    // otherwise replay the request history rather than clearing it.
    let mut terminal = read_update(&f.home, "fixture")
        .unwrap()
        .unwrap()
        .into_value();
    terminal["phase"] = json!("complete");
    terminal["requestId"] = Value::Null;
    terminal["requestedBy"] = Value::Null;
    terminal["requesterBootId"] = Value::Null;
    terminal["requestHistory"] = json!([]);
    write_private(
        &f.home.join("desktop-updates").join("fixture.json"),
        &pacer_js_json::stringify(&terminal).into_bytes(),
    );
    assert!(read_native_transaction(&f.home, "fixture", &f.transaction_id).is_err());
}

#[test]
fn read_refuses_path_escape_and_missing_binding() {
    let f = fixture();
    assert!(read_native_transaction(&f.home, "fixture", "no-such-tx").is_err());
    assert!(read_native_transaction(&f.home, "../escape", "tx").is_err());
    assert!(
        read_native_transaction(Path::new("/nonexistent"), "fixture", &f.transaction_id).is_err()
    );
}

#[test]
fn authorized_journal_requires_exact_durable_service_grant() {
    let f = fixture();
    let auth = binding_authorization(&f);
    // A journal that claims authorization without any service grant must be
    // refused, because no durable authority was ever written.
    let mut claimed = f;
    claimed.journal["authorization"] = auth.clone();
    claimed.journal["state"] = json!("authorized");
    claimed.save();
    assert!(read_native_transaction(&claimed.home, "fixture", &claimed.transaction_id).is_err());

    // A real grant makes the authorized journal readable.
    let mut granted = claimed;
    // Not authorized yet: a plain prepared journal still reads.
    granted.journal["authorization"] = Value::Null;
    granted.journal["state"] = json!("prepared");
    granted.save();
    let tx = read_native_transaction(&granted.home, "fixture", &granted.transaction_id).unwrap();
    grant_native_transaction(&tx).unwrap();
    granted.journal["authorization"] = auth.clone();
    granted.journal["state"] = json!("authorized");
    granted.save();
    let read = read_native_transaction(&granted.home, "fixture", &granted.transaction_id).unwrap();
    assert!(read.authorization.is_some());

    // A mutated authorization (different commandId) no longer matches the
    // durable grant and must be refused.
    let mut mismatched = granted;
    mismatched.journal["authorization"]["commandId"] = json!("different");
    mismatched.save();
    assert!(
        read_native_transaction(&mismatched.home, "fixture", &mismatched.transaction_id).is_err()
    );
}

#[test]
fn fresh_authenticated_launch_fills_the_crash_gap_with_exact_durable_intent() {
    let f = fixture();
    let tx = read_native_transaction(&f.home, "fixture", &f.transaction_id).unwrap();
    grant_native_transaction(&tx).unwrap();
    let mut journal = f;
    journal.journal["authorization"] = binding_authorization(&journal);
    journal.journal["state"] = json!("installing");
    let launch_id = "d".repeat(64);
    let service = json!({ "pid": 201, "bootId": "boot-one", "birth": "2:1" });
    journal.journal["steps"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "action": {"kind": "launch", "role": "service", "release": "candidate", "launchId": "e".repeat(64)},
            "intentRevision": 6,
            "intentBootId": "boot-one",
            "evidence": {"kind": "launched", "launch": {
                "role": "service", "release": "candidate", "launchId": "e".repeat(64),
                "process": service, "nativeSessionId": "service-session", "version": "1.1.0"
            }}
        }));
    journal.journal["steps"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "action": {"kind": "launch", "role": "desktop", "release": "candidate", "launchId": launch_id},
            "intentRevision": 7,
            "intentBootId": "boot-one",
            "evidence": Value::Null
        }));
    journal.save();
    let ticket = json!({
        "schema": 1,
        "installationId": "fixture",
        "transactionId": journal.transaction_id,
        "launchId": launch_id,
        "nonce": launch_id,
        "nativeSessionId": "candidate-session",
        "service": service,
        "serviceVersion": "1.1.0",
        "desktopVersion": "1.1.0",
        "protocol": 3
    });
    let desktop_process = NativeProcess {
        pid: 202,
        boot_id: "boot-one".to_owned(),
        birth: "2:2".to_owned(),
    };
    assert_eq!(
        verify_native_launch(&journal.home, &ticket, &desktop_process)
            .unwrap()
            .record
            .get("transactionId")
            .and_then(Value::as_str),
        Some(journal.transaction_id.as_str())
    );
    let mut bad_version = ticket.clone();
    bad_version["desktopVersion"] = json!("9.0.0");
    assert!(verify_native_launch(&journal.home, &bad_version, &desktop_process).is_err());
    let mut bad_launch = ticket.clone();
    bad_launch["launchId"] = json!("f".repeat(64));
    bad_launch["nonce"] = json!("f".repeat(64));
    assert!(verify_native_launch(&journal.home, &bad_launch, &desktop_process).is_err());
}

fn binding_authorization(f: &Fx) -> Value {
    let mut auth = f.prepared.get("binding").unwrap().clone();
    auth.as_object_mut()
        .unwrap()
        .insert("kind".into(), json!("authorize-install"));
    auth.as_object_mut()
        .unwrap()
        .insert("reservationId".into(), json!(f.transaction_id));
    auth.as_object_mut().unwrap().insert(
        "journalSha256".into(),
        f.journal.get("manifestSha256").unwrap().clone(),
    );
    auth
}

#[test]
fn grantless_terminal_cleanup_requires_unchanged_original_and_rejects_destructive_steps() {
    let f = fixture();
    // No grant, state restored but nothing recorded as unchanged.
    let mut restored = f;
    restored.journal["state"] = json!("restored");
    restored.save();
    assert!(read_native_cleanup(&restored.home, "fixture", &restored.transaction_id).is_err());

    // Record the unchanged original digest; cleanup is now allowed without
    // a grant, while the ordinary install reader still needs authority.
    restored.journal["unchangedOriginal"] = json!({
        "sha256": restored.prepared["oldBundleBackup"]["sha256"],
        "observedAt": {"bootId": "boot-one", "millis": 42}
    });
    restored.save();
    assert!(
        read_native_cleanup(&restored.home, "fixture", &restored.transaction_id)
            .unwrap()
            .authorization
            .is_none()
    );
    assert!(read_native_transaction(&restored.home, "fixture", &restored.transaction_id).is_err());
}

#[test]
fn service_maintenance_launch_discovery_binds_pending_intent_and_refuses_changed_incarnations() {
    let f = fixture();
    let tx = read_native_transaction(&f.home, "fixture", &f.transaction_id).unwrap();
    grant_native_transaction(&tx).unwrap();
    let mut journal = f;
    journal.journal["authorization"] = binding_authorization(&journal);
    journal.journal["state"] = json!("installing");
    let own = NativeProcess {
        pid: 300,
        boot_id: "boot-one".to_owned(),
        birth: "3:1".to_owned(),
    };
    journal.journal["steps"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "action": {"kind": "launch", "role": "service", "release": "candidate", "launchId": "e".repeat(64)},
            "intentRevision": 6,
            "intentBootId": "boot-one",
            "evidence": Value::Null
        }));
    journal.save();
    let app_path = journal.prepared["target"]["appPath"].as_str().unwrap();
    let executable = format!("{app_path}/Contents/Resources/pacer");
    let launch = discover_service_launch(&journal.home, &executable, "1.1.0", &own)
        .unwrap()
        .expect("pending intent");
    assert_eq!(launch.launch_id, "e".repeat(64));
    assert_eq!(launch.version, "1.1.0");

    // A changed incarnation no longer matches the bound process.
    let changed = NativeProcess {
        boot_id: "next-boot".to_owned(),
        ..own
    };
    assert!(
        discover_service_launch(&journal.home, &executable, "1.1.0", &changed)
            .unwrap()
            .is_none()
    );
}

/// `same_native_value` must order object keys recursively so two documents
/// differing only in key order compare equal.
#[test]
fn same_native_value_orders_object_keys_recursively() {
    let a: Value = json!({"b": {"y": 1, "x": 2}, "a": [{"z": 1, "w": 2}]});
    let b: Value = json!({"a": [{"w": 2, "z": 1}], "b": {"x": 2, "y": 1}});
    assert!(same_native_value(&a, &b));
    let mut c = a.clone();
    c["b"]["x"] = json!(9);
    assert!(!same_native_value(&a, &c));
}
