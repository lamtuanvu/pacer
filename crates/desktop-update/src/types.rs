//! Desktop update record type and validation (mirror of
//! `src/update/desktop/types.ts`; schema 1).
//!
//! The record is kept as an ordered `serde_json::Value` so persisted bytes
//! round-trip byte-for-byte with the TypeScript writer. `parse_update_record`
//! validates an incoming value against the schema-1 contract, ignoring
//! additive fields but failing closed on invalid known fields or an unsupported
//! schema — matching the TS zod `recordSchema`.
use serde_json::Value;
use sha2::{Digest, Sha256};

/// A validated desktop-update record (schema 1). Kept as JSON for byte
/// parity with the TypeScript store.
#[derive(Clone, Debug, PartialEq)]
pub struct UpdateRecord(Value);

impl UpdateRecord {
    /// Access the underlying ordered value.
    pub fn as_value(&self) -> &Value {
        &self.0
    }
    pub fn into_value(self) -> Value {
        self.0
    }
    pub fn installation_id(&self) -> &str {
        self.0["installationId"].as_str().unwrap_or_default()
    }
    /// Revision as stored on a validated record.
    pub fn revision(&self) -> u64 {
        self.0["revision"].as_u64().unwrap_or(0)
    }
}

/// Validates and wraps a parsed update record. Returns an error message on
/// failure (mirror of the TS zod failure).
pub fn parse_update_record(value: &Value) -> Result<UpdateRecord, &'static str> {
    validate_record(value)?;
    Ok(UpdateRecord(value.clone()))
}

/// The identifier rule from `src/update/desktop/types.ts` (`assertIdentifier`):
/// a first non-empty alphanumeric character, then 0..=127 of
/// alphanumeric, `_` or `-`.
pub fn is_valid_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 {
        return false;
    }
    if !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

/// Shared by request creation, replay and persisted-intent validation. The
/// canonical form is the sorted `[key, value]` lists, hashed with SHA-256.
pub fn request_fingerprint(parameters: &Value) -> String {
    let mut canonical: Vec<(String, Value)> = parameters
        .as_object()
        .map(|map| map.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    canonical.sort_by(|a, b| a.0.cmp(&b.0));
    let json = serde_json::to_string(&canonical).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(json.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn validate_record(value: &Value) -> Result<(), &'static str> {
    let obj = value.as_object().ok_or("not an object")?;
    if obj.get("schema").and_then(Value::as_u64) != Some(1) {
        return Err("unsupported schema");
    }
    let installation_id = obj
        .get("installationId")
        .and_then(Value::as_str)
        .ok_or("installationId")?;
    if !is_valid_identifier(installation_id) {
        return Err("invalid identifier");
    }
    check_revision(obj.get("revision"))?;
    check_phase(obj.get("phase"))?;
    check_optional_identifier(obj.get("transactionId"))?;
    check_optional_identifier(obj.get("requestId"))?;
    check_optional_identifier(obj.get("requestedBy"))?;
    check_optional_identifier(obj.get("requesterBootId"))?;
    check_bool(obj.get("autoDownload"), "autoDownload")?;
    check_checked_at(obj.get("checkedAt"))?;
    check_blockers(obj.get("blockers"))?;
    check_revision(obj.get("downloadedBytes")).map_err(|_| "downloadedBytes")?;
    match obj.get("totalBytes") {
        None | Some(Value::Null) => {}
        Some(v) => check_revision(Some(v))?,
    }
    check_candidate(obj.get("candidate"))?;
    check_error(obj.get("error"))?;
    if let Some(failed) = obj.get("failedVersion")
        && !failed.is_null()
        && failed.as_str().is_none()
    {
        return Err("failedVersion");
    }
    check_request_history(obj.get("requestHistory"))?;

    // Cross-field constraints matching the TS superRefine.
    let total = obj.get("totalBytes").and_then(Value::as_u64);
    let downloaded = obj
        .get("downloadedBytes")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if total.is_some_and(|t| downloaded > t) {
        return Err("download exceeds total");
    }
    let phase = obj.get("phase").and_then(Value::as_str).unwrap_or_default();
    let requires_restart_authority = matches!(
        phase,
        "waiting" | "reserved" | "installing" | "verifying" | "rolling-back"
    );
    let complete_candidate = obj.get("candidate").is_some_and(|c| !c.is_null())
        && total.is_some_and(|t| t > 0)
        && total.is_some_and(|t| downloaded == t);
    if (phase == "ready" || requires_restart_authority) && !complete_candidate {
        return Err("candidate is not complete");
    }
    if requires_restart_authority && !restart_authority_valid(obj) {
        return Err("missing restart authority");
    }
    Ok(())
}

fn check_revision(value: Option<&Value>) -> Result<(), &'static str> {
    match value {
        Some(Value::Number(n)) if n.is_u64() && n.as_u64().unwrap_or(0) <= i64::MAX as u64 => {
            Ok(())
        }
        _ => Err("revision"),
    }
}

fn check_phase(value: Option<&Value>) -> Result<(), &'static str> {
    const PHASES: [&str; 13] = [
        "idle",
        "checking",
        "downloading",
        "ready",
        "waiting",
        "reserved",
        "installing",
        "verifying",
        "complete",
        "rolling-back",
        "restored",
        "error",
        "recovery-failed",
    ];
    match value.and_then(Value::as_str) {
        Some(p) if PHASES.contains(&p) => Ok(()),
        _ => Err("phase"),
    }
}

fn check_optional_identifier(value: Option<&Value>) -> Result<(), &'static str> {
    match value {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(s)) if is_valid_identifier(s) => Ok(()),
        _ => Err("identifier"),
    }
}

