//! Candidate-free adoption state (mirror of `src/update/desktop/adoption-state.ts`).
//!
//! All writers hold the home coordinator transaction (`admission.sqlite`). Rows
//! live in the `desktop_adoptions` table and round-trip byte-for-byte with the
//! TypeScript writer because they are kept as ordered `serde_json::Value`
//! documents. This module owns the schema codec (validation, pending checks,
//! history) that the store uses; it never opens the database itself.
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.
use crate::types::is_valid_identifier;
use pacer_foundation::api::{Code, CoreError};
use pacer_update::is_version;
use rusqlite::{OptionalExtension, Transaction};
use serde_json::Value;

/// `JSON.stringify` replication for adoption rows, byte-for-byte with the TS
/// `saveAdoption` writer (no trailing newline; the sqlite cell is exact).
fn render(value: &Value) -> String {
    pacer_js_json::stringify(value)
}

/// Terminal phases: a pending adoption is anything that is not terminal.
const TERMINAL: [&str; 3] = ["committed", "restored", "cancelled"];

/// Bundle id for the compiled desktop app (`dev.pacer.desktop`).
pub const DESKTOP_BUNDLE_ID: &str = "dev.pacer.desktop";

/// The maximum safe integer both runtimes share (`Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE: u64 = 9_007_199_254_740_991;

fn conflict() -> CoreError {
    CoreError::new(Code::Conflict, "Desktop service adoption changed")
        .hint("Read the current adoption status and retry with a new request ID.")
}

fn pending() -> CoreError {
    CoreError::new(Code::Conflict, "Desktop service adoption is pending")
        .hint("Cancel the waiting adoption or retain its recovery state.")
}

/// ``: a row is pending unless it reached a terminal phase.
pub fn adoption_pending(record: &Value) -> bool {
    let phase = record.get("phase").and_then(Value::as_str);
    !phase.is_some_and(|p| TERMINAL.contains(&p))
}

/// Validation of the descriptor, path and process identity fields shared by the
/// authority schema (`zod` in `adoption-state.ts`). Returns an error label on
/// failure.
fn id(value: Option<&Value>) -> Result<(), &'static str> {
    match value.and_then(Value::as_str) {
        Some(s) if is_valid_identifier(s) => Ok(()),
        _ => Err("id"),
    }
}

fn safe_integer(value: Option<&Value>) -> Result<(), &'static str> {
    match value {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Number(n)) if n.is_u64() && n.as_u64().unwrap_or(0) <= MAX_SAFE => Ok(()),
        _ => Err("integer"),
    }
}

fn path(value: Option<&Value>) -> Result<(), &'static str> {
    let Some(s) = value.and_then(Value::as_str) else {
        return Err("path");
    };
    if s.is_empty()
        || s.len() > 4096
        || !s.starts_with('/')
        || s.contains('\0')
        || s.split('/').any(|p| p == "." || p == "..")
    {
        return Err("path");
    }
    Ok(())
}

/// A hardened process identity object (`processIdentity` in the TS schema).
fn process_identity(value: Option<&Value>) -> Result<(), &'static str> {
    let Some(obj) = value.and_then(Value::as_object) else {
        return Err("processIdentity");
    };
    match obj.get("pid").and_then(Value::as_u64) {
        Some(pid) if pid > 0 => {}
        _ => return Err("pid"),
    }
    if obj
        .get("bootId")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
        || obj
            .get("birth")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return Err("processIdentity");
    }
    Ok(())
}

fn arch(value: Option<&Value>) -> Result<(), &'static str> {
    match value.and_then(Value::as_str) {
        Some("aarch64") | Some("x86_64") => Ok(()),
        _ => Err("arch"),
    }
}

