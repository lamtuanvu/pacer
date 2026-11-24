//! Candidate-free native adoption authority (port of
//! `src/update/desktop/native-adoption.ts`).
//!
//! Only authenticated control consumes these records. `read_adoption_tx`
//! validates the helper's private `adoption-prepared.json` /
//! `adoption-journal.json` / `service-adoption-grant.json` transaction;
//! `grant_adoption` commits the service-owned continuation;
//! `adoption_reconnect_plan` describes the recovery choices a fresh service
//! incarnation may take; `verify_adoption_launch` admits a fresh service
//! against a durable launch intent.
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use pacer_desktop_update::adapter::{parse_adapter_command, parse_install_authorization};
use pacer_desktop_update::types::is_valid_identifier;
use pacer_desktop_update::{read_adoption, read_terminal_adoption};
use pacer_foundation::api::{Code, CoreError};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::record::{NativeProcess, same_native_value};

fn denied() -> CoreError {
    CoreError::new(
        Code::NotAllowed,
        "Native adoption authority could not be verified",
    )
    .hint("Retain the adoption transaction for authenticated recovery.")
}

fn valid_identifier(s: &str) -> bool {
    is_valid_identifier(s)
}

fn private_native_bytes(path: &Path) -> Result<Vec<u8>, CoreError> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| denied())?;
    let meta = file.metadata().map_err(|_| denied())?;
    let uid = nix::unistd::getuid().as_raw();
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.uid() != uid
        || meta.mode() & 0o077 != 0
        || meta.len() > 262_144
    {
        return Err(denied());
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize + 1);
    file.take(262_145)
        .read_to_end(&mut bytes)
        .map_err(|_| denied())?;
    if bytes.len() > 262_144 {
        return Err(denied());
    }
    Ok(bytes)
}

