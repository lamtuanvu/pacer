//! Reconciliation fence, mirroring `src/update/desktop/reconciliation-fence.ts`.
//!
//! The fence is an optimistic-concurrency marker in the same SQLite file as the
//! admission row. A fence owner is bound to its process identity (pid, boot id,
//! birth) so a crashed owner or a reused pid can never release another owner's
//! hold. Unknown writers and coordinator authentication remain unproven; the
//! fence must not be used to authorize native effects.
//!
//! The `PRAGMA user_version` is the version stamp: `1` means the fence has
//! shipped and a matching table exists. `0` means this file has never been
//! initialized here, so any present table is ambiguous and fails closed.
use crate::{AdmissionError, coordinator, process_identity::ProcessIdentity, state};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// A point-in-time fence view. `owner` is the process identity that currently
/// holds the fence, or `None` when it is free.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FenceSnapshot {
    pub epoch: i64,
    pub transaction: Option<String>,
    pub owner: Option<ProcessIdentity>,
}

/// The (not yet committed) row must not already exist when version is unset.
fn conflict() -> AdmissionError {
    AdmissionError::Reason("Reconciliation fence conflict or unavailable identity".to_string())
}

/// Maximum safe integer, matching `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// Read the fence, initializing it when `initialize` is set and the file has
/// never seen one. A present-but-unversioned table, a wrong version, a missing
/// table, or an undecodable row all fail closed (ambiguous).
pub fn optional_fence(
    tx: &Transaction<'_>,
    initialize: bool,
) -> Result<Option<FenceSnapshot>, AdmissionError> {
    let version: i64 = tx
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    let table: Option<String> = tx
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='reconciliation_fence'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if version == 0 {
        if table.is_some() {
            return Err(conflict());
        }
        if !initialize {
            return Ok(None);
        }
        state::ensure_admission(tx, true)?;
        tx.execute_batch(
            "CREATE TABLE reconciliation_fence (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL, transaction_id TEXT, pid INTEGER, boot_id TEXT, birth TEXT)",
        )?;
        tx.execute(
            "INSERT INTO reconciliation_fence (id, epoch) VALUES (1, 0)",
            [],
        )
        .map(|_| ())?;
        tx.pragma_update(None, "user_version", 1)?;
        return Ok(Some(FenceSnapshot {
            epoch: 0,
            transaction: None,
            owner: None,
        }));
    }
    if version != 1 || table.is_none() {
        return Err(conflict());
    }
    read_fence_row(tx).map(Some)
}

