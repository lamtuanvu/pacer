//! Durable private transaction storage.
use super::*;
use std::path::Path;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TransactionState {
    Preparing,
    Prepared,
    Authorized,
    Installing,
    Verifying,
    Restoring,
    Committed,
    Restored,
    RecoveryFailed,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub action: PlatformAction,
    pub intent_revision: u64,
    pub intent_boot_id: String,
    #[serde(deserialize_with = "required_nullable")]
    pub evidence: Option<ActionEvidence>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OriginalBundleProof {
    pub sha256: String,
    pub observed_at: AwakeStamp,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub schema: u32,
    pub revision: u64,
    pub manifest_sha256: String,
    pub state: TransactionState,
    #[serde(deserialize_with = "required_nullable")]
    pub authorization: Option<Authorization>,
    #[serde(default)]
    pub unchanged_original: Option<OriginalBundleProof>,
    pub steps: Vec<Step>,
    #[serde(deserialize_with = "required_nullable")]
    pub verification_started: Option<AwakeStamp>,
    #[serde(deserialize_with = "required_nullable")]
    pub restoration_started: Option<AwakeStamp>,
    pub restoration_history: Vec<AwakeStamp>,
    #[serde(deserialize_with = "required_nullable")]
    pub verification_proof: Option<ReadinessProof>,
    #[serde(deserialize_with = "required_nullable")]
    pub restoration_proof: Option<ReadinessProof>,
    #[serde(deserialize_with = "required_nullable")]
    pub failed_version: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub error: Option<OtaError>,
}

pub struct JournalStore {
    root: std::path::PathBuf,
    directory: std::fs::File,
    lock: std::fs::File,
}

const MAX_JOURNAL_BYTES: u64 = 1_048_576;
fn invalid(ok: bool) -> Result<(), OtaError> {
    if ok {
        Ok(())
    } else {
        Err(OtaError::Invalid)
    }
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn process_valid(process: &ProcessIdentity) -> bool {
    process.pid > 0
        && !process.boot_id.is_empty()
        && process.boot_id.len() <= 128
        && !process.birth.is_empty()
        && process.birth.len() <= 128
}
fn asset_valid(asset: &AssetIdentity) -> bool {
    hash(&asset.sha256)
        && asset.relative_path.len() <= 4096
        && !asset.relative_path.contains('\0')
        && asset
            .relative_path
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}
pub(crate) fn validate_manifest(manifest: &PreparedManifest) -> Result<(), OtaError> {
    use wire::WireMessage;
    AdapterCommand::Install {
        binding: manifest.binding.clone(),
        target: manifest.target.clone(),
        candidate: manifest.candidate.clone(),
    }
    .validate()
    .map_err(|_| OtaError::Invalid)?;
    let executable = Path::new(&manifest.old_service_executable);
    invalid(
        executable.is_absolute()
            && manifest.old_service_executable.len() <= 4096
            && !manifest.old_service_executable.contains('\0')
            && executable.components().all(|part| {
                matches!(
                    part,
                    std::path::Component::RootDir | std::path::Component::Normal(_)
                )
            })
            && executable
                .components()
                .collect::<std::path::PathBuf>()
                .as_os_str()
                == executable.as_os_str(),
    )?;
    invalid(
        manifest.schema == 1
            && identifier(&manifest.native_session_id)
            && !manifest.requester_boot_id.is_empty()
            && process_valid(&manifest.old_desktop)
            && process_valid(&manifest.old_service)
            && manifest.requester_boot_id == manifest.old_desktop.boot_id
            && manifest.old_service.boot_id == manifest.old_desktop.boot_id
            && manifest.old_state_compatible
            && manifest.old_admission_protocol == 1
            && manifest.old_service_protocol > 0
            && manifest.old_service_protocol <= 9_007_199_254_740_991
            && !manifest.old_service_version.is_empty()
            && asset_valid(&manifest.artifact)
            && manifest.artifact.sha256 == manifest.candidate.sha256
            && asset_valid(&manifest.old_bundle_backup)
            && asset_valid(&manifest.recovery_job.helper)
            && manifest
                .registration_backup
                .as_ref()
                .is_none_or(asset_valid)
            && manifest.managed() == manifest.registration_backup.is_some()
            && (!manifest.managed() || manifest.old_service_version == manifest.target.version)
            && (!manifest.managed()
                || executable
                    == Path::new(&manifest.target.app_path).join("Contents/Resources/pacer"))
            && !manifest.recovery_job.label.is_empty()
            && manifest.recovery_job.label.len() <= 255,
    )?;
    let mut paths = std::collections::HashSet::new();
    for asset in [
        &manifest.artifact,
        &manifest.old_bundle_backup,
        &manifest.recovery_job.helper,
    ]
    .into_iter()
    .chain(manifest.registration_backup.iter())
    {
        invalid(paths.insert(&asset.relative_path))?;
    }
    Ok(())
}
pub(crate) fn evidence_valid(
    action: &PlatformAction,
    evidence: &ActionEvidence,
    manifest: &PreparedManifest,
) -> bool {
    match (action, evidence) {
        (
            PlatformAction::Launch {
                role,
                release,
                launch_id,
            },
            ActionEvidence::Launched { launch },
        ) => {
            launch.role == *role
                && launch.release == *release
                && launch.launch_id == *launch_id
                && process_valid(&launch.process)
                && identifier(&launch.native_session_id)
                && &launch.version
                    == if *release == Release::Old {
                        &manifest.target.version
                    } else {
                        &manifest.candidate.version
                    }
        }
        (PlatformAction::Launch { .. }, _) | (_, ActionEvidence::Launched { .. }) => false,
        (_, ActionEvidence::Complete) => true,
    }
}
fn preparing_action(action: &PlatformAction) -> bool {
    matches!(
        action,
        PlatformAction::PrepareBackup | PlatformAction::ArmRecovery
    )
}
fn cleanup_action(action: &PlatformAction) -> bool {
    matches!(
        action,
        PlatformAction::ReleaseReservation
            | PlatformAction::RetireRecovery
            | PlatformAction::PruneSupersededBackup
    )
}
impl Journal {
    /// Only the original managed candidate launch can authorize this closed cleanup.
    pub(crate) fn unready_candidate_launch(
        &self,
        m: &PreparedManifest,
        id: &str,
        boot: &str,
    ) -> Result<(), OtaError> {
        invalid(
            m.managed()
                && self.authorization.is_some()
                && hash(id)
                && matches!(
                    self.state,
                    TransactionState::Restoring
                        | TransactionState::Restored
                        | TransactionState::RecoveryFailed
                ),
        )?;
        let index=self.steps.iter().position(|step|step.intent_boot_id==boot && matches!(&step.action,PlatformAction::Launch{role:ProcessRole::Service,release:Release::Candidate,launch_id}if launch_id==id)).ok_or(OtaError::Invalid)?;
        invalid(self.steps[index].evidence.is_none())?;
        for action in [
            PlatformAction::SuppressLifecycle,
            PlatformAction::Stop {
                role: ProcessRole::Desktop,
                process: m.old_desktop.clone(),
            },
            PlatformAction::Stop {
                role: ProcessRole::Service,
                process: m.old_service.clone(),
            },
            PlatformAction::InstallCandidate,
            PlatformAction::SwitchRegistration,
        ] {
            invalid(self.steps[..index].iter().any(|step| {
                step.action == action && step.evidence == Some(ActionEvidence::Complete)
            }))?;
        }
        invalid(!self.steps.iter().any(|step| {
            matches!(
                step.action,
                PlatformAction::Launch {
                    role: ProcessRole::Desktop,
                    release: Release::Candidate,
                    ..
                }
            )
        }))
    }
    pub fn validate(&self, manifest: &PreparedManifest, digest: &str) -> Result<(), OtaError> {
        use wire::WireMessage;
        invalid(
            self.schema == 1
                && self.revision <= 9_007_199_254_740_991
                && self.manifest_sha256 == digest
                && hash(digest)
                && self.steps.len() <= 64,
        )?;
        if let Some(proof) = &self.unchanged_original {
            invalid(
                self.authorization.is_none()
                    && self.state == TransactionState::Restored
                    && proof.sha256 == manifest.old_bundle_backup.sha256
                    && !proof.observed_at.boot_id.is_empty()
                    && proof.observed_at.millis <= 9_007_199_254_740_991,
            )?;
        }
        if self.authorization.is_none() && self.state == TransactionState::Restored {
            invalid(self.unchanged_original.is_some())?;
        }
        if let Some(authorization) = &self.authorization {
            authorization.validate().map_err(|_| OtaError::Invalid)?;
            invalid(
                authorization.binding == manifest.binding && authorization.journal_sha256 == digest,
            )?;
        }
        if matches!(
            self.state,
            TransactionState::Authorized
                | TransactionState::Installing
                | TransactionState::Verifying
                | TransactionState::Restoring
                | TransactionState::Committed
        ) {
            invalid(self.authorization.is_some())?;
        }
        if self.state == TransactionState::Prepared || self.authorization.is_some() {
            invalid(
                [PlatformAction::PrepareBackup, PlatformAction::ArmRecovery]
                    .iter()
                    .all(|action| {
                        self.steps.iter().any(|step| {
                            &step.action == action
                                && step.evidence == Some(ActionEvidence::Complete)
                        })
                    }),
            )?;
        }
        if matches!(
            self.state,
            TransactionState::Preparing | TransactionState::Prepared
        ) {
            invalid(self.authorization.is_none())?;
        }
        if self.state == TransactionState::Committed {
            invalid(
                self.steps
                    .iter()
                    .all(|step| cleanup_action(&step.action) || step.evidence.is_some()),
            )?;
        }
        for (index, step) in self.steps.iter().enumerate() {
            invalid(
                step.intent_revision <= self.revision
                    && !step.intent_boot_id.is_empty()
                    && !self.steps[..index]
                        .iter()
                        .any(|previous| previous.action == step.action),
            )?;
            if self.authorization.is_none() {
                invalid(preparing_action(&step.action) || cleanup_action(&step.action))?;
            }
            if !manifest.managed() {
                invalid(!matches!(
                    step.action,
                    PlatformAction::Stop {
                        role: ProcessRole::Service,
                        ..
                    } | PlatformAction::Launch {
                        role: ProcessRole::Service,
                        ..
                    } | PlatformAction::SwitchRegistration
                        | PlatformAction::RestoreRegistration
                ))?;
            }
            if let PlatformAction::Launch { launch_id, .. } = &step.action {
                // This private durable identifier is also the launch-ticket capability.
                invalid(hash(launch_id))?;
            }
            if let PlatformAction::Stop { process, .. } = &step.action {
                invalid(process_valid(process))?;
            }
            if let PlatformAction::StopUnreadyCandidateService { launch_id } = &step.action {
                self.unready_candidate_launch(manifest, launch_id, &step.intent_boot_id)?;
                invalid(self.steps[..index].iter().any(|prior|matches!(&prior.action,PlatformAction::Launch{role:ProcessRole::Service,release:Release::Candidate,launch_id:id}if id==launch_id)))?;
            }
            if let Some(evidence) = &step.evidence {
                invalid(evidence_valid(&step.action, evidence, manifest))?;
            }
        }
        for stamp in [&self.verification_started, &self.restoration_started]
            .into_iter()
            .flatten()
        {
            invalid(!stamp.boot_id.is_empty())?;
        }
        let mut restoration_boots = std::collections::HashSet::new();
        invalid(self.restoration_history.len() <= 16)?;
        for stamp in &self.restoration_history {
            invalid(!stamp.boot_id.is_empty() && restoration_boots.insert(&stamp.boot_id))?;
        }
        if let Some(stamp) = &self.restoration_started {
            invalid(!restoration_boots.contains(&stamp.boot_id))?;
        }
        if self.state == TransactionState::Verifying || self.state == TransactionState::Committed {
            invalid(self.verification_started.is_some())?;
        }
        if self.state == TransactionState::Committed {
            invalid(self.proof_valid(
                self.verification_proof.as_ref(),
                Release::Candidate,
                manifest,
            ))?;
        }
        if self.state == TransactionState::Restored && self.authorization.is_some() {
            invalid(
                self.restoration_started.is_some()
                    && self.proof_valid(self.restoration_proof.as_ref(), Release::Old, manifest),
            )?;
        }
        if let Some(version) = &self.failed_version {
            invalid(version == &manifest.candidate.version)?;
        }
        Ok(())
    }
    fn proof_valid(
        &self,
        proof: Option<&ReadinessProof>,
        release: Release,
        manifest: &PreparedManifest,
    ) -> bool {
        let Some(proof) = proof else {
            return false;
        };
        let launch = |role| {
            self.steps
                .iter()
                .rev()
                .find_map(|step| match &step.evidence {
                    Some(ActionEvidence::Launched { launch })
                        if launch.role == role && launch.release == release =>
                    {
                        Some(launch)
                    }
                    _ => None,
                })
        };
        let Some(desktop) = launch(ProcessRole::Desktop) else {
            return false;
        };
        let service = if manifest.managed() {
            match launch(ProcessRole::Service) {
                Some(launch) => &launch.process,
                None => return false,
            }
        } else {
            &manifest.old_service
        };
        proof.installation_id == manifest.target.id
            && proof.transaction_id == manifest.transaction_id()
            && proof.desktop == desktop.process
            && proof.native_session_id == desktop.native_session_id
            && proof.desktop_version == desktop.version
            && &proof.service == service
            && proof.desktop_signed_in
            && proof.valid_state_read
            && &proof.service_version
                == if release == Release::Candidate && manifest.managed() {
                    &manifest.candidate.version
                } else {
                    &manifest.old_service_version
                }
            && if release == Release::Old || !manifest.managed() {
                proof.protocol == manifest.old_service_protocol
            } else {
                manifest.candidate.protocol_majors.contains(&proof.protocol)
            }
    }
}

use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};

fn cstr(value: &std::ffi::OsStr) -> Result<CString, OtaError> {
    CString::new(value.as_bytes()).map_err(|_| OtaError::Invalid)
}
fn openat(directory: &File, name: &str, flags: i32, mode: libc::mode_t) -> Result<File, OtaError> {
    let name = cstr(std::ffi::OsStr::new(name))?;
    // The returned descriptor is owned exactly once by File. Never follows a symlink.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(OtaError::Io);
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn open_directory(path: &Path) -> Result<File, OtaError> {
    invalid(path.is_absolute())?;
    let slash = CString::new("/").unwrap();
    let fd = unsafe {
        libc::open(
            slash.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(OtaError::Io);
    }
    let mut current = unsafe { File::from_raw_fd(fd) };
    for component in path.components() {
        match component {
            std::path::Component::RootDir => {}
            std::path::Component::Normal(name) => {
                let name = name.to_str().ok_or(OtaError::Invalid)?;
                current = openat(&current, name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
            }
            _ => return Err(OtaError::Invalid),
        }
    }
    Ok(current)
}
fn private_file(file: &File, directory: bool) -> Result<(), OtaError> {
    let meta = file.metadata().map_err(|_| OtaError::Io)?;
    invalid(
        meta.uid() == unsafe { libc::geteuid() }
            && meta.permissions().mode() & 0o777 == if directory { 0o700 } else { 0o600 }
            && if directory {
                meta.is_dir()
            } else {
                meta.is_file() && meta.nlink() == 1
            },
    )
}
fn same_inode(a: &File, b: &File) -> Result<(), OtaError> {
    let a = a.metadata().map_err(|_| OtaError::Io)?;
    let b = b.metadata().map_err(|_| OtaError::Io)?;
    invalid(a.dev() == b.dev() && a.ino() == b.ino())
}
pub(crate) fn random_id() -> Result<String, OtaError> {
    let mut bytes = [0_u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|_| OtaError::Io)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
impl Drop for JournalStore {
    fn drop(&mut self) {
        // A fork can transiently inherit the open file description before exec.
        // Explicit release prevents that unrelated child from extending ownership.
        unsafe {
            libc::flock(self.lock.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
impl JournalStore {
    /// root must already be a private, absolute, symlink-free directory derived by
    /// the verified provider. The kernel lock inode is never removed or age-stolen.
    pub fn open(root: &Path) -> Result<Self, OtaError> {
        let directory = open_directory(root)?;
        private_file(&directory, true)?;
        let lock = openat(&directory, ".lock", libc::O_RDWR | libc::O_CREAT, 0o600)?;
        private_file(&lock, false)?;
        loop {
            if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                break;
            }
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(if error.kind() == std::io::ErrorKind::WouldBlock {
                OtaError::Busy
            } else {
                OtaError::Io
            });
        }
        directory.sync_all().map_err(|_| OtaError::Io)?;
        let store = Self {
            root: root.to_path_buf(),
            directory,
            lock,
        };
        store.ensure_current()?;
        Ok(store)
    }
    fn ensure_current(&self) -> Result<(), OtaError> {
        let current = open_directory(&self.root)?;
        private_file(&current, true)?;
        same_inode(&current, &self.directory)?;
        let lock = openat(&self.directory, ".lock", libc::O_RDONLY, 0)?;
        private_file(&lock, false)?;
        same_inode(&lock, &self.lock)
    }
    fn read(&self, name: &str) -> Result<Vec<u8>, OtaError> {
        self.ensure_current()?;
        let file = openat(&self.directory, name, libc::O_RDONLY, 0)?;
        private_file(&file, false)?;
        invalid(file.metadata().map_err(|_| OtaError::Io)?.len() <= MAX_JOURNAL_BYTES)?;
        let mut bytes = Vec::new();
        file.take(MAX_JOURNAL_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| OtaError::Io)?;
        invalid(bytes.len() as u64 <= MAX_JOURNAL_BYTES)?;
        self.ensure_current()?;
        Ok(bytes)
    }
    fn write(&self, name: &str, bytes: &[u8], exclusive: bool) -> Result<(), OtaError> {
        invalid(bytes.len() as u64 <= MAX_JOURNAL_BYTES)?;
        self.ensure_current()?;
        let temporary = format!(".tmp-{}", random_id()?);
        let mut file = openat(
            &self.directory,
            &temporary,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        private_file(&file, false)?;
        let result = (|| {
            file.write_all(bytes).map_err(|_| OtaError::Io)?;
            file.sync_all().map_err(|_| OtaError::Io)?;
            self.ensure_current()?;
            let from = CString::new(temporary.as_str()).unwrap();
            let to = CString::new(name).map_err(|_| OtaError::Invalid)?;
            let status = unsafe {
                if exclusive {
                    libc::linkat(
                        self.directory.as_raw_fd(),
                        from.as_ptr(),
                        self.directory.as_raw_fd(),
                        to.as_ptr(),
                        0,
                    )
                } else {
                    libc::renameat(
                        self.directory.as_raw_fd(),
                        from.as_ptr(),
                        self.directory.as_raw_fd(),
                        to.as_ptr(),
                    )
                }
            };
            if status != 0 {
                return Err(OtaError::Io);
            }
            if exclusive {
                unsafe {
                    libc::unlinkat(self.directory.as_raw_fd(), from.as_ptr(), 0);
                }
            }
            self.directory.sync_all().map_err(|_| OtaError::Io)?;
            self.ensure_current()
        })();
        // Only this invocation's exclusive temporary name is eligible for cleanup.
        let temporary = CString::new(temporary).unwrap();
        unsafe {
            libc::unlinkat(self.directory.as_raw_fd(), temporary.as_ptr(), 0);
        }
        result
    }
    pub fn create_manifest(&self, manifest: &PreparedManifest) -> Result<String, OtaError> {
        validate_manifest(manifest)?;
        let bytes = serde_json::to_vec(manifest).map_err(|_| OtaError::Invalid)?;
        self.write("prepared.json", &bytes, true)?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
    pub fn manifest(&self) -> Result<(PreparedManifest, String), OtaError> {
        let bytes = self.read("prepared.json")?;
        let manifest: PreparedManifest =
            serde_json::from_slice(&bytes).map_err(|_| OtaError::Invalid)?;
        validate_manifest(&manifest)?;
        Ok((manifest, format!("{:x}", Sha256::digest(bytes))))
    }
    pub fn initialize(&self, digest: &str) -> Result<Journal, OtaError> {
        let (manifest, actual) = self.manifest()?;
        invalid(actual == digest)?;
        let journal = Journal {
            schema: 1,
            revision: 0,
            manifest_sha256: digest.into(),
            state: TransactionState::Preparing,
            authorization: None,
            unchanged_original: None,
            steps: vec![],
            verification_started: None,
            restoration_started: None,
            restoration_history: vec![],
            verification_proof: None,
            restoration_proof: None,
            failed_version: None,
            error: None,
        };
        journal.validate(&manifest, digest)?;
        self.write(
            "journal.json",
            &serde_json::to_vec(&journal).map_err(|_| OtaError::Invalid)?,
            true,
        )?;
        Ok(journal)
    }
    pub fn load(&self) -> Result<Journal, OtaError> {
        let (manifest, digest) = self.manifest()?;
        let journal: Journal =
            serde_json::from_slice(&self.read("journal.json")?).map_err(|_| OtaError::Invalid)?;
        journal.validate(&manifest, &digest)?;
        Ok(journal)
    }
    pub fn save(&self, journal: &mut Journal) -> Result<(), OtaError> {
        let previous = self.load()?;
        invalid(
            previous.revision == journal.revision
                && previous.manifest_sha256 == journal.manifest_sha256,
        )?;
        invalid(
            previous.unchanged_original.is_none()
                || previous.unchanged_original == journal.unchanged_original,
        )?;
        let valid_transition = previous.state == journal.state
            || match previous.state {
                TransactionState::Preparing => matches!(
                    journal.state,
                    TransactionState::Prepared
                        | TransactionState::Restored
                        | TransactionState::RecoveryFailed
                ),
                TransactionState::Prepared => matches!(
                    journal.state,
                    TransactionState::Authorized
                        | TransactionState::Restored
                        | TransactionState::RecoveryFailed
                ),
                TransactionState::Authorized => matches!(
                    journal.state,
                    TransactionState::Installing
                        | TransactionState::Restoring
                        | TransactionState::RecoveryFailed
                ),
                TransactionState::Installing => matches!(
                    journal.state,
                    TransactionState::Verifying
                        | TransactionState::Restoring
                        | TransactionState::RecoveryFailed
                ),
                TransactionState::Verifying => matches!(
                    journal.state,
                    TransactionState::Committed
                        | TransactionState::Restoring
                        | TransactionState::RecoveryFailed
                ),
                TransactionState::Restoring => matches!(
                    journal.state,
                    TransactionState::Restored | TransactionState::RecoveryFailed
                ),
                _ => false,
            };
        invalid(valid_transition)?;
        if matches!(
            previous.state,
            TransactionState::Committed
                | TransactionState::Restored
                | TransactionState::RecoveryFailed
        ) {
            invalid(previous.state == journal.state)?;
        }
        if previous.authorization.is_some() {
            invalid(previous.authorization == journal.authorization)?;
        }
        if previous.verification_started.is_some() {
            invalid(previous.verification_started == journal.verification_started)?;
        }
        if previous.restoration_started != journal.restoration_started
            && previous.restoration_started.is_some()
        {
            let old = previous
                .restoration_started
                .as_ref()
                .ok_or(OtaError::Invalid)?;
            let new = journal
                .restoration_started
                .as_ref()
                .ok_or(OtaError::Invalid)?;
            let mut history = previous.restoration_history.clone();
            history.push(old.clone());
            invalid(
                previous.state == TransactionState::Restoring
                    && journal.state == TransactionState::Restoring
                    && old.boot_id != new.boot_id
                    && journal.restoration_history == history,
            )?;
        } else {
            invalid(previous.restoration_history == journal.restoration_history)?;
        }
        if previous.verification_proof.is_some() {
            invalid(previous.verification_proof == journal.verification_proof)?;
        }
        if previous.restoration_proof.is_some() {
            invalid(previous.restoration_proof == journal.restoration_proof)?;
        }
        if previous.failed_version.is_some() {
            invalid(previous.failed_version == journal.failed_version)?;
        }
        invalid(journal.steps.len() >= previous.steps.len())?;
        invalid(journal.steps.iter().skip(previous.steps.len()).all(|step| {
            !matches!(
                step.action,
                PlatformAction::StopUnreadyCandidateService { .. }
            ) || journal.state == TransactionState::Restoring
        }))?;
        for (old, new) in previous.steps.iter().zip(&journal.steps) {
            invalid(
                old.action == new.action
                    && old.intent_revision == new.intent_revision
                    && old.intent_boot_id == new.intent_boot_id
                    && (old.evidence.is_none() || old.evidence == new.evidence),
            )?;
        }
        if matches!(
            previous.state,
            TransactionState::Committed | TransactionState::Restored
        ) {
            for step in &journal.steps[previous.steps.len()..] {
                invalid(cleanup_action(&step.action))?;
            }
        }
        if previous.state == TransactionState::RecoveryFailed {
            invalid(previous.steps == journal.steps)?;
        }
        let mut next = journal.clone();
        next.revision = next.revision.checked_add(1).ok_or(OtaError::Invalid)?;
        let (manifest, digest) = self.manifest()?;
        next.validate(&manifest, &digest)?;
        self.write(
            "journal.json",
            &serde_json::to_vec(&next).map_err(|_| OtaError::Invalid)?,
            false,
        )?;
        *journal = next;
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, DirBuilderExt, PermissionsExt};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    pub struct Temp(pub PathBuf);
    impl Temp {
        pub fn new() -> Self {
            let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "pacer-ota-journal-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn grantless_restored_requires_explicit_original_tree_proof() {
        let (_temp, store, mut journal) = initialized();
        let (manifest, digest) = store.manifest().unwrap();
        journal.state = TransactionState::Restored;
        assert!(journal.validate(&manifest, &digest).is_err());
        journal.unchanged_original = Some(OriginalBundleProof {
            sha256: manifest.old_bundle_backup.sha256.clone(),
            observed_at: AwakeStamp {
                boot_id: "boot-one".into(),
                millis: 10,
            },
        });
        journal.validate(&manifest, &digest).unwrap();
        journal.unchanged_original.as_mut().unwrap().sha256 = "f".repeat(64);
        assert!(journal.validate(&manifest, &digest).is_err());
    }
    #[test]
    fn recorded_service_executable_is_required_and_cannot_redirect_offline_recovery() {
        for path in [
            "/tmp/../foreign",
            "relative",
            "/tmp//foreign",
            "/tmp/./foreign",
            "/tmp/foreign",
        ] {
            let mut value = serde_json::to_value(manifest()).unwrap();
            value["oldServiceExecutable"] = serde_json::json!(path);
            assert!(validate_manifest(&serde_json::from_value(value).unwrap()).is_err());
        }
        let mut value = serde_json::to_value(manifest()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .remove("oldServiceExecutable");
        assert!(serde_json::from_value::<PreparedManifest>(value).is_err());
    }
    pub fn manifest() -> PreparedManifest {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/desktop-update/adapter-wire.json"
        ))
        .unwrap();
        let command =
            wire::parse_command(&serde_json::to_vec(&fixture["commands"][2]).unwrap()).unwrap();
        let (binding, target, candidate) = match command {
            AdapterCommand::Install {
                binding,
                target,
                candidate,
            } => (binding, target, candidate),
            _ => unreachable!(),
        };
        PreparedManifest {
            schema: 1,
            binding,
            target,
            candidate,
            native_session_id: "native-session".into(),
            requester_boot_id: "boot-one".into(),
            old_desktop: ProcessIdentity {
                pid: 100,
                boot_id: "boot-one".into(),
                birth: "1000:5".into(),
            },
            old_service: ProcessIdentity {
                pid: 101,
                boot_id: "boot-one".into(),
                birth: "1000:6".into(),
            },
            old_service_executable: "/tmp/pacer-ota-fixture/pacer.app/Contents/Resources/pacer"
                .into(),
            old_service_version: "1.0.0".into(),
            old_service_protocol: 3,
            old_admission_protocol: 1,
            old_state_compatible: true,
            artifact: AssetIdentity {
                relative_path: "candidate.tar.gz".into(),
                sha256: "a".repeat(64),
            },
            old_bundle_backup: AssetIdentity {
                relative_path: "old.app".into(),
                sha256: "b".repeat(64),
            },
            registration_backup: Some(AssetIdentity {
                relative_path: "registration.plist".into(),
                sha256: "d".repeat(64),
            }),
            recovery_job: RecoveryJob {
                label: "dev.pacer.recovery.fixture".into(),
                helper: AssetIdentity {
                    relative_path: "helper".into(),
                    sha256: "e".repeat(64),
                },
            },
        }
    }
    pub fn initialized() -> (Temp, JournalStore, Journal) {
        let temp = Temp::new();
        let store = JournalStore::open(&temp.0).unwrap();
        let digest = store.create_manifest(&manifest()).unwrap();
        let journal = store.initialize(&digest).unwrap();
        (temp, store, journal)
    }
    #[test]
    fn private_manifest_and_journal_survive_reopen_with_exact_digest() {
        let (temp, store, mut journal) = initialized();
        journal.error = Some(OtaError::Interrupted);
        store.save(&mut journal).unwrap();
        assert_eq!(journal.revision, 1);
        let (original, digest) = store.manifest().unwrap();
        assert_eq!(digest, journal.manifest_sha256);
        assert_eq!(original, manifest());
        for file in ["prepared.json", "journal.json", ".lock"] {
            assert_eq!(
                fs::metadata(temp.0.join(file))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        drop(store);
        let reopened = JournalStore::open(&temp.0).unwrap();
        assert_eq!(reopened.load().unwrap(), journal);
    }
    #[test]
    fn immutable_manifest_and_stale_journal_revision_cannot_overwrite_authority() {
        let (_temp, store, mut journal) = initialized();
        let mut stale = journal.clone();
        let mut changed = manifest();
        changed.native_session_id = "other-session".into();
        assert!(store.create_manifest(&changed).is_err());
        journal.error = Some(OtaError::Interrupted);
        store.save(&mut journal).unwrap();
        stale.error = Some(OtaError::Interrupted);
        assert!(store.save(&mut stale).is_err());
        assert_eq!(store.load().unwrap(), journal);
    }
    #[test]
    fn dropping_writer_unlocks_even_when_a_fork_inherited_the_description() {
        let temp = Temp::new();
        let first = JournalStore::open(&temp.0).unwrap();
        let inherited = first.lock.try_clone().unwrap();
        drop(first);
        let next = JournalStore::open(&temp.0).unwrap();
        drop(inherited);
        drop(next);
    }
    #[test]
    fn stable_kernel_lock_is_exclusive_and_released_without_deleting_inode() {
        let temp = Temp::new();
        let first = JournalStore::open(&temp.0).unwrap();
        assert!(matches!(JournalStore::open(&temp.0), Err(OtaError::Busy)));
        let metadata = fs::metadata(temp.0.join(".lock")).unwrap();
        drop(first);
        let _next = JournalStore::open(&temp.0).unwrap();
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            metadata.ino(),
            fs::metadata(temp.0.join(".lock")).unwrap().ino()
        );
    }
    #[test]
    fn symlinks_open_permissions_and_replaced_directory_fail_closed() {
        let temp = Temp::new();
        let link = temp.0.join("link");
        symlink(&temp.0, &link).unwrap();
        assert!(JournalStore::open(&link).is_err());
        fs::set_permissions(&temp.0, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(JournalStore::open(&temp.0).is_err());
        fs::set_permissions(&temp.0, fs::Permissions::from_mode(0o700)).unwrap();
        let store = JournalStore::open(&temp.0).unwrap();
        symlink("elsewhere", temp.0.join("prepared.json")).unwrap();
        assert!(store.create_manifest(&manifest()).is_err());
        fs::remove_file(temp.0.join("prepared.json")).unwrap();
        let moved = temp.0.with_extension("moved");
        fs::rename(&temp.0, &moved).unwrap();
        fs::DirBuilder::new().mode(0o700).create(&temp.0).unwrap();
        assert!(store.create_manifest(&manifest()).is_err());
        fs::remove_dir_all(moved).unwrap();
    }

    #[test]
    fn terminal_markers_require_verified_readiness_and_malformed_journals_are_preserved() {
        let (temp, store, mut journal) = initialized();
        journal.authorization = Some(Authorization {
            binding: manifest().binding,
            kind: wire::AuthorizationKind::AuthorizeInstall,
            reservation_id: "tx-1".into(),
            journal_sha256: journal.manifest_sha256.clone(),
        });
        journal.verification_started = Some(AwakeStamp {
            boot_id: "boot-one".into(),
            millis: 1000,
        });
        journal.state = TransactionState::Committed;
        assert!(store.save(&mut journal).is_err());
        let original = fs::read(temp.0.join("journal.json")).unwrap();
        let mut missing: serde_json::Value = serde_json::from_slice(&original).unwrap();
        missing.as_object_mut().unwrap().remove("failedVersion");
        let malformed = serde_json::to_vec(&missing).unwrap();
        fs::write(temp.0.join("journal.json"), &malformed).unwrap();
        assert!(store.load().is_err());
        assert_eq!(fs::read(temp.0.join("journal.json")).unwrap(), malformed);
        fs::write(
            temp.0.join("journal.json"),
            vec![b' '; MAX_JOURNAL_BYTES as usize + 1],
        )
        .unwrap();
        assert!(store.load().is_err());
        assert!(temp.0.join("prepared.json").exists());
    }

    #[test]
    fn preparation_and_authority_cannot_skip_durable_backup_and_recovery_arm() {
        let (_temp, store, original) = initialized();
        let mut prepared = original.clone();
        prepared.state = TransactionState::Prepared;
        assert!(store.save(&mut prepared).is_err());
        let mut authorized = original;
        authorized.authorization = Some(Authorization {
            binding: manifest().binding,
            kind: wire::AuthorizationKind::AuthorizeInstall,
            reservation_id: "tx-1".into(),
            journal_sha256: authorized.manifest_sha256.clone(),
        });
        authorized.state = TransactionState::Authorized;
        assert!(store.save(&mut authorized).is_err());
    }

    #[test]
    fn shared_schema_one_journal_fixture_accepts_additions_but_rejects_changed_authority() {
        let mut fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/desktop-update/journal.json"
        ))
        .unwrap();
        let manifest: PreparedManifest =
            serde_json::from_value(fixture["prepared"].clone()).unwrap();
        validate_manifest(&manifest).unwrap();
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&manifest).unwrap())
        );
        fixture["journal"]["futureField"] = serde_json::json!(true);
        let journal: Journal = serde_json::from_value(fixture["journal"].clone()).unwrap();
        journal.validate(&manifest, &digest).unwrap();
        assert!(serde_json::to_value(&journal)
            .unwrap()
            .get("futureField")
            .is_none());
        fixture["journal"]["manifestSha256"] = serde_json::json!("f".repeat(64));
        let bad: Journal = serde_json::from_value(fixture["journal"].clone()).unwrap();
        assert!(bad.validate(&manifest, &digest).is_err());
    }

    #[test]
    fn journal_child_lock_helper() {
        let Some(root) = std::env::var_os("PACER_OTA_JOURNAL_TEST_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let _store = JournalStore::open(&root).unwrap();
        use std::os::unix::fs::OpenOptionsExt;
        let mut pending = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(root.join(".tmp-interrupted-test"))
            .unwrap();
        pending.write_all(b"incomplete-json").unwrap();
        pending.sync_all().unwrap();
        fs::write(root.join("child-locked"), []).unwrap();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    #[test]
    fn owner_death_releases_kernel_lock_and_incomplete_temp_does_not_replace_journal() {
        let (temp, store, original) = initialized();
        drop(store);
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "ota::journal::tests::journal_child_lock_helper",
                "--nocapture",
            ])
            .env("PACER_OTA_JOURNAL_TEST_ROOT", &temp.0)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !temp.0.join("child-locked").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let locked = temp.0.join("child-locked").exists();
        let denied = matches!(JournalStore::open(&temp.0), Err(OtaError::Busy));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(locked);
        assert!(denied);
        let reopened = JournalStore::open(&temp.0).unwrap();
        assert_eq!(reopened.load().unwrap(), original);
        assert!(temp.0.join(".tmp-interrupted-test").exists());
    }
}
