//! Private, stable-lock adoption journal storage.
use super::*;
use crate::ota::platform_fs::{NativeLocks, PrivateDir};
use std::path::Path;
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AdoptionState {
    Preparing,
    Prepared,
    Authorized,
    Switching,
    Verifying,
    Restoring,
    Committed,
    Restored,
    RecoveryFailed,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdoptionStep {
    pub action: AdoptionAction,
    pub intent_revision: u64,
    pub intent_boot_id: String,
    #[serde(deserialize_with = "required_nullable")]
    pub evidence: Option<AdoptionEvidence>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnchangedRegistration {
    pub sha256: String,
    pub observed_at: AwakeStamp,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdoptionJournal {
    pub schema: u32,
    pub transaction_kind: String,
    pub revision: u64,
    pub manifest_sha256: String,
    pub state: AdoptionState,
    #[serde(deserialize_with = "required_nullable")]
    pub authorization: Option<Authorization>,
    pub steps: Vec<AdoptionStep>,
    #[serde(deserialize_with = "required_nullable")]
    pub verification_started: Option<AwakeStamp>,
    #[serde(deserialize_with = "required_nullable")]
    pub restoration_started: Option<AwakeStamp>,
    pub restoration_history: Vec<AwakeStamp>,
    #[serde(default)]
    pub recovery_reconnects: Vec<RecoveryReconnectCapability>,
    #[serde(deserialize_with = "required_nullable")]
    pub verification_proof: Option<AdoptionReadinessProof>,
    #[serde(deserialize_with = "required_nullable")]
    pub restoration_proof: Option<AdoptionReadinessProof>,
    #[serde(deserialize_with = "required_nullable")]
    pub unchanged_registration: Option<UnchangedRegistration>,
    #[serde(deserialize_with = "required_nullable")]
    pub error: Option<OtaError>,
    /// The error that started restoration; `error` later holds any restoration failure.
    #[serde(default)]
    pub restoration_cause: Option<OtaError>,
}
pub struct AdoptionStore {
    directory: PrivateDir,
    _lock: NativeLocks,
}
impl AdoptionStore {
    pub fn open(path: &Path) -> Result<Self, OtaError> {
        let directory = PrivateDir::open(path)?;
        let lock = directory.lock_named(".lock")?;
        Ok(Self {
            directory,
            _lock: lock,
        })
    }
}

use crate::ota::wire::WireMessage;
use sha2::{Digest, Sha256};
fn require(value: bool) -> Result<(), OtaError> {
    if value {
        Ok(())
    } else {
        Err(OtaError::Invalid)
    }
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || matches!(v, b'-' | b'_'))
}
fn path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.contains('\0')
        && Path::new(value).is_absolute()
        && Path::new(value).components().all(|v| {
            matches!(
                v,
                std::path::Component::RootDir | std::path::Component::Normal(_)
            )
        })
}
fn process(value: &ProcessIdentity) -> bool {
    value.pid > 0
        && !value.boot_id.is_empty()
        && value.boot_id.len() <= 128
        && !value.birth.is_empty()
        && value.birth.len() <= 128
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn validate_manifest(m: &AdoptionManifest) -> Result<(), OtaError> {
    AdapterCommand::Adopt {
        binding: m.binding.clone(),
        target: m.source.target.clone(),
    }
    .validate()
    .map_err(|_| OtaError::Invalid)?;
    require(
        m.schema == 1
            && m.transaction_kind == "adoption"
            && m.binding.installation_id == m.source.target.id
            && m.binding.transaction_id.as_deref().is_some_and(id)
            && id(&m.source.native_session_id)
            && id(&m.source.desktop_client_id)
            && !m.source.boot_id.is_empty()
            && process(&m.source.desktop)
            && process(&m.source.service)
            && m.source.desktop != m.source.service
            && m.source.boot_id == m.source.desktop.boot_id
            && m.source.boot_id == m.source.service.boot_id
            && path(&m.source.old_service_executable)
            && path(&m.source.new_service_executable)
            && m.source.old_service_executable != m.source.new_service_executable
            && m.source.new_service_executable
                == format!("{}/Contents/Resources/pacer", m.source.target.app_path)
            && semver::Version::parse(&m.source.service_version).is_ok()
            && id(&m.request.request_id)
            && hash(&m.request.fingerprint)
            && hash(&m.expected_new_installation_id)
            && m.expected_new_installation_id != m.source.target.id
            && hash(&m.managed_launch_id)
            && hash(&m.original_launch_id)
            && m.managed_launch_id != m.original_launch_id
            && m.old_registration.relative_path == "old-registration.plist"
            && hash(&m.old_registration.sha256)
            && m.new_registration.relative_path == "new-registration.plist"
            && hash(&m.new_registration.sha256)
            && m.old_registration.sha256 != m.new_registration.sha256
            && m.recovery_job.helper.relative_path == "pacer-update-helper"
            && hash(&m.recovery_job.helper.sha256)
            && !m.recovery_job.label.is_empty()
            && m.recovery_job.label.len() <= 128
            && m.recovery_job
                .label
                .bytes()
                .all(|v| v.is_ascii_alphanumeric() || matches!(v, b'.' | b'-' | b'_')),
    )
}
fn evidence_valid(
    action: &AdoptionAction,
    evidence: &AdoptionEvidence,
    m: &AdoptionManifest,
) -> bool {
    match (action, evidence) {
        (
            AdoptionAction::LaunchService { branch, launch_id },
            AdoptionEvidence::Launched {
                branch: observed,
                launch,
            },
        ) => {
            branch == observed
                && launch.launch_id == *launch_id
                && launch.role == ProcessRole::Service
                && launch.release
                    == if *branch == AdoptionBranch::Managed {
                        Release::Candidate
                    } else {
                        Release::Old
                    }
                && launch.native_session_id == *launch_id
                && launch.version == m.version(*branch)
                && process(&launch.process)
        }
        (
            AdoptionAction::LaunchRecoveryDesktop { .. },
            AdoptionEvidence::DesktopSpawned { process: p },
        ) => process(p),
        (
            AdoptionAction::LaunchService { .. } | AdoptionAction::LaunchRecoveryDesktop { .. },
            _,
        ) => false,
        (_, AdoptionEvidence::Complete) => true,
        _ => false,
    }
}
impl AdoptionJournal {
    pub fn proof_valid(
        &self,
        proof: &AdoptionReadinessProof,
        branch: AdoptionBranch,
        m: &AdoptionManifest,
    ) -> bool {
        let launch = self
            .steps
            .iter()
            .rev()
            .find_map(|step| match &step.evidence {
                Some(AdoptionEvidence::Launched { branch: b, launch }) if *b == branch => {
                    Some(launch)
                }
                _ => None,
            });
        launch.is_some_and(|launch| {
            proof.installation_id == m.source.target.id
                && proof.transaction_id == m.transaction_id()
                && proof.resulting_installation_id == m.resulting_id(branch)
                && proof.branch == branch
                && proof.desktop
                    == self
                        .recovery_reconnects
                        .iter()
                        .find(|cap| {
                            branch == AdoptionBranch::Original
                                && cap.original_launch_id == launch.launch_id
                        })
                        .map(|cap| &cap.desktop)
                        .unwrap_or(&m.source.desktop)
                        .clone()
                && proof.native_session_id == launch.launch_id
                && (launch.process.boot_id == m.source.boot_id
                    || self.recovery_reconnects.iter().any(|cap| {
                        cap.original_launch_id == launch.launch_id
                            && cap.boot_id == launch.process.boot_id
                            && self.steps.iter().any(|step| {
                                step.action
                                    == AdoptionAction::PrepareRecoveryReconnect {
                                        capability: cap.clone(),
                                    }
                                    && step.evidence == Some(AdoptionEvidence::Complete)
                            })
                    }))
                && proof.desktop_version == m.source.target.version
                && proof.desktop.boot_id == launch.process.boot_id
                && proof.service == launch.process
                && proof.service_version == m.version(branch)
                && proof.protocol == 3
                && proof.desktop_signed_in
                && proof.valid_state_read
        })
    }
    pub fn validate(&self, m: &AdoptionManifest, sha: &str) -> Result<(), OtaError> {
        validate_manifest(m)?;
        require(
            self.schema == 1
                && self.transaction_kind == "adoption"
                && self.manifest_sha256 == sha
                && hash(sha)
                && self.revision <= 9_007_199_254_740_991
                && self.steps.len() <= 256,
        )?;
        if let Some(auth) = &self.authorization {
            auth.validate().map_err(|_| OtaError::Invalid)?;
            require(
                auth.binding == m.binding
                    && auth.reservation_id == m.transaction_id()
                    && auth.journal_sha256 == sha,
            )?;
        } else {
            require(matches!(
                self.state,
                AdoptionState::Preparing
                    | AdoptionState::Prepared
                    | AdoptionState::Restored
                    | AdoptionState::RecoveryFailed
            ))?;
        }
        if matches!(
            self.state,
            AdoptionState::Preparing | AdoptionState::Prepared
        ) {
            require(self.authorization.is_none())?;
        }
        if self.state == AdoptionState::Prepared || self.authorization.is_some() {
            for action in [
                AdoptionAction::BackupRegistration,
                AdoptionAction::ArmRecovery,
            ] {
                require(self.steps.iter().any(|step| {
                    step.action == action && step.evidence == Some(AdoptionEvidence::Complete)
                }))?;
            }
        }
        let mut actions = Vec::new();
        for step in &self.steps {
            require(
                step.intent_revision > 0
                    && step.intent_revision <= self.revision
                    && !step.intent_boot_id.is_empty()
                    && !actions.iter().any(|(action, boot)| {
                        action == &step.action
                            && (!matches!(
                                step.action,
                                AdoptionAction::SuppressLifecycle
                                    | AdoptionAction::SwitchRegistration { .. }
                            ) || boot == &step.intent_boot_id)
                    }),
            )?;
            actions.push((step.action.clone(), step.intent_boot_id.clone()));
            if self.authorization.is_none() {
                require(matches!(
                    step.action,
                    AdoptionAction::BackupRegistration
                        | AdoptionAction::ArmRecovery
                        | AdoptionAction::ReleaseReservation
                        | AdoptionAction::RetireRecovery
                ))?;
            }
            match &step.action {
                AdoptionAction::LaunchService { branch, launch_id } => {
                    if *branch == AdoptionBranch::Managed || step.intent_boot_id == m.source.boot_id
                    {
                        require(launch_id == m.launch_id(*branch))?;
                    } else {
                        require(
                            hash(launch_id)
                                && launch_id != &m.managed_launch_id
                                && launch_id != &m.original_launch_id,
                        )?;
                        require(
                            self.steps
                                .iter()
                                .filter(|other| {
                                    other.intent_boot_id == step.intent_boot_id
                                        && matches!(
                                            other.action,
                                            AdoptionAction::LaunchService {
                                                branch: AdoptionBranch::Original,
                                                ..
                                            }
                                        )
                                })
                                .count()
                                == 1,
                        )?;
                    }
                }
                AdoptionAction::LaunchRecoveryDesktop { launch_id } => {
                    require(hash(launch_id) && step.intent_boot_id != m.source.boot_id)?
                }
                AdoptionAction::PrepareRecoveryReconnect { capability } => require(
                    self.recovery_reconnects.contains(capability)
                        && capability.boot_id == step.intent_boot_id,
                )?,
                AdoptionAction::StopService { process: p } => require(process(p))?,
                _ => {}
            }
            if let Some(e) = &step.evidence {
                require(evidence_valid(&step.action, e, m))?;
            }
        }
        require(self.recovery_reconnects.len() <= 16)?;
        let mut boots = std::collections::HashSet::new();
        for cap in &self.recovery_reconnects {
            require(
                self.authorization.is_some()
                    && process(&cap.desktop)
                    && cap.desktop.boot_id == cap.boot_id
                    && cap.boot_id != m.source.boot_id
                    && hash(&cap.original_launch_id)
                    && id(&cap.native_session_id)
                    && boots.insert(&cap.boot_id),
            )?;
            require(self.steps.iter().any(|step|step.intent_boot_id==cap.boot_id&&matches!(&step.evidence,Some(AdoptionEvidence::Launched{branch:AdoptionBranch::Original,launch}) if launch.launch_id==cap.original_launch_id&&launch.process.boot_id==cap.boot_id)))?;
        }
        if matches!(
            self.state,
            AdoptionState::Authorized
                | AdoptionState::Switching
                | AdoptionState::Verifying
                | AdoptionState::Committed
                | AdoptionState::Restoring
        ) {
            require(self.authorization.is_some())?;
        }
        if let Some(proof) = &self.unchanged_registration {
            require(
                self.authorization.is_none()
                    && self.state == AdoptionState::Restored
                    && proof.sha256 == m.old_registration.sha256
                    && !proof.observed_at.boot_id.is_empty(),
            )?;
        }
        if self.state == AdoptionState::Restored && self.authorization.is_none() {
            require(self.unchanged_registration.is_some())?;
        }
        for stamp in [&self.verification_started, &self.restoration_started]
            .into_iter()
            .flatten()
        {
            require(!stamp.boot_id.is_empty())?;
        }
        require(self.restoration_history.len() <= 16)?;
        if matches!(
            self.state,
            AdoptionState::Verifying | AdoptionState::Committed
        ) {
            require(self.verification_started.is_some())?;
        }
        if self.state == AdoptionState::Committed {
            require(
                self.verification_proof
                    .as_ref()
                    .is_some_and(|p| self.proof_valid(p, AdoptionBranch::Managed, m)),
            )?;
        }
        if self.state == AdoptionState::Restored && self.authorization.is_some() {
            require(
                self.restoration_started.is_some()
                    && self
                        .restoration_proof
                        .as_ref()
                        .is_some_and(|p| self.proof_valid(p, AdoptionBranch::Original, m)),
            )?;
        }
        Ok(())
    }
}
impl AdoptionStore {
    pub fn create_manifest(&self, m: &AdoptionManifest) -> Result<String, OtaError> {
        validate_manifest(m)?;
        let bytes = serde_json::to_vec(m).map_err(|_| OtaError::Invalid)?;
        require(bytes.len() <= 1_048_576)?;
        self.directory.write_new("adoption-prepared.json", &bytes)?;
        Ok(digest(&bytes))
    }
    pub fn manifest(&self) -> Result<(AdoptionManifest, String), OtaError> {
        let bytes = self.directory.read("adoption-prepared.json", 1_048_576)?;
        let m: AdoptionManifest = serde_json::from_slice(&bytes).map_err(|_| OtaError::Invalid)?;
        validate_manifest(&m)?;
        Ok((m, digest(&bytes)))
    }
    pub fn initialize(&self, sha: &str) -> Result<AdoptionJournal, OtaError> {
        let (m, actual) = self.manifest()?;
        require(actual == sha)?;
        let j = AdoptionJournal {
            schema: 1,
            transaction_kind: "adoption".into(),
            revision: 0,
            manifest_sha256: sha.into(),
            state: AdoptionState::Preparing,
            authorization: None,
            steps: vec![],
            verification_started: None,
            restoration_started: None,
            restoration_history: vec![],
            recovery_reconnects: vec![],
            verification_proof: None,
            restoration_proof: None,
            unchanged_registration: None,
            error: None,
            restoration_cause: None,
        };
        j.validate(&m, sha)?;
        self.directory.write_new(
            "adoption-journal.json",
            &serde_json::to_vec(&j).map_err(|_| OtaError::Invalid)?,
        )?;
        Ok(j)
    }
    pub fn load(&self) -> Result<AdoptionJournal, OtaError> {
        let (m, sha) = self.manifest()?;
        let j: AdoptionJournal =
            serde_json::from_slice(&self.directory.read("adoption-journal.json", 1_048_576)?)
                .map_err(|_| OtaError::Invalid)?;
        j.validate(&m, &sha)?;
        Ok(j)
    }
    pub fn save(&self, j: &mut AdoptionJournal) -> Result<(), OtaError> {
        let before = self.directory.read("adoption-journal.json", 1_048_576)?;
        let old: AdoptionJournal =
            serde_json::from_slice(&before).map_err(|_| OtaError::Invalid)?;
        let (m, sha) = self.manifest()?;
        old.validate(&m, &sha)?;
        require(
            old.revision == j.revision
                && old.manifest_sha256 == j.manifest_sha256
                && old.steps.len() <= j.steps.len()
                && j.steps.len() <= old.steps.len() + 1,
        )?;
        require(
            j.recovery_reconnects.starts_with(&old.recovery_reconnects)
                && j.recovery_reconnects.len() <= old.recovery_reconnects.len() + 1,
        )?;
        if j.recovery_reconnects.len() > old.recovery_reconnects.len() {
            require(j.state == AdoptionState::Restoring)?;
        }
        require(old.authorization.is_none() || old.authorization == j.authorization)?;
        if old.authorization.is_none() && j.authorization.is_some() {
            require(old.state == AdoptionState::Prepared && j.state == AdoptionState::Authorized)?;
        }
        if let Some(step) = j.steps.get(old.steps.len()) {
            require(step.intent_revision == old.revision.checked_add(1).ok_or(OtaError::Invalid)?)?;
            require(match &step.action {
                AdoptionAction::BackupRegistration | AdoptionAction::ArmRecovery => {
                    j.state == AdoptionState::Preparing
                }
                AdoptionAction::LaunchService {
                    branch: AdoptionBranch::Managed,
                    ..
                } => j.state == AdoptionState::Verifying,
                AdoptionAction::LaunchService {
                    branch: AdoptionBranch::Original,
                    ..
                }
                | AdoptionAction::LaunchRecoveryDesktop { .. }
                | AdoptionAction::PrepareRecoveryReconnect { .. } => {
                    j.state == AdoptionState::Restoring
                }
                AdoptionAction::SwitchRegistration {
                    branch: AdoptionBranch::Managed,
                } => j.state == AdoptionState::Switching,
                AdoptionAction::SwitchRegistration {
                    branch: AdoptionBranch::Original,
                } => j.state == AdoptionState::Restoring,
                AdoptionAction::PrepareReconnect
                | AdoptionAction::SuppressLifecycle
                | AdoptionAction::StopService { .. } => {
                    matches!(j.state, AdoptionState::Switching | AdoptionState::Restoring)
                }
                AdoptionAction::ReleaseReservation | AdoptionAction::RetireRecovery => {
                    matches!(j.state, AdoptionState::Committed | AdoptionState::Restored)
                }
            })?;
        }
        if old.restoration_started != j.restoration_started {
            require(j.state == AdoptionState::Restoring)?;
            let next = j.restoration_started.as_ref().ok_or(OtaError::Invalid)?;
            if let Some(previous) = &old.restoration_started {
                require(
                    previous.boot_id != next.boot_id
                        && !old
                            .restoration_history
                            .iter()
                            .any(|s| s.boot_id == next.boot_id),
                )?;
                let mut expected = old.restoration_history.clone();
                expected.push(previous.clone());
                require(j.restoration_history == expected)?;
            } else {
                require(j.restoration_history == old.restoration_history)?;
            }
        } else {
            require(j.restoration_history == old.restoration_history)?;
        }

        require(
            old.unchanged_registration.is_none()
                || old.unchanged_registration == j.unchanged_registration,
        )?;
        require(
            old.verification_started.is_none()
                || old.verification_started == j.verification_started,
        )?;
        require(
            old.verification_proof.is_none() || old.verification_proof == j.verification_proof,
        )?;
        require(
            old.restoration_cause.is_none() || old.restoration_cause == j.restoration_cause,
        )?;
        require(old.restoration_proof.is_none() || old.restoration_proof == j.restoration_proof)?;
        for (a, b) in old.steps.iter().zip(&j.steps) {
            require(
                a.action == b.action
                    && a.intent_revision == b.intent_revision
                    && a.intent_boot_id == b.intent_boot_id
                    && (a.evidence.is_none() || a.evidence == b.evidence),
            )?;
        }
        require(
            old.state == j.state
                || match old.state {
                    AdoptionState::Preparing => matches!(
                        j.state,
                        AdoptionState::Prepared
                            | AdoptionState::Restored
                            | AdoptionState::RecoveryFailed
                    ),
                    AdoptionState::Prepared => matches!(
                        j.state,
                        AdoptionState::Authorized
                            | AdoptionState::Restored
                            | AdoptionState::RecoveryFailed
                    ),
                    AdoptionState::Authorized => matches!(
                        j.state,
                        AdoptionState::Switching
                            | AdoptionState::Restoring
                            | AdoptionState::RecoveryFailed
                    ),
                    AdoptionState::Switching => matches!(
                        j.state,
                        AdoptionState::Verifying
                            | AdoptionState::Restoring
                            | AdoptionState::RecoveryFailed
                    ),
                    AdoptionState::Verifying => matches!(
                        j.state,
                        AdoptionState::Committed
                            | AdoptionState::Restoring
                            | AdoptionState::RecoveryFailed
                    ),
                    AdoptionState::Restoring => matches!(
                        j.state,
                        AdoptionState::Restored | AdoptionState::RecoveryFailed
                    ),
                    _ => false,
                },
        )?;
        if matches!(
            old.state,
            AdoptionState::Committed | AdoptionState::Restored
        ) {
            require(j.steps.iter().skip(old.steps.len()).all(|step| {
                matches!(
                    step.action,
                    AdoptionAction::ReleaseReservation | AdoptionAction::RetireRecovery
                )
            }))?;
        }
        if old.state == AdoptionState::RecoveryFailed {
            require(old == *j)?;
        }
        let mut next = j.clone();
        next.revision = next.revision.checked_add(1).ok_or(OtaError::Invalid)?;
        next.validate(&m, &sha)?;
        let bytes = serde_json::to_vec(&next).map_err(|_| OtaError::Invalid)?;
        require(bytes.len() <= 1_048_576)?;
        self.directory
            .replace_exact("adoption-journal.json", &before, &bytes)?;
        *j = next;
        Ok(())
    }
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    #[test]
    fn takeover_manifest_is_not_adoption() {
        let bytes = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../test/fixtures/desktop-update/takeover-manifest.json"));
        assert!(serde_json::from_slice::<AdoptionManifest>(bytes).is_err());
        let mut adoption = manifest();
        adoption.transaction_kind = "takeover".into();
        assert_eq!(validate_manifest(&adoption), Err(OtaError::Invalid));
    }
    pub fn manifest() -> AdoptionManifest {
        let mut old = crate::ota::journal::tests::manifest();
        old.recovery_job.helper.relative_path = "pacer-update-helper".into();
        let mut target = old.target;
        target.ownership = Ownership::Attached;
        let new_service_executable = format!("{}/Contents/Resources/pacer", target.app_path);
        AdoptionManifest {
            schema: 1,
            transaction_kind: "adoption".into(),
            binding: old.binding,
            source: AdoptionSource {
                target,
                native_session_id: old.native_session_id,
                desktop_client_id: "desktop-client".into(),
                boot_id: old.requester_boot_id,
                desktop: old.old_desktop,
                service: old.old_service,
                service_version: old.old_service_version,
                old_service_executable: "/tmp/pacer-ota-fixture/external-pacer".into(),
                new_service_executable,
            },
            request: AdoptionRequestReceipt {
                request_id: "adopt-request".into(),
                fingerprint: "e".repeat(64),
            },
            expected_new_installation_id: "f".repeat(64),
            managed_launch_id: "a".repeat(64),
            original_launch_id: "b".repeat(64),
            old_registration: AssetIdentity {
                relative_path: "old-registration.plist".into(),
                sha256: "c".repeat(64),
            },
            new_registration: AssetIdentity {
                relative_path: "new-registration.plist".into(),
                sha256: "d".repeat(64),
            },
            recovery_job: old.recovery_job,
        }
    }
    pub fn initialized() -> (
        crate::ota::journal::tests::Temp,
        AdoptionStore,
        AdoptionJournal,
    ) {
        let temp = crate::ota::journal::tests::Temp::new();
        let store = AdoptionStore::open(&temp.0).unwrap();
        let hash = store.create_manifest(&manifest()).unwrap();
        let journal = store.initialize(&hash).unwrap();
        (temp, store, journal)
    }
    #[test]
    fn prepared_or_authorized_requires_completed_backup_and_recovery_arm() {
        let (_temp, store, mut value) = initialized();
        value.state = AdoptionState::Prepared;
        assert!(store.save(&mut value).is_err());
        let (m, sha) = store.manifest().unwrap();
        value.state = AdoptionState::Authorized;
        value.authorization = Some(Authorization {
            binding: m.binding.clone(),
            kind: wire::AuthorizationKind::AuthorizeInstall,
            reservation_id: m.transaction_id().into(),
            journal_sha256: sha.clone(),
        });
        assert!(value.validate(&m, &sha).is_err());
    }
    #[test]
    fn private_adoption_store_is_immutable_locked_and_cas() {
        let (temp, store, mut journal) = initialized();
        assert!(AdoptionStore::open(&temp.0).is_err());
        assert!(store.create_manifest(&manifest()).is_err());
        let mut stale = journal.clone();
        store.save(&mut journal).unwrap();
        assert_eq!(journal.revision, 1);
        assert!(store.save(&mut stale).is_err());
        assert_eq!(store.load().unwrap(), journal);
        drop(store);
        let reopened = AdoptionStore::open(&temp.0).unwrap();
        assert_eq!(reopened.load().unwrap(), journal);
        let metadata = std::fs::metadata(temp.0.join("adoption-journal.json")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    }
    #[test]
    fn immutable_adoption_authority_refuses_managed_target_and_redirected_source() {
        validate_manifest(&manifest()).unwrap();
        let mut value = manifest();
        value.source.target.ownership = Ownership::Managed;
        assert!(validate_manifest(&value).is_err());
        let mut value = manifest();
        value.source.new_service_executable = "/tmp/unrelated".into();
        assert!(validate_manifest(&value).is_err());
        let mut value = manifest();
        value.source.service.boot_id = "other".into();
        assert!(validate_manifest(&value).is_err());
        let mut value = manifest();
        value.original_launch_id = value.managed_launch_id.clone();
        assert!(validate_manifest(&value).is_err());
    }
    #[test]
    fn grantless_adoption_cannot_record_stop_or_terminal_without_unchanged_proof() {
        let (_temp, store, mut journal) = initialized();
        journal.steps.push(AdoptionStep {
            action: AdoptionAction::StopService {
                process: manifest().source.service,
            },
            intent_revision: 1,
            intent_boot_id: "boot-one".into(),
            evidence: None,
        });
        assert!(store.save(&mut journal).is_err());
        journal.steps.clear();
        journal.state = AdoptionState::Restored;
        assert!(store.save(&mut journal).is_err());
        journal.unchanged_registration = Some(UnchangedRegistration {
            sha256: manifest().old_registration.sha256,
            observed_at: AwakeStamp {
                boot_id: "boot-one".into(),
                millis: 1,
            },
        });
        store.save(&mut journal).unwrap();
        journal.state = AdoptionState::Switching;
        assert!(store.save(&mut journal).is_err());
    }
}
