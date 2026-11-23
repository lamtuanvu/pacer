//! Native transaction records (port of `src/update/desktop/native-record.ts`).
//!
//! Bounded, read-mostly native access to the private per-transaction
//! journals written by the desktop helper: `prepared.json` (the immutable
//! manifest), `journal.json` (the helper's write-ahead log) and, once a
//! service grants authority, `service-grant.json`. The intended caller
//! model is: `read_native_transaction` at work scheduling, `verify_native_launch`
//! to admit a freshly-launched desktop peer, `grant_native_transaction` to
//! commit the service-owned continuation (the helper remains the sole journal
//! writer), `discover_service_launch` during service start, and
//! `read_native_cleanup` for terminal cleanup.

#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.

use pacer_desktop_update::adapter::{parse_adapter_command, parse_install_authorization};
use pacer_desktop_update::types::is_valid_identifier;
use pacer_desktop_update::{read_update, request_fingerprint};
use pacer_foundation::api::{Code, CoreError};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

/// A verified native process identity (`nativeProcessSchema`).
#[derive(Clone, Debug, PartialEq)]
pub struct NativeProcess {
    pub pid: u32,
    pub boot_id: String,
    pub birth: String,
}

/// The parsed install command derived from a manifest's binding plus the
/// `install` target and candidate (the subset the record checks consume).
#[derive(Clone, Debug)]
pub struct InstallCommand {
    pub schema: u64,
    pub command_id: String,
    pub installation_id: String,
    pub transaction_id: Option<String>,
    pub revision: u64,
    pub nonce: String,
    pub target: Value,
    pub candidate: Value,
}

/// A titled, validated transfer of value: `prepared.json` digest plus the
/// parsed fields the record reads bind to a private transaction.
fn denied() -> CoreError {
    CoreError::new(
        Code::NotAllowed,
        "Native transaction authority could not be verified",
    )
    .hint("Retain the transaction for authenticated recovery.")
}

fn is_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| (b'a'..=b'f').contains(&b) || b.is_ascii_digit())
}

fn hash_from(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| is_hash(s))
}

fn identifier_from(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| is_valid_identifier(s))
}

/// `sameNativeValue`: canonical comparison that sorts object keys
/// recursively and compares the canonical JSON text.
pub fn same_native_value(a: &Value, b: &Value) -> bool {
    pacer_js_json::stringify(&canonical(a)) == pacer_js_json::stringify(&canonical(b))
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Object(fields) => {
            let mut keys: Vec<&String> = fields.keys().collect();
            keys.sort();
            let mut map = serde_json::Map::new();
            for key in keys {
                map.insert(key.clone(), canonical(&fields[key]));
            }
            Value::Object(map)
        }
        other => other.clone(),
    }
}

/// `nativeTransactionDirectory`: walks `pacerHome/desktop-updates/native/
/// <installationId>/<transactionId>`, each an owned, non-symlink private
/// directory.
fn native_transaction_directory(
    pacer_home: &Path,
    installation_id: &str,
    transaction_id: &str,
) -> Result<PathBuf, CoreError> {
    if !is_valid_identifier(installation_id) || !is_valid_identifier(transaction_id) {
        return Err(denied());
    }
    let home = fs::canonicalize(pacer_home).map_err(|_| denied())?;
    let mut path = home;
    for part in ["desktop-updates", "native", installation_id, transaction_id] {
        path = path.join(part);
        let meta = fs::symlink_metadata(&path).map_err(|_| denied())?;
        let uid = nix::unistd::getuid().as_raw();
        if !meta.is_dir()
            || meta.file_type().is_symlink()
            || meta.uid() != uid
            || meta.mode() & 0o077 != 0
        {
            return Err(denied());
        }
    }
    Ok(path)
}

/// `privateNativeBytes`: a bounded read of a private, single-link regular
/// file (262144 bytes cap), exposing no symlink following.
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

