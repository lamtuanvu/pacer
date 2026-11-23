//! Desktop update policy (mirror of `src/update/desktop/policy.ts`).
//!
//! Pure, candidate-based decision rules that mutate an update record and
//! project a public status. The record stays an ordered `serde_json::Value`
//! so persistence round-trips byte-for-byte with the TypeScript writer
//! (`store.ts`). Recheck enablement reuses `pacer-update`'s channel checks.
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.
use crate::types::{is_valid_identifier, request_fingerprint};
use pacer_foundation::Ctx;
use pacer_foundation::api::{Code, CoreError};
use pacer_update::UPDATE_CACHE_S;
use pacer_update::checks_enabled as update_checks_enabled;
use serde_json::{Map, Value, json};

/// The maximum safe integer both runtimes share (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE: u64 = 9_007_199_254_740_991;

fn conflict(message: &'static str, hint: &'static str) -> CoreError {
    CoreError::new(Code::Conflict, message).hint(hint)
}

fn invalid(message: &'static str) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

/// `checksEnabled`: both the environment and active-strategy opt-outs are
/// reused from `pacer-update` (which aliases `updateChecksEnabled`).
pub fn checks_enabled(ctx: &Ctx) -> bool {
    update_checks_enabled(ctx)
}

/// `checkDue`: persisted timestamps and `now` are Unix seconds. `true` when
/// unset, when the clock moved backwards, or once the cache window elapses.
pub fn check_due(checked_at: Option<u64>, now: u64) -> bool {
    match checked_at {
        None => true,
        Some(at) => now < at || now.wrapping_sub(at) >= UPDATE_CACHE_S,
    }
}

/// The identifying fields common to every update request
/// (`UpdateRequest` in `src/update/desktop/types.ts`).
#[derive(Clone, Debug, PartialEq)]
pub struct UpdateRequest {
    pub installation_id: String,
    pub request_id: String,
    pub expect_revision: u64,
}

/// A restart intent (`RestartRequest`): an update request plus the proposed
/// candidate version and the requesting client identity.
#[derive(Clone, Debug, PartialEq)]
pub struct RestartRequest {
    pub installation_id: String,
    pub request_id: String,
    pub expect_revision: u64,
    pub version: String,
    pub client_id: String,
}

fn assert_identifier(value: &str) -> Result<(), CoreError> {
    if is_valid_identifier(value) {
        Ok(())
    } else {
        Err(invalid("Invalid desktop update identifier"))
    }
}

fn check_expect_revision(expect_revision: u64) -> Result<(), CoreError> {
    if expect_revision <= MAX_SAFE {
        Ok(())
    } else {
        Err(invalid("Invalid desktop update revision"))
    }
}

/// The private, append-only idempotency ledger. Mirrors `replayRequest`.
pub fn replay_request(
    record: &Value,
    request: &UpdateRequest,
    action: &str,
    parameters: &Value,
) -> Result<Option<Value>, CoreError> {
    assert_identifier(&request.installation_id)?;
    assert_identifier(&request.request_id)?;
    check_expect_revision(request.expect_revision)?;
    if record["installationId"].as_str() != Some(request.installation_id.as_str()) {
        return Err(conflict(
            "Desktop update conflict: installation changed",
            "",
        ));
    }
    let requested = request_fingerprint(parameters);
    if let Some(receipt) = find_receipt(record, &request.request_id) {
        if receipt["action"].as_str() != Some(action)
            || receipt["fingerprint"].as_str() != Some(requested.as_str())
        {
            return Err(conflict(
                "Desktop update conflict: request ID was already used for different input",
                "",
            ));
        }
        return Ok(Some(receipt.clone()));
    }
    if record["revision"].as_u64() != Some(request.expect_revision) {
        return Err(conflict(
            "Desktop update conflict: revision changed",
            "Read the current status and retry.",
        ));
    }
    Ok(None)
}

fn find_receipt<'a>(record: &'a Value, request_id: &str) -> Option<&'a Value> {
    record["requestHistory"]
        .as_array()
        .and_then(|history| history.iter().find(|item| item["requestId"] == request_id))
}

