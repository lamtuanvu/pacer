//! Golden tests for the desktop update policy (mirror of the store-relevant
//! `desktop-update-state.test.ts` cases: restart pinning, cancellation,
//! action receipts, status projection, check timing and strategy opt-outs).
#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_desktop_update::policy::{self, Installation, RestartRequest};
use pacer_desktop_update::{
    cancel_restart, check_due, checks_enabled, request_restart, update_status, write_update,
};
use pacer_foundation::Ctx;
use pacer_foundation::api::Code;
use serde_json::{Value, json};
use std::{collections::HashMap, fs, path::Path};
use tempfile::TempDir;

/// The schema-1 ready candidate from `test/fixtures/desktop-update/wire.json`.
fn ready_record() -> Value {
    json!({
        "schema": 1,
        "installationId": "desktop-fixture",
        "revision": 0,
        "phase": "ready",
        "candidate": {
            "version": "1.1.0",
            "arch": "aarch64",
            "sha256": "a".repeat(64),
            "signature": "fixture-signature",
            "url": "https://example.invalid/pacer-1.1.0.tar.gz",
            "protocolMajors": [3],
            "rollbackCompatible": true,
            "notes": "A new release.",
        },
        "transactionId": Value::Null,
        "requestId": Value::Null,
        "requestedBy": Value::Null,
        "requesterBootId": Value::Null,
        "autoDownload": true,
        "checkedAt": 100,
        "blockers": [],
        "downloadedBytes": 1024,
        "totalBytes": 1024,
        "failedVersion": Value::Null,
        "error": Value::Null,
        "requestHistory": [],
    })
}

/// The matched `Installation` from the wire fixture; ownership is "managed".
fn installation() -> Installation {
    Installation {
        id: "desktop-fixture".to_string(),
        version: "1.0.0".to_string(),
        ownership: "managed".to_string(),
    }
}

