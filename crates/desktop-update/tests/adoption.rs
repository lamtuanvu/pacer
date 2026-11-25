//! Golden tests for the desktop adoption store (mirror of the store-relevant
//! `desktop-update-adoption.test.ts` cases). The TypeScript writer and its
//! cross-process fixture were retired with the TS desktop stack.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_desktop_update::adoption_store::UpdateRequest;
use pacer_desktop_update::{
    begin_adoption, cancel_adoption, list_adoptions, read_adoption, read_terminal_adoption,
    replay_adoption_request, transition_adoption, write_update,
};
use pacer_foundation::api::Code;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
};
use tempfile::TempDir;

/// Identifiers accepted by `assertIdentifier`.
const INSTALLATION_ID: &str = "attached";
const REQUEST_ID: &str = "adopt-one";

/// A valid `AdoptionAuthority` mirroring the TypeScript test fixture.
fn authority(home: &Path) -> Value {
    json!({
        "target": {
            "id": INSTALLATION_ID,
            "appPath": "/tmp/pacer.app",
            "bundleId": "dev.pacer.desktop",
            "ownerUid": 501,
            "arch": "aarch64",
            "pacerHome": home.to_string_lossy(),
            "port": 7433,
            "serviceLabel": "com.pacer.serve",
            "ownership": "attached",
            "version": "1.0.0",
        },
        "nativeSessionId": "native",
        "desktopClientId": "desktop",
        "bootId": "boot",
        "desktop": { "pid": 101, "bootId": "boot", "birth": "1:1" },
        "service": { "pid": 102, "bootId": "boot", "birth": "1:2" },
        "serviceVersion": "1.0.0",
        "oldServiceExecutable": "/opt/pacer",
        "newServiceExecutable": "/tmp/pacer.app/Contents/Resources/pacer",
    })
}

fn request(request_id: &str, expect_revision: u64) -> UpdateRequest {
    UpdateRequest {
        installation_id: INSTALLATION_ID.to_string(),
        request_id: request_id.to_string(),
        expect_revision,
    }
}

fn conflict(result: Result<Value, pacer_foundation::api::CoreError>) -> bool {
    result.unwrap_err().code == Code::Conflict
}

fn conflict_opt(result: Result<Option<Value>, pacer_foundation::api::CoreError>) -> bool {
    result.unwrap_err().code == Code::Conflict
}

fn conflict_unit(result: Result<(), pacer_foundation::api::CoreError>) -> bool {
    result.unwrap_err().code == Code::Conflict
}

/// A minimal schema-1 idle update record accepted by `write_update`.
fn idle_update() -> Value {
    json!({
        "schema": 1,
        "installationId": INSTALLATION_ID,
        "revision": 0,
        "phase": "idle",
        "autoDownload": false,
        "downloadedBytes": 0,
        "blockers": [],
        "requestHistory": [],
    })
}

#[test]
fn adoption_intent_and_receipt_are_one_mutation_without_update_or_record() {
    let home = TempDir::new().unwrap();
    let adopted = begin_adoption(
        home.path(),
        &request(REQUEST_ID, 0),
        &authority(home.path()),
    )
    .unwrap();
    assert_eq!(adopted["phase"], json!("waiting"));
    assert_eq!(adopted["revision"], json!(1));
    assert_eq!(adopted["installationId"], json!(INSTALLATION_ID));
    assert_eq!(adopted["receipts"].as_array().unwrap().len(), 1);
    assert_eq!(
        read_adoption(home.path(), INSTALLATION_ID).unwrap(),
        Some(adopted.clone())
    );
    // No JSON candidate mutation happened: the update record is still absent.
    assert!(
        pacer_desktop_update::read_update(home.path(), INSTALLATION_ID)
            .unwrap()
            .is_none()
    );
}