/// Append a receipt before CAS persistence; callers must include every action
/// parameter. Mirrors `rememberRequest`.
pub fn remember_request(
    record: Value,
    request: &UpdateRequest,
    action: &str,
    parameters: &Value,
) -> Result<Value, CoreError> {
    if replay_request(&record, request, action, parameters)?.is_some() {
        return Ok(record);
    }
    let mut next = record;
    let transaction_id = next["transactionId"].clone();
    let mut receipt = Map::new();
    receipt.insert("requestId".into(), json!(request.request_id));
    receipt.insert("action".into(), json!(action));
    receipt.insert("fingerprint".into(), json!(request_fingerprint(parameters)));
    receipt.insert("transactionId".into(), transaction_id);
    let history = next
        .get_mut("requestHistory")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| conflict("Desktop update conflict: history is missing", ""))?;
    history.push(Value::Object(receipt));
    Ok(next)
}

/// Request a restart once the approved candidate is complete. Mirrors
/// `requestRestart`.
pub fn request_restart(
    record: Value,
    request: &RestartRequest,
    boot_id: &str,
) -> Result<Value, CoreError> {
    assert_identifier(&request.client_id)?;
    assert_identifier(boot_id)?;
    let parameters = json!({ "version": request.version, "clientId": request.client_id });
    let receipt = replay_request(&record, &as_update_request(request), "restart", &parameters)?;
    if let Some(receipt) = receipt {
        if record["transactionId"] != receipt["transactionId"]
            || record["requestId"] != request.request_id
            || record["requesterBootId"] != boot_id
            || record["requestedBy"] != request.client_id
        {
            return Err(conflict(
                "Desktop update conflict: restart permission expired",
                "Use a new request ID after reviewing the current candidate.",
            ));
        }
        return Ok(record);
    }
    let candidate = record.get("candidate").and_then(|c| c.as_object());
    let ready = record["phase"].as_str() == Some("ready")
        && candidate.is_some()
        && candidate.and_then(|c| c.get("version").and_then(Value::as_str))
            == Some(request.version.as_str())
        && record["totalBytes"].as_u64().is_some_and(|t| t > 0)
        && record["downloadedBytes"].as_u64() == record["totalBytes"].as_u64();
    if !ready {
        return Err(conflict(
            "Desktop update conflict: the approved candidate is not ready",
            "Read the current status before requesting restart.",
        ));
    }
    let mut waiting = record;
    waiting["phase"] = json!("waiting");
    waiting["transactionId"] = json!(uuid::Uuid::new_v4().to_string());
    waiting["requestId"] = json!(request.request_id);
    waiting["requestedBy"] = json!(request.client_id);
    waiting["requesterBootId"] = json!(boot_id);
    waiting["error"] = Value::Null;
    remember_request(waiting, &as_update_request(request), "restart", &parameters)
}

fn as_update_request(request: &RestartRequest) -> UpdateRequest {
    UpdateRequest {
        installation_id: request.installation_id.clone(),
        request_id: request.request_id.clone(),
        expect_revision: request.expect_revision,
    }
}

/// Revoke restart permission, keeping the candidate. Mirrors `cancelRestart`.
pub fn cancel_restart(record: Value) -> Result<Value, CoreError> {
    if record["phase"].as_str() == Some("ready") && record["requestId"].is_null() {
        return Ok(record);
    }
    if record["phase"].as_str() != Some("waiting") {
        return Err(conflict(
            "Desktop update conflict: cancellation is unavailable",
            "Installation cannot be cancelled after reservation.",
        ));
    }
    let mut next = record;
    next["phase"] = json!("ready");
    next["requestId"] = Value::Null;
    next["requestedBy"] = Value::Null;
    next["requesterBootId"] = Value::Null;
    next["blockers"] = json!([]);
    Ok(next)
}