fn check_bool(value: Option<&Value>, field: &'static str) -> Result<(), &'static str> {
    match value {
        Some(Value::Bool(_)) => Ok(()),
        _ => Err(field),
    }
}

fn check_checked_at(value: Option<&Value>) -> Result<(), &'static str> {
    // `checkedAt` mirrors TS `clock.nowS()` (`Date.now() / 1000`), an
    // integer or fractional wall-clock seconds. Accept any finite number.
    match value {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Number(n)) if n.is_u64() => Ok(()),
        Some(Value::Number(n)) if n.is_f64() && n.as_f64().unwrap_or(f64::INFINITY).is_finite() => {
            Ok(())
        }
        _ => Err("checkedAt"),
    }
}

fn check_blockers(value: Option<&Value>) -> Result<(), &'static str> {
    let Some(Value::Array(items)) = value else {
        return Err("blockers");
    };
    for item in items {
        let Some(obj) = item.as_object() else {
            return Err("blocker");
        };
        let Some(kind) = obj.get("kind").and_then(Value::as_str) else {
            return Err("blocker kind");
        };
        if !matches!(kind, "task" | "session" | "launch" | "operation") {
            return Err("blocker kind");
        }
        if obj
            .get("id")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err("blocker id");
        }
        if obj.get("label").and_then(Value::as_str).is_none() {
            return Err("blocker label");
        }
    }
    Ok(())
}

fn check_candidate(value: Option<&Value>) -> Result<(), &'static str> {
    match value {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Object(obj)) => {
            let arch = obj.get("arch").and_then(Value::as_str);
            if !matches!(arch, Some("aarch64") | Some("x86_64")) {
                return Err("candidate arch");
            }
            let sha = obj
                .get("sha256")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("candidate sha256");
            }
            if obj.get("version").and_then(Value::as_str).is_none() {
                return Err("candidate version");
            }
            let Some(protos) = obj.get("protocolMajors").and_then(Value::as_array) else {
                return Err("candidate protocolMajors");
            };
            if protos.is_empty() {
                return Err("candidate protocolMajors");
            }
            for value in protos {
                check_revision(Some(value))?;
            }
            if obj.get("signature").and_then(Value::as_str).is_none() {
                return Err("candidate signature");
            }
            if obj.get("url").and_then(Value::as_str).is_none() {
                return Err("candidate url");
            }
            check_bool(
                obj.get("rollbackCompatible"),
                "candidate rollbackCompatible",
            )?;
            if obj.get("notes").and_then(Value::as_str).is_none() {
                return Err("candidate notes");
            }
            Ok(())
        }
        _ => Err("candidate"),
    }
}

fn check_error(value: Option<&Value>) -> Result<(), &'static str> {
    match value {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Object(obj)) => {
            if obj
                .get("code")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return Err("error code");
            }
            if obj.get("message").and_then(Value::as_str).is_none() {
                return Err("error message");
            }
            Ok(())
        }
        _ => Err("error"),
    }
}

fn check_request_history(value: Option<&Value>) -> Result<(), &'static str> {
    let Some(Value::Array(items)) = value else {
        return Err("requestHistory");
    };
    let mut seen = std::collections::HashSet::new();
    for item in items {
        let Some(obj) = item.as_object() else {
            return Err("receipt");
        };
        let Some(request_id) = obj.get("requestId").and_then(Value::as_str) else {
            return Err("receipt requestId");
        };
        if !seen.insert(request_id.to_string()) {
            return Err("duplicate request receipt");
        }
        let Some(action) = obj.get("action").and_then(Value::as_str) else {
            return Err("receipt action");
        };
        if !matches!(
            action,
            "check" | "download" | "restart" | "cancel" | "configure" | "adopt"
        ) {
            return Err("receipt action");
        }
        if obj.get("fingerprint").and_then(Value::as_str).is_none() {
            return Err("receipt fingerprint");
        }
        check_optional_identifier(obj.get("transactionId"))?;
    }
    Ok(())
}

/// Validates the restart-authority cross-field constraint for restart phases:
/// the initiating intent is retained and matches the candidate.
fn restart_authority_valid(obj: &serde_json::Map<String, Value>) -> bool {
    let transaction_id = obj.get("transactionId").and_then(Value::as_str);
    let request_id = obj.get("requestId").and_then(Value::as_str);
    let requested_by = obj.get("requestedBy").and_then(Value::as_str);
    let requester_boot_id = obj.get("requesterBootId").and_then(Value::as_str);
    if transaction_id.is_none()
        || request_id.is_none()
        || requested_by.is_none()
        || requester_boot_id.is_none()
    {
        return false;
    }
    let Some(Value::Array(receipts)) = obj.get("requestHistory") else {
        return false;
    };
    let Some(receipt) = receipts
        .iter()
        .find(|r| r.get("requestId").and_then(Value::as_str) == request_id)
    else {
        return false;
    };
    if receipt.get("action").and_then(Value::as_str) != Some("restart") {
        return false;
    }
    if receipt.get("transactionId").and_then(Value::as_str) != transaction_id {
        return false;
    }
    if let Some(candidate) = obj.get("candidate").and_then(|c| c.as_object()) {
        let version = candidate.get("version").and_then(Value::as_str);
        let fp = request_fingerprint(&serde_json::json!({
            "version": version,
            "clientId": requested_by,
        }));
        if receipt.get("fingerprint").and_then(Value::as_str) != Some(&fp) {
            return false;
        }
    }
    true
}