#[test]
fn committed_change_is_read_and_cancel_closes_it() {
    let home = TempDir::new().unwrap();
    let adopted = begin_adoption(
        home.path(),
        &request(REQUEST_ID, 0),
        &authority(home.path()),
    )
    .unwrap();
    // A fresh read sees the committed row.
    assert_eq!(
        read_adoption(home.path(), INSTALLATION_ID).unwrap(),
        Some(adopted.clone())
    );
    let cancelled = cancel_adoption(
        home.path(),
        &request("cancel", adopted["revision"].as_u64().unwrap()),
    )
    .unwrap();
    assert_eq!(cancelled["phase"], json!("cancelled"));
    assert_eq!(
        read_adoption(home.path(), INSTALLATION_ID).unwrap(),
        Some(cancelled.clone())
    );
}

#[test]
fn exact_retries_replay_and_stale_or_altered_requests_conflict() {
    let home = TempDir::new().unwrap();
    let a = authority(home.path());
    let first = begin_adoption(home.path(), &request(REQUEST_ID, 0), &a).unwrap();
    // Exact retry replays the original record.
    assert_eq!(
        begin_adoption(home.path(), &request(REQUEST_ID, 0), &a).unwrap(),
        first
    );
    // Stale revision on the same request conflicts.
    assert!(conflict(begin_adoption(
        home.path(),
        &request(REQUEST_ID, 1),
        &a
    )));
    // Altered authority (fingerprint change) conflicts.
    let mut altered = a.clone();
    altered["oldServiceExecutable"] = json!("/opt/other");
    assert!(conflict(begin_adoption(
        home.path(),
        &request(REQUEST_ID, 0),
        &altered
    )));
}

#[test]
fn cancellation_uses_its_own_revision_and_cannot_rearm() {
    let home = TempDir::new().unwrap();
    let a = authority(home.path());
    let first = begin_adoption(home.path(), &request(REQUEST_ID, 0), &a).unwrap();
    let cancel_req = request("cancel", first["revision"].as_u64().unwrap());
    let cancelled = cancel_adoption(home.path(), &cancel_req).unwrap();
    assert_eq!(cancelled["phase"], json!("cancelled"));
    // Exact cancel retry returns the same terminal record.
    assert_eq!(
        cancel_adoption(home.path(), &cancel_req).unwrap(),
        cancelled
    );
    // Re-beginning with the original request replays the terminal outcome.
    assert_eq!(
        begin_adoption(home.path(), &request(REQUEST_ID, 0), &a).unwrap(),
        cancelled
    );
}

#[test]
fn archived_authorization_cannot_cancel_and_invalid_transition_rejected() {
    let home = TempDir::new().unwrap();
    let a = authority(home.path());
    let first = begin_adoption(home.path(), &request(REQUEST_ID, 0), &a).unwrap();
    let reserved = transition_adoption(
        home.path(),
        INSTALLATION_ID,
        first["revision"].as_u64().unwrap(),
        "reserved",
        None,
    )
    .unwrap();
    let installing = transition_adoption(
        home.path(),
        INSTALLATION_ID,
        reserved["revision"].as_u64().unwrap(),
        "installing",
        None,
    )
    .unwrap();
    // A non-waiting phase cannot be cancelled at a later revision.
    assert!(conflict(cancel_adoption(
        home.path(),
        &request("cancel", installing["revision"].as_u64().unwrap()),
    )));
    // "cancelled" is not a valid transition out of "installing".
    assert!(conflict(transition_adoption(
        home.path(),
        INSTALLATION_ID,
        installing["revision"].as_u64().unwrap(),
        "cancelled",
        None,
    )));
}

#[test]
fn pending_adoption_blocks_update_cas_and_competing_installation() {
    let home = TempDir::new().unwrap();
    let a = authority(home.path());
    begin_adoption(home.path(), &request(REQUEST_ID, 0), &a).unwrap();
    // Pending adoption blocks update writes.
    assert!(conflict_unit(write_update(
        home.path(),
        parse(idle_update()),
        Some(0)
    )));
    // Pending adoption blocks a competing installation's begin.
    let mut other = a.clone();
    other["target"]["id"] = json!("other");
    other["target"]["pacerHome"] = json!(home.path().to_string_lossy());
    let other_req = UpdateRequest {
        installation_id: "other".to_string(),
        request_id: "other".to_string(),
        expect_revision: 0,
    };
    assert!(conflict(begin_adoption(home.path(), &other_req, &other)));
}

