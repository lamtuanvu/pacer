#![allow(clippy::unwrap_used)]
//! Adoption authority tests (transcribed from
//! `src/update/desktop/native-adoption.ts`): committing the service-owned
//! adoption grant onto a real private adoption directory, and the
//! recovery choices a fresh service incarnation may take.
use super::super::adoption::{NativeAdoption, adoption_reconnect_plan, grant_adoption};
use std::os::unix::fs::PermissionsExt;

fn adoption(record_phase: &str) -> NativeAdoption {
    let dir = tempfile::tempdir().unwrap();
    let home = std::fs::canonicalize(dir.path()).unwrap();
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
    // Keep the private directory alive across the transaction's lifetime so
    // grants written onto it survive for later reads (mirrors the helper's
    // real home, which is never deleted mid-transaction).
    std::mem::forget(dir);
    let digest = "d".repeat(64);
    let receipt = serde_json::json!({
        "action": "adopt",
        "requestId": "req-1",
        "fingerprint": "fp-1",
        "transactionId": "tx-1",
    });
    let record = serde_json::json!({
        "schema": 1,
        "installationId": "fixture",
        "revision": 1,
        "transactionId": "tx-1",
        "phase": record_phase,
        "receipts": [receipt.clone()],
    });
    NativeAdoption {
        dir: home.clone(),
        digest: digest.clone(),
        manifest: serde_json::json!({
            "schema": 1,
            "transactionKind": "adoption",
            "managedLaunchId": "launch-managed",
            "originalLaunchId": "launch-original",
            "expectedNewInstallationId": "fixture-next",
            "recoveryJob": {"helper": {"relativePath": "pacer-update-helper"}},
            "source": {
                "nativeSessionId": "ses-1",
                "bootId": "boot-one",
                "oldServiceExecutable": "/app/Contents/Resources/pacer",
                "newServiceExecutable": "/app/Contents/Resources/pacer",
                "serviceVersion": "1.0.0",
                "desktop": {"pid": 1, "bootId": "boot-one", "birth": "1:1"},
                "service": {"pid": 2, "bootId": "boot-one", "birth": "1:2"},
                "target": {"id": "fixture", "version": "1.0.0"},
            },
            "request": {"requestId": "req-1", "fingerprint": "fp-1"},
        }),
        command: serde_json::json!({
            "schema": 1,
            "commandId": "c",
            "installationId": "fixture",
            "transactionId": "tx-1",
            "revision": 1,
            "nonce": "b".repeat(64),
            "command": "adopt",
            "target": {"id": "fixture", "pacerHome": home.to_str().unwrap()},
        }),
        journal: serde_json::json!({
            "schema": 1,
            "transactionKind": "adoption",
            "manifestSha256": digest,
            "state": "prepared",
            "steps": [],
        }),
        authorization: None,
        record,
        receipt,
    }
}

#[test]
fn grant_writes_the_service_owned_continuation() {
    let tx = adoption("reserved");
    let grant_path = tx.dir.join("service-adoption-grant.json");
    grant_adoption(&tx).unwrap();

    // The durable grant now carries the authorization bound to this
    // transaction and the receipt's request identity.
    let grant: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&grant_path).unwrap()).unwrap();
    assert_eq!(grant["schema"], 1);
    assert_eq!(
        grant["authorization"]["kind"],
        serde_json::json!("authorize-install")
    );
    assert_eq!(grant["authorization"]["reservationId"], "tx-1");
    assert_eq!(grant["authorization"]["transactionId"], "tx-1");
    assert_eq!(grant["requestId"], "req-1");
    assert_eq!(grant["fingerprint"], "fp-1");
    assert_eq!(grant["nativeSessionId"], "ses-1");

    // Re-granting the same transaction is idempotent.
    grant_adoption(&tx).unwrap();
}

#[test]
fn grant_refuses_until_the_transaction_is_reserved() {
    // A waiting (not reserved) adoption is not yet committable.
    assert!(grant_adoption(&adoption("waiting")).is_err());
}

#[test]
fn reconnect_plan_offers_managed_branch_and_recovery_for_fresh_service() {
    let tx = adoption("reserved");
    let plan = adoption_reconnect_plan(&tx, None);
    assert_eq!(plan["schema"], 1);
    assert_eq!(plan["kind"], "adoption");
    assert_eq!(plan["installationId"], "fixture");
    assert_eq!(plan["transactionId"], "tx-1");
    assert_eq!(plan["nativeSessionId"], "ses-1");
    assert_eq!(plan["manifestSha256"], tx.digest);
    assert_eq!(plan["recovery"], serde_json::Value::Bool(false));

    // The managed branch names the launch intent and target version.
    let managed = &plan["managed"];
    assert_eq!(managed["branch"], "managed");
    assert_eq!(managed["launchId"], "launch-managed");
    assert_eq!(managed["version"], "1.0.0");

    // The original branch carries the old service variant.
    let original = &plan["original"];
    assert_eq!(original["branch"], "original");
    assert_eq!(original["version"], "1.0.0");
}
