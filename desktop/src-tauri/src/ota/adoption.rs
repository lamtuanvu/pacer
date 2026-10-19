//! Candidate-free service adoption. This engine cannot replace an application bundle.
use super::{
    control::{AdoptionBranch, AdoptionReadinessProof, AdoptionRequestReceipt, AdoptionSource},
    *,
};
pub mod journal;
pub mod recovery;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdoptionManifest {
    pub schema: u32,
    pub transaction_kind: String,
    pub binding: Binding,
    pub source: AdoptionSource,
    pub request: AdoptionRequestReceipt,
    pub expected_new_installation_id: String,
    pub managed_launch_id: String,
    pub original_launch_id: String,
    pub old_registration: AssetIdentity,
    pub new_registration: AssetIdentity,
    pub recovery_job: RecoveryJob,
}
impl AdoptionManifest {
    pub fn transaction_id(&self) -> &str {
        self.binding.transaction_id.as_deref().unwrap_or("")
    }
    pub fn launch_id(&self, branch: AdoptionBranch) -> &str {
        match branch {
            AdoptionBranch::Managed => &self.managed_launch_id,
            AdoptionBranch::Original => &self.original_launch_id,
        }
    }
    pub fn resulting_id(&self, branch: AdoptionBranch) -> &str {
        match branch {
            AdoptionBranch::Managed => &self.expected_new_installation_id,
            AdoptionBranch::Original => &self.source.target.id,
        }
    }
    pub fn version(&self, branch: AdoptionBranch) -> &str {
        match branch {
            AdoptionBranch::Managed => &self.source.target.version,
            AdoptionBranch::Original => &self.source.service_version,
        }
    }
}
pub struct AdoptionRequest {
    pub binding: Binding,
    pub target: Installation,
    pub authority: VerifiedNativeAuthority,
}
pub struct VerifiedAdoptionPreparation {
    pub(crate) manifest: AdoptionManifest,
    pub(crate) authority: VerifiedNativeAuthority,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AdoptionAction {
    LaunchRecoveryDesktop {
        launch_id: String,
    },
    PrepareRecoveryReconnect {
        capability: RecoveryReconnectCapability,
    },
    BackupRegistration,
    ArmRecovery,
    PrepareReconnect,
    SuppressLifecycle,
    StopService {
        process: ProcessIdentity,
    },
    SwitchRegistration {
        branch: AdoptionBranch,
    },
    LaunchService {
        branch: AdoptionBranch,
        launch_id: String,
    },
    ReleaseReservation,
    RetireRecovery,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AdoptionEvidence {
    DesktopSpawned {
        process: ProcessIdentity,
    },
    Complete,
    Launched {
        branch: AdoptionBranch,
        launch: LaunchEvidence,
    },
}
pub enum AdoptionActionObservation {
    NotStarted,
    Completed(AdoptionEvidence),
    Ambiguous,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegistrationObservation {
    Original,
    Managed,
    Unknown,
}
pub struct AdoptionObservation {
    pub registration: RegistrationObservation,
    pub reservation_held: bool,
    pub recovery_job_armed: bool,
    /// Fresh authenticated process proof only. Never a PID inferred from a port.
    pub service: Option<ProcessIdentity>,
}
pub enum AdoptionReadiness {
    Pending,
    Ready(AdoptionReadinessProof),
    Failed,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReconnectCapability {
    pub desktop: ProcessIdentity,
    pub original_launch_id: String,
    pub boot_id: String,
    pub native_session_id: String,
}
/// Constructed only after a fresh native peer and service incarnation are verified.
pub struct VerifiedRecoveryDesktop {
    pub(crate) desktop: ProcessIdentity,
    pub(crate) native_session_id: String,
    pub(crate) service: ProcessIdentity,
}
pub trait AdoptionPlatform {
    fn recovery_desktop<'a>(
        &'a self,
        _manifest: &'a AdoptionManifest,
        _launch: &'a LaunchEvidence,
    ) -> PlatformFuture<'a, Option<VerifiedRecoveryDesktop>> {
        Box::pin(async { Err(OtaError::Unavailable) })
    }
    fn awake_now(&self) -> Result<AwakeStamp, OtaError>;
    fn acquire_transaction_locks<'a>(
        &'a self,
        target: &'a Installation,
    ) -> PlatformFuture<'a, Box<dyn TransactionLocks>>;
    fn verify_preconditions<'a>(
        &'a self,
        request: &'a AdoptionRequest,
    ) -> PlatformFuture<'a, VerifiedAdoptionPreparation>;
    fn reverify<'a>(
        &'a self,
        manifest: &'a AdoptionManifest,
        purpose: VerificationPurpose,
    ) -> PlatformFuture<'a, VerifiedNativeAuthority>;
    fn observe<'a>(
        &'a self,
        manifest: &'a AdoptionManifest,
    ) -> PlatformFuture<'a, AdoptionObservation>;
    fn inspect_action<'a>(
        &'a self,
        manifest: &'a AdoptionManifest,
        action: &'a AdoptionAction,
    ) -> PlatformFuture<'a, AdoptionActionObservation>;
    fn perform<'a>(
        &'a self,
        manifest: &'a AdoptionManifest,
        action: &'a AdoptionAction,
        authority: &'a VerifiedNativeAuthority,
    ) -> PlatformFuture<'a, AdoptionEvidence>;
    fn poll_readiness<'a>(
        &'a self,
        manifest: &'a AdoptionManifest,
        branch: AdoptionBranch,
        launch: &'a LaunchEvidence,
    ) -> PlatformFuture<'a, AdoptionReadiness>;
    fn wait_for_observation<'a>(&'a self) -> PlatformFuture<'a, ()>;
}