/// Read the current fence row, requiring it to be initialized. Fails closed on
/// any ambiguity.
fn read_fence_row(tx: &Transaction<'_>) -> Result<FenceSnapshot, AdmissionError> {
    let row = tx
        .query_row(
            "SELECT epoch, transaction_id, pid, boot_id, birth FROM reconciliation_fence WHERE id = 1",
            [],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten()
        .ok_or_else(conflict)?;
    let (epoch, transaction_id, pid, boot_id, birth) = row;
    // Bounds-check the stored epoch on the read path to match the TS
    // `rowSchema` (`z.number().int().nonnegative().safe()`): the value must
    // be a safe integer at or above zero and no greater than MAX_SAFE. A
    // corrupted row outside these bounds fails closed rather than being
    // accepted. (reserve/release additionally require `epoch < MAX_SAFE`
    // before advancing, matching TS.)
    if epoch < 0 || epoch > MAX_SAFE {
        return Err(conflict());
    }
    // The transaction and owner must be all-set or all-null together.
    let owner = match (
        transaction_id.as_deref(),
        pid,
        boot_id.as_deref(),
        birth.as_deref(),
    ) {
        (Some(tx_id), Some(pid), Some(boot_id), Some(birth))
            if !tx_id.is_empty() && pid > 0 && !boot_id.is_empty() && !birth.is_empty() =>
        {
            Some(ProcessIdentity {
                pid,
                boot_id: boot_id.to_owned(),
                birth: birth.to_owned(),
            })
        }
        (None, None, None, None) => None,
        _ => return Err(conflict()),
    };
    Ok(FenceSnapshot {
        epoch,
        transaction: transaction_id,
        owner,
    })
}

/// Load the fence, initializing it when this file has never seen one. Fatal on
/// ambiguity (used by read/reserve/release).
fn load_fence(tx: &Transaction<'_>) -> Result<FenceSnapshot, AdmissionError> {
    optional_fence(tx, true)?.ok_or_else(conflict)
}

/// Read the fence fence inside a coordinator transaction.
pub fn read_fence(home: &Path) -> Result<FenceSnapshot, AdmissionError> {
    coordinator::with_coordinator(home, |tx| load_fence(tx))
}

/// Attempt to take the fence for `transaction` at exactly `epoch`.
pub fn reserve_fence(
    home: &Path,
    epoch: i64,
    transaction: &str,
) -> Result<FenceSnapshot, AdmissionError> {
    let identity = crate::process_identity::own_process_identity().ok_or_else(|| conflict())?;
    if transaction.is_empty() || !(0..=MAX_SAFE).contains(&epoch) || epoch == MAX_SAFE {
        return Err(conflict());
    }
    coordinator::with_coordinator(home, |tx| {
        let state = load_fence(tx)?;
        crate::reservation::assert_reconciliation_idle(tx, home)?;
        // Orca state requires asynchronous inspection and cannot be proved idle.
        if home.join("orca.json").exists() {
            return Err(conflict());
        }
        if state.epoch != epoch || state.transaction.is_some() {
            return Err(conflict());
        }
        let changes = tx
            .execute(
                "UPDATE reconciliation_fence SET epoch = epoch + 1, transaction_id = ?, pid = ?, boot_id = ?, birth = ? WHERE id = 1 AND epoch = ? AND transaction_id IS NULL",
                params![
                    transaction,
                    identity.pid,
                    identity.boot_id,
                    identity.birth,
                    epoch
                ],
            )
            .map_err(|e| AdmissionError::Sqlite(e))?;
        if changes != 1 {
            return Err(conflict());
        }
        load_fence(tx)
    })
}

/// Release a fence only when `snapshot` still describes the current owner
/// (same epoch, transaction and process). Rejects a stale or foreign hold.
pub fn release_fence(
    home: &Path,
    snapshot: &FenceSnapshot,
) -> Result<FenceSnapshot, AdmissionError> {
    let identity = crate::process_identity::own_process_identity().ok_or_else(|| conflict())?;
    let Some(owner) = snapshot.owner.as_ref() else {
        return Err(conflict());
    };
    if !crate::process_identity::same_process(&Some(identity.clone()), &Some(owner.clone()))
        || snapshot.transaction.is_none()
        || !(0..=MAX_SAFE).contains(&snapshot.epoch)
        || snapshot.epoch == MAX_SAFE
    {
        return Err(conflict());
    }
    coordinator::with_coordinator(home, |tx| {
        let state = load_fence(tx)?;
        if state.epoch != snapshot.epoch
            || state.transaction != snapshot.transaction
            || !crate::process_identity::same_process(&state.owner, &Some(identity.clone()))
        {
            return Err(conflict());
        }
        let changes = tx
            .execute(
                "UPDATE reconciliation_fence SET epoch = epoch + 1, transaction_id = NULL, pid = NULL, boot_id = NULL, birth = NULL WHERE id = 1 AND epoch = ? AND transaction_id = ? AND pid = ? AND boot_id = ? AND birth = ?",
                params![
                    snapshot.epoch,
                    snapshot.transaction,
                    identity.pid,
                    identity.boot_id,
                    identity.birth
                ],
            )
            .map_err(|e| AdmissionError::Sqlite(e))?;
        if changes != 1 {
            return Err(conflict());
        }
        load_fence(tx)
    })
}
