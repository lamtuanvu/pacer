//! Install authority for the native front door (port of
//! `src/update/desktop/native-provider.ts` `authorizeInstall` /
//! `verifyOutcome`).
//!
//! `record.rs` provides the bounded read of the helper's private
//! `prepared.json`/`journal.json`/`service-grant.json` transaction. This
//! authority validates the *prepared frame* the desktop peer presents
//! (binding, digest, reservation, and session identity) and then commits
//! the service-owned continuation via `grant_native_transaction`. Outcome
//! verification reads the terminal cleanup record and returns the resulting
//! installation together with whether this grant was attempted.
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.

use std::path::Path;

use pacer_foundation::api::{Code, CoreError};
use serde_json::Value;

use crate::record::{
    NativeProcess, NativeTransaction, grant_native_transaction, read_native_cleanup,
    read_native_transaction, same_native_value,
};

fn denied() -> CoreError {
    CoreError::new(
        Code::NotAllowed,
        "Native transaction authority could not be verified",
    )
    .hint("Retain the transaction for authenticated recovery.")
}

/// The verified native desktop session an install is authorized for.
/// Mirrors the subset of `VerifiedNativeSession` + the installed
/// `Installation` that the prepared-frame checks consume.
#[derive(Clone, Debug)]
pub struct InstallSession {
    /// The verified current installation (`session.installation`).
    pub installation: Value,
    /// `nativeSessionId`.
    pub session_id: String,
    /// `oldDesktop` process (`session.desktop`).
    pub desktop: NativeProcess,
    /// `oldService` process (`session.service`).
    pub service: NativeProcess,
    /// `record.requestedBy` (`session.desktopClientId`).
    pub desktop_client_id: String,
    /// `record.requesterBootId` (`session.bootId`).
    pub boot_id: String,
    /// `oldServiceExecutable` (`this.serviceExecutable`).
    pub service_executable: String,
}

/// Validate that a `session` matches the transaction's own manifest, so the
/// authority refuses to grant against a session identity the record was not
/// bound to.
fn session_binds_tx(session: &InstallSession, tx: &NativeTransaction) -> Result<(), CoreError> {
    if !same_native_value(&tx.command.target, &session.installation)
        || tx.manifest.get("nativeSessionId").and_then(Value::as_str)
            != Some(session.session_id.as_str())
        || !same_native_value(
            &tx.manifest
                .get("oldDesktop")
                .and_then(native_process)
                .map(|p| native_process_value(&p))
                .unwrap_or(Value::Null),
            &native_process_value(&session.desktop),
        )
        || !same_native_value(
            &tx.manifest
                .get("oldService")
                .and_then(native_process)
                .map(|p| native_process_value(&p))
                .unwrap_or(Value::Null),
            &native_process_value(&session.service),
        )
        || tx.record.get("requestedBy").and_then(Value::as_str)
            != Some(session.desktop_client_id.as_str())
        || tx.record.get("requesterBootId").and_then(Value::as_str)
            != Some(session.boot_id.as_str())
        || tx
            .manifest
            .get("oldServiceExecutable")
            .and_then(Value::as_str)
            != Some(session.service_executable.as_str())
    {
        return Err(denied());
    }
    Ok(())
}

fn native_process(value: &Value) -> Option<NativeProcess> {
    let obj = value.as_object()?;
    let pid = obj.get("pid")?.as_u64()?;
    if pid == 0 || pid > u32::MAX as u64 {
        return None;
    }
    let boot_id = obj.get("bootId")?.as_str()?;
    let birth = obj.get("birth")?.as_str()?;
    if boot_id.is_empty() || birth.is_empty() {
        return None;
    }
    Some(NativeProcess {
        pid: pid as u32,
        boot_id: boot_id.to_owned(),
        birth: birth.to_owned(),
    })
}

fn native_process_value(process: &NativeProcess) -> Value {
    serde_json::json!({
        "pid": process.pid,
        "bootId": process.boot_id,
        "birth": process.birth,
    })
}

