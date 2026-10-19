//! Offline recovery cross-check against the service-owned admission and request records.
use super::{
    journal::{Journal, TransactionState},
    platform_fs::PrivateDir,
    wire::{self, InstallAuthorization},
    OtaError, PreparedManifest,
};
use serde::Deserialize;
use std::path::Path;

/// The service remains the only logical writer of admission. SQLite may recover
/// its own hot rollback journal while this short synchronous snapshot is opened.
#[cfg(not(target_os = "macos"))]
pub(crate) fn reservation_held(_home: &Path, _transaction: &str) -> Result<bool, OtaError> {
    Err(OtaError::Unavailable)
}
#[cfg(target_os = "macos")]
pub(crate) fn reservation_held(home: &Path, transaction: &str) -> Result<bool, OtaError> {
    admission_snapshot(home, Some(transaction))
}
/// Read-only refusal guard for ordinary managed bootstrap. A clear result is not
/// an install/adoption grant and never releases another transaction's reservation.
#[cfg(target_os = "macos")]
pub(crate) fn admission_clear(home: &Path) -> Result<bool, OtaError> {
    admission_snapshot(home, None)
}
#[cfg(target_os = "macos")]
fn admission_snapshot(home: &Path, transaction: Option<&str>) -> Result<bool, OtaError> {
    database_snapshot(home, |connection| read_admission(connection, transaction))
}
#[cfg(target_os = "macos")]
fn database_snapshot<T>(
    home: &Path,
    read: impl FnOnce(&sqlite::Connection) -> Result<T, OtaError>,
) -> Result<T, OtaError> {
    use std::{
        ffi::CString,
        os::unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
        },
    };
    let directory = PrivateDir::open(&home.join("desktop-updates"))?;
    let path = directory.path.join("admission.sqlite");
    let guard = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
        .map_err(|_| OtaError::Identity)?;
    let before = guard.metadata().map_err(|_| OtaError::Io)?;
    if !before.is_file()
        || before.uid() != unsafe { libc::geteuid() }
        || before.mode() & 0o7777 != 0o600
        || before.nlink() != 1
    {
        return Err(OtaError::Identity);
    }
    for suffix in ["-journal", "-wal", "-shm"] {
        match std::fs::symlink_metadata(directory.path.join(format!("admission.sqlite{suffix}"))) {
            Ok(info)
                if !info.is_file()
                    || info.uid() != before.uid()
                    || info.mode() & 0o077 != 0
                    || info.nlink() != 1 =>
            {
                return Err(OtaError::Identity)
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(OtaError::Io),
            _ => {}
        }
    }
    let path_c = CString::new(path.as_os_str().as_bytes()).map_err(|_| OtaError::Invalid)?;
    let mut raw = std::ptr::null_mut();
    // READWRITE without CREATE permits SQLite's own hot-journal recovery. No
    // logical writes are issued; query_only and one short transaction follow.
    let result = unsafe {
        sqlite::sqlite3_open_v2(
            path_c.as_ptr(),
            &mut raw,
            0x2 | 0x10000 | 0x01000000,
            std::ptr::null(),
        )
    };
    let connection = sqlite::Connection(raw);
    if result != 0 || raw.is_null() {
        return Err(OtaError::Io);
    }
    unsafe {
        sqlite::sqlite3_limit(raw, 0, 1_048_576);
        sqlite::sqlite3_busy_timeout(raw, 5000);
    }
    connection.exec(c"PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE; PRAGMA query_only=ON;")?;
    let result = read(&connection)?;
    let after = std::fs::symlink_metadata(&path).map_err(|_| OtaError::Io)?;
    if after.dev() != before.dev() || after.ino() != before.ino() {
        return Err(OtaError::Identity);
    }
    connection.exec(c"ROLLBACK;")?;
    Ok(result)
}