fn parse(value: Value) -> pacer_desktop_update::UpdateRecord {
    pacer_desktop_update::parse_update_record(&value).unwrap()
}

#[test]
fn older_request_replays_terminal_outcome_after_newer_adoption_begins() {
    let home = TempDir::new().unwrap();
    let a = authority(home.path());
    let first = begin_adoption(home.path(), &request(REQUEST_ID, 0), &a).unwrap();
    let old = cancel_adoption(
        home.path(),
        &request("cancel-old", first["revision"].as_u64().unwrap()),
    )
    .unwrap();
    let next = begin_adoption(
        home.path(),
        &UpdateRequest {
            installation_id: INSTALLATION_ID.to_string(),
            request_id: "new-adopt".to_string(),
            expect_revision: 0,
        },
        &a,
    )
    .unwrap();
    assert_ne!(next["transactionId"], first["transactionId"]);
    // Replaying the original request returns the terminal outcome.
    let replay = begin_adoption(home.path(), &request(REQUEST_ID, 0), &a).unwrap();
    assert_eq!(replay["transactionId"], first["transactionId"]);
    assert_eq!(replay["phase"], json!("cancelled"));
    assert_eq!(replay["revision"], old["revision"]);
    assert_eq!(
        read_adoption(home.path(), INSTALLATION_ID)
            .unwrap()
            .unwrap()["transactionId"],
        next["transactionId"]
    );
}

