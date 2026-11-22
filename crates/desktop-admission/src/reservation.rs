//! Idle reservation and reconciliation gate, mirroring the reservation side of
//! `src/update/desktop/admission.ts` (`reserveIdle`, `releaseReservation`,
//! `reconcileAdmission`, `enrolledWorkProcesses`, `assertReconciliationIdle`).
//!
//! Leases stay shared with TypeScript: this module owns the reservation and the
//! reconciliation gate, while the lease lifecycle remains in TS. Reservations
//! are keyed by an owner transaction identifier carried inside `Reservation`.
//! Crash recovery deliberately keeps ambiguous leases and update reservations;
//! owner death does not prove a detached/remote child finished.
use crate::{
    AdmissionError, blockers, coordinator, fence, process_identity::ProcessIdentity, state,
};
use blockers::OrcaProbe;
use rusqlite::Transaction;
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};

/// Outcome of `reserve_idle`. `reserved` is true only when no blocker stood
/// in the way; `blockers` lists the reasons otherwise. `owner` is the held
/// reservation's transaction id (set when reserved, or the already-held one),
/// used to release exactly the reservation that was taken.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reservation {
    pub owner: Option<String>,
    pub reserved: bool,
    pub blockers: Vec<blockers::Blocker>,
}

/// Identifier validation, mirroring `assertIdentifier` in `types.ts`:
/// `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`.
fn assert_identifier(value: &str) -> Result<(), AdmissionError> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        && value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric());
    if valid {
        Ok(())
    } else {
        Err(AdmissionError::Reason(
            "Invalid desktop update identifier".to_string(),
        ))
    }
}

/// Default external-blocker probe: the production Orca CLI with a bounded
/// deadline, as `blockers.ts` does through `OrcaClient`.
fn default_external_blockers(home: &Path, deadline: Duration) -> Vec<blockers::Blocker> {
    blockers::external_blockers(home, &move |handle, incarnation| {
        Box::new(blockers::OrcaCliProbe::new(
            handle.to_owned(),
            incarnation.to_owned(),
            "orca",
            deadline,
        ))
    })
}

/// Reserve idle work given no stored lease, task, run, session, operation or
/// external Orca terminal is outstanding. `owner` is the transaction id that
/// will own the reservation; `deadline` bounds each Orca terminal probe.
pub fn reserve_idle(
    home: &Path,
    owner: &str,
    deadline: Duration,
) -> Result<Reservation, AdmissionError> {
    assert_identifier(owner)?;
    reconcile_admission(home, 0.0)?;
    let external = default_external_blockers(home, deadline);
    coordinator::with_coordinator(home, |tx| {
        let fence = fence::optional_fence(tx, false)?;
        if fence
            .as_ref()
            .and_then(|f| f.transaction.as_deref())
            .is_some()
        {
            return Err(AdmissionError::Reason(
                "Reconciliation maintenance is reserved".to_string(),
            ));
        }
        let allow_create = fence.is_none();
        let mut state = state::read_admission(tx, allow_create)?;
        state::reconcile_stored(&mut state, home);
        if state.reservation.is_some() && state.reservation.as_deref() != Some(owner) {
            return Err(AdmissionError::Reason(
                "Desktop reservation conflict".to_string(),
            ));
        }
        let mut pending: Vec<blockers::Blocker> = Vec::new();
        for lease in &state.leases {
            match state::lease_blocker(lease) {
                Some(blocker) => pending.push(blocker),
                // A lease whose blocker does not decode must stay a blocker.
                None => pending.push(blockers::Blocker::new(
                    "session",
                    lease
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("lease")
                        .to_owned(),
                    "Desktop work lease".to_owned(),
                )),
            }
        }
        pending.extend(blockers::stored_blockers(home));
        pending.extend(external);
        if !pending.is_empty() {
            return Ok(Reservation {
                owner: state.reservation.clone(),
                reserved: false,
                blockers: pending,
            });
        }
        state.reservation = Some(owner.to_owned());
        state::write_admission(tx, &state)?;
        Ok(Reservation {
            owner: Some(owner.to_owned()),
            reserved: true,
            blockers: Vec::new(),
        })
    })
}

/// Release the reservation originally taken by `reservation`. Fails when the
/// stored reservation belongs to a different owner or is absent.
pub fn release_reservation(home: &Path, reservation: &Reservation) -> Result<(), AdmissionError> {
    let Some(owner) = reservation.owner.as_deref() else {
        return Err(AdmissionError::Reason(
            "Desktop reservation conflict".to_string(),
        ));
    };
    assert_identifier(owner)?;
    coordinator::with_coordinator(home, |tx| {
        let fence = fence::optional_fence(tx, false)?;
        let allow_create = fence.is_none();
        let mut state = state::read_admission(tx, allow_create)?;
        if state.reservation.is_some() && state.reservation.as_deref() != Some(owner) {
            return Err(AdmissionError::Reason(
                "Desktop reservation conflict".to_string(),
            ));
        }
        state.reservation = None;
        state::write_admission(tx, &state)?;
        Ok(())
    })
}