#[cfg(target_os = "macos")]
fn read_admission(
    connection: &sqlite::Connection,
    transaction: Option<&str>,
) -> Result<bool, OtaError> {
    let bytes = connection.text(c"SELECT state FROM admission WHERE id = 1")?;
    let state: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| OtaError::Invalid)?;
    let leases = state
        .get("leases")
        .and_then(serde_json::Value::as_array)
        .ok_or(OtaError::Invalid)?;
    if state.get("schema").and_then(serde_json::Value::as_u64) != Some(1)
        || (!leases.is_empty() && !state["reservation"].is_null())
    {
        return Err(OtaError::Identity);
    }
    let held = match state.get("reservation") {
        Some(serde_json::Value::Null) => transaction.is_none() && leases.is_empty(),
        Some(serde_json::Value::String(value)) => transaction.is_some_and(|tx| value == tx),
        _ => return Err(OtaError::Invalid),
    };
    let held = if transaction.is_none() {
        let table=connection.text(c"SELECT CAST(COUNT(*) AS TEXT) FROM sqlite_master WHERE type='table' AND name='desktop_adoptions'")?;
        if table == b"0" {
            held
        } else {
            // Unknown or malformed phases are conservatively pending. SQLite JSON
            // parsing errors also refuse; no adoption data is treated as authority.
            let pending=connection.text(c"SELECT CAST(COUNT(*) AS TEXT) FROM desktop_adoptions WHERE COALESCE(json_extract(body,'$.schema'),0)!=1 OR COALESCE(json_extract(body,'$.phase'),'') NOT IN ('committed','restored','cancelled')")?;
            held && pending == b"0"
        }
    } else {
        held
    };
    Ok(held)
}