/// The authority (`adoptionAuthoritySchema`): the target installation, the
/// originating session identities, and the resolved service executable path.
pub fn parse_adoption_authority(value: &Value) -> Result<Value, &'static str> {
    let obj = value.as_object().ok_or("authority")?;
    let target = obj.get("target").ok_or("target")?;
    let target_obj = target.as_object().ok_or("target")?;
    id(target_obj.get("id"))?;
    path(target_obj.get("appPath"))?;
    if target_obj.get("bundleId").and_then(Value::as_str) != Some(DESKTOP_BUNDLE_ID) {
        return Err("bundleId");
    }
    safe_integer(target_obj.get("ownerUid"))?;
    arch(target_obj.get("arch"))?;
    path(target_obj.get("pacerHome"))?;
    if !target_obj
        .get("port")
        .and_then(Value::as_u64)
        .is_some_and(|p| (1..=65535).contains(&p))
    {
        return Err("port");
    }
    match target_obj.get("serviceLabel").and_then(Value::as_str) {
        Some(s)
            if !s.is_empty()
                && s.len() <= 128
                && s.as_bytes()[0].is_ascii_alphanumeric()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-') =>
        {
            // valid service label
        }
        _ => return Err("serviceLabel"),
    }
    if target_obj.get("ownership").and_then(Value::as_str) != Some("attached") {
        return Err("ownership");
    }
    if target_obj
        .get("version")
        .and_then(Value::as_str)
        .is_some_and(is_version)
    {
        // pass
    } else {
        return Err("version");
    }

    id(obj.get("nativeSessionId"))?;
    id(obj.get("desktopClientId"))?;
    if obj
        .get("bootId")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err("bootId");
    }
    process_identity(obj.get("desktop"))?;
    process_identity(obj.get("service"))?;
    if obj
        .get("serviceVersion")
        .and_then(Value::as_str)
        .is_some_and(is_version)
    {
        // pass
    } else {
        return Err("serviceVersion");
    }
    path(obj.get("oldServiceExecutable"))?;
    path(obj.get("newServiceExecutable"))?;

    // Cross-field refinement: shared boot id and a resolved service path.
    let boot = obj
        .get("bootId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if obj
        .get("desktop")
        .and_then(|d| d.get("bootId").and_then(Value::as_str))
        != Some(boot)
        || obj
            .get("service")
            .and_then(|d| d.get("bootId").and_then(Value::as_str))
            != Some(boot)
    {
        return Err("bootId");
    }
    let old = obj
        .get("oldServiceExecutable")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let new = obj
        .get("newServiceExecutable")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let app_path = target_obj
        .get("appPath")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if old == new || new != format!("{app_path}/Contents/Resources/pacer") {
        return Err("newServiceExecutable");
    }
    Ok(value.clone())
}

fn receipt(value: Option<&Value>) -> Result<(), &'static str> {
    let Some(obj) = value.and_then(Value::as_object) else {
        return Err("receipt");
    };
    id(obj.get("requestId"))?;
    match obj.get("action").and_then(Value::as_str) {
        Some("adopt") | Some("adoptCancel") => Ok(()),
        _ => Err("receipt action"),
    }?;
    match obj.get("fingerprint").and_then(Value::as_str) {
        Some(f) if f.len() == 64 && f.bytes().all(|b| b.is_ascii_hexdigit()) => Ok(()),
        _ => Err("receipt fingerprint"),
    }?;
    id(obj.get("transactionId"))?;
    safe_integer(obj.get("expectRevision"))?;
    Ok(())
}

fn blocker(value: Option<&Value>) -> Result<(), &'static str> {
    let Some(obj) = value.and_then(Value::as_object) else {
        return Err("blocker");
    };
    match obj.get("kind").and_then(Value::as_str) {
        Some("task") | Some("session") | Some("launch") | Some("operation") => Ok(()),
        _ => Err("blocker kind"),
    }?;
    if obj
        .get("id")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
        || obj.get("label").and_then(Value::as_str).is_none()
    {
        return Err("blocker");
    }
    Ok(())
}