/// `authorizeInstall`: validate the prepared frame and write the
/// service-owned grant. Returns the authorized transaction.
///
/// `has_reservation` reproduces `hasReservation(ctx, transactionId)` for
/// managed ownership; it is a pure predicate so tests can view it without a
/// coordinator.
pub fn authorize_install(
    home: &Path,
    session: &InstallSession,
    prepared: &Value,
    has_reservation: impl Fn(&str) -> bool,
) -> Result<NativeTransaction, CoreError> {
    let prepared_obj = prepared.as_object().ok_or_else(denied)?;
    let transaction_id = prepared_obj
        .get("transactionId")
        .and_then(Value::as_str)
        .ok_or_else(denied)?;
    let installation_id = prepared_obj
        .get("installationId")
        .and_then(Value::as_str)
        .ok_or_else(denied)?;
    if prepared_obj.get("reservationId").and_then(Value::as_str) != Some(transaction_id) {
        return Err(denied());
    }
    let tx = read_native_transaction(home, installation_id, transaction_id)?;
    // Strip `kind`, `sequence`, `reservationId`, `journalSha256`: the
    // remaining fields are the immutable command binding.
    let binding = {
        let mut map = serde_json::Map::new();
        for (key, val) in prepared_obj {
            if !matches!(
                key.as_str(),
                "kind" | "sequence" | "reservationId" | "journalSha256"
            ) {
                map.insert(key.clone(), val.clone());
            }
        }
        Value::Object(map)
    };
    // The record already bound `command` to `prepared.json`'s digest;
    // compare the presented binding and digest directly.
    if prepared_obj.get("journalSha256").and_then(Value::as_str) != Some(tx.digest.as_str())
        || !same_native_value(&binding, &tx_command_binding(&tx))
    {
        return Err(denied());
    }
    session_binds_tx(session, &tx)?;
    let managed = tx.command.target.get("ownership").and_then(Value::as_str) == Some("managed");
    if managed && !has_reservation(transaction_id) {
        return Err(denied());
    }
    grant_native_transaction(&tx)?;
    Ok(tx)
}

/// The immutable command binding the prepared frame must match
/// (`parseAdapterCommand` minus `command`, `candidate`, `target`). The
/// transaction's `InstallCommand` carries the exact fields the helper bound
/// its `prepared.json` to; this reproduces `native-record.ts`'
/// `commandEntries` (minus the excluded keys).
fn tx_command_binding(tx: &NativeTransaction) -> Value {
    let cmd = &tx.command;
    let mut map = serde_json::Map::new();
    map.insert("schema".into(), serde_json::json!(cmd.schema));
    map.insert("commandId".into(), serde_json::json!(cmd.command_id));
    map.insert(
        "installationId".into(),
        serde_json::json!(cmd.installation_id),
    );
    map.insert(
        "transactionId".into(),
        cmd.transaction_id
            .as_ref()
            .map_or(Value::Null, |t| serde_json::json!(t)),
    );
    map.insert("revision".into(), serde_json::json!(cmd.revision));
    map.insert("nonce".into(), serde_json::json!(cmd.nonce));
    Value::Object(map)
}

/// The verified outcome of an install: the resulting installation and
/// whether this grant was attempted. Mirrors `verifyOutcome`.
///
/// `verify_service` reproduces the `verifyService({ coverage })` check the
/// task condition path applies; the authority calls it for the
/// no-authorization (restored) path only.
pub fn verify_outcome(
    home: &Path,
    session: &InstallSession,
    record: &Value,
    outcome: &str,
    verify_bundle: impl Fn(&Value) -> Result<(), CoreError>,
    verify_service: impl Fn() -> Result<(), CoreError>,
) -> Result<(Value, bool), CoreError> {
    if outcome == "recovery-failed" {
        return Err(denied());
    }
    let transaction_id = record
        .get("transactionId")
        .and_then(Value::as_str)
        .ok_or_else(denied)?;
    let installation_id = record
        .get("installationId")
        .and_then(Value::as_str)
        .ok_or_else(denied)?;
    let tx = read_native_cleanup(home, installation_id, transaction_id)?;
    if tx.journal.get("state").and_then(Value::as_str) != Some(outcome) {
        return Err(denied());
    }
    if tx.authorization.is_none() {
        // Restored without a grant: the bundle must verify and service
        // coverage must be complete, and only `restored` on the same
        // installation is acceptable.
        verify_bundle(&tx.command.target)?;
        verify_service()?;
        if outcome != "restored"
            || tx.command.target.get("id").and_then(Value::as_str)
                != session.installation.get("id").and_then(Value::as_str)
        {
            return Err(denied());
        }
        return Ok((tx.command.target.clone(), false));
    }
    // Granted path: the verification/restoration proof must be present and
    // the session re-verified against the resulting installation.
    let proof = tx
        .journal
        .get(if outcome == "committed" {
            "verificationProof"
        } else {
            "restorationProof"
        })
        .cloned();
    let proof = proof.ok_or_else(denied)?;
    if proof.is_null() {
        return Err(denied());
    }
    session_binds_tx(session, &tx)?;
    let installation = tx.command.target.clone();
    let installed_id = installation.get("id").and_then(Value::as_str);
    let expected_version = installation.get("version").and_then(Value::as_str);
    let record_version = if outcome == "committed" {
        record.get("candidate").and_then(|c| c.get("version"))
    } else {
        session.installation.get("version")
    };
    if installed_id != session.installation.get("id").and_then(Value::as_str)
        || expected_version != record_version.and_then(Value::as_str)
    {
        return Err(denied());
    }
    Ok((installation, true))
}

#[cfg(test)]
#[path = "tests/authority.rs"]
mod tests;
