//! Desktop update state store (mirror of `src/update/desktop/store.ts`).
//!
//! `read_update` and `write_update` operate on a per-installation JSON file
//! (`desktop-updates/<id>.json`) guarded by the shared admission coordinator
//! (the physical `admission.sqlite` lock), matching the TypeScript crash-safe
//! CAS writer byte-for-byte.
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.
use crate::types::{UpdateRecord, is_valid_identifier, parse_update_record};
use pacer_desktop_admission::coordinator::{self, AdmissionError};
use pacer_foundation::api::{Code, CoreError};
use rusqlite::{OptionalExtension, Transaction};
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

fn conflict(message: &'static str, hint: &'static str) -> CoreError {
    CoreError::new(Code::Conflict, message).hint(hint)
}

fn invalid(message: &'static str) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn boundary() -> CoreError {
    CoreError::new(Code::NotAllowed, "Cannot access desktop update state")
        .hint("Check the service home's ownership and permissions; retain pending recovery state.")
}

fn private(path: &Path, directory: bool) -> Result<(), CoreError> {
    let m = fs::symlink_metadata(path).map_err(|_| boundary())?;
    if (if directory { !m.is_dir() } else { !m.is_file() })
        || m.mode() & 0o077 != 0
        || m.uid() != nix::unistd::Uid::current().as_raw()
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            if directory {
                "Desktop update directory must be private and owned by the service user"
            } else {
                "Desktop update state must be a private regular file"
            },
        ));
    }
    Ok(())
}

fn sync_directory(dir: &Path) -> Result<(), CoreError> {
    let fd = File::open(dir).map_err(|_| boundary())?;
    fd.sync_all().map_err(|_| boundary())
}

fn state_directory(home: &Path, create: bool) -> Result<PathBuf, CoreError> {
    let dir = home.join("desktop-updates");
    if create {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(home)
            .map_err(|_| boundary())?;
        if let Some(parent) = home.parent() {
            sync_directory(parent)?;
        }
        match fs::DirBuilder::new().mode(0o700).create(&dir) {
            Ok(()) => sync_directory(home)?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(boundary()),
        }
        private(&dir, true)?;
    } else {
        // A missing state directory where nothing has been written yet reads as
        // absent (the TS equivalent of the idle initial record), so the
        // permission check is only run against an existing directory.
        match fs::symlink_metadata(&dir) {
            Ok(_) => private(&dir, true)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(boundary()),
        }
    }
    Ok(dir)
}

fn assert_no_pending_adoption(tx: &Transaction<'_>) -> Result<(), CoreError> {
    let table: Option<String> = tx
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='desktop_adoptions'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| boundary())?;
    if table.is_none() {
        return Ok(());
    }
    let mut stmt = tx
        .prepare("SELECT body FROM desktop_adoptions LIMIT 1025")
        .map_err(|_| boundary())?;
    let rows: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|_| boundary())?
        .collect::<Result<_, _>>()
        .map_err(|_| boundary())?;
    drop(stmt);
    let adoption_changed = || {
        CoreError::new(Code::Conflict, "Desktop service adoption changed")
            .hint("Read the current adoption status and retry with a new request ID.")
    };
    if rows.len() > 1024 || rows.iter().any(|b| b.len() > 1048576) {
        return Err(adoption_changed());
    }
    const TERMINAL: [&str; 3] = ["committed", "restored", "cancelled"];
    for body in &rows {
        let value: Value = serde_json::from_str(body).map_err(|_| adoption_changed())?;
        let phase = value.get("phase").and_then(Value::as_str);
        if phase.is_some_and(|p| !TERMINAL.contains(&p)) {
            return Err(conflict(
                "Desktop service adoption is pending",
                "Cancel the waiting adoption or retain its recovery state.",
            ));
        }
    }
    Ok(())
}

/// Reads the current update record for an installation. Returns `Ok(None)`
/// when no state file exists yet (the TS equivalent of the idle initial
/// record).
pub fn read_update(home: &Path, installation_id: &str) -> Result<Option<UpdateRecord>, CoreError> {
    if !is_valid_identifier(installation_id) {
        return Err(invalid("Invalid desktop update identifier"));
    }
    let dir = state_directory(home, false)?;
    let path = dir.join(format!("{installation_id}.json"));
    let mut file = match OpenOptions::new().read(true).open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(boundary()),
    };
    let meta = file.metadata().map_err(|_| boundary())?;
    if !meta.is_file()
        || meta.mode() & 0o077 != 0
        || meta.uid() != nix::unistd::Uid::current().as_raw()
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Desktop update state must be a private regular file",
        ));
    }
    let mut contents = String::new();
    file.read_to_string(&mut contents).map_err(|_| boundary())?;
    let value: Value = serde_json::from_str(&contents)
        .map_err(|_| invalid("Invalid desktop update state JSON"))?;
    let record = parse_update_record(&value).map_err(|_| {
        CoreError::new(Code::InvalidInput, "Invalid desktop update state")
            .hint("Keep the state for diagnosis; do not reset a pending update.")
    })?;
    if record.installation_id() != installation_id {
        return Err(invalid("Desktop update installation identity mismatch"));
    }
    Ok(Some(record))
}