/// The `desktop_adoptions` table row schema (`adoptionSchema`). `< 1024`
/// receipts, exactly one when none yet; the kind-of value may carry only the
/// documented fields.
pub fn parse_adoption(value: &Value) -> Result<Value, &'static str> {
    let obj = value.as_object().ok_or("adoption")?;
    if obj.get("schema").and_then(Value::as_u64) != Some(1) {
        return Err("schema");
    }
    id(obj.get("installationId"))?;
    safe_integer(obj.get("revision"))?;
    id(obj.get("transactionId"))?;
    match obj.get("phase").and_then(Value::as_str) {
        Some("waiting")
        | Some("reserved")
        | Some("installing")
        | Some("verifying")
        | Some("committed")
        | Some("restored")
        | Some("recovery-failed")
        | Some("cancelled") => Ok(()),
        _ => Err("phase"),
    }?;
    parse_adoption_authority(obj.get("authority").unwrap_or(&Value::Null))?;
    match obj.get("resultingInstallationId") {
        None | Some(Value::Null) => Ok(()),
        Some(v) => id(Some(v)),
    }?;
    let Some(Value::Array(blockers)) = obj.get("blockers") else {
        return Err("blockers");
    };
    for b in blockers {
        blocker(Some(b))?;
    }
    match obj.get("error") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Object(_)) => Ok(()),
        _ => Err("error"),
    }?;
    let Some(Value::Array(receipts)) = obj.get("receipts") else {
        return Err("receipts");
    };
    if receipts.is_empty() || receipts.len() > 1024 {
        return Err("receipts");
    }
    let mut seen = std::collections::HashSet::new();
    for r in receipts {
        receipt(Some(r))?;
        let rid = r
            .get("requestId")
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        if let Some(rid) = rid
            && !seen.insert(rid)
        {
            return Err("duplicate receipt");
        }
    }

    // Cross-field refinement.
    let installation = obj.get("installationId").and_then(Value::as_str);
    if obj
        .get("authority")
        .and_then(|a| a.get("target"))
        .and_then(|t| t.get("id"))
        .and_then(Value::as_str)
        != installation
    {
        return Err("installationId");
    }
    if obj.get("phase").and_then(Value::as_str) == Some("committed")
        && obj
            .get("resultingInstallationId")
            .and_then(Value::as_str)
            .is_none()
    {
        return Err("committed must carry resultingInstallationId");
    }
    Ok(value.clone())
}

/// All rows in `desktop_adoptions`, validated, capped at 1024 rows of at most
/// 1 MiB each. Mirrors `adoptionRows`.
pub fn adoption_rows(tx: &Transaction<'_>) -> Result<Vec<Value>, CoreError> {
    let table: Option<String> = tx
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='desktop_adoptions'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| CoreError::new(Code::NotAllowed, "Cannot access desktop adoption state"))?;
    if table.is_none() {
        return Ok(Vec::new());
    }
    let mut stmt = tx
        .prepare("SELECT body FROM desktop_adoptions LIMIT 1025")
        .map_err(|_| CoreError::new(Code::NotAllowed, "Cannot access desktop adoption state"))?;
    let bodies: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|_| CoreError::new(Code::NotAllowed, "Cannot access desktop adoption state"))?
        .collect::<Result<_, _>>()
        .map_err(|_| CoreError::new(Code::NotAllowed, "Cannot access desktop adoption state"))?;
    drop(stmt);
    if bodies.len() > 1024 {
        return Err(conflict());
    }
    let mut rows = Vec::with_capacity(bodies.len());
    for body in bodies {
        if body.len() > 1_048_576 {
            return Err(conflict());
        }
        let value: Value = serde_json::from_str(&body).map_err(|_| conflict())?;
        rows.push(parse_adoption(&value).map_err(|_| conflict())?);
    }
    Ok(rows)
}

/// Fails when any adoption row is pending. Mirrors `assertNoPendingAdoption`.
pub fn assert_no_pending_adoption(tx: &Transaction<'_>) -> Result<(), CoreError> {
    if adoption_rows(tx)?.iter().any(adoption_pending) {
        return Err(pending());
    }
    Ok(())
}

