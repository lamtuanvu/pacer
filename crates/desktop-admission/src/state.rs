//! Admission-row codec, mirroring `src/update/desktop/admission.ts`
//! `ensureAdmission` and the `state` write path.
//!
//! The coordinator grants the `admission` table; this module owns its row
//! codec. Leases stay as raw `serde_json::Value` objects so unknown fields
//! added by other runtimes (for example `remote` or `launched`) survive a
//! round-trip, exactly like the TS schema which ignores additive fields.
use crate::AdmissionError;
use rusqlite::params;
use serde_json::{Value, json};
use std::path::Path;

/// Decoded admission-row state. `leases` are raw objects (the `leaseSchema`
/// structure: `id`, `blocker`, `owner`, `process`, `state`, optional
/// `runDir`/`remote`/`launched`/`orca`), preserved verbatim on writes.
#[derive(Clone, Debug)]
pub struct AdmissionState {
    pub reservation: Option<String>,
    pub leases: Vec<Value>,
}

/// Create the `admission` table and seed the single row on first use.
fn ensure_table(tx: &rusqlite::Transaction<'_>) -> Result<(), AdmissionError> {
    tx.execute_batch(
        "CREATE TABLE admission (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)",
    )?;
    tx.execute(
        "INSERT INTO admission (id, state) VALUES (1, ?)",
        params![
            json!({ "schema": 1, "reservation": serde_json::Value::Null, "leases": [] })
                .to_string()
        ],
    )
    .map(|_| ())?;
    Ok(())
}

/// Ensure the `admission` table and single row exist, creating them when
/// `allow_create` is set (fence initialization). A present-but-undecodable
/// row fails closed. Mirrors `ensureAdmission`.
pub fn ensure_admission(
    tx: &rusqlite::Transaction<'_>,
    allow_create: bool,
) -> Result<AdmissionState, AdmissionError> {
    read_admission(tx, allow_create)
}

/// Read the admission row, creating it first when `allow_create` is set (the
/// fence has been initialized). A present table without its row, or a row
/// that does not decode to schema 1, fails closed (ambiguous).
pub fn read_admission(
    tx: &rusqlite::Transaction<'_>,
    allow_create: bool,
) -> Result<AdmissionState, AdmissionError> {
    let table: Option<String> = tx
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='admission'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if table.is_none() {
        if !allow_create {
            return Err(AdmissionError::Reason(
                "Desktop admission evidence is unavailable".to_string(),
            ));
        }
        ensure_table(tx)?;
    }
    let row: Option<String> = tx
        .query_row("SELECT state FROM admission WHERE id = 1", [], |r| r.get(0))
        .optional()?;
    let Some(text) = row else {
        return Err(AdmissionError::Reason(
            "Desktop admission evidence is unavailable".to_string(),
        ));
    };
    let parsed: Value = serde_json::from_str(&text).map_err(|_| {
        AdmissionError::Reason("Desktop admission evidence is unavailable".to_string())
    })?;
    decode_state(&parsed).ok_or_else(|| {
        AdmissionError::Reason("Desktop admission evidence is unavailable".to_string())
    })
}

/// Read-only authority check: returns the decoded state only when the table
/// already exists and its row decodes. Used by `has_reservation` and
/// `enrolled_work_processes`, which must never create the table.
pub fn try_read_admission(
    conn: &rusqlite::Connection,
) -> Result<Option<AdmissionState>, AdmissionError> {
    let table: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='admission'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if table.is_none() {
        return Ok(None);
    }
    let row: Option<String> = conn
        .query_row("SELECT state FROM admission WHERE id = 1", [], |r| r.get(0))
        .optional()?;
    let Some(text) = row else {
        return Ok(None);
    };
    let parsed: Value = serde_json::from_str(&text).map_err(|_| {
        AdmissionError::Reason("Desktop admission evidence is unavailable".to_string())
    })?;
    decode_state(&parsed)
        .ok_or_else(|| {
            AdmissionError::Reason("Desktop admission evidence is unavailable".to_string())
        })
        .map(Some)
}

/// Serialize the state back to the `{schema, reservation, leases}` row.
pub fn write_admission(
    tx: &rusqlite::Transaction<'_>,
    state: &AdmissionState,
) -> Result<(), AdmissionError> {
    let mut object = serde_json::Map::new();
    object.insert("schema".into(), json!(1));
    object.insert(
        "reservation".into(),
        state.reservation.as_ref().map_or(Value::Null, |v| json!(v)),
    );
    object.insert("leases".into(), Value::Array(state.leases.clone()));
    let text = serde_json::Value::Object(object).to_string();
    tx.execute("UPDATE admission SET state = ? WHERE id = 1", params![text])
        .map(|_| ())?;
    Ok(())
}

/// Decode a parsed row into `AdmissionState`, accepting additive fields but
/// requiring `schema == 1`, a string-or-null reservation, and an array of
/// leases whose entries are objects with `id`, `blocker` and `owner`.
fn decode_state(value: &Value) -> Option<AdmissionState> {
    if value.get("schema").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    if !value.get("leases").is_some_and(Value::is_array) {
        return None;
    }
    let reservation = match value.get("reservation") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Null) | None => None,
        _ => return None,
    };
    Some(AdmissionState {
        reservation,
        leases: value["leases"].as_array()?.clone(),
    })
}

/// Drop leases whose run has actually finished and carries this lease's exact
/// completion receipt (`admission.complete == lease.id`). Owner or parent
/// death does not clear a lease; only positive completion evidence does.
/// Mirrors `reconcileStored`.
pub fn reconcile_stored(state: &mut AdmissionState, home: &Path) {
    state.leases.retain(|lease| {
        let Some(run_dir) = lease.get("runDir").and_then(Value::as_str) else {
            return true;
        };
        let run = Path::new(run_dir);
        let run_abs;
        let dir = if run.is_absolute() {
            run
        } else {
            run_abs = home.join(run_dir);
            &run_abs
        };
        if !crate::blockers::run_finished(dir) {
            return true;
        }
        match std::fs::read_to_string(dir.join("admission.complete")) {
            Ok(text) => text.trim() != lease.get("id").and_then(Value::as_str).unwrap_or(""),
            Err(_) => true,
        }
    });
}

/// Decode a lease's `process` identity, used by lease-blocks and the
/// enrolled-work-processes projection. Fails closed on malformed identity.
pub fn decode_identity(value: &Value) -> Option<crate::process_identity::ProcessIdentity> {
    let pid = value.get("pid").and_then(Value::as_i64)?;
    let boot_id = value.get("bootId").and_then(Value::as_str)?.to_owned();
    let birth = value.get("birth").and_then(Value::as_str)?.to_owned();
    if pid <= 0 || boot_id.is_empty() || birth.is_empty() {
        return None;
    }
    Some(crate::process_identity::ProcessIdentity {
        pid,
        boot_id,
        birth,
    })
}

/// The `blocker` of a lease as an owned tuple `(kind, id, label)`, or `None`
/// when the lease's blocker is malformed.
pub fn lease_blocker(value: &Value) -> Option<crate::blockers::Blocker> {
    let blocker = value.get("blocker")?;
    let kind = blocker.get("kind").and_then(Value::as_str)?.to_owned();
    let id = blocker.get("id").and_then(Value::as_str)?.to_owned();
    let label = blocker.get("label").and_then(Value::as_str)?.to_owned();
    Some(crate::blockers::Blocker::new(&kind, id, label))
}

use rusqlite::OptionalExtension;