#[test]
fn read_only_replay_and_terminal_read_work() {
    let home = TempDir::new().unwrap();
    let a = authority(home.path());
    let first = begin_adoption(home.path(), &request(REQUEST_ID, 0), &a).unwrap();
    let cancelled = cancel_adoption(
        home.path(),
        &request("cancel-old", first["revision"].as_u64().unwrap()),
    )
    .unwrap();
    // A newer, pending adoption begins on top of the cancelled one.
    let next = begin_adoption(
        home.path(),
        &UpdateRequest {
            installation_id: INSTALLATION_ID.to_string(),
            request_id: "new".to_string(),
            expect_revision: 0,
        },
        &a,
    )
    .unwrap();
    // Replaying the original request returns its terminal outcome without
    // granting anything to the newer row.
    let replay = replay_adoption_request(home.path(), &request(REQUEST_ID, 0), "adopt")
        .unwrap()
        .unwrap();
    assert_eq!(replay["transactionId"], cancelled["transactionId"]);
    assert_eq!(replay["phase"], json!("cancelled"));
    // listAdoptions sees both the pending row and the list.
    let rows = list_adoptions(home.path()).unwrap();
    assert!(
        rows.iter()
            .any(|r| r["installationId"] == json!(INSTALLATION_ID))
    );

    // Drive to committed so read_terminal_adoption can observe it.
    let reserved = transition_adoption(
        home.path(),
        INSTALLATION_ID,
        next["revision"].as_u64().unwrap(),
        "reserved",
        None,
    )
    .unwrap();
    let verifying = transition_adoption(
        home.path(),
        INSTALLATION_ID,
        reserved["revision"].as_u64().unwrap(),
        "verifying",
        None,
    )
    .unwrap();
    let committed = transition_adoption(
        home.path(),
        INSTALLATION_ID,
        verifying["revision"].as_u64().unwrap(),
        "committed",
        Some(&json!({ "resultingInstallationId": "managed" })),
    )
    .unwrap();
    let terminal = read_terminal_adoption(
        home.path(),
        INSTALLATION_ID,
        committed["transactionId"].as_str().unwrap(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(terminal["phase"], json!("committed"));
    assert_eq!(terminal["resultingInstallationId"], json!("managed"));
}

#[test]
fn snapshot_rejects_hardlinked_and_redirected_sqlite() {
    let home = TempDir::new().unwrap();
    let a = authority(home.path());
    begin_adoption(home.path(), &request(REQUEST_ID, 0), &a).unwrap();
    let db = home.path().join("desktop-updates/admission.sqlite");
    let alias = home.path().join("admission.sqlite.alias");
    // Successful read baseline.
    assert!(
        read_adoption(home.path(), INSTALLATION_ID)
            .unwrap()
            .is_some()
    );
    // Hardlink adds a second link count.
    fs::hard_link(&db, &alias).unwrap();
    assert!(conflict_opt(read_adoption(home.path(), INSTALLATION_ID)));
    fs::remove_file(&alias).unwrap();
    assert!(
        read_adoption(home.path(), INSTALLATION_ID)
            .unwrap()
            .is_some()
    );
    // A non-private rollback journal is refused.
    let journal = home.path().join("desktop-updates/admission.sqlite-journal");
    fs::write(&journal, "").unwrap();
    fs::set_permissions(&journal, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(conflict_opt(read_adoption(home.path(), INSTALLATION_ID)));
    fs::remove_file(&journal).unwrap();
    // A redirected (symlinked) database is refused.
    fs::rename(&db, &alias).unwrap();
    std::os::unix::fs::symlink(&alias, &db).unwrap();
    assert!(conflict_opt(read_adoption(home.path(), INSTALLATION_ID)));
}

#[test]
fn revision_exhaustion_preserves_durable_state() {
    let home = TempDir::new().unwrap();
    let a = authority(home.path());
    let first = begin_adoption(home.path(), &request(REQUEST_ID, 0), &a).unwrap();
    cancel_adoption(
        home.path(),
        &request("cancel", first["revision"].as_u64().unwrap()),
    )
    .unwrap();
    // Drive the row to MAX_SAFE directly in sqlite.
    let db_path = home.path().join("desktop-updates/admission.sqlite");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute_batch("PRAGMA journal_mode=DELETE").unwrap();
    let row: String = conn
        .query_row(
            "SELECT body FROM desktop_adoptions WHERE installation_id='attached'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let mut value: Value = serde_json::from_str(&row).unwrap();
    value["revision"] = json!(pacer_desktop_update::adoption_state::MAX_SAFE);
    conn.execute(
        "UPDATE desktop_adoptions SET body=?1 WHERE installation_id='attached'",
        [serde_json::to_string(&value).unwrap()],
    )
    .unwrap();
    drop(conn);
    // A new begin is refused when the adoption revision is exhausted.
    assert!(conflict(begin_adoption(
        home.path(),
        &UpdateRequest {
            installation_id: INSTALLATION_ID.to_string(),
            request_id: "new".to_string(),
            expect_revision: 0,
        },
        &a,
    )));
    // Durable state is preserved at MAX_SAFE.
    assert_eq!(
        read_adoption(home.path(), INSTALLATION_ID)
            .unwrap()
            .unwrap()["revision"],
        json!(pacer_desktop_update::adoption_state::MAX_SAFE)
    );
}

#[test]
fn reconnected_request_replays_original_authority() {
    let home = TempDir::new().unwrap();
    let a = authority(home.path());
    let first = begin_adoption(home.path(), &request(REQUEST_ID, 0), &a).unwrap();
    // The same request reconnecting with a new session replays the original record.
    let mut reconnected = a.clone();
    reconnected["nativeSessionId"] = json!("reconnected");
    reconnected["desktopClientId"] = json!("new-client");
    reconnected["desktop"] = json!({ "pid": 201, "bootId": "boot", "birth": "2:1" });
    let replay = begin_adoption(home.path(), &request(REQUEST_ID, 0), &reconnected).unwrap();
    assert_eq!(replay, first);
    assert_eq!(replay["authority"]["nativeSessionId"], json!("native"));
}