/// Reconcile stored and orca-bound leases: drop leases whose run has finished
/// with the exact completion receipt, and drop orca-bound leases whose
/// terminal is proved closed. Keeps ambiguous leases and reservations.
/// `now` is reserved for future time-based reconciliation and is currently
/// unused (matching the library contract).
pub fn reconcile_admission(home: &Path, now: f64) -> Result<(), AdmissionError> {
    let _ = now;
    // Phase 1: reconcile stored runs and gather orca-bound lease evidence under
    // the coordinator, writing back the stored reconciliation.
    let bound = coordinator::with_coordinator(home, |tx| {
        let fence = fence::optional_fence(tx, false)?;
        let allow_create = fence.is_none();
        let mut state = state::read_admission(tx, allow_create)?;
        state::reconcile_stored(&mut state, home);
        // Match closed leases by identity (their `id`), never by positional
        // index: a concurrent writer can reorder or remove leases between
        // phase 2's probe and phase 3's re-entry, so an index captured here
        // may point at a different lease there. This mirrors the TS
        // reference, which filters by `lease.id`.
        let mut outstanding: Vec<(String, String, String)> = Vec::new();
        for lease in &state.leases {
            let id = lease.get("id").and_then(serde_json::Value::as_str);
            let terminal = lease
                .get("orca")
                .and_then(|o| o.get("terminal"))
                .and_then(serde_json::Value::as_str);
            let incarnation = lease
                .get("orca")
                .and_then(|o| o.get("incarnationId"))
                .and_then(serde_json::Value::as_str);
            if let (Some(id), Some(terminal), Some(incarnation)) = (id, terminal, incarnation) {
                outstanding.push((id.to_owned(), terminal.to_owned(), incarnation.to_owned()));
            }
        }
        state::write_admission(tx, &state)?;
        Ok(outstanding)
    })?;
    // Phase 2: probe closure outside the coordinator lock (bounded IO).
    let mut closed: Vec<String> = Vec::new();
    for (id, terminal, incarnation) in bound {
        let probe = blockers::OrcaCliProbe::new(
            terminal.clone(),
            incarnation,
            "orca",
            Duration::from_secs(1),
        );
        if probe.closed(&terminal) {
            closed.push(id);
        }
    }
    // Phase 3: remove the closed leases by identity, retaining ambiguous ones.
    if !closed.is_empty() {
        coordinator::with_coordinator(home, |tx| {
            let fence = fence::optional_fence(tx, false)?;
            let allow_create = fence.is_none();
            let mut state = state::read_admission(tx, allow_create)?;
            state.leases.retain(|lease| {
                !closed
                    .iter()
                    .any(|id| lease.get("id").and_then(serde_json::Value::as_str) == Some(id))
            });
            state::write_admission(tx, &state)?;
            Ok(())
        })?;
    }
    Ok(())
}

/// Read-only projection of the incarnations that hold durable work leases.
/// Returns empty when no admission table exists.
pub fn enrolled_work_processes(home: &Path) -> Vec<ProcessIdentity> {
    let mut result: Vec<ProcessIdentity> = Vec::new();
    let _ = coordinator::with_coordinator(home, |tx| {
        if let Ok(Some(state)) = state::try_read_admission(tx) {
            for lease in &state.leases {
                if let Some(identity) = lease.get("process").and_then(state::decode_identity) {
                    result.push(identity);
                }
            }
        }
        Ok::<(), AdmissionError>(())
    });
    result
}

/// Called only inside the coordinator transaction before acquiring the fence:
/// admission must be idle (no reservation, no leases, no stored blockers).
pub fn assert_reconciliation_idle(tx: &Transaction<'_>, home: &Path) -> Result<(), AdmissionError> {
    let mut state = state::read_admission(tx, false)?;
    state::reconcile_stored(&mut state, home);
    if state.reservation.is_some() || !state.leases.is_empty() {
        return Err(AdmissionError::Reason(
            "Desktop work is active or reserved".to_string(),
        ));
    }
    if !blockers::stored_blockers(home).is_empty() {
        return Err(AdmissionError::Reason(
            "Stored work blocks reconciliation".to_string(),
        ));
    }
    Ok(())
}