fn read_json_file(path: &Path) -> Result<Value, CoreError> {
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

fn native_process_value(process: &NativeProcess) -> Value {
    serde_json::json!({
        "pid": process.pid,
        "bootId": process.boot_id,
        "birth": process.birth,
    })
}

/// Build the `install` command from `manifest.binding` and validate it.
fn parse_install_command(
    binding: &Value,
    target: &Value,
    candidate: &Value,
) -> Result<InstallCommand, CoreError> {
    let mut command = match binding.as_object() {
        Some(map) => map.clone(),
        None => return Err(denied()),
    };
    command.insert("command".into(), serde_json::json!("install"));
    command.insert("target".into(), target.clone());
    command.insert("candidate".into(), candidate.clone());
    let command = Value::Object(command);
    parse_adapter_command(&command).map_err(|_| denied())?;
    let obj = command.as_object().ok_or_else(denied)?;
    let schema = obj
        .get("schema")
        .and_then(Value::as_u64)
        .ok_or_else(denied)?;
    let command_id = obj
        .get("commandId")
        .and_then(Value::as_str)
        .ok_or_else(denied)?
        .to_owned();
    let installation_id = obj
        .get("installationId")
        .and_then(Value::as_str)
        .ok_or_else(denied)?
        .to_owned();
    let transaction_id = match obj.get("transactionId") {
        Some(Value::Null) | None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err(denied()),
    };
    let revision = obj
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or_else(denied)?;
    let nonce = obj
        .get("nonce")
        .and_then(Value::as_str)
        .ok_or_else(denied)?
        .to_owned();
    let target = target.clone();
    let candidate = candidate.clone();
    Ok(InstallCommand {
        schema,
        command_id,
        installation_id,
        transaction_id,
        revision,
        nonce,
        target,
        candidate,
    })
}

struct Manifest {
    native_session_id: String,
    old_desktop: NativeProcess,
    old_service: NativeProcess,
    old_service_executable: String,
}

fn parse_manifest(value: &Value) -> Result<Manifest, CoreError> {
    let obj = value.as_object().ok_or_else(denied)?;
    let native_session_id = identifier_from(obj.get("nativeSessionId").ok_or_else(denied)?)
        .ok_or_else(denied)?
        .to_owned();
    let old_desktop =
        native_process(obj.get("oldDesktop").ok_or_else(denied)?).ok_or_else(denied)?;
    let old_service =
        native_process(obj.get("oldService").ok_or_else(denied)?).ok_or_else(denied)?;
    let old_service_executable = obj
        .get("oldServiceExecutable")
        .and_then(Value::as_str)
        .filter(|p| {
            p.starts_with('/')
                && !p.contains('\0')
                && !p.split('/').any(|part| part == "." || part == "..")
        })
        .ok_or_else(denied)?
        .to_owned();
    if obj
        .get("oldServiceVersion")
        .and_then(Value::as_str)
        .is_none_or(|s| s.is_empty())
    {
        return Err(denied());
    }
    if obj.get("oldServiceProtocol").and_then(Value::as_u64) != Some(3)
        || obj.get("oldAdmissionProtocol").and_then(Value::as_u64) != Some(1)
        || obj.get("oldStateCompatible").and_then(Value::as_bool) != Some(true)
    {
        return Err(denied());
    }
    Ok(Manifest {
        native_session_id,
        old_desktop,
        old_service,
        old_service_executable,
    })
}

fn parse_binding_process(value: &Value) -> Result<NativeProcess, CoreError> {
    native_process(value).ok_or_else(denied)
}

fn target_value(value: &Value, key: &str) -> Result<Value, CoreError> {
    value.get(key).cloned().ok_or_else(denied)
}

struct Journal {
    value: Value,
    state: String,
    revision: u64,
    steps: Vec<Value>,
    authorization: Option<Value>,
}

fn parse_journal(value: &Value) -> Result<Journal, CoreError> {
    let obj = value.as_object().ok_or_else(denied)?;
    if obj.get("schema").and_then(Value::as_u64) != Some(1) {
        return Err(denied());
    }
    let revision = obj
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or_else(denied)?;
    let state = obj
        .get("state")
        .and_then(Value::as_str)
        .ok_or_else(denied)?
        .to_owned();
    const STATES: [&str; 9] = [
        "preparing",
        "prepared",
        "authorized",
        "installing",
        "verifying",
        "restoring",
        "committed",
        "restored",
        "recovery-failed",
    ];
    if !STATES.contains(&state.as_str()) {
        return Err(denied());
    }
    let steps = obj
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(denied)?;
    let authorization = match obj.get("authorization") {
        Some(Value::Null) | None => None,
        Some(v) => Some(v.clone()),
    };
    let steps = steps.clone();
    let value = value.clone();
    Ok(Journal {
        value,
        state,
        revision,
        steps,
        authorization,
    })
}

/// The validated native transaction record.
pub struct NativeTransaction {
    pub dir: PathBuf,
    pub digest: String,
    pub manifest: Value,
    pub command: InstallCommand,
    pub journal: Value,
    pub authorization: Option<Value>,
    pub record: Value,
    pub receipt: Value,
}

fn read_native_record(
    pacer_home: &Path,
    installation_id: &str,
    transaction_id: &str,
    cleanup: bool,
) -> Result<NativeTransaction, CoreError> {
    let dir = native_transaction_directory(pacer_home, installation_id, transaction_id)?;
    let prepared = private_native_bytes(&dir.join("prepared.json"))?;
    let digest = sha256_hex(&prepared);
    let manifest = serde_json::from_slice(&prepared).map_err(|_| denied())?;
    let parsed_manifest = parse_manifest(&manifest)?;
    let binding = target_value(&manifest, "binding")?;
    let target = target_value(&manifest, "target")?;
    let candidate = target_value(&manifest, "candidate")?;
    let command = parse_install_command(&binding, &target, &candidate)?;
    if command.transaction_id.as_deref() != Some(transaction_id)
        || command.installation_id != installation_id
        || command.target.get("id").and_then(Value::as_str) != Some(installation_id)
        || fs::canonicalize(pacer_home).ok()
            != fs::canonicalize(Path::new(
                command
                    .target
                    .get("pacerHome")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            ))
            .ok()
    {
        return Err(denied());
    }
    let journal_value = read_json_file(&dir.join("journal.json"))?;
    let journal = parse_journal(&journal_value)?;
    if journal.value.get("manifestSha256").and_then(Value::as_str) != Some(digest.as_str()) {
        return Err(denied());
    }
    let target_managed = command.target.get("ownership").and_then(Value::as_str) == Some("managed");
    let app_path = command
        .target
        .get("appPath")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if target_managed
        && parsed_manifest.old_service_executable != format!("{app_path}/Contents/Resources/pacer")
    {
        return Err(denied());
    }
    let record = read_update(pacer_home, installation_id)?
        .ok_or_else(denied)?
        .into_value();
    let requested_by = record.get("requestedBy").and_then(Value::as_str);
    let candidate_version = command
        .candidate
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let receipt = {
        let history = record.get("requestHistory").and_then(Value::as_array);
        let mut found = None;
        if let Some(items) = history {
            for item in items {
                let action = item.get("action").and_then(Value::as_str);
                let receipt_tx = item.get("transactionId").and_then(Value::as_str);
                if action != Some("restart") || receipt_tx != Some(transaction_id) {
                    continue;
                }
                let fingerprints_match = if cleanup || requested_by.is_none() {
                    true
                } else {
                    let fp = request_fingerprint(&serde_json::json!({
                        "version": candidate_version,
                        "clientId": requested_by,
                    }));
                    item.get("fingerprint").and_then(Value::as_str) == Some(&fp)
                };
                if fingerprints_match {
                    found = Some(item.clone());
                    break;
                }
            }
        }
        found.ok_or_else(denied)?
    };
    let record_tx = record.get("transactionId").and_then(Value::as_str);
    let record_revision = record.get("revision").and_then(Value::as_u64).unwrap_or(0);
    let candidate_matches = record
        .get("candidate")
        .is_some_and(|c| same_native_value(c, &command.candidate));
    if (!cleanup && (record_tx != Some(transaction_id) || !candidate_matches))
        || command.revision > record_revision
        || (!cleanup
            && record.get("phase").and_then(Value::as_str) == Some("reserved")
            && command.revision != record_revision)
    {
        return Err(denied());
    }
    let mut authorization = None;
    if let Some(authorization_value) = journal.authorization.as_ref() {
        parse_install_authorization(authorization_value).map_err(|_| denied())?;
        let binding = {
            let mut map = serde_json::Map::new();
            for (key, val) in command_entries(&command) {
                if !matches!(key.as_str(), "command" | "candidate" | "target") {
                    map.insert(key, val);
                }
            }
            Value::Object(map)
        };
        let authorization_binding = {
            let mut map = serde_json::Map::new();
            if let Some(obj) = authorization_value.as_object() {
                for (key, val) in obj {
                    if !matches!(
                        key.as_str(),
                        "kind" | "sequence" | "reservationId" | "journalSha256"
                    ) {
                        map.insert(key.clone(), val.clone());
                    }
                }
            }
            Value::Object(map)
        };
        if !same_native_value(&binding, &authorization_binding)
            || authorization_value
                .get("journalSha256")
                .and_then(Value::as_str)
                != Some(digest.as_str())
            || authorization_value
                .get("reservationId")
                .and_then(Value::as_str)
                != Some(transaction_id)
        {
            return Err(denied());
        }
        let grant_path = dir.join("service-grant.json");
        let grant_value = read_json_file(&grant_path)?;
        let grant_obj = grant_value.as_object().ok_or_else(denied)?;
        if grant_obj.get("schema").and_then(Value::as_u64) != Some(1) {
            return Err(denied());
        }
        let grant_authorization = grant_obj.get("authorization").ok_or_else(denied)?;
        if !same_native_value(grant_authorization, authorization_value)
            || grant_obj.get("requestId").and_then(Value::as_str)
                != receipt.get("requestId").and_then(Value::as_str)
            || grant_obj.get("fingerprint").and_then(Value::as_str)
                != receipt.get("fingerprint").and_then(Value::as_str)
            || grant_obj.get("nativeSessionId").and_then(Value::as_str)
                != Some(parsed_manifest.native_session_id.as_str())
        {
            return Err(denied());
        }
        authorization = Some(authorization_value.clone());
    }
    let valid_no_auth = matches!(journal.state.as_str(), "preparing" | "prepared")
        || (cleanup && journal.state.as_str() == "restored");
    if !valid_no_auth && authorization.is_none() {
        return Err(denied());
    }
    check_stop_unready_steps(
        &journal.steps,
        &parsed_manifest,
        journal.state.as_str(),
        journal.revision,
        target_managed,
        authorization.is_some(),
    )?;
    Ok(NativeTransaction {
        dir,
        digest,
        manifest: manifest.clone(),
        command,
        journal: journal_value,
        authorization,
        record,
        receipt,
    })
}

fn command_entries(command: &InstallCommand) -> Vec<(String, Value)> {
    vec![
        ("schema".into(), serde_json::json!(command.schema)),
        ("commandId".into(), serde_json::json!(command.command_id)),
        (
            "installationId".into(),
            serde_json::json!(command.installation_id),
        ),
        (
            "transactionId".into(),
            command
                .transaction_id
                .as_ref()
                .map_or(Value::Null, |t| serde_json::json!(t)),
        ),
        ("revision".into(), serde_json::json!(command.revision)),
        ("nonce".into(), serde_json::json!(command.nonce)),
    ]
}

fn check_stop_unready_steps(
    steps: &[Value],
    manifest: &Manifest,
    state: &str,
    revision: u64,
    target_managed: bool,
    authorized: bool,
) -> Result<(), CoreError> {
    for (index, step) in steps.iter().enumerate() {
        let action = step.get("action");
        let action_kind = action.and_then(|a| a.get("kind")).and_then(Value::as_str);
        if action_kind != Some("stop-unready-candidate-service") {
            continue;
        }
        let action = action.ok_or_else(denied)?;
        let launch_id = action
            .get("launchId")
            .and_then(Value::as_str)
            .filter(|s| is_hash(s))
            .ok_or_else(denied)?;
        let intent_boot_id = step.get("intentBootId").and_then(Value::as_str);
        let intent_revision = step
            .get("intentRevision")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let evidence = step.get("evidence").ok_or_else(denied)?;
        if !authorized
            || !target_managed
            || !matches!(state, "restoring" | "restored" | "recovery-failed")
            || intent_boot_id.is_none_or(str::is_empty)
            || intent_revision > revision
            || (!evidence.is_null()
                && !same_native_value(evidence, &serde_json::json!({"kind": "complete"})))
        {
            return Err(denied());
        }
        let launch_index = steps.iter().position(|s| {
            let sa = s.get("action");
            sa.and_then(|a| a.get("kind")).and_then(Value::as_str) == Some("launch")
                && sa.and_then(|a| a.get("role")).and_then(Value::as_str) == Some("service")
                && sa.and_then(|a| a.get("release")).and_then(Value::as_str) == Some("candidate")
                && sa.and_then(|a| a.get("launchId")).and_then(Value::as_str) == Some(launch_id)
                && s.get("intentBootId").and_then(Value::as_str) == intent_boot_id
        });
        let Some(li) = launch_index else {
            return Err(denied());
        };
        if li >= index || steps[li].get("evidence").is_some_and(|e| !e.is_null()) {
            return Err(denied());
        }
        let desktop_candidate = steps.iter().any(|s| {
            let sa = s.get("action");
            sa.and_then(|a| a.get("kind")).and_then(Value::as_str) == Some("launch")
                && sa.and_then(|a| a.get("role")).and_then(Value::as_str) == Some("desktop")
                && sa.and_then(|a| a.get("release")).and_then(Value::as_str) == Some("candidate")
        });
        if desktop_candidate {
            return Err(denied());
        }
        let prerequisites: [Value; 5] = [
            serde_json::json!({"kind": "suppress-lifecycle"}),
            serde_json::json!({"kind": "stop", "role": "desktop", "process": native_process_value(&manifest.old_desktop)}),
            serde_json::json!({"kind": "stop", "role": "service", "process": native_process_value(&manifest.old_service)}),
            serde_json::json!({"kind": "install-candidate"}),
            serde_json::json!({"kind": "switch-registration"}),
        ];
        for prerequisite in prerequisites {
            let meets = steps[..li].iter().any(|s| {
                same_native_value(s.get("action").unwrap_or(&Value::Null), &prerequisite)
                    && same_native_value(
                        s.get("evidence").unwrap_or(&Value::Null),
                        &serde_json::json!({"kind": "complete"}),
                    )
            });
            if !meets {
                return Err(denied());
            }
        }
        if steps[..index].iter().any(|s| {
            same_native_value(
                s.get("action").unwrap_or(&Value::Null),
                &serde_json::json!({"kind": "stop-unready-candidate-service", "launchId": launch_id}),
            )
        }) {
            return Err(denied());
        }
    }
    Ok(())
}

/// `readNativeTransaction`: read-only snapshot for work scheduling.
pub fn read_native_transaction(
    pacer_home: &Path,
    installation_id: &str,
    transaction_id: &str,
) -> Result<NativeTransaction, CoreError> {
    read_native_record(pacer_home, installation_id, transaction_id, false)
}

/// `readNativeCleanup`: immutable original receipt/grant survives a later
/// core transaction; only `committed`/`restored` may be cleaned.
pub fn read_native_cleanup(
    pacer_home: &Path,
    installation_id: &str,
    transaction_id: &str,
) -> Result<NativeTransaction, CoreError> {
    let tx = read_native_record(pacer_home, installation_id, transaction_id, true)?;
    let state = tx
        .journal
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(state, "committed" | "restored") {
        return Err(denied());
    }
    let authorization = tx.authorization.as_ref();
    if authorization.is_none() {
        let backup = tx
            .manifest
            .get("oldBundleBackup")
            .and_then(Value::as_object);
        let backup_sha = backup.and_then(|b| b.get("sha256")).and_then(Value::as_str);
        let unchanged_sha = tx
            .journal
            .get("unchangedOriginal")
            .and_then(|u| u.get("sha256"))
            .and_then(Value::as_str);
        let steps_ok = tx
            .journal
            .get("steps")
            .and_then(Value::as_array)
            .map(|steps| {
                steps.iter().all(|s| {
                    s.get("action")
                        .and_then(|a| a.get("kind"))
                        .and_then(Value::as_str)
                        .is_some_and(|k| {
                            matches!(
                                k,
                                "prepare-backup"
                                    | "arm-recovery"
                                    | "release-reservation"
                                    | "retire-recovery"
                            )
                        })
                })
            })
            .unwrap_or(false);
        if state != "restored" || backup_sha.is_none() || unchanged_sha != backup_sha || !steps_ok {
            return Err(denied());
        }
    }
    let _ = authorization;
    Ok(tx)
}

/// `verifyNativeLaunch`: admits a freshly-launched desktop peer against the
/// recorded service launch intent and any completion evidence.
pub fn verify_native_launch(
    pacer_home: &Path,
    ticket: &Value,
    desktop: &NativeProcess,
) -> Result<NativeTransaction, CoreError> {
    let obj = ticket.as_object().ok_or_else(denied)?;
    let installation_id =
        identifier_from(obj.get("installationId").ok_or_else(denied)?).ok_or_else(denied)?;
    let transaction_id =
        identifier_from(obj.get("transactionId").ok_or_else(denied)?).ok_or_else(denied)?;
    let launch_id = hash_from(obj.get("launchId").ok_or_else(denied)?).ok_or_else(denied)?;
    let native_session_id =
        identifier_from(obj.get("nativeSessionId").ok_or_else(denied)?).ok_or_else(denied)?;
    let nonce = hash_from(obj.get("nonce").ok_or_else(denied)?).ok_or_else(denied)?;
    if nonce != launch_id
        || obj.get("protocol").and_then(Value::as_u64) != Some(3)
        || obj.get("schema").and_then(Value::as_u64) != Some(1)
    {
        return Err(denied());
    }
    let tx = read_native_transaction(pacer_home, installation_id, transaction_id)?;
    if tx.authorization.is_none() {
        return Err(denied());
    }
    let intent = tx
        .journal
        .get("steps")
        .and_then(Value::as_array)
        .and_then(|steps| {
            steps
                .iter()
                .find(|s| {
                    let a = s.get("action");
                    a.and_then(|a| a.get("kind")).and_then(Value::as_str) == Some("launch")
                        && a.and_then(|a| a.get("role")).and_then(Value::as_str) == Some("desktop")
                        && a.and_then(|a| a.get("launchId")).and_then(Value::as_str)
                            == Some(launch_id)
                })
                .cloned()
        })
        .ok_or_else(denied)?;
    let intent_obj = intent.as_object().ok_or_else(denied)?;
    let intent_boot_id = intent_obj
        .get("intentBootId")
        .and_then(Value::as_str)
        .ok_or_else(denied)?;
    let release = intent_obj
        .get("action")
        .and_then(|a| a.get("release"))
        .and_then(Value::as_str);
    if intent_boot_id != desktop.boot_id || !matches!(release, Some("old") | Some("candidate")) {
        return Err(denied());
    }
    let release = release.map(str::to_owned);
    let version = if release.as_deref() == Some("candidate") {
        tx.command
            .candidate
            .get("version")
            .and_then(Value::as_str)
            .ok_or_else(denied)?
            .to_owned()
    } else {
        tx.command
            .target
            .get("version")
            .and_then(Value::as_str)
            .ok_or_else(denied)?
            .to_owned()
    };
    if obj.get("desktopVersion").and_then(Value::as_str) != Some(version.as_str()) {
        return Err(denied());
    }
    let intent_evidence = intent_obj.get("evidence").ok_or_else(denied)?;
    if !intent_evidence.is_null() {
        let evidence = intent_evidence.as_object().ok_or_else(denied)?;
        if evidence.get("kind").and_then(Value::as_str) != Some("launched") {
            return Err(denied());
        }
        let launch = evidence.get("launch").ok_or_else(denied)?;
        let l = launch.as_object().ok_or_else(denied)?;
        if l.get("launchId").and_then(Value::as_str) != Some(launch_id)
            || l.get("role").and_then(Value::as_str) != Some("desktop")
            || l.get("release").and_then(Value::as_str) != release.as_deref()
            || !same_native_value(
                l.get("process").unwrap_or(&Value::Null),
                &native_process_value(desktop),
            )
            || l.get("nativeSessionId").and_then(Value::as_str) != Some(native_session_id)
            || l.get("version").and_then(Value::as_str) != Some(version.as_str())
        {
            return Err(denied());
        }
    }
    let ownership = tx
        .command
        .target
        .get("ownership")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let manifest = tx.manifest.as_object().ok_or_else(denied)?;
    let (service, service_version) = if ownership == "attached" {
        let old_service =
            native_process(manifest.get("oldService").ok_or_else(denied)?).ok_or_else(denied)?;
        let old_service_version = manifest
            .get("oldServiceVersion")
            .and_then(Value::as_str)
            .ok_or_else(denied)?;
        (old_service, old_service_version.to_owned())
    } else {
        let service_launch = tx
            .journal
            .get("steps")
            .and_then(Value::as_array)
            .and_then(|steps| {
                steps.iter().find_map(|s| {
                    let evidence = s.get("evidence");
                    let eo = evidence.and_then(|e| e.as_object())?;
                    if eo.get("kind").and_then(Value::as_str) != Some("launched") {
                        return None;
                    }
                    let launch = eo.get("launch")?.as_object()?;
                    if launch.get("role").and_then(Value::as_str) == Some("service")
                        && launch.get("release").and_then(Value::as_str) == release.as_deref()
                    {
                        Some(launch.clone())
                    } else {
                        None
                    }
                })
            })
            .ok_or_else(denied)?;
        let service =
            native_process(service_launch.get("process").ok_or_else(denied)?).ok_or_else(denied)?;
        (service, version.clone())
    };
    let ticket_service = parse_binding_process(obj.get("service").ok_or_else(denied)?)?;
    if !same_native_value(
        &native_process_value(&ticket_service),
        &native_process_value(&service),
    ) || obj.get("serviceVersion").and_then(Value::as_str) != Some(service_version.as_str())
    {
        return Err(denied());
    }
    Ok(tx)
}

/// `grantNativeTransaction`: writes the service-owned continuation
/// (`service-grant.json`) atomically via hard-link.
pub fn grant_native_transaction(tx: &NativeTransaction) -> Result<(), CoreError> {
    let phase = tx.record.get("phase").and_then(Value::as_str);
    let state = tx.journal.get("state").and_then(Value::as_str);
    let requested_by = tx.record.get("requestedBy").and_then(Value::as_str);
    if phase != Some("reserved")
        || tx.authorization.is_some()
        || state != Some("prepared")
        || requested_by.is_none()
    {
        return Err(denied());
    }
    let authorization = {
        let mut map = serde_json::Map::new();
        for (key, val) in command_entries(&tx.command) {
            if !matches!(key.as_str(), "command" | "candidate" | "target") {
                map.insert(key, val);
            }
        }
        map.insert("kind".into(), serde_json::json!("authorize-install"));
        map.insert(
            "reservationId".into(),
            tx.command
                .transaction_id
                .as_ref()
                .map_or(Value::Null, |t| serde_json::json!(t)),
        );
        map.insert("journalSha256".into(), serde_json::json!(tx.digest));
        let value = Value::Object(map);
        parse_install_authorization(&value).map_err(|_| denied())?;
        value
    };
    let value = serde_json::json!({
        "schema": 1,
        "authorization": authorization,
        "requestId": tx.receipt.get("requestId"),
        "fingerprint": tx.receipt.get("fingerprint"),
        "nativeSessionId": tx.manifest.get("nativeSessionId"),
    });
    let path = tx.dir.join("service-grant.json");
    let temporary = tx
        .dir
        .join(format!(".service-grant-{}", uuid::Uuid::new_v4()));
    {
        let mut fd = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(&temporary)
            .map_err(|_| denied())?;
        let bytes = pacer_js_json::stringify(&value);
        fd.write_all(bytes.as_bytes()).map_err(|_| denied())?;
        fd.sync_all().map_err(|_| denied())?;
    }
    match fs::hard_link(&temporary, &path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = read_json_file(&path)?;
            let existing_obj = existing.as_object().ok_or_else(denied)?;
            if existing_obj.get("schema").and_then(Value::as_u64) != Some(1)
                || !same_native_value(
                    existing_obj.get("authorization").unwrap_or(&Value::Null),
                    &authorization,
                )
                || existing_obj.get("requestId").and_then(Value::as_str)
                    != tx.receipt.get("requestId").and_then(Value::as_str)
                || existing_obj.get("fingerprint").and_then(Value::as_str)
                    != tx.receipt.get("fingerprint").and_then(Value::as_str)
                || existing_obj.get("nativeSessionId").and_then(Value::as_str)
                    != tx.manifest.get("nativeSessionId").and_then(Value::as_str)
            {
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

/// `discoverServiceLaunch`: reads pending service launch intents before
/// scheduling; no environment launch ID is trusted.
pub fn discover_service_launch(
    pacer_home: &Path,
    executable: &str,
    version: &str,
    process: &NativeProcess,
) -> Result<Option<ServiceLaunch>, CoreError> {
    let dir = pacer_home.join("desktop-updates");
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(denied()),
    };
    let mut found = None;
    for entry in entries {
        let entry = entry.map_err(|_| denied())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.ends_with(".json") {
            continue;
        }
        let id = &name[..name.len() - 5];
        if !is_valid_identifier(id) {
            continue;
        }
        let record = match read_update(pacer_home, id) {
            Ok(Some(r)) => r.into_value(),
            Ok(None) => continue,
            Err(_) => continue,
        };
        let transaction_id = record.get("transactionId").and_then(Value::as_str);
        let phase = record.get("phase").and_then(Value::as_str);
        if transaction_id.is_none()
            || !matches!(
                phase,
                Some("reserved")
                    | Some("installing")
                    | Some("verifying")
                    | Some("rolling-back")
                    | Some("recovery-failed")
            )
        {
            continue;
        }
        let transaction_id = transaction_id.unwrap_or_default();
        let tx = read_native_transaction(pacer_home, id, transaction_id)?;
        if tx.authorization.is_none()
            || tx.command.target.get("ownership").and_then(Value::as_str) != Some("managed")
        {
            continue;
        }
        let step = tx
            .journal
            .get("steps")
            .and_then(Value::as_array)
            .and_then(|steps| {
                steps.iter().rev().find(|s| {
                    let a = s.get("action");
                    a.and_then(|a| a.get("kind")).and_then(Value::as_str) == Some("launch")
                        && a.and_then(|a| a.get("role")).and_then(Value::as_str) == Some("service")
                })
            });
        let Some(step) = step else {
            continue;
        };
        let step_obj = step.as_object().ok_or_else(denied)?;
        if step_obj.get("intentBootId").and_then(Value::as_str) != Some(process.boot_id.as_str()) {
            continue;
        }
        let action = step_obj.get("action").ok_or_else(denied)?;
        let release = action.get("release").and_then(Value::as_str);
        let launch_id = hash_from(action.get("launchId").ok_or_else(denied)?).ok_or_else(denied)?;
        if !matches!(release, Some("old") | Some("candidate")) {
            return Err(denied());
        }
        let release = release.map(str::to_owned).ok_or_else(denied)?;
        let manifest_obj = tx.manifest.as_object().ok_or_else(denied)?;
        let expected_executable = if release == "old" {
            manifest_obj
                .get("oldServiceExecutable")
                .and_then(Value::as_str)
                .ok_or_else(denied)?
                .to_owned()
        } else {
            let app = tx
                .command
                .target
                .get("appPath")
                .and_then(Value::as_str)
                .ok_or_else(denied)?;
            format!("{app}/Contents/Resources/pacer")
        };
        if executable != expected_executable {
            return Err(denied());
        }
        let expected_version = if release == "candidate" {
            tx.command
                .candidate
                .get("version")
                .and_then(Value::as_str)
                .ok_or_else(denied)?
                .to_owned()
        } else {
            manifest_obj
                .get("oldServiceVersion")
                .and_then(Value::as_str)
                .ok_or_else(denied)?
                .to_owned()
        };
        if version != expected_version {
            return Err(denied());
        }
        let evidence = ServiceLaunch {
            installation_id: id.to_owned(),
            transaction_id: transaction_id.to_owned(),
            release: release.clone(),
            launch_id: launch_id.to_owned(),
            process: process.clone(),
            native_session_id: launch_id.to_owned(),
            version: version.to_owned(),
        };
        let step_evidence = step_obj.get("evidence").ok_or_else(denied)?;
        if !step_evidence.is_null() {
            let evidence_obj = step_evidence
                .as_object()
                .and_then(|e| e.get("launch"))
                .ok_or_else(denied)?;
            if !same_native_value(evidence_obj, &service_launch_value(&evidence)) {
                return Err(denied());
            }
        }
        if found.is_some() {
            return Err(denied());
        }
        found = Some(evidence);
    }
    Ok(found)
}

/// A pending authenticated service launch intent (`discoverServiceLaunch`
/// result).
#[derive(Clone, Debug)]
pub struct ServiceLaunch {
    pub installation_id: String,
    pub transaction_id: String,
    pub release: String,
    pub launch_id: String,
    pub process: NativeProcess,
    pub native_session_id: String,
    pub version: String,
}

fn service_launch_value(launch: &ServiceLaunch) -> Value {
    serde_json::json!({
        "role": "service",
        "release": launch.release,
        "launchId": launch.launch_id,
        "process": native_process_value(&launch.process),
        "nativeSessionId": launch.native_session_id,
        "version": launch.version,
    })
}

#[cfg(test)]
#[path = "tests/record.rs"]
mod tests;