fn read_json(path: &Path) -> Result<Value, CoreError> {
    let bytes = private_native_bytes(path)?;
    serde_json::from_slice(&bytes).map_err(|_| denied())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
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

/// The validated adoption transaction record.
pub struct NativeAdoption {
    pub dir: PathBuf,
    pub digest: String,
    pub manifest: Value,
    pub command: Value,
    pub journal: Value,
    pub authorization: Option<Value>,
    pub record: Value,
    pub receipt: Value,
}

fn adoption_directory(
    home: &Path,
    installation_id: &str,
    transaction_id: &str,
) -> Result<PathBuf, CoreError> {
    if !valid_identifier(installation_id) || !valid_identifier(transaction_id) {
        return Err(denied());
    }
    let mut dir = fs::canonicalize(home).map_err(|_| denied())?;
    for part in ["desktop-updates", "native", installation_id, transaction_id] {
        dir = dir.join(part);
        let meta = fs::symlink_metadata(&dir).map_err(|_| denied())?;
        let uid = nix::unistd::getuid().as_raw();
        if !meta.is_dir()
            || meta.file_type().is_symlink()
            || meta.uid() != uid
            || meta.mode() & 0o077 != 0
        {
            return Err(denied());
        }
    }
    Ok(dir)
}

fn command_without(obj: &Value, stripped: &[&str]) -> Value {
    let mut map = serde_json::Map::new();
    if let Some(src) = obj.as_object() {
        for (key, val) in src {
            if !stripped.contains(&key.as_str()) {
                map.insert(key.clone(), val.clone());
            }
        }
    }
    Value::Object(map)
}

/// `readNativeAdoption`: validated snapshot of an adoption transaction.
pub fn read_adoption_tx(
    home: &Path,
    installation_id: &str,
    transaction_id: &str,
    cleanup: bool,
) -> Result<NativeAdoption, CoreError> {
    let dir = adoption_directory(home, installation_id, transaction_id)?;
    let bytes = private_native_bytes(&dir.join("adoption-prepared.json"))?;
    let digest = sha256_hex(&bytes);
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|_| denied())?;
    let manifest_obj = manifest.as_object().ok_or_else(denied)?;
    if manifest_obj.get("schema").and_then(Value::as_u64) != Some(1)
        || manifest_obj.get("transactionKind").and_then(Value::as_str) != Some("adoption")
    {
        return Err(denied());
    }
    let binding = manifest_obj.get("binding").ok_or_else(denied)?;
    let source = manifest_obj.get("source").ok_or_else(denied)?;
    let source_target = source.get("target").ok_or_else(denied)?;
    let mut command = match binding.as_object() {
        Some(map) => map.clone(),
        None => return Err(denied()),
    };
    command.insert("command".into(), serde_json::json!("adopt"));
    command.insert("target".into(), source_target.clone());
    let command = Value::Object(command);
    parse_adapter_command(&command).map_err(|_| denied())?;
    let cmd_obj = command.as_object().ok_or_else(denied)?;
    if cmd_obj.get("command").and_then(Value::as_str) != Some("adopt")
        || cmd_obj.get("installationId").and_then(Value::as_str) != Some(installation_id)
        || cmd_obj.get("transactionId").and_then(Value::as_str) != Some(transaction_id)
        || fs::canonicalize(home).ok()
            != fs::canonicalize(Path::new(
                cmd_obj
                    .get("target")
                    .and_then(|t| t.get("pacerHome"))
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            ))
            .ok()
    {
        return Err(denied());
    }
    let managed_launch = manifest_obj
        .get("managedLaunchId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let original_launch = manifest_obj
        .get("originalLaunchId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let expected_new_id = manifest_obj
        .get("expectedNewInstallationId")
        .and_then(Value::as_str);
    let helper_rel = manifest_obj
        .get("recoveryJob")
        .and_then(|r| r.get("helper"))
        .and_then(|h| h.get("relativePath"))
        .and_then(Value::as_str);
    if managed_launch.is_none()
        || original_launch.is_none()
        || managed_launch == original_launch
        || expected_new_id == Some(installation_id)
        || helper_rel != Some("pacer-update-helper")
    {
        return Err(denied());
    }
    let record = if cleanup {
        read_terminal_adoption(home, installation_id, transaction_id)?
    } else {
        read_adoption(home, installation_id)?
            .filter(|r| r.get("transactionId").and_then(Value::as_str) == Some(transaction_id))
            .or_else(|| {
                read_terminal_adoption(home, installation_id, transaction_id)
                    .ok()
                    .flatten()
            })
    };
    let record = record.ok_or_else(denied)?;
    if record.get("transactionId").and_then(Value::as_str) != Some(transaction_id) {
        return Err(denied());
    }
    let receipt = record
        .get("receipts")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find(|r| {
                r.get("action").and_then(Value::as_str) == Some("adopt")
                    && r.get("transactionId").and_then(Value::as_str) == Some(transaction_id)
            })
        })
        .cloned()
        .ok_or_else(denied)?;
    let request = manifest_obj.get("request").ok_or_else(denied)?;
    if receipt.get("requestId").and_then(Value::as_str)
        != request.get("requestId").and_then(Value::as_str)
        || receipt.get("fingerprint").and_then(Value::as_str)
            != request.get("fingerprint").and_then(Value::as_str)
        || !same_native_value(record.get("authority").unwrap_or(&Value::Null), source)
    {
        return Err(denied());
    }
    let command_revision = cmd_obj.get("revision").and_then(Value::as_u64).unwrap_or(0);
    let record_revision = record.get("revision").and_then(Value::as_u64).unwrap_or(0);
    if command_revision > record_revision
        || (record.get("phase").and_then(Value::as_str) == Some("reserved")
            && command_revision != record_revision)
    {
        return Err(denied());
    }
    let journal = read_json(&dir.join("adoption-journal.json"))?;
    let journal_obj = journal.as_object().ok_or_else(denied)?;
    if journal_obj.get("schema").and_then(Value::as_u64) != Some(1)
        || journal_obj.get("transactionKind").and_then(Value::as_str) != Some("adoption")
        || journal_obj.get("manifestSha256").and_then(Value::as_str) != Some(digest.as_str())
    {
        return Err(denied());
    }
    let state = journal_obj
        .get("state")
        .and_then(Value::as_str)
        .ok_or_else(denied)?;
    if state.is_empty() {
        return Err(denied());
    }
    let mut authorization = None;
    if let Some(auth) = journal_obj.get("authorization").filter(|a| !a.is_null()) {
        parse_install_authorization(auth).map_err(|_| denied())?;
        let binding = command_without(&command, &["command", "candidate", "target"]);
        let mut expected = serde_json::Map::new();
        if let Some(b) = binding.as_object() {
            for (key, val) in b {
                expected.insert(key.clone(), val.clone());
            }
        }
        expected.insert("kind".into(), serde_json::json!("authorize-install"));
        expected.insert("reservationId".into(), serde_json::json!(transaction_id));
        expected.insert("journalSha256".into(), serde_json::json!(digest));
        if !same_native_value(auth, &Value::Object(expected)) {
            return Err(denied());
        }
        let grant = read_json(&dir.join("service-adoption-grant.json"))?;
        let grant_obj = grant.as_object().ok_or_else(denied)?;
        if !same_native_value(grant_obj.get("authorization").unwrap_or(&Value::Null), auth)
            || grant_obj.get("requestId").and_then(Value::as_str)
                != receipt.get("requestId").and_then(Value::as_str)
            || grant_obj.get("fingerprint").and_then(Value::as_str)
                != receipt.get("fingerprint").and_then(Value::as_str)
            || grant_obj.get("nativeSessionId").and_then(Value::as_str)
                != source.get("nativeSessionId").and_then(Value::as_str)
        {
            return Err(denied());
        }
        authorization = Some(auth.clone());
    }
    let valid_no_auth =
        matches!(state, "preparing" | "prepared") || (cleanup && state == "restored");
    if !valid_no_auth && authorization.is_none() {
        return Err(denied());
    }
    if cleanup && !matches!(state, "committed" | "restored") {
        return Err(denied());
    }
    Ok(NativeAdoption {
        dir,
        digest,
        manifest,
        command,
        journal,
        authorization,
        record,
        receipt,
    })
}

