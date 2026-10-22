//! Native update contracts. Serialized records are descriptions, never OS authority.
pub mod adoption;
pub mod bootstrap_identity;
pub mod control;
#[cfg(any(test, feature = "ota-fixture"))]
pub mod fixture_fault;
pub mod fixture_policy;
pub mod helper;
pub mod journal;
pub mod native;
pub(crate) mod platform;
pub(crate) mod platform_fs;
pub mod recovery;
pub(crate) mod recovery_authority;
pub(crate) mod retention;
pub(crate) mod space;
pub mod trust;
pub mod updater;
pub mod wire;

pub use native::{AwakeStamp, ProcessIdentity};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;
use wire::{AdapterCommand, Binding, Candidate, InstallAuthorization, Installation, Ownership};

pub const VERIFY_TIMEOUT_MS: u64 = 120_000;
pub type PlatformFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, OtaError>> + 'a>>;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OtaError {
    Unavailable,
    Invalid,
    Io,
    Busy,
    Identity,
    Timeout,
    Interrupted,
    RecoveryFailed,
}
impl std::fmt::Display for OtaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unavailable => "Native update capability is unavailable",
            Self::Invalid => "Invalid native update record",
            Self::Io => "Native update storage failed",
            Self::Busy => "Native update is already owned",
            Self::Identity => "Native update identity could not be verified",
            Self::Timeout => "Native update verification timed out",
            Self::Interrupted => "Native update was interrupted",
            Self::RecoveryFailed => "Native update recovery requires repair",
        })
    }
}
impl std::error::Error for OtaError {}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryOutcome {
    Committed,
    Restored,
    RecoveryFailed,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Release {
    Old,
    Candidate,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProcessRole {
    Desktop,
    Service,
}

/// Paths here are relative to the provider-derived private transaction directory.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetIdentity {
    pub relative_path: String,
    pub sha256: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryJob {
    pub label: String,
    pub helper: AssetIdentity,
}

/// Immutable bytes persisted before prepared is emitted. Their digest is the wire journalSha256.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedManifest {
    pub schema: u32,
    pub binding: Binding,
    pub target: Installation,
    pub candidate: Candidate,
    pub native_session_id: String,
    pub requester_boot_id: String,
    pub old_desktop: ProcessIdentity,
    pub old_service: ProcessIdentity,
    pub old_service_executable: String,
    pub old_service_version: String,
    pub old_service_protocol: u64,
    pub old_admission_protocol: u64,
    pub old_state_compatible: bool,
    pub artifact: AssetIdentity,
    pub old_bundle_backup: AssetIdentity,
    #[serde(deserialize_with = "required_nullable")]
    pub registration_backup: Option<AssetIdentity>,
    pub recovery_job: RecoveryJob,
}
impl PreparedManifest {
    pub fn managed(&self) -> bool {
        self.target.ownership == Ownership::Managed
    }
    pub fn transaction_id(&self) -> &str {
        self.binding.transaction_id.as_deref().unwrap_or("")
    }
}

/// No Deserialize/public constructor. Only the trusted native provider may create it.
#[derive(Clone, Debug)]
pub struct VerifiedNativeAuthority {
    binding: Binding,
}
impl VerifiedNativeAuthority {
    pub(crate) fn verified(binding: Binding) -> Self {
        Self { binding }
    }
    pub fn binding(&self) -> &Binding {
        &self.binding
    }
}
/// A provider-created preparation whose artifact, target and baseline have been verified.
#[derive(Clone, Debug)]
pub struct VerifiedPreparation {
    manifest: PreparedManifest,
    authority: VerifiedNativeAuthority,
}
impl VerifiedPreparation {
    pub(crate) fn verified(manifest: PreparedManifest, authority: VerifiedNativeAuthority) -> Self {
        Self {
            manifest,
            authority,
        }
    }
    pub fn manifest(&self) -> &PreparedManifest {
        &self.manifest
    }
    pub fn authority(&self) -> &VerifiedNativeAuthority {
        &self.authority
    }
}
pub struct InstallRequest {
    pub command: AdapterCommand,
    pub authority: VerifiedNativeAuthority,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerificationPurpose {
    Prepare,
    Authorize,
    Recover,
}
pub trait TransactionLocks {}

/// Closed effects only; never arbitrary commands or user-selected target paths.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum PlatformAction {
    StopUnreadyCandidateService {
        launch_id: String,
    },
    PrepareBackup,
    ArmRecovery,
    SuppressLifecycle,
    Stop {
        role: ProcessRole,
        process: ProcessIdentity,
    },
    InstallCandidate,
    SwitchRegistration,
    Launch {
        role: ProcessRole,
        release: Release,
        launch_id: String,
    },
    RestoreBundle,
    RestoreRegistration,
    ReleaseReservation,
    RetireRecovery,
    PruneSupersededBackup,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchEvidence {
    pub role: ProcessRole,
    pub release: Release,
    pub launch_id: String,
    pub process: ProcessIdentity,
    pub native_session_id: String,
    pub version: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ActionEvidence {
    Complete,
    Launched { launch: LaunchEvidence },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActionObservation {
    NotStarted,
    Completed(ActionEvidence),
    Ambiguous,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BundleObservation {
    Old,
    Candidate,
    Missing,
    Unknown,
}
#[derive(Clone, Debug)]
pub struct Observation {
    /// Closed managed candidate service launch with verified job/gate but no native receipt.
    pub unready_candidate_service: Option<String>,
    pub bundle: BundleObservation,
    pub reservation_held: bool,
    pub recovery_job_armed: bool,
    /// Only cryptographically/OS-bound transaction launches, not guessed PIDs.
    pub candidate_processes: Vec<LaunchEvidence>,
    /// Fresh authenticated maintenance context for the original durable managed reservation.
    pub recovery_service: Option<ProcessIdentity>,
}
#[derive(Clone, Debug)]
pub struct ExpectedReadiness {
    pub installation_id: String,
    pub transaction_id: String,
    pub release: Release,
    pub desktop: LaunchEvidence,
    pub service: ProcessIdentity,
    pub service_version: String,
    pub protocol: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessProof {
    pub installation_id: String,
    pub transaction_id: String,
    pub desktop: ProcessIdentity,
    pub native_session_id: String,
    pub desktop_version: String,
    pub service: ProcessIdentity,
    pub service_version: String,
    pub protocol: u64,
    pub desktop_signed_in: bool,
    pub valid_state_read: bool,
}
#[derive(Clone, Debug)]
pub enum ReadinessObservation {
    Pending,
    Ready(ReadinessProof),
    Failed,
}

/// All identity/side-effect methods reverify actual OS state. Futures may run on
/// the Wry main-thread/local executor. The engine never blocks that event loop.
pub trait UpdatePlatform {
    fn awake_now(&self) -> Result<AwakeStamp, OtaError>;
    fn acquire_transaction_locks<'a>(
        &'a self,
        target: &'a Installation,
    ) -> PlatformFuture<'a, Box<dyn TransactionLocks>>;
    fn verify_preconditions<'a>(
        &'a self,
        request: &'a InstallRequest,
    ) -> PlatformFuture<'a, VerifiedPreparation>;
    fn reverify<'a>(
        &'a self,
        manifest: &'a PreparedManifest,
        purpose: VerificationPurpose,
    ) -> PlatformFuture<'a, VerifiedNativeAuthority>;
    fn observe<'a>(&'a self, manifest: &'a PreparedManifest) -> PlatformFuture<'a, Observation>;
    fn inspect_action<'a>(
        &'a self,
        manifest: &'a PreparedManifest,
        action: &'a PlatformAction,
    ) -> PlatformFuture<'a, ActionObservation>;
    fn perform<'a>(
        &'a self,
        manifest: &'a PreparedManifest,
        action: &'a PlatformAction,
        authority: &'a VerifiedNativeAuthority,
    ) -> PlatformFuture<'a, ActionEvidence>;
    fn poll_readiness<'a>(
        &'a self,
        expected: &'a ExpectedReadiness,
    ) -> PlatformFuture<'a, ReadinessObservation>;
    fn wait_for_observation<'a>(&'a self) -> PlatformFuture<'a, ()>;
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedReceipt {
    pub reservation_id: String,
    pub journal_sha256: String,
}

// InstallAuthorization remains the accepted wire continuation. A recover command
// has its own transport binding and never changes the stored authorization.
pub type Authorization = InstallAuthorization;

/// Each observation of the service is a fresh authenticated connection, and the
/// service verifies its own signature and every pacer process synchronously for
/// it. Polling faster starves the service's event loop, so its health probe fails
/// and clients drop. Deadlines are measured separately and are unaffected.
pub(crate) const OBSERVATION_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

pub(crate) fn required_nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}