#[cfg(target_os = "macos")]
mod sqlite {
    use super::OtaError;
    use std::ffi::{c_char, c_void, CStr};
    #[link(name = "sqlite3")]
    unsafe extern "C" {
        pub fn sqlite3_open_v2(
            path: *const c_char,
            db: *mut *mut c_void,
            flags: i32,
            vfs: *const c_char,
        ) -> i32;
        fn sqlite3_close_v2(db: *mut c_void) -> i32;
        pub fn sqlite3_limit(db: *mut c_void, category: i32, value: i32) -> i32;
        pub fn sqlite3_busy_timeout(db: *mut c_void, millis: i32) -> i32;
        fn sqlite3_exec(
            db: *mut c_void,
            sql: *const c_char,
            callback: *mut c_void,
            context: *mut c_void,
            error: *mut *mut c_char,
        ) -> i32;
        fn sqlite3_prepare_v2(
            db: *mut c_void,
            sql: *const c_char,
            size: i32,
            statement: *mut *mut c_void,
            tail: *mut *const c_char,
        ) -> i32;
        fn sqlite3_step(statement: *mut c_void) -> i32;
        fn sqlite3_column_type(statement: *mut c_void, column: i32) -> i32;
        fn sqlite3_column_text(statement: *mut c_void, column: i32) -> *const u8;
        fn sqlite3_column_bytes(statement: *mut c_void, column: i32) -> i32;
        fn sqlite3_finalize(statement: *mut c_void) -> i32;
    }
    pub struct Connection(pub *mut c_void);
    impl Drop for Connection {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    sqlite3_close_v2(self.0);
                }
            }
        }
    }
    struct Statement(*mut c_void);
    impl Drop for Statement {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    sqlite3_finalize(self.0);
                }
            }
        }
    }
    impl Connection {
        pub fn exec(&self, sql: &CStr) -> Result<(), OtaError> {
            if unsafe {
                sqlite3_exec(
                    self.0,
                    sql.as_ptr(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            } != 0
            {
                return Err(OtaError::Io);
            }
            Ok(())
        }
        pub fn text(&self, sql: &CStr) -> Result<Vec<u8>, OtaError> {
            let mut raw = std::ptr::null_mut();
            let result = unsafe {
                sqlite3_prepare_v2(self.0, sql.as_ptr(), -1, &mut raw, std::ptr::null_mut())
            };
            let statement = Statement(raw);
            if result != 0
                || raw.is_null()
                || unsafe { sqlite3_step(raw) } != 100
                || unsafe { sqlite3_column_type(raw, 0) } != 3
            {
                return Err(OtaError::Invalid);
            }
            let pointer = unsafe { sqlite3_column_text(raw, 0) };
            let length = unsafe { sqlite3_column_bytes(raw, 0) };
            if pointer.is_null() || !(1..=1_048_576).contains(&length) {
                return Err(OtaError::Invalid);
            }
            let bytes = unsafe { std::slice::from_raw_parts(pointer, length as usize) }.to_vec();
            if unsafe { sqlite3_step(statement.0) } != 101 {
                return Err(OtaError::Invalid);
            }
            Ok(bytes)
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Grant {
    schema: u32,
    authorization: InstallAuthorization,
    request_id: String,
    fingerprint: String,
    native_session_id: String,
}

pub(crate) fn verify(
    home: &Path,
    manifest: &PreparedManifest,
    journal: &Journal,
) -> Result<bool, OtaError> {
    let id = &manifest.target.id;
    let tx = manifest.transaction_id();
    if id.is_empty()
        || tx.is_empty()
        || id.contains('/')
        || tx.contains('/')
        || Path::new(&manifest.target.pacer_home) != home
    {
        return Err(OtaError::Identity);
    }
    let state = PrivateDir::open(&home.join("desktop-updates"))?;
    let record = wire::parse_record(&state.read(&format!("{id}.json"), 1_048_576)?)
        .map_err(|_| OtaError::Invalid)?;
    let held = if manifest.managed() {
        reservation_held(home, tx)?
    } else {
        false
    };
    let terminal = matches!(
        journal.state,
        TransactionState::Committed | TransactionState::Restored
    );
    // A cancelled preparation has no installation authority. Its retained
    // request receipt permits only verification and cleanup of its own assets.
    let preparation = journal.authorization.is_none()
        && matches!(
            journal.state,
            TransactionState::Preparing | TransactionState::Prepared | TransactionState::Restored
        )
        && journal.steps.iter().all(|step| {
            matches!(
                step.action,
                super::PlatformAction::PrepareBackup
                    | super::PlatformAction::ArmRecovery
                    | super::PlatformAction::ReleaseReservation
                    | super::PlatformAction::RetireRecovery
                    | super::PlatformAction::PruneSupersededBackup
            )
        })
        && (journal.state != TransactionState::Restored
            || journal
                .unchanged_original
                .as_ref()
                .is_some_and(|proof| proof.sha256 == manifest.old_bundle_backup.sha256))
        && record.request_history.iter().any(|receipt| {
            receipt.action == wire::Action::Restart && receipt.transaction_id.as_deref() == Some(tx)
        });
    if journal.authorization.is_none() && !preparation {
        return Err(OtaError::Identity);
    }
    if !terminal && !preparation && manifest.managed() && !held {
        return Err(OtaError::Identity);
    }
    if record.installation_id != *id || record.revision < manifest.binding.revision {
        return Err(OtaError::Identity);
    }
    let current = record.transaction_id.as_deref() == Some(tx)
        && record.candidate.as_ref() == Some(&manifest.candidate);
    // Terminal cleanup cannot mutate the bundle again. Its original service
    // grant and append-only receipt remain authority after a newer request.
    // Never reinterpret the newer admission reservation as this transaction's.
    if !current && !preparation && !(terminal && journal.authorization.is_some()) {
        return Err(OtaError::Identity);
    }
    if let Some(authorization) = &journal.authorization {
        let directory = PrivateDir::open(&home.join("desktop-updates/native").join(id).join(tx))?;
        let grant: Grant = serde_json::from_slice(&directory.read("service-grant.json", 262_144)?)
            .map_err(|_| OtaError::Invalid)?;
        if grant.schema != 1
            || &grant.authorization != authorization
            || grant.native_session_id != manifest.native_session_id
            || !record.request_history.iter().any(|receipt| {
                receipt.action == wire::Action::Restart
                    && receipt.transaction_id.as_deref() == Some(tx)
                    && receipt.request_id == grant.request_id
                    && receipt.fingerprint == grant.fingerprint
            })
        {
            return Err(OtaError::Identity);
        }
    }
    Ok(held)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn fixture() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let updates = temp.path().join("desktop-updates");
        std::fs::create_dir(&updates).unwrap();
        std::fs::set_permissions(&updates, std::fs::Permissions::from_mode(0o700)).unwrap();
        let output=std::process::Command::new("/usr/bin/sqlite3").arg(updates.join("admission.sqlite")).arg("CREATE TABLE admission(id INTEGER PRIMARY KEY,state TEXT NOT NULL); INSERT INTO admission VALUES(1,'{\"schema\":1,\"reservation\":\"transaction-one\",\"leases\":[]}');").output().unwrap();
        assert!(output.status.success());
        std::fs::set_permissions(
            updates.join("admission.sqlite"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        temp
    }
    #[test]
    fn managed_bootstrap_refuses_reservations_leases_and_pending_adoption() {
        let temp = fixture();
        let home = temp.path().canonicalize().unwrap();
        let db = home.join("desktop-updates/admission.sqlite");
        let sql = |text: &str| {
            assert!(std::process::Command::new("/usr/bin/sqlite3")
                .arg(&db)
                .arg(text)
                .status()
                .unwrap()
                .success())
        };
        assert!(!admission_clear(&home).unwrap());
        sql(r#"UPDATE admission SET state='{"schema":1,"reservation":null,"leases":[{}]}'"#);
        assert!(!admission_clear(&home).unwrap());
        sql(r#"UPDATE admission SET state='{"schema":1,"reservation":null,"leases":[]}'"#);
        assert!(admission_clear(&home).unwrap());
        sql(
            r#"CREATE TABLE desktop_adoptions(body TEXT); INSERT INTO desktop_adoptions VALUES('{"schema":1,"phase":"waiting"}')"#,
        );
        assert!(!admission_clear(&home).unwrap());
        sql(r#"UPDATE desktop_adoptions SET body='{"schema":1,"phase":"cancelled"}'"#);
        assert!(admission_clear(&home).unwrap());
        sql(r#"UPDATE desktop_adoptions SET body='{}'"#);
        assert!(!admission_clear(&home).unwrap());
    }
    #[test]
    fn reads_real_sqlite_reservation_without_releasing_or_inventing_it() {
        let temp = fixture();
        let home = temp.path().canonicalize().unwrap();
        assert!(reservation_held(&home, "transaction-one").unwrap());
        assert!(!reservation_held(&home, "another-transaction").unwrap());
        assert!(reservation_held(&home, "transaction-one").unwrap());
    }
    #[test]
    fn conflicting_leases_and_redirected_database_are_not_recovery_authority() {
        let temp = fixture();
        let home = temp.path().canonicalize().unwrap();
        let database = home.join("desktop-updates/admission.sqlite");
        let output=std::process::Command::new("/usr/bin/sqlite3").arg(&database).arg("UPDATE admission SET state='{\"schema\":1,\"reservation\":\"transaction-one\",\"leases\":[{}]}';").output().unwrap();
        assert!(output.status.success());
        assert!(reservation_held(&home, "transaction-one").is_err());
        std::fs::remove_file(&database).unwrap();
        std::os::unix::fs::symlink("/dev/null", &database).unwrap();
        assert!(reservation_held(&home, "transaction-one").is_err());
    }
    #[test]
    fn terminal_cleanup_uses_original_grant_without_claiming_a_later_reservation() {
        use serde_json::json;
        let temp = fixture();
        let home = temp.path().canonicalize().unwrap();
        let source: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/desktop-update/journal.json"
        ))
        .unwrap();
        let mut manifest: PreparedManifest =
            serde_json::from_value(source["prepared"].clone()).unwrap();
        manifest.target.pacer_home = home.to_str().unwrap().into();
        let mut journal: Journal = serde_json::from_value(source["journal"].clone()).unwrap();
        journal.state = TransactionState::Committed;
        let authorization = InstallAuthorization {
            binding: manifest.binding.clone(),
            kind: wire::AuthorizationKind::AuthorizeInstall,
            reservation_id: manifest.transaction_id().into(),
            journal_sha256: journal.manifest_sha256.clone(),
        };
        journal.authorization = Some(authorization.clone());
        let source: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/desktop-update/wire.json"
        ))
        .unwrap();
        let mut record = source["record"].clone();
        record["installationId"] = json!(manifest.target.id);
        record["revision"] = json!(9);
        record["phase"] = json!("idle");
        record["candidate"] = json!(null);
        record["requestHistory"] = json!([{"action":"restart","requestId":"original-request","fingerprint":"f".repeat(64),"transactionId":manifest.transaction_id()}]);
        let state = PrivateDir::open(&home.join("desktop-updates")).unwrap();
        state
            .write_new(
                &format!("{}.json", manifest.target.id),
                &serde_json::to_vec(&record).unwrap(),
            )
            .unwrap();
        let dir = PrivateDir::installation(&home, &manifest.target.id)
            .unwrap()
            .child(manifest.transaction_id())
            .unwrap();
        let grant = json!({"schema":1,"authorization":authorization,"requestId":"original-request","fingerprint":"f".repeat(64),"nativeSessionId":manifest.native_session_id});
        dir.write_new("service-grant.json", &serde_json::to_vec(&grant).unwrap())
            .unwrap();
        assert!(!verify(&home, &manifest, &journal).unwrap());
        assert!(reservation_held(&home, "transaction-one").unwrap());
        journal.state = TransactionState::Installing;
        assert!(verify(&home, &manifest, &journal).is_err());
        journal.state = TransactionState::Committed;
        std::fs::remove_file(dir.path.join("service-grant.json")).unwrap();
        assert!(verify(&home, &manifest, &journal).is_err());
    }
    #[test]
    fn cancelled_preparation_can_clean_up_without_claiming_a_new_reservation() {
        use serde_json::json;
        let temp = fixture();
        let home = temp.path().canonicalize().unwrap();
        let source: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/desktop-update/journal.json"
        ))
        .unwrap();
        let mut manifest: PreparedManifest =
            serde_json::from_value(source["prepared"].clone()).unwrap();
        manifest.target.pacer_home = home.to_str().unwrap().into();
        let mut journal: Journal = serde_json::from_value(source["journal"].clone()).unwrap();
        journal.state = TransactionState::Prepared;
        journal.authorization = None;
        journal.steps.clear();
        let source: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/desktop-update/wire.json"
        ))
        .unwrap();
        let mut record = source["record"].clone();
        record["installationId"] = json!(manifest.target.id);
        record["revision"] = json!(9);
        record["phase"] = json!("idle");
        record["candidate"] = json!(null);
        record["requestHistory"] = json!([{"action":"restart","requestId":"original-request","fingerprint":"f".repeat(64),"transactionId":manifest.transaction_id()}]);
        let state = PrivateDir::open(&home.join("desktop-updates")).unwrap();
        let path = state.path.join(format!("{}.json", manifest.target.id));
        state
            .write_new(
                path.file_name().unwrap().to_str().unwrap(),
                &serde_json::to_vec(&record).unwrap(),
            )
            .unwrap();
        assert!(!verify(&home, &manifest, &journal).unwrap());
        assert!(reservation_held(&home, "transaction-one").unwrap());
        journal.state = TransactionState::Restored;
        assert!(verify(&home, &manifest, &journal).is_err());
        journal.unchanged_original = Some(super::super::journal::OriginalBundleProof {
            sha256: manifest.old_bundle_backup.sha256.clone(),
            observed_at: super::super::AwakeStamp {
                boot_id: manifest.requester_boot_id.clone(),
                millis: 1,
            },
        });
        assert!(!verify(&home, &manifest, &journal).unwrap());
        journal.unchanged_original.as_mut().unwrap().sha256 = "f".repeat(64);
        assert!(verify(&home, &manifest, &journal).is_err());
        journal.unchanged_original = None;
        journal.state = TransactionState::Prepared;
        journal.steps.push(super::super::journal::Step {
            action: super::super::PlatformAction::InstallCandidate,
            intent_revision: 1,
            intent_boot_id: manifest.requester_boot_id.clone(),
            evidence: None,
        });
        assert!(verify(&home, &manifest, &journal).is_err());
        journal.steps.clear();
        journal.state = TransactionState::Installing;
        assert!(verify(&home, &manifest, &journal).is_err());
        journal.state = TransactionState::Prepared;
        record["requestHistory"] = json!([]);
        std::fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(verify(&home, &manifest, &journal).is_err());
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn verify_adoption(
    home: &Path,
    manifest: &super::adoption::AdoptionManifest,
    journal: &super::adoption::journal::AdoptionJournal,
) -> Result<bool, OtaError> {
    use super::adoption::{journal::AdoptionState, AdoptionAction, AdoptionManifest};
    use sha2::{Digest, Sha256};
    use std::ffi::CString;
    let require = |value: bool| {
        if value {
            Ok(())
        } else {
            Err(OtaError::Identity)
        }
    };
    super::adoption::journal::validate_manifest(manifest)?;
    let id = &manifest.source.target.id;
    let tx = manifest.transaction_id();
    require(Path::new(&manifest.source.target.pacer_home) == home)?;
    let directory = PrivateDir::open(&home.join("desktop-updates/native").join(id).join(tx))?;
    let bytes = directory.read("adoption-prepared.json", 1_048_576)?;
    let stored: AdoptionManifest = serde_json::from_slice(&bytes).map_err(|_| OtaError::Invalid)?;
    require(&stored == manifest)?;
    journal.validate(manifest, &format!("{:x}", Sha256::digest(&bytes)))?;
    let terminal = matches!(
        journal.state,
        AdoptionState::Committed | AdoptionState::Restored
    );
    let preparation = journal.authorization.is_none()
        && matches!(
            journal.state,
            AdoptionState::Preparing | AdoptionState::Prepared | AdoptionState::Restored
        )
        && journal.steps.iter().all(|step| {
            matches!(
                step.action,
                AdoptionAction::BackupRegistration
                    | AdoptionAction::ArmRecovery
                    | AdoptionAction::ReleaseReservation
                    | AdoptionAction::RetireRecovery
            )
        })
        && (journal.state != AdoptionState::Restored
            || journal
                .unchanged_registration
                .as_ref()
                .is_some_and(|proof| proof.sha256 == manifest.old_registration.sha256));
    require(journal.authorization.is_some() || preparation)?;
    database_snapshot(home, |connection| {
        // Manifest validation restricts id to ASCII alphanumeric, '_' and '-'.
        let query = |column: &str| -> Result<Vec<u8>, OtaError> {
            let sql = CString::new(format!(
                "SELECT {column} FROM desktop_adoptions WHERE installation_id='{id}'"
            ))
            .map_err(|_| OtaError::Invalid)?;
            connection.text(&sql)
        };
        let current: serde_json::Value =
            serde_json::from_slice(&query("body")?).map_err(|_| OtaError::Invalid)?;
        let history: Vec<serde_json::Value> =
            serde_json::from_slice(&query("history")?).map_err(|_| OtaError::Invalid)?;
        require(history.len() <= 1024)?;
        let rows: Vec<_> = std::iter::once(&current)
            .chain(history.iter())
            .filter(|row| row["transactionId"] == tx)
            .collect();
        require(rows.len() == 1)?;
        let row = rows[0];
        let phase = row["phase"].as_str().ok_or(OtaError::Invalid)?;
        let revision = row["revision"].as_u64().ok_or(OtaError::Invalid)?;
        require(
            row["schema"] == 1
                && row["installationId"] == *id
                && revision <= 9_007_199_254_740_991
                && revision >= manifest.binding.revision
                && row["authority"]
                    == serde_json::to_value(&manifest.source).map_err(|_| OtaError::Invalid)?
                && matches!(
                    phase,
                    "reserved"
                        | "installing"
                        | "verifying"
                        | "recovery-failed"
                        | "committed"
                        | "restored"
                        | "cancelled"
                ),
        )?;
        if current["transactionId"] != tx {
            require(terminal && matches!(phase, "committed" | "restored" | "cancelled"))?;
        }
        if phase == "reserved" {
            require(revision == manifest.binding.revision)?;
        }
        if journal.authorization.is_some() {
            require(phase != "cancelled")?;
        }
        let receipts = row["receipts"].as_array().ok_or(OtaError::Invalid)?;
        require(!receipts.is_empty() && receipts.len() <= 1024)?;
        let matches: Vec<_> = receipts
            .iter()
            .filter(|receipt| receipt["requestId"] == manifest.request.request_id)
            .collect();
        require(matches.len() == 1)?;
        let receipt = matches[0];
        require(
            receipt["action"] == "adopt"
                && receipt["transactionId"] == tx
                && receipt["fingerprint"] == manifest.request.fingerprint
                && receipt["expectRevision"]
                    .as_u64()
                    .is_some_and(|rev| rev < manifest.binding.revision),
        )?;
        if let Some(authorization) = &journal.authorization {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct AdoptionGrant {
                schema: u32,
                transaction_kind: String,
                authorization: InstallAuthorization,
                request_id: String,
                fingerprint: String,
                native_session_id: String,
            }
            let grant: AdoptionGrant =
                serde_json::from_slice(&directory.read("service-adoption-grant.json", 262_144)?)
                    .map_err(|_| OtaError::Invalid)?;
            require(
                grant.schema == 1
                    && grant.transaction_kind == "adoption"
                    && &grant.authorization == authorization
                    && grant.request_id == manifest.request.request_id
                    && grant.fingerprint == manifest.request.fingerprint
                    && grant.native_session_id == manifest.source.native_session_id,
            )?;
        }
        let held = read_admission(connection, Some(tx))?;
        require(terminal || preparation || held)?;
        if !terminal && !preparation {
            require(!matches!(phase, "committed" | "restored" | "cancelled"))?;
        }
        Ok(held)
    })
}

#[cfg(all(test, target_os = "macos"))]
mod adoption_tests {
    use super::super::adoption::{
        journal::{
            AdoptionJournal, AdoptionState, AdoptionStep, AdoptionStore, UnchangedRegistration,
        },
        AdoptionAction, AdoptionEvidence, AdoptionManifest,
    };
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;
    fn sql(home: &Path, text: &str) {
        let output = std::process::Command::new("/usr/bin/sqlite3")
            .arg(home.join("desktop-updates/admission.sqlite"))
            .arg(text)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fn row(home: &Path, body: &serde_json::Value, history: &serde_json::Value) {
        sql(
            home,
            &format!(
                "INSERT OR REPLACE INTO desktop_adoptions VALUES ('fixture','{}','{}')",
                body.to_string().replace('\'', "''"),
                history.to_string().replace('\'', "''")
            ),
        );
    }
    fn fixture() -> (
        tempfile::TempDir,
        std::path::PathBuf,
        AdoptionManifest,
        AdoptionJournal,
        serde_json::Value,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let mut m = super::super::adoption::journal::tests::manifest();
        m.source.target.pacer_home = home.to_string_lossy().into();
        m.binding.transaction_id = Some("transaction-one".into());
        m.binding.revision = 3;
        let directory = PrivateDir::installation(&home, "fixture")
            .unwrap()
            .child("transaction-one")
            .unwrap();
        let store = AdoptionStore::open(&directory.path).unwrap();
        let digest = store.create_manifest(&m).unwrap();
        let mut j = store.initialize(&digest).unwrap();
        j.revision = 5;
        j.state = AdoptionState::Prepared;
        for action in [
            AdoptionAction::BackupRegistration,
            AdoptionAction::ArmRecovery,
        ] {
            j.steps.push(AdoptionStep {
                action,
                intent_revision: 1,
                intent_boot_id: m.source.boot_id.clone(),
                evidence: Some(AdoptionEvidence::Complete),
            });
        }
        let body = json!({"schema":1,"installationId":"fixture","revision":3,"transactionId":"transaction-one","phase":"reserved","authority":m.source,"receipts":[{"requestId":m.request.request_id,"action":"adopt","fingerprint":m.request.fingerprint,"transactionId":"transaction-one","expectRevision":1}]});
        sql(&home,"CREATE TABLE admission(id INTEGER PRIMARY KEY,state TEXT NOT NULL); INSERT INTO admission VALUES(1,'{\"schema\":1,\"reservation\":\"transaction-one\",\"leases\":[]}'); CREATE TABLE desktop_adoptions(installation_id TEXT PRIMARY KEY,body TEXT NOT NULL,history TEXT NOT NULL)");
        std::fs::set_permissions(
            home.join("desktop-updates/admission.sqlite"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        row(&home, &body, &json!([]));
        (temp, home, m, j, body)
    }
    #[test]
    fn adoption_requires_its_own_receipt_source_and_kind_bound_service_grant() {
        let (_temp, home, m, mut j, mut body) = fixture();
        assert!(verify_adoption(&home, &m, &j).unwrap());
        body["authority"]["oldServiceExecutable"] = json!("/tmp/unrelated");
        row(&home, &body, &json!([]));
        assert!(verify_adoption(&home, &m, &j).is_err());
        body["authority"] = json!(m.source);
        row(&home, &body, &json!([]));
        let authorization = InstallAuthorization {
            binding: m.binding.clone(),
            kind: wire::AuthorizationKind::AuthorizeInstall,
            reservation_id: m.transaction_id().into(),
            journal_sha256: j.manifest_sha256.clone(),
        };
        j.authorization = Some(authorization.clone());
        j.state = AdoptionState::Authorized;
        assert!(verify_adoption(&home, &m, &j).is_err());
        let directory =
            PrivateDir::open(&home.join("desktop-updates/native/fixture/transaction-one")).unwrap();
        let grant = json!({"schema":1,"transactionKind":"adoption","authorization":authorization,"requestId":m.request.request_id,"fingerprint":m.request.fingerprint,"nativeSessionId":m.source.native_session_id});
        directory
            .write_new(
                "service-adoption-grant.json",
                &serde_json::to_vec(&grant).unwrap(),
            )
            .unwrap();
        assert!(verify_adoption(&home, &m, &j).unwrap());
        let mut wrong = grant.clone();
        wrong["transactionKind"] = json!("update");
        std::fs::write(
            directory.path.join("service-adoption-grant.json"),
            serde_json::to_vec(&wrong).unwrap(),
        )
        .unwrap();
        assert!(verify_adoption(&home, &m, &j).is_err());
    }
    #[test]
    fn old_grantless_terminal_cleanup_uses_history_without_claiming_new_reservation() {
        let (_temp, home, m, mut j, mut body) = fixture();
        j.state = AdoptionState::Restored;
        j.unchanged_registration = Some(UnchangedRegistration {
            sha256: m.old_registration.sha256.clone(),
            observed_at: super::super::AwakeStamp {
                boot_id: m.source.boot_id.clone(),
                millis: 1,
            },
        });
        body["phase"] = json!("cancelled");
        body["revision"] = json!(4);
        let history = json!([body.clone()]);
        body["transactionId"] = json!("later");
        body["revision"] = json!(6);
        body["phase"] = json!("reserved");
        row(&home, &body, &history);
        sql(
            &home,
            "UPDATE admission SET state='{\"schema\":1,\"reservation\":\"later\",\"leases\":[]}'",
        );
        assert!(!verify_adoption(&home, &m, &j).unwrap());
        assert!(reservation_held(&home, "later").unwrap());
        j.unchanged_registration = None;
        assert!(verify_adoption(&home, &m, &j).is_err());
        j.state = AdoptionState::Prepared;
        assert!(verify_adoption(&home, &m, &j).is_err());
    }
}

#[cfg(all(test, target_os = "macos"))]
mod sqlite_fifo_tests {
    use super::*;
    #[test]
    fn refuses_fifo_before_opening_sqlite_without_waiting_for_writer() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        PrivateDir::installation(&home, "fixture").unwrap();
        let path = std::ffi::CString::new(
            home.join("desktop-updates/admission.sqlite")
                .to_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            tx.send(reservation_held(&home, "transaction")).unwrap();
        });
        let result = rx.recv_timeout(std::time::Duration::from_secs(1));
        // Unblock the deliberately failing implementation before asserting RED.
        let rescue = if result.is_err() {
            unsafe { libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_NONBLOCK) }
        } else {
            -1
        };
        worker.join().unwrap();
        if rescue >= 0 {
            unsafe { libc::close(rescue) };
        }
        assert!(result
            .expect("private database open must not wait on a FIFO")
            .is_err());
    }
}