/// `grantNativeAdoption`: write the service-owned adoption grant.
pub fn grant_adoption(tx: &NativeAdoption) -> Result<(), CoreError> {
    if tx.record.get("phase").and_then(Value::as_str) != Some("reserved")
        || tx.authorization.is_some()
        || tx.journal.get("state").and_then(Value::as_str) != Some("prepared")
    {
        return Err(denied());
    }
    let binding = command_without(&tx.command, &["command", "candidate", "target"]);
    let mut inner = serde_json::Map::new();
    if let Some(b) = binding.as_object() {
        for (key, val) in b {
            inner.insert(key.clone(), val.clone());
        }
    }
    inner.insert("kind".into(), serde_json::json!("authorize-install"));
    inner.insert(
        "reservationId".into(),
        tx.command
            .get("transactionId")
            .cloned()
            .unwrap_or(Value::Null),
    );
    inner.insert("journalSha256".into(), serde_json::json!(tx.digest));
    let authorization = Value::Object(inner);
    parse_install_authorization(&authorization).map_err(|_| denied())?;
    let value = serde_json::json!({
        "schema": 1,
        "transactionKind": "adoption",
        "authorization": authorization,
        "requestId": tx.receipt.get("requestId"),
        "fingerprint": tx.receipt.get("fingerprint"),
        "nativeSessionId": tx.manifest.get("source").and_then(|s| s.get("nativeSessionId")),
    });
    let path = tx.dir.join("service-adoption-grant.json");
    let temporary = tx
        .dir
        .join(format!(".adoption-grant-{}", uuid::Uuid::new_v4()));
    {
        let mut fd = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(&temporary)
            .map_err(|_| denied())?;
        fd.write_all(pacer_js_json::stringify(&value).as_bytes())
            .map_err(|_| denied())?;
        fd.sync_all().map_err(|_| denied())?;
    }
    match fs::hard_link(&temporary, &path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = read_json(&path)?;
            if !same_native_value(&existing, &value) {
                return Err(denied());
            }
        }
        Err(_) => return Err(denied()),
    }
    let _ = fs::remove_file(&temporary);
    let dir = fs::File::open(&tx.dir).map_err(|_| denied())?;
    dir.sync_all().map_err(|_| denied())?;
    Ok(())
}

