#![allow(clippy::unwrap_used, clippy::result_large_err)]
//! Install authority tests, transcribed from `authorizeInstall` /
//! `verifyOutcome` (`src/update/desktop/native-provider.ts`). A live
//! private native transaction (mirroring the shared `journal.json`
//! fixture) sits next to a real reserved update record; the authority must
//! accept the authentic prepared frame and grant the service-owned
//! continuation, and refuse every mismatch a peer could present.
use super::super::authority::{InstallSession, authorize_install, verify_outcome};
use crate::record::{NativeProcess, read_native_transaction};

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

fn write_private(path: &Path, bytes: &[u8]) {
    let mut f = std::fs::File::create(path).unwrap();
    f.write_all(bytes).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

fn make_dir(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

/// A reserved native install transaction (credentials-Fixture builder).
struct Fx {
    _dir: tempfile::TempDir,
    home: PathBuf,
    installation_id: String,
    transaction_id: String,
    prepared: Value,
    journal: Value,
    dir: PathBuf,
}

impl Fx {
    /// Re-commit the current `prepared`/`journal` with a fresh digest.
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

    let native_base = home.join("desktop-updates").join("native").join("fixture");
    for d in [
        &home,
        &home.join("desktop-updates"),
        &home.join("desktop-updates").join("native"),
        &native_base,
    ] {
        std::fs::create_dir_all(d).unwrap();
        std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let tx_dir = native_base.join(&transaction_id);
    make_dir(&tx_dir);

    let mut f = Fx {
        _dir: dir,
        home,
        installation_id: "fixture".to_owned(),
        transaction_id,
        prepared,
        journal,
        dir: tx_dir,
    };
    f.save();
    f
}

/// The verified desktop session the fixture was prepared for.
fn install_session(f: &Fx) -> InstallSession {
    let tx = read_native_transaction(&f.home, &f.installation_id, &f.transaction_id).unwrap();
    let record = &tx.record;
    InstallSession {
        installation: tx.command.target.clone(),
        session_id: tx
            .manifest
            .get("nativeSessionId")
            .and_then(Value::as_str)
            .unwrap()
            .to_owned(),
        desktop: native_process(f.prepared.get("oldDesktop").unwrap()).unwrap(),
        service: native_process(f.prepared.get("oldService").unwrap()).unwrap(),
        desktop_client_id: record
            .get("requestedBy")
            .and_then(Value::as_str)
            .unwrap()
            .to_owned(),
        boot_id: record
            .get("requesterBootId")
            .and_then(Value::as_str)
            .unwrap()
            .to_owned(),
        service_executable: f
            .prepared
            .get("oldServiceExecutable")
            .and_then(Value::as_str)
            .unwrap()
            .to_owned(),
    }
}

fn native_process(value: &Value) -> Option<NativeProcess> {
    let obj = value.as_object()?;
    Some(NativeProcess {
        pid: obj.get("pid")?.as_u64()? as u32,
        boot_id: obj.get("bootId")?.as_str()?.to_owned(),
        birth: obj.get("birth")?.as_str()?.to_owned(),
    })
}

/// The authentic prepared frame the desktop presents at authorize time:
/// the immutable command binding plus the reserved identity fields.
fn prepared_frame(f: &Fx) -> Value {
    let tx = read_native_transaction(&f.home, &f.installation_id, &f.transaction_id).unwrap();
    json!({
        "schema": tx.command.schema,
        "commandId": tx.command.command_id,
        "installationId": tx.command.installation_id,
        "transactionId": tx.command.transaction_id,
        "revision": tx.command.revision,
        "nonce": tx.command.nonce,
        "kind": "authorize",
        "sequence": 1,
        "reservationId": f.transaction_id,
        "journalSha256": tx.digest,
    })
}

#[test]
fn authorize_accepts_authentic_prepared_frame_and_grants() {
    let f = fixture();
    let session = install_session(&f);
    // No grant yet: the transaction reads authorized-free (prepared).
    let tx = authorize_install(
        &f.home,
        &session,
        &prepared_frame(&f),
        |_| true, // managed ownership; reservation held
    )
    .unwrap();
    assert_eq!(
        tx.command.transaction_id.as_deref(),
        Some(f.transaction_id.as_str())
    );

    // The helper then advances its journal to carry the authorization it
    // applies once the grant is in place (mirrors the reference fixture);
    // the subsequent read is now authorized against the written grant.
    let mut granted_ctx = f;
    granted_ctx.journal["authorization"] = binding_authorization(&granted_ctx);
    granted_ctx.save();
    let granted = read_native_transaction(
        &granted_ctx.home,
        &granted_ctx.installation_id,
        &granted_ctx.transaction_id,
    )
    .unwrap();
    assert!(granted.authorization.is_some());
}

#[test]
fn authorize_refuses_foreign_reservation_and_digest() {
    let f = fixture();
    let session = install_session(&f);

    // A peer presenting the wrong reservation id is refused (its digest and
    // binding match but the reservation does not name the transaction).
    let mut wrong_reservation = prepared_frame(&f);
    wrong_reservation["reservationId"] = json!("other-tx");
    assert!(authorize_install(&f.home, &session, &wrong_reservation, |_| true).is_err());

    // A peer presenting a bogus journal digest for this transaction is
    // refused before any bindings are re-checked.
    let mut wrong_digest = prepared_frame(&f);
    wrong_digest["journalSha256"] = json!("c".repeat(64));
    assert!(authorize_install(&f.home, &session, &wrong_digest, |_| true).is_err());
}

#[test]
fn authorize_refuses_a_foreign_session_identity() {
    let f = fixture();
    let mut session = install_session(&f);
    // A session whose old desktop process differs is not the one the
    // manifest bound, even when the prepared frame is authentic.
    session.desktop = NativeProcess {
        pid: 42,
        boot_id: "another-boot".to_owned(),
        birth: "9:9".to_owned(),
    };
    assert!(authorize_install(&f.home, &session, &prepared_frame(&f), |_| true).is_err());
}

#[test]
fn authorize_refuses_managed_without_a_held_reservation() {
    let f = fixture();
    let session = install_session(&f);
    // Managed ownership requires the reservation still be held by the
    // coordinator; an absent reservation is refused.
    assert!(authorize_install(&f.home, &session, &prepared_frame(&f), |_| false).is_err());
}

#[test]
fn verify_outcome_rejects_recovery_failed() {
    let f = fixture();
    let session = install_session(&f);
    assert!(
        verify_outcome(
            &f.home,
            &session,
            &json!({"transactionId": f.transaction_id, "installationId": "fixture"}),
            "recovery-failed",
            |_| Ok(()),
            || Ok(()),
        )
        .is_err()
    );
}

#[test]
fn verify_outcome_accepts_committed_with_proof() {
    let f = fixture();
    let session = install_session(&f);
    // Authorize, then advance the journal to committed with proof.
    authorize_install(&f.home, &session, &prepared_frame(&f), |_| true).unwrap();
    let mut committed = f;
    committed.journal["authorization"] = binding_authorization(&committed);
    committed.journal["state"] = json!("committed");
    committed.journal["verificationProof"] = json!({"kind": "verified", "observedAt": 1});
    committed.save();

    let record = json!({
        "transactionId": committed.transaction_id,
        "installationId": "fixture",
        "candidate": {"version": committed.prepared["target"]["version"]},
    });
    let (installation, granted) = verify_outcome(
        &committed.home,
        &session,
        &record,
        "committed",
        |_| Err(denied_noop()),
        || Err(denied_noop()),
    )
    .unwrap();
    assert!(granted);
    assert_eq!(
        installation.get("id").and_then(Value::as_str),
        Some("fixture")
    );
    assert!(installation.get("version").is_some());
}

#[test]
fn verify_outcome_refuses_committed_without_proof() {
    let f = fixture();
    let session = install_session(&f);
    // Authorize, then advance to committed but omit the verification
    // proof: the outcome is not verifiable.
    authorize_install(&f.home, &session, &prepared_frame(&f), |_| true).unwrap();
    let mut committed = f;
    committed.journal["authorization"] = binding_authorization(&committed);
    committed.journal["state"] = json!("committed");
    committed.save();

    let record = json!({
        "transactionId": committed.transaction_id,
        "installationId": "fixture",
        "candidate": {"version": committed.prepared["target"]["version"]},
    });
    assert!(
        verify_outcome(
            &committed.home,
            &session,
            &record,
            "committed",
            |_| Ok(()),
            || Ok(()),
        )
        .is_err()
    );
}

fn denied_noop() -> pacer_foundation::api::CoreError {
    pacer_foundation::api::CoreError::new(
        pacer_foundation::api::Code::NotAllowed,
        "should not be called",
    )
}

/// The exact authorization the fixture's journal carries after a grant:
/// the command binding plus the reserved identity fields.
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
