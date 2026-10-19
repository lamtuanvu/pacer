//! Bounded pruning of independently terminal transactions and obsolete downloads.
use super::{
    journal::{Journal, TransactionState},
    platform_fs::{NativeLocks, PrivateDir},
    OtaError, PlatformAction, PreparedManifest,
};

fn eligible(
    manifest: &PreparedManifest,
    journal: &Journal,
    id: &str,
    current: &str,
    current_revision: u64,
) -> bool {
    manifest.target.id == id
        && manifest.binding.revision < current_revision
        && manifest.transaction_id() != current
        && matches!(
            journal.state,
            TransactionState::Committed | TransactionState::Restored
        )
        && [
            PlatformAction::ReleaseReservation,
            PlatformAction::RetireRecovery,
        ]
        .iter()
        .all(|action| {
            journal.steps.iter().any(|step| {
                &step.action == action && step.evidence == Some(super::ActionEvidence::Complete)
            })
        })
}

fn entries(directory: &PrivateDir) -> Result<Vec<String>, OtaError> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(&directory.path).map_err(|_| OtaError::Io)? {
        if names.len() >= 1024 {
            return Err(OtaError::Unavailable);
        }
        let entry = entry.map_err(|_| OtaError::Io)?;
        names.push(
            entry
                .file_name()
                .into_string()
                .map_err(|_| OtaError::Invalid)?,
        );
    }
    Ok(names)
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The caller holds the cache writer lock and has freshly reverified the service
/// download binding. Active transactions keep their own immutable archive copy.
pub(crate) fn prune_downloads(
    directory: &PrivateDir,
    selected: &str,
    _lock: &NativeLocks,
) -> Result<(), OtaError> {
    if !hash(selected) {
        return Err(OtaError::Invalid);
    }
    for entry in entries(directory)? {
        let Some(sha) = entry.strip_suffix(".tar.gz") else {
            continue;
        };
        if sha == selected || !hash(sha) {
            continue;
        }
        // The held-directory implementation verifies ownership, type and hash
        // before removal. Unrecognized or corrupt files are retained for inspection.
        let _ = directory.prune_file(&entry, sha);
    }
    Ok(())
}