fn restart_request(record: &Value, request_id: &str) -> RestartRequest {
    RestartRequest {
        installation_id: record["installationId"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        request_id: request_id.to_string(),
        expect_revision: record["revision"].as_u64().unwrap_or(0),
        version: "1.1.0".to_string(),
        client_id: "desktop-client".to_string(),
    }
}

fn conflict(result: Result<Value, pacer_foundation::api::CoreError>) -> bool {
    result.unwrap_err().code == Code::Conflict
}

fn conflict_option(result: Result<Option<Value>, pacer_foundation::api::CoreError>) -> bool {
    result.unwrap_err().code == Code::Conflict
}

fn parse(value: Value) -> pacer_desktop_update::UpdateRecord {
    pacer_desktop_update::parse_update_record(&value).unwrap()
}

/// A minimal `Ctx` with an isolated pacer home.
fn ctx(home: &Path, env: HashMap<String, String>) -> Ctx {
    Ctx::with(home.to_path_buf(), home.to_path_buf(), env, 0.0)
}

#[test]
fn restart_pins_version_installation_and_revision_and_requires_complete_ready() {
    let record = ready_record();
    let req = restart_request(&record, "restart-1");
    for change in [
        json!({ "version": "1.2.0" }),
        json!({ "expectRevision": 9 }),
        json!({ "installationId": "other" }),
    ] {
        let mut r = req.clone();
        if let Some(v) = change.get("version").and_then(Value::as_str) {
            r.version = v.to_string();
        }
        if let Some(e) = change.get("expectRevision").and_then(Value::as_u64) {
            r.expect_revision = e;
        }
        if let Some(i) = change.get("installationId").and_then(Value::as_str) {
            r.installation_id = i.to_string();
        }
        assert!(conflict(request_restart(record.clone(), &r, "boot-1")));
    }
    for change in [
        json!({ "phase": "downloading" }),
        json!({ "candidate": Value::Null }),
        json!({ "downloadedBytes": 100 }),
        json!({ "totalBytes": Value::Null }),
    ] {
        let mut r = record.clone();
        for (k, v) in change.as_object().unwrap() {
            r[k] = v.clone();
        }
        assert!(conflict(request_restart(r, &req, "boot-1")));
    }
    let waiting = request_restart(record.clone(), &req, "boot-1").unwrap();
    assert_eq!(waiting["phase"], json!("waiting"));
    assert_eq!(waiting["requestedBy"], json!("desktop-client"));
    assert_eq!(waiting["requesterBootId"], json!("boot-1"));
    assert_eq!(waiting["requestId"], json!("restart-1"));
    assert!(waiting["transactionId"].is_string());
    // The original record is unchanged (policy is pure).
    assert_eq!(record["phase"], json!("ready"));
}

#[test]
fn cancellation_revokes_permission_keeps_candidate_and_rejects_replay() {
    let record = ready_record();
    let req = restart_request(&record, "restart-1");
    let waiting = request_restart(record.clone(), &req, "boot-1").unwrap();
    let cancelled = cancel_restart(waiting.clone()).unwrap();
    assert_eq!(cancelled["phase"], json!("ready"));
    assert_eq!(cancelled["requestId"], Value::Null);
    assert_eq!(cancelled["requestedBy"], Value::Null);
    assert_eq!(cancelled["requesterBootId"], Value::Null);
    assert_eq!(cancelled["candidate"], record["candidate"]);
    // Replaying the revoked permission now conflicts (phase is no longer waiting).
    assert!(conflict(request_restart(cancelled.clone(), &req, "boot-1")));
    // Cancellation is unavailable outside the waiting phase.
    let mut installing = waiting.clone();
    installing["phase"] = json!("installing");
    assert!(conflict(cancel_restart(installing)));
    // Cancel is idempotent on an already-cancelled ready record.
    assert_eq!(cancel_restart(cancelled.clone()).unwrap(), cancelled);
}

#[test]
fn generic_action_receipts_preserve_fingerprint() {
    let record = ready_record();
    let mut req = restart_request(&record, "configure-1");
    req.version = "fixture".to_string();
    let mut changed = record.clone();
    changed["autoDownload"] = json!(false);
    let saved = policy::remember_request(
        changed,
        &policy::UpdateRequest {
            installation_id: req.installation_id.clone(),
            request_id: req.request_id.clone(),
            expect_revision: 0,
        },
        "configure",
        &json!({ "autoDownload": false }),
    )
    .unwrap();
    assert!(
        policy::replay_request(
            &saved,
            &policy::UpdateRequest {
                installation_id: req.installation_id.clone(),
                request_id: req.request_id.clone(),
                expect_revision: 0,
            },
            "configure",
            &json!({ "autoDownload": false }),
        )
        .unwrap()
        .is_some()
    );
    // A changed payload changes the fingerprint and therefore conflicts.
    assert!(conflict_option(policy::replay_request(
        &saved,
        &policy::UpdateRequest {
            installation_id: req.installation_id.clone(),
            request_id: req.request_id.clone(),
            expect_revision: 0,
        },
        "configure",
        &json!({ "autoDownload": true }),
    )));
}

#[test]
fn status_projects_public_fields_and_actions() {
    let installation = installation();
    let ready = ready_record();
    let status = update_status(&installation, &ready).unwrap();
    assert_eq!(status["current"], json!("1.0.0"));
    assert_eq!(status["target"], json!("1.1.0"));
    assert_eq!(status["ownership"], json!("managed"));
    assert_eq!(status["releaseNotes"], json!("A new release."));
    assert!(
        status["actions"]
            .as_array()
            .unwrap()
            .contains(&json!("restart"))
    );
    for key in [
        "candidate",
        "signature",
        "url",
        "sha256",
        "appPath",
        "pacerHome",
        "requestHistory",
        "requestedBy",
        "requesterBootId",
    ] {
        assert!(status.get(key).is_none(), "{key} must be hidden");
    }
    let req = restart_request(&ready, "restart-1");
    let waiting = request_restart(ready.clone(), &req, "boot-1").unwrap();
    assert_eq!(
        update_status(&installation, &waiting).unwrap()["actions"],
        json!(["cancel", "configure"])
    );
    let mut installing = waiting.clone();
    installing["phase"] = json!("installing");
    assert_eq!(
        update_status(&installation, &installing).unwrap()["actions"],
        json!([])
    );
    let mut recovery = waiting.clone();
    recovery["phase"] = json!("recovery-failed");
    assert_eq!(
        update_status(&installation, &recovery).unwrap()["actions"],
        json!([])
    );
    let attached = Installation {
        ownership: "attached".to_string(),
        ..installation.clone()
    };
    assert!(
        update_status(&attached, &ready).unwrap()["actions"]
            .as_array()
            .unwrap()
            .contains(&json!("adopt"))
    );
}

#[test]
fn checks_use_seconds_at_the_24h_boundary_and_recover_from_backwards_clock() {
    assert!(check_due(None, 100));
    assert!(!check_due(Some(100), 100 + 86_399));
    assert!(check_due(Some(100), 100 + 86_400));
    assert!(check_due(Some(100), 99));
}

#[test]
fn desktop_check_policy_respects_environment_and_active_strategy_opt_outs() {
    let home = TempDir::new().unwrap();
    let mut env = HashMap::new();
    assert!(checks_enabled(&ctx(home.path(), env.clone())));
    env.insert("PACER_NO_UPDATE_CHECK".to_string(), "1".to_string());
    assert!(!checks_enabled(&ctx(home.path(), env.clone())));
    env.remove("PACER_NO_UPDATE_CHECK");

    // strategy.yaml opt-out.
    fs::create_dir_all(home.path()).unwrap();
    fs::write(home.path().join("strategy.yaml"), "update_check: false\n").unwrap();
    assert!(!checks_enabled(&ctx(home.path(), env.clone())));

    // An active strategy that re-enables checks.
    fs::write(home.path().join("active"), "economy").unwrap();
    fs::create_dir_all(home.path().join("strategies")).unwrap();
    fs::write(
        home.path().join("strategies/economy.yaml"),
        "update_check: true\n",
    )
    .unwrap();
    assert!(checks_enabled(&ctx(home.path(), env.clone())));
    fs::write(
        home.path().join("strategies/economy.yaml"),
        "update_check: false\n",
    )
    .unwrap();
    assert!(!checks_enabled(&ctx(home.path(), env)));
}

#[test]
fn offered_candidates_expose_manual_download_only_complete_downloads_expose_restart() {
    let installation = installation();
    let mut offered = ready_record();
    offered["phase"] = json!("idle");
    offered["autoDownload"] = json!(false);
    offered["downloadedBytes"] = json!(0);
    offered["totalBytes"] = Value::Null;
    let actions = update_status(&installation, &offered).unwrap()["actions"]
        .as_array()
        .unwrap()
        .clone();
    assert!(actions.contains(&json!("download")));
    assert!(!actions.contains(&json!("restart")));
    // A partially downloaded ready record has no restart action.
    let mut partial = ready_record();
    partial["downloadedBytes"] = json!(10);
    assert!(
        !update_status(&installation, &partial).unwrap()["actions"]
            .as_array()
            .unwrap()
            .contains(&json!("restart"))
    );
}

#[test]
fn replay_after_persistence_advances_revision_conflicts_for_new_request() {
    let home = TempDir::new().unwrap();
    let record = ready_record();
    let req = restart_request(&record, "restart-1");
    let waiting = request_restart(record, &req, "boot-1").unwrap();
    write_update(home.path(), parse(waiting), Some(0)).unwrap();
    // After persistence the stored revision advances to 1.
    let stored = pacer_desktop_update::read_update(home.path(), "desktop-fixture")
        .unwrap()
        .expect("saved record")
        .into_value();
    assert_eq!(stored["revision"], json!(1));
    // Replaying the same request id is idempotent (the receipt still matches).
    assert!(request_restart(stored.clone(), &req, "boot-1").is_ok());
    // A brand-new request id at the stale revision 0 sees no receipt and the
    // revision hallmark, so it conflicts.
    let fresh = restart_request(&stored, "restart-2");
    assert!(conflict(request_restart(stored, &fresh, "boot-1")));
}
