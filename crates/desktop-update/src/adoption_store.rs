//! Adoption store: candidate-free adoption lifecycle (mirror of
//! `src/update/desktop/adoption-store.ts`). All writes run inside the shared
//! home coordinator transaction; reads use a private, read-only sqlite
//! snapshot guarded by the same inode/nlink/sidecar checks as the TS
//! snapshot reader. Rows live in the `desktop_adoptions` table and
//! round-trip byte-for-byte with the TypeScript writer.
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.
use crate::adoption_state::{
    self, MAX_SAFE, adoption_pending, adoption_replay, adoption_rows, assert_no_pending_adoption,
    parse_adoption_authority, save_adoption,
};
use crate::store;
use crate::types::{is_valid_identifier, request_fingerprint};
use pacer_desktop_admission::coordinator::{self, AdmissionError};
use pacer_foundation::api::{Code, CoreError};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

fn conflict() -> CoreError {
    CoreError::new(Code::Conflict, "Desktop service adoption changed")
        .hint("Read the current adoption status and retry with a new request ID.")
}

/// A validated adoption update request (`UpdateRequest`).
#[derive(Clone, Debug)]
pub struct UpdateRequest {
    pub installation_id: String,
    pub request_id: String,
    pub expect_revision: u64,
}

fn request(input: &UpdateRequest) -> Result<(), CoreError> {
    if !is_valid_identifier(&input.installation_id)
        || !is_valid_identifier(&input.request_id)
        || input.expect_revision > MAX_SAFE
    {
        return Err(conflict());
    }
    Ok(())
}

/// Read-only snapshot of the `desktop_adoptions` table. Opens the
/// coordinator's sqlite read-only after validating directory/file privacy,
/// single link count, and side-car files, matching `adoptionSnapshot`.
fn adoption_snapshot(home: &std::path::Path) -> Result<Vec<Value>, CoreError> {
    let dir = home.join("desktop-updates");
    let path = dir.join("admission.sqlite");

    // Directory and file private checks; missing file means no rows yet.
    let (dir_meta, file_meta) = match (
        std::fs::symlink_metadata(&dir),
        std::fs::symlink_metadata(&path),
    ) {
        (Ok(d), Ok(f)) => (d, f),
        _ => return Ok(adoption_state::empty()),
    };
    if !dir_meta.is_dir()
        || dir_check(&dir_meta)
        || !file_meta.is_file()
        || file_nlink(&file_meta) != 1
        || file_check_mode_uid(&file_meta)
    {
        return Err(conflict());
    }
    check_sidecars(&path)?;

    // Keep the canonical pathname so SQLite observes its own journal.
    let canonical_dir = std::fs::canonicalize(&dir)
        .map_err(|_| CoreError::new(Code::NotAllowed, "Cannot access desktop adoption state"))?;
    let database_path = canonical_dir.join("admission.sqlite");
    let mut db = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| conflict())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| conflict())?;
    db.pragma_update(None, "query_only", "ON")
        .map_err(|_| conflict())?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)
        .map_err(|_| conflict())?;
    let rows = adoption_rows(&tx)?;
    tx.commit().map_err(|_| conflict())?;
    Ok(rows)
}

fn dir_check(m: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    m.mode() & 0o077 != 0 || m.uid() != nix::unistd::Uid::current().as_raw()
}

fn file_check_mode_uid(m: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    m.mode() & 0o077 != 0 || m.uid() != nix::unistd::Uid::current().as_raw()
}

fn file_nlink(m: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    m.nlink()
}