/// `adoptionReconnectPlan`: the recovery choices for a transaction.
#[allow(clippy::redundant_closure)] // mirrors the TS ternary faithfully
pub fn adoption_reconnect_plan(
    tx: &NativeAdoption,
    session: Option<(NativeProcess, String)>,
) -> Value {
    let source = tx.manifest.get("source").cloned().unwrap_or(Value::Null);
    let upgrade_capability = tx
        .journal
        .get("recoveryReconnects")
        .and_then(Value::as_array)
        .and_then(|capabilities| capabilities.last())
        .cloned();
    let native_session_id = upgrade_capability
        .as_ref()
        .and_then(|c| c.get("nativeSessionId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            source
                .get("nativeSessionId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default();
    let desktop = upgrade_capability
        .as_ref()
        .and_then(|c| c.get("desktop"))
        .and_then(native_process)
        .or_else(|| source.get("desktop").and_then(native_process));
    let recovery = upgrade_capability.is_some();
    let managed = if recovery {
        Value::Null
    } else {
        serde_json::json!({
            "branch": "managed",
            "launchId": tx.manifest.get("managedLaunchId"),
            "nonce": tx.manifest.get("managedLaunchId"),
            "executable": source.get("newServiceExecutable"),
            "version": source.get("target").and_then(|t| t.get("version")),
            "installationId": tx.manifest.get("expectedNewInstallationId"),
        })
    };
    let service_version = source
        .get("serviceVersion")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let managed_version = source
        .get("target")
        .and_then(|t| t.get("version"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    // The desktop may be re-observed after a reconnect; `session` supplies
    // the live process. `service_version`, `managed_version` and
    // `original_boot` are the branch invariants the plan's readable form
    // should carry, but they are intentionally not yet surfaced.
    let resolve_version = managed_version
        .clone()
        .or(service_version)
        .unwrap_or_default();
    let original_boot = source
        .get("bootId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_default();
    let desktop_value = desktop
        .clone()
        .map(|p| native_process_value(&p))
        .or_else(|| session.map(|(p, _)| native_process_value(&p)))
        .unwrap_or(Value::Null);
    let _ = (&resolve_version, &original_boot, &native_session_id);
    serde_json::json!({
        "schema": 1,
        "kind": "adoption",
        "installationId": tx.command.get("installationId"),
        "transactionId": tx.command.get("transactionId"),
        "nativeSessionId": native_session_id,
        "manifestSha256": tx.digest,
        "desktop": desktop_value,
        "recovery": recovery,
        "managed": managed,
        "original": {
            "branch": "original",
            "launchId": upgrade_capability
                .as_ref()
                .and_then(|c| c.get("originalLaunchId"))
                .or_else(|| tx.manifest.get("originalLaunchId")),
            "nonce": upgrade_capability
                .as_ref()
                .and_then(|c| c.get("originalLaunchId"))
                .or_else(|| tx.manifest.get("originalLaunchId")),
            "executable": source.get("oldServiceExecutable"),
            "version": source.get("serviceVersion"),
            "installationId": source.get("target").and_then(|t| t.get("id")),
        },
    })
}

fn native_process_value(process: &NativeProcess) -> Value {
    serde_json::json!({
        "pid": process.pid,
        "bootId": process.boot_id,
        "birth": process.birth,
    })
}

/// `verifyAdoptionLaunch`: admit a fresh service incarnation against a
/// durable launch intent.
pub fn verify_adoption_launch(
    home: &Path,
    plan: &Value,
    desktop: &NativeProcess,
    service: &NativeProcess,
    executable: &str,
    version: &str,
) -> Result<(NativeAdoption, Value), CoreError> {
    let installation_id = identifier(plan, "installationId")?;
    let transaction_id = identifier(plan, "transactionId")?;
    let tx = read_adoption_tx(home, installation_id, transaction_id, false)?;
    if tx.authorization.is_none() {
        return Err(denied());
    }
    let recomputed = adoption_reconnect_plan(&tx, None);
    if !same_native_value(plan, &recomputed) {
        return Err(denied());
    }
    if !same_native_value(
        &native_process_value(desktop),
        &plan.get("desktop").cloned().unwrap_or(Value::Null),
    ) {
        return Err(denied());
    }
    let candidates = [plan.get("managed"), plan.get("original")];
    let selected = candidates
        .into_iter()
        .flatten()
        .find(|branch| {
            branch.get("executable").and_then(Value::as_str) == Some(executable)
                && branch.get("version").and_then(Value::as_str) == Some(version)
        })
        .cloned()
        .ok_or_else(denied)?;
    let branch = selected
        .get("branch")
        .and_then(Value::as_str)
        .ok_or_else(denied)?;
    let launch_id = selected
        .get("launchId")
        .and_then(Value::as_str)
        .ok_or_else(denied)?;
    let step = tx
        .journal
        .get("steps")
        .and_then(Value::as_array)
        .and_then(|steps| {
            steps
                .iter()
                .find(|s| {
                    let a = s.get("action");
                    a.and_then(|a| a.get("kind")).and_then(Value::as_str) == Some("launch-service")
                        && a.and_then(|a| a.get("branch")).and_then(Value::as_str) == Some(branch)
                        && a.and_then(|a| a.get("launchId")).and_then(Value::as_str)
                            == Some(launch_id)
                        && s.get("intentBootId").and_then(Value::as_str)
                            == Some(service.boot_id.as_str())
                })
                .cloned()
        })
        .ok_or_else(denied)?;
    if let Some(evidence) = step.get("evidence").filter(|e| !e.is_null()) {
        let ok = evidence
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|k| k == "launched")
            && same_native_value(
                evidence
                    .get("launch")
                    .and_then(|l| l.get("process"))
                    .unwrap_or(&Value::Null),
                &native_process_value(service),
            );
        if !ok {
            return Err(denied());
        }
    }
    Ok((tx, selected))
}

fn identifier<'a>(value: &'a Value, key: &str) -> Result<&'a str, CoreError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| valid_identifier(s))
        .ok_or_else(denied)
}

#[cfg(test)]
#[path = "tests/adoption.rs"]
mod tests;