/// A validated desktop installation identity
/// (`Installation` in `src/update/desktop/types.ts`).
#[derive(Clone, Debug)]
pub struct Installation {
    pub id: String,
    pub version: String,
    pub ownership: String,
}

/// Project the public, bounded status. No claim here grants authority to
/// mutate the service. Mirrors `updateStatus`.
pub fn update_status(installation: &Installation, record: &Value) -> Result<Value, CoreError> {
    if installation.id != record["installationId"].as_str().unwrap_or_default() {
        return Err(conflict(
            "Desktop update conflict: installation changed",
            "",
        ));
    }
    let phase = record["phase"].as_str().unwrap_or_default();
    let mut actions: Vec<&str> = Vec::new();
    match phase {
        "idle" | "complete" => {
            actions.push("check");
            let candidate_version = record
                .get("candidate")
                .and_then(|c| c.get("version"))
                .and_then(Value::as_str);
            if !record["candidate"].is_null()
                && candidate_version.is_some_and(|v| v != installation.version)
            {
                actions.push("download");
            }
        }
        "ready" => {
            actions.push("check");
            let complete = record["totalBytes"].as_u64().is_some_and(|t| t > 0)
                && record["downloadedBytes"].as_u64() == record["totalBytes"].as_u64();
            if !record["candidate"].is_null() && complete {
                actions.push("restart");
            }
        }
        "checking" | "downloading" | "waiting" => {
            actions.push("cancel");
        }
        "error" | "restored" => {
            actions.push("check");
            actions.push("retry");
            if !record["candidate"].is_null() {
                actions.push("download");
            }
        }
        _ => {}
    }
    if !matches!(
        phase,
        "reserved" | "installing" | "verifying" | "rolling-back" | "recovery-failed"
    ) {
        actions.push("configure");
    }
    if installation.ownership == "attached"
        && matches!(phase, "idle" | "ready" | "complete" | "error" | "restored")
    {
        actions.push("adopt");
    }

    let errors = record.get("error");
    let error = match errors {
        None | Some(Value::Null) => Value::Null,
        Some(errors) => {
            let mut e = Map::new();
            e.insert(
                "code".into(),
                errors.get("code").cloned().unwrap_or(Value::Null),
            );
            e.insert(
                "message".into(),
                errors.get("message").cloned().unwrap_or(Value::Null),
            );
            if errors.get("hint").is_some() {
                e.insert(
                    "hint".into(),
                    errors.get("hint").cloned().unwrap_or(Value::Null),
                );
            }
            Value::Object(e)
        }
    };

    let blockers = record.get("blockers").cloned().unwrap_or_else(|| json!([]));

    Ok(json!({
        "installationId": record.get("installationId").cloned().unwrap_or(Value::Null),
        "revision": record.get("revision").cloned().unwrap_or(Value::Null),
        "phase": record.get("phase").cloned().unwrap_or(Value::Null),
        "transactionId": record.get("transactionId").cloned().unwrap_or(Value::Null),
        "autoDownload": record.get("autoDownload").cloned().unwrap_or(Value::Null),
        "checkedAt": record.get("checkedAt").cloned().unwrap_or(Value::Null),
        "blockers": blockers,
        "downloadedBytes": record.get("downloadedBytes").cloned().unwrap_or(Value::Null),
        "totalBytes": record.get("totalBytes").cloned().unwrap_or(Value::Null),
        "error": error,
        "current": installation.version,
        "target": record.get("candidate").and_then(|c| c.get("version")).cloned().unwrap_or(Value::Null),
        "releaseNotes": record.get("candidate").and_then(|c| c.get("notes")).cloned().unwrap_or(Value::Null),
        "ownership": installation.ownership,
        "actions": Value::Array(actions.iter().map(|a| json!(a)).collect()),
    }))
}