fn check_sidecars(path: &std::path::Path) -> Result<(), CoreError> {
    for suffix in ["-journal", "-wal", "-shm"] {
        let p = std::path::PathBuf::from(format!("{}{suffix}", path.display()));
        match std::fs::symlink_metadata(&p) {
            Ok(m) => {
                use std::os::unix::fs::MetadataExt;
                if m.file_type().is_symlink()
                    || !m.is_file()
                    || m.nlink() != 1
                    || m.uid() != nix::unistd::Uid::current().as_raw()
                    || m.mode() & 0o077 != 0
                {
                    return Err(conflict());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(conflict()),
        }
    }
    Ok(())
}

/// Read a single adoption row, or `None`. Mirrors `readAdoption`.
pub fn read_adoption(
    home: &std::path::Path,
    installation_id: &str,
) -> Result<Option<Value>, CoreError> {
    if !is_valid_identifier(installation_id) {
        return Err(conflict());
    }
    let rows = adoption_snapshot(home)?;
    Ok(rows
        .into_iter()
        .find(|r| r.get("installationId").and_then(Value::as_str) == Some(installation_id)))
}

/// List all adoption rows. Mirrors `listAdoptions`.
pub fn list_adoptions(home: &std::path::Path) -> Result<Vec<Value>, CoreError> {
    adoption_snapshot(home)
}

/// Begin an adoption. Mirrors `beginAdoption`. The caller holds a
/// coordinator transaction and provides an untrusted authority document.
pub fn begin_adoption(
    home: &std::path::Path,
    input: &UpdateRequest,
    untrusted: &Value,
) -> Result<Value, CoreError> {
    request(input)?;
    let authority = parse_adoption_authority(untrusted).map_err(|_| conflict())?;
    let target_id = authority
        .get("target")
        .and_then(|t| t.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if target_id != input.installation_id {
        return Err(conflict());
    }
    let fingerprint = request_fingerprint(&serde_json::json!({
        "installationId": target_id,
        "oldServiceExecutable": authority.get("oldServiceExecutable"),
        "newServiceExecutable": authority.get("newServiceExecutable"),
        "expectRevision": input.expect_revision.to_string(),
    }));
    coordinator::with_coordinator(home, |tx| {
        let rows = adoption_rows(tx).map_err(admission_passthrough)?;
        let old = rows
            .iter()
            .find(|r| {
                r.get("installationId").and_then(Value::as_str)
                    == Some(input.installation_id.as_str())
            })
            .cloned();
        let receipt = old.as_ref().and_then(|o| {
            o.get("receipts")
                .and_then(Value::as_array)
                .and_then(|rs| {
                    rs.iter().find(|r| {
                        r.get("requestId").and_then(Value::as_str)
                            == Some(input.request_id.as_str())
                    })
                })
                .cloned()
        });
        if let Some(receipt) = receipt {
            let replay_tx = receipt
                .get("transactionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if receipt.get("action").and_then(Value::as_str) != Some("adopt")
                || receipt.get("fingerprint").and_then(Value::as_str) != Some(fingerprint.as_str())
                || receipt.get("expectRevision").and_then(Value::as_u64)
                    != Some(input.expect_revision)
            {
                return Err(admission_passthrough(conflict()));
            }
            let Some(current) = old.as_ref() else {
                return Err(admission_passthrough(conflict()));
            };
            return adoption_replay(tx, current, &replay_tx).map_err(admission_passthrough);
        }
        assert_no_pending_adoption(tx).map_err(admission_passthrough)?;
        let update = store::read_update(home, &input.installation_id)
            .map_err(admission_passthrough)?
            .map(|u| u.into_value())
            // A missing update record is the TS idle initial record.
            .unwrap_or_else(|| serde_json::json!({ "revision": 0, "phase": "idle" }));
        let update_revision = update.get("revision").and_then(Value::as_u64).unwrap_or(0);
        let update_phase = update
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let old_revision = old
            .as_ref()
            .and_then(|o| o.get("revision").and_then(Value::as_u64))
            .unwrap_or(0);
        if update_revision != input.expect_revision
            || !["idle", "ready", "complete", "restored", "error"].contains(&update_phase)
            || update_revision == MAX_SAFE
            || update_revision.max(old_revision) == MAX_SAFE
        {
            return Err(admission_passthrough(conflict()));
        }
        let transaction_id = uuid::Uuid::new_v4().to_string();
        let next_revision = update_revision.max(old_revision) + 1;
        let mut base_receipts: Vec<Value> = old
            .as_ref()
            .and_then(|o| o.get("receipts"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        base_receipts.push(serde_json::json!({
            "requestId": input.request_id,
            "action": "adopt",
            "fingerprint": fingerprint,
            "transactionId": transaction_id,
            "expectRevision": input.expect_revision,
        }));
        let next = serde_json::json!({
            "schema": 1,
            "installationId": input.installation_id,
            "revision": next_revision,
            "transactionId": transaction_id,
            "phase": "waiting",
            "authority": authority,
            "resultingInstallationId": Value::Null,
            "blockers": [],
            "error": Value::Null,
            "receipts": base_receipts,
        });
        save_adoption(tx, &next).map_err(admission_passthrough)
    })
    .map_err(admission_to_core)
}

/// Cancel a waiting adoption. Mirrors `cancelAdoption`.
pub fn cancel_adoption(home: &std::path::Path, input: &UpdateRequest) -> Result<Value, CoreError> {
    request(input)?;
    let fingerprint = request_fingerprint(&serde_json::json!({
        "expectRevision": input.expect_revision.to_string(),
    }));
    coordinator::with_coordinator(home, |tx| {
        let rows = adoption_rows(tx).map_err(admission_passthrough)?;
        let value = rows
            .into_iter()
            .find(|r| {
                r.get("installationId").and_then(Value::as_str)
                    == Some(input.installation_id.as_str())
            })
            .ok_or_else(|| admission_passthrough(conflict()))?;
        let receipt = value
            .get("receipts")
            .and_then(Value::as_array)
            .and_then(|rs| {
                rs.iter().find(|r| {
                    r.get("requestId").and_then(Value::as_str) == Some(input.request_id.as_str())
                })
            })
            .cloned();
        if let Some(receipt) = receipt {
            let replay_tx = receipt
                .get("transactionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if receipt.get("action").and_then(Value::as_str) != Some("adoptCancel")
                || receipt.get("fingerprint").and_then(Value::as_str) != Some(fingerprint.as_str())
                || receipt.get("expectRevision").and_then(Value::as_u64)
                    != Some(input.expect_revision)
            {
                return Err(admission_passthrough(conflict()));
            }
            return adoption_replay(tx, &value, &replay_tx).map_err(admission_passthrough);
        }
        let revision = value.get("revision").and_then(Value::as_u64).unwrap_or(0);
        let phase = value
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if revision != input.expect_revision || phase != "waiting" {
            return Err(admission_passthrough(conflict()));
        }
        let mut next = value;
        next["revision"] = serde_json::json!(revision + 1);
        next["phase"] = serde_json::json!("cancelled");
        next["blockers"] = serde_json::json!([]);
        let mut new_receipt = serde_json::Map::new();
        new_receipt.insert("requestId".into(), serde_json::json!(input.request_id));
        new_receipt.insert("action".into(), serde_json::json!("adoptCancel"));
        new_receipt.insert("fingerprint".into(), serde_json::json!(fingerprint));
        new_receipt.insert(
            "transactionId".into(),
            next.get("transactionId").cloned().unwrap_or(Value::Null),
        );
        new_receipt.insert(
            "expectRevision".into(),
            serde_json::json!(input.expect_revision),
        );
        let Some(receipts) = next.get_mut("receipts").and_then(Value::as_array_mut) else {
            return Err(admission_passthrough(conflict()));
        };
        receipts.push(Value::Object(new_receipt));
        save_adoption(tx, &next).map_err(admission_passthrough)
    })
    .map_err(admission_to_core)
}

/// Allowed phase transitions (`transitions` in the TS store), keyed by the
/// current phase.
fn allowed_transitions(phase: &str) -> &'static [&'static str] {
    match phase {
        "waiting" => &["reserved", "cancelled"],
        "reserved" => &[
            "installing",
            "verifying",
            "restored",
            "cancelled",
            "recovery-failed",
        ],
        "installing" => &["verifying", "restored", "recovery-failed"],
        "verifying" => &["committed", "restored", "recovery-failed"],
        "recovery-failed" => &["verifying", "committed", "restored"],
        "committed" | "restored" | "cancelled" => &[],
        _ => &[],
    }
}

/// Internal runner CAS. Native effects and admission calls always occur
/// outside this callback. Mirrors `transitionAdoption`.
pub fn transition_adoption(
    home: &std::path::Path,
    installation_id: &str,
    expect_revision: u64,
    phase: &str,
    patch: Option<&Value>,
) -> Result<Value, CoreError> {
    if !is_valid_identifier(installation_id) {
        return Err(conflict());
    }
    coordinator::with_coordinator(home, |tx| {
        let rows = adoption_rows(tx).map_err(admission_passthrough)?;
        let value = rows
            .into_iter()
            .find(|r| r.get("installationId").and_then(Value::as_str) == Some(installation_id))
            .ok_or_else(|| admission_passthrough(conflict()))?;
        let revision = value.get("revision").and_then(Value::as_u64).unwrap_or(0);
        let current_phase = value
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let valid_transition = allowed_transitions(current_phase).contains(&phase);
        if revision != expect_revision
            || !adoption_pending(&value)
            || (!valid_transition && phase != current_phase)
        {
            return Err(admission_passthrough(conflict()));
        }
        let mut next = value;
        if let Some(patch) = patch
            && let Some(obj) = patch.as_object()
        {
            for (k, v) in obj {
                next[k] = v.clone();
            }
        }
        next["phase"] = serde_json::json!(phase);
        next["revision"] = serde_json::json!(revision + 1);
        save_adoption(tx, &next).map_err(admission_passthrough)
    })
    .map_err(admission_to_core)
}

/// Read-only replay survives an ownership-ID transition and grants no new
/// native permission. Mirrors `replayAdoptionRequest`.
pub fn replay_adoption_request(
    home: &std::path::Path,
    input: &UpdateRequest,
    action: &str,
) -> Result<Option<Value>, CoreError> {
    request(input)?;
    let rows = adoption_snapshot(home)?;
    let current = rows.into_iter().find(|r| {
        r.get("installationId").and_then(Value::as_str) == Some(input.installation_id.as_str())
    });
    let Some(current) = current else {
        return Ok(None);
    };
    let receipt = current
        .get("receipts")
        .and_then(Value::as_array)
        .and_then(|rs| {
            rs.iter().find(|r| {
                r.get("requestId").and_then(Value::as_str) == Some(input.request_id.as_str())
            })
        });
    let Some(receipt) = receipt else {
        return Ok(None);
    };
    if receipt.get("action").and_then(Value::as_str) != Some(action)
        || receipt.get("expectRevision").and_then(Value::as_u64) != Some(input.expect_revision)
    {
        return Err(conflict());
    }
    let replay_tx = receipt
        .get("transactionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok(Some(replay_from(home, &current, &replay_tx)?))
}

fn replay_from(
    home: &std::path::Path,
    current: &Value,
    transaction_id: &str,
) -> Result<Value, CoreError> {
    coordinator::with_coordinator(home, |tx| {
        adoption_replay(tx, current, transaction_id).map_err(admission_passthrough)
    })
    .map_err(admission_to_core)
}

/// Terminal cleanup may read an immutable prior row image, but cannot resume
/// it. Mirrors `readTerminalAdoption`.
pub fn read_terminal_adoption(
    home: &std::path::Path,
    installation_id: &str,
    transaction_id: &str,
) -> Result<Option<Value>, CoreError> {
    if !is_valid_identifier(installation_id) || !is_valid_identifier(transaction_id) {
        return Err(conflict());
    }
    let rows = adoption_snapshot(home)?;
    let current = rows
        .into_iter()
        .find(|r| r.get("installationId").and_then(Value::as_str) == Some(installation_id));
    let Some(current) = current else {
        return Ok(None);
    };
    let value = replay_from(home, &current, transaction_id)?;
    let phase = value
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !["committed", "restored"].contains(&phase) {
        return Err(conflict());
    }
    Ok(Some(value))
}

fn admission_passthrough(e: CoreError) -> AdmissionError {
    AdmissionError::Passthrough(Box::new(e))
}

fn admission_to_core(error: AdmissionError) -> CoreError {
    match error {
        AdmissionError::Passthrough(boxed) => match boxed.downcast::<CoreError>() {
            Ok(core) => *core,
            Err(_) => CoreError::new(Code::NotAllowed, "Cannot access desktop adoption state"),
        },
        _ => conflict(),
    }
}

/// The bundle id the adoption schema requires, re-exported for callers that
/// need to construct an authority.
pub use adoption_state::DESKTOP_BUNDLE_ID as DESKTOP_IDENTIFIER;