/// The write path, executed inside the shared coordinator transaction.
fn write_update_locked(
    tx: &Transaction<'_>,
    home: &Path,
    valid_id: &str,
    value: &Value,
    current_revision: u64,
    expect_revision: Option<u64>,
    request_history: Option<Value>,
) -> Result<(), CoreError> {
    assert_no_pending_adoption(tx)?;
    let dir = state_directory(home, true)?;

    // Legacy `.lock` is fail-closed and never stolen.
    let lock = dir.join(format!("{valid_id}.lock"));
    if fs::symlink_metadata(&lock).is_ok() {
        return Err(conflict(
            "Desktop update conflict: installation is locked",
            "Retain the legacy lock for recovery.",
        ));
    }

    let current = read_update(home, valid_id)?.map(UpdateRecord::into_value);
    if let Some(expect) = expect_revision {
        let persisted = current
            .as_ref()
            .and_then(|v| v["revision"].as_u64())
            .unwrap_or(0);
        if persisted != expect || current_revision != expect || expect == i64::MAX as u64 {
            return Err(conflict(
                "Desktop update conflict: revision changed",
                "Read the current status and retry.",
            ));
        }
    }

    if let (Some(cur), Some(Value::Array(history))) = (&current, request_history.as_ref())
        && let Some(persisted) = cur.get("requestHistory").and_then(Value::as_array)
    {
        for receipt in persisted {
            let retained = history
                .iter()
                .find(|item| item.get("requestId") == receipt.get("requestId"));
            if !retained.is_some_and(|item| {
                item.get("action") == receipt.get("action")
                    && item.get("fingerprint") == receipt.get("fingerprint")
                    && item.get("transactionId") == receipt.get("transactionId")
            }) {
                return Err(conflict(
                    "Desktop update conflict: request history cannot be changed",
                    "Read the current status and retry.",
                ));
            }
        }
    }

    let mut written = value.clone();
    written["revision"] = (expect_revision.map_or(current_revision + 1, |r| r + 1)).into();
    let mut rendered = pacer_js_json::stringify(&written);
    rendered.push('\n');

    let temp = dir.join(format!("{valid_id}.{}.tmp", uuid::Uuid::new_v4()));
    {
        let mut fd = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)
            .map_err(|_| boundary())?;
        fd.write_all(rendered.as_bytes()).map_err(|_| boundary())?;
        fd.sync_all().map_err(|_| boundary())?;
    }
    fs::rename(&temp, dir.join(format!("{valid_id}.json"))).map_err(|_| boundary())?;
    sync_directory(&dir)?;
    Ok(())
}

/// Writes an update record under the shared coordinator with a revision CAS.
/// `expect_revision`, when provided, must equal both the current persisted
/// revision and the record's own revision; the persisted revision advances by
/// one. Returns `Ok(())` on success.
pub fn write_update(
    home: &Path,
    record: UpdateRecord,
    expect_revision: Option<u64>,
) -> Result<(), CoreError> {
    if !is_valid_identifier(record.installation_id()) {
        return Err(invalid("Invalid desktop update identifier"));
    }
    let value = record.into_value();
    parse_update_record(&value).map_err(|_| invalid("Invalid desktop update state"))?;
    let valid_id = value["installationId"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let current_revision = value["revision"].as_u64().unwrap_or(0);
    let request_history = value.get("requestHistory").cloned();

    coordinator::with_coordinator(home, |tx| {
        write_update_locked(
            tx,
            home,
            &valid_id,
            &value,
            current_revision,
            expect_revision,
            request_history,
        )
        .map_err(|e| AdmissionError::Passthrough(Box::new(e)))
    })
    .map_err(admission_to_core)
}

fn admission_to_core(error: AdmissionError) -> CoreError {
    match error {
        AdmissionError::Passthrough(boxed) => match boxed.downcast::<CoreError>() {
            Ok(core) => *core,
            Err(_) => boundary(),
        },
        AdmissionError::Denied => boundary(),
        AdmissionError::Reason(_) | AdmissionError::Sqlite(_) => conflict(
            "Desktop coordination is unavailable",
            "Retry after active coordination finishes; retain recovery state if this persists.",
        ),
    }
}