fn parse_history(text: &str) -> Result<Vec<Value>, CoreError> {
    if text.len() > 1_048_576 {
        return Err(conflict());
    }
    let values: Vec<Value> = serde_json::from_str(text).map_err(|_| conflict())?;
    let values = values
        .iter()
        .map(|v| parse_adoption(v).map_err(|_| conflict()))
        .collect::<Result<Vec<_>, _>>()?;
    if values.len() > 1024 || values.iter().any(adoption_pending) {
        return Err(conflict());
    }
    Ok(values)
}

/// Persist an adoption row and its terminal history. Mirrors `saveAdoption`.
/// The caller holds the coordinator transaction.
pub fn save_adoption(tx: &Transaction<'_>, value: &Value) -> Result<Value, CoreError> {
    let parsed = parse_adoption(value).map_err(|_| conflict())?;
    let body = render(&parsed);
    if body.len() > 1_048_576 {
        return Err(conflict());
    }
    tx.execute(
        "CREATE TABLE IF NOT EXISTS desktop_adoptions (installation_id TEXT PRIMARY KEY, body TEXT NOT NULL, history TEXT NOT NULL)",
        [],
    )
    .map_err(|_| CoreError::new(Code::NotAllowed, "Cannot access desktop adoption state"))?;
    let installation_id = parsed
        .get("installationId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let old_row: Option<(String, String)> = tx
        .query_row(
            "SELECT body, history FROM desktop_adoptions WHERE installation_id=?1",
            [&installation_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| CoreError::new(Code::NotAllowed, "Cannot access desktop adoption state"))?;
    let (old_body, old_history) = old_row.unwrap_or_default();

    let transaction_id = parsed
        .get("transactionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut history: Vec<Value> = Vec::new();
    if !old_history.is_empty() {
        let mut loaded = parse_history(&old_history)?;
        loaded.truncate(1024);
        history = loaded;
    }
    if !old_body.is_empty() {
        let previous = parse_adoption(&serde_json::from_str(&old_body).map_err(|_| conflict())?)
            .map_err(|_| conflict())?;
        let prev_tx = previous
            .get("transactionId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if prev_tx != transaction_id {
            if adoption_pending(&previous) {
                return Err(conflict());
            }
            history.push(previous);
        }
    }
    if history.len() > 1024 {
        return Err(conflict());
    }
    let saved_history = render(&Value::Array(history));
    if saved_history.len() > 1_048_576 {
        return Err(conflict());
    }
    tx.execute(
        "INSERT INTO desktop_adoptions (installation_id, body, history) VALUES (?1,?2,?3) ON CONFLICT(installation_id) DO UPDATE SET body=excluded.body, history=excluded.history",
        rusqlite::params![installation_id, body, saved_history],
    )
    .map_err(|_| CoreError::new(Code::NotAllowed, "Cannot access desktop adoption state"))?;
    Ok(parsed)
}

/// Replay a prior row image from history by transaction id. Mirrors
/// `adoptionReplay`.
pub fn adoption_replay(
    tx: &Transaction<'_>,
    current: &Value,
    transaction_id: &str,
) -> Result<Value, CoreError> {
    let current_tx = current
        .get("transactionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if current_tx == transaction_id {
        return Ok(current.clone());
    }
    let installation_id = current
        .get("installationId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let history: Option<String> = tx
        .query_row(
            "SELECT history FROM desktop_adoptions WHERE installation_id=?1",
            rusqlite::params![installation_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| CoreError::new(Code::NotAllowed, "Cannot access desktop adoption state"))?;
    let Some(history) = history else {
        return Err(conflict());
    };
    let result = parse_history(&history)?
        .into_iter()
        .find(|v| v.get("transactionId").and_then(Value::as_str) == Some(transaction_id));
    result.ok_or_else(conflict)
}

/// The empty-Value fallback used by the snapshot reader when no adoption
/// database exists yet.
pub fn empty() -> Vec<Value> {
    Vec::new()
}