/// Only older terminal transactions with independently retired recovery authority
/// are eligible. The current transaction's known-good bundle always survives.
#[cfg(target_os = "macos")]
pub(crate) fn prune_superseded(
    home: &std::path::Path,
    current_manifest: &PreparedManifest,
    trust: &super::trust::ReleaseTrust,
) -> Result<(), OtaError> {
    let id = &current_manifest.target.id;
    let current = current_manifest.transaction_id();
    let installation = PrivateDir::installation(home, id)?;
    let names = entries(&installation)?;
    let processes = super::control::native_process_inventory()?;
    for name in names {
        if name == current
            || name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            continue;
        }
        let Ok(directory) = PrivateDir::open(&installation.path.join(&name)) else {
            continue;
        };
        // Do not create a lock in an unknown directory.
        if directory.read("prepared.json", 1_048_576).is_err()
            || directory.read("journal.json", 1_048_576).is_err()
        {
            continue;
        }
        let Ok(store) = super::journal::JournalStore::open(&directory.path) else {
            continue;
        };
        let Ok((manifest, _)) = store.manifest() else {
            continue;
        };
        let Ok(journal) = store.load() else { continue };
        if manifest.transaction_id() != name
            || !eligible(
                &manifest,
                &journal,
                id,
                current,
                current_manifest.binding.revision,
            )
            || super::recovery_authority::verify(home, &manifest, &journal).is_err()
        {
            continue;
        }
        // Never remove the executable of a running helper or a job that can
        // respawn it. Fixture registration files are evidence, so retain them.
        if super::platform::copy_user_job(&manifest.recovery_job.label)?.is_some()
            || processes
                .iter()
                .any(|process| process.executable.starts_with(&directory.path))
        {
            continue;
        }
        let fixture_locks = trust
            .fixture_policy()
            .map(|policy| PrivateDir::open(&policy.root.join("locks")))
            .transpose()?;
        let _fixture_lock = fixture_locks
            .as_ref()
            .map(|locks| locks.lock_named("ledger-lock"))
            .transpose()?;
        if let Some(policy) = trust.fixture_policy() {
            policy.validate_live().map_err(|_| OtaError::Identity)?;
            if manifest.recovery_job.label != policy.recovery_label {
                continue;
            }
            let directory = PrivateDir::open(&policy.root)?;
            let record: serde_json::Value =
                serde_json::from_slice(&directory.read("record.json", 65_536)?)
                    .map_err(|_| OtaError::Invalid)?;
            if !record["registrations"].as_array().is_some_and(|rows| {
                rows.iter().any(|row| {
                    row["label"] == manifest.recovery_job.label && row["state"] == "retired"
                })
            }) {
                continue;
            }
        } else {
            if manifest.recovery_job.label != format!("com.pacer.update.{id}.{name}") {
                continue;
            }
            let persistent = super::platform::user_home(trust)?
                .join("Library/LaunchAgents")
                .join(format!("{}.plist", manifest.recovery_job.label));
            match std::fs::symlink_metadata(persistent) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => continue,
            }
        }
        // Each operation checks its own exact held inode and digest again.
        // A mismatch or interrupted partial cleanup remains for inspection.
        let _ = directory.prune_bundle(
            &manifest.old_bundle_backup.relative_path,
            &manifest.old_bundle_backup.sha256,
        );
        let _ = directory.prune_file(&manifest.artifact.relative_path, &manifest.artifact.sha256);
        let _ = directory.prune_file(
            &manifest.recovery_job.helper.relative_path,
            &manifest.recovery_job.helper.sha256,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{
        journal::{OriginalBundleProof, Step},
        ActionEvidence, AwakeStamp,
    };
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn only_old_terminal_transactions_with_completed_cleanup_are_eligible() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/desktop-update/journal.json"
        ))
        .unwrap();
        let manifest: PreparedManifest =
            serde_json::from_value(fixture["prepared"].clone()).unwrap();
        let mut journal: Journal = serde_json::from_value(fixture["journal"].clone()).unwrap();
        journal.state = TransactionState::Restored;
        journal.unchanged_original = Some(OriginalBundleProof {
            sha256: manifest.old_bundle_backup.sha256.clone(),
            observed_at: AwakeStamp {
                boot_id: "boot-one".into(),
                millis: 10,
            },
        });
        for action in [
            PlatformAction::ReleaseReservation,
            PlatformAction::RetireRecovery,
        ] {
            journal.steps.push(Step {
                action,
                intent_revision: 4,
                intent_boot_id: "boot-one".into(),
                evidence: Some(ActionEvidence::Complete),
            });
        }
        assert!(eligible(&manifest, &journal, "fixture", "later-tx", 3));
        assert!(!eligible(&manifest, &journal, "fixture", "earlier-tx", 1));
        assert!(!eligible(
            &manifest,
            &journal,
            "fixture",
            "same-revision",
            2
        ));
        assert!(!eligible(&manifest, &journal, "fixture", "tx-1", 3));
        assert!(!eligible(&manifest, &journal, "another", "later-tx", 3));
        journal.steps.last_mut().unwrap().evidence = None;
        assert!(!eligible(&manifest, &journal, "fixture", "later-tx", 3));
        journal.steps.last_mut().unwrap().evidence = Some(ActionEvidence::Complete);
        journal.state = TransactionState::Installing;
        assert!(!eligible(&manifest, &journal, "fixture", "later-tx", 3));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn real_terminal_pruning_retains_current_newer_and_audit_evidence() {
        use base64::Engine;
        use serde_json::json;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let id = super::super::journal::random_id().unwrap();
        let installation = PrivateDir::installation(&home, &id).unwrap();
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/desktop-update/journal.json"
        ))
        .unwrap();
        let mut manifests = Vec::new();
        for (tx, revision) in [("old", 2), ("current", 4), ("newer", 6)] {
            let directory = installation.child(tx).unwrap();
            let backup = directory.child("old.app").unwrap();
            backup.write_new("resource", b"old version").unwrap();
            directory.write_new("candidate.tar.gz", b"archive").unwrap();
            directory.write_new("helper", b"helper").unwrap();
            let mut manifest: PreparedManifest =
                serde_json::from_value(fixture["prepared"].clone()).unwrap();
            manifest.binding.installation_id = id.clone();
            manifest.binding.transaction_id = Some(tx.into());
            manifest.binding.revision = revision;
            manifest.target.id = id.clone();
            manifest.target.pacer_home = home.to_string_lossy().into();
            manifest.target.ownership = super::super::wire::Ownership::Attached;
            manifest.registration_backup = None;
            manifest.candidate.sha256 = format!("{:x}", Sha256::digest(b"archive"));
            manifest.artifact.sha256 = manifest.candidate.sha256.clone();
            manifest.old_bundle_backup.sha256 =
                super::super::platform_fs::bundle_hash(&backup.path).unwrap();
            manifest.recovery_job.helper.sha256 = format!("{:x}", Sha256::digest(b"helper"));
            manifest.recovery_job.label = format!("com.pacer.update.{id}.{tx}");
            let store = super::super::journal::JournalStore::open(&directory.path).unwrap();
            let digest = store.create_manifest(&manifest).unwrap();
            let mut journal: Journal = serde_json::from_value(fixture["journal"].clone()).unwrap();
            journal.manifest_sha256 = digest;
            journal.state = TransactionState::Restored;
            journal.unchanged_original = Some(OriginalBundleProof {
                sha256: manifest.old_bundle_backup.sha256.clone(),
                observed_at: AwakeStamp {
                    boot_id: "boot-one".into(),
                    millis: 10,
                },
            });
            for action in [
                PlatformAction::ReleaseReservation,
                PlatformAction::RetireRecovery,
            ] {
                journal.steps.push(Step {
                    action,
                    intent_revision: 4,
                    intent_boot_id: "boot-one".into(),
                    evidence: Some(ActionEvidence::Complete),
                });
            }
            journal
                .validate(&manifest, &journal.manifest_sha256)
                .unwrap();
            directory
                .write_new("journal.json", &serde_json::to_vec(&journal).unwrap())
                .unwrap();
            manifests.push(manifest);
        }
        let source: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/desktop-update/wire.json"
        ))
        .unwrap();
        let mut record = source["record"].clone();
        record["installationId"] = json!(id);
        record["revision"] = json!(9);
        record["phase"] = json!("idle");
        record["candidate"] = json!(null);
        record["requestHistory"] = json!([{"action":"restart","requestId":"old-request","fingerprint":"f".repeat(64),"transactionId":"old"},{"action":"restart","requestId":"current-request","fingerprint":"e".repeat(64),"transactionId":"current"},{"action":"restart","requestId":"newer-request","fingerprint":"d".repeat(64),"transactionId":"newer"}]);
        PrivateDir::open(&home.join("desktop-updates"))
            .unwrap()
            .write_new(&format!("{id}.json"), &serde_json::to_vec(&record).unwrap())
            .unwrap();
        let base64 = base64::engine::general_purpose::STANDARD;
        let mut packet = [0u8; 42];
        packet[..2].copy_from_slice(b"Ed");
        let key = base64.encode(format!(
            "untrusted comment: test\n{}\n",
            base64.encode(packet)
        ));
        let trust = super::super::trust::ReleaseTrust::from_production(&key, "TEST000000").unwrap();
        prune_superseded(&home, &manifests[1], &trust).unwrap();
        assert!(!installation.path.join("old/old.app").exists());
        assert!(!installation.path.join("old/candidate.tar.gz").exists());
        assert!(!installation.path.join("old/helper").exists());
        assert!(installation.path.join("old/prepared.json").exists());
        assert!(installation.path.join("old/journal.json").exists());
        assert!(installation.path.join("current/old.app").exists());
        assert!(installation.path.join("newer/old.app").exists());
        prune_superseded(&home, &manifests[1], &trust).unwrap();
        assert!(installation.path.join("current/old.app").exists());
    }
    #[test]
    fn download_pruning_keeps_selected_and_unknown_files_without_following_links() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let directory = PrivateDir::downloads(&home, "fixture").unwrap();
        let hash = |b: &[u8]| format!("{:x}", Sha256::digest(b));
        let selected = hash(b"selected");
        let old = hash(b"old");
        directory.store_archive(&selected, b"selected").unwrap();
        directory.store_archive(&old, b"old").unwrap();
        directory.write_new("unknown", b"retain").unwrap();
        let outside = home.join("outside");
        std::fs::write(&outside, b"outside").unwrap();
        std::os::unix::fs::symlink(
            &outside,
            directory.path.join(format!("{}.tar.gz", "f".repeat(64))),
        )
        .unwrap();
        let lock = directory.lock_named(".cache-lock").unwrap();
        prune_downloads(&directory, &selected, &lock).unwrap();
        assert!(!directory.path.join(format!("{old}.tar.gz")).exists());
        assert_eq!(directory.read_archive(&selected).unwrap(), b"selected");
        assert_eq!(directory.read("unknown", 100).unwrap(), b"retain");
        assert_eq!(std::fs::read(outside).unwrap(), b"outside");
        assert!(std::fs::symlink_metadata(
            directory.path.join(format!("{}.tar.gz", "f".repeat(64)))
        )
        .unwrap()
        .file_type()
        .is_symlink());
    }
}
