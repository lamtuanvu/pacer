//! Native plugin registry, call authority and plugin frame codec.
//! `pacer-plugin-capabilities` owns the native capability brokers;
//! `pacer-plugin-runtime` owns the plugin child transport and process owner.

mod admission;
mod authority;
pub mod bun_glob;
mod config;
mod credentials;
mod error;
mod hardening;
mod host_lease;
pub mod js_semantics;
mod manifest;
mod native_write;
mod observation_generation;
mod observations;
mod pairing;
mod policy;
mod process;
mod registry;
mod registry_policy;
mod spawn_spec;
mod work_lease;

pub use admission::{AdmissionError, CallAdmission};
pub use authority::{
    AuthorityError, CallAuthority, CallResources, CommandResource, ExecutorClaimResource,
    HostOperationResource, HttpResource, ORCA_PROVIDER, OrcaAttemptResource, OrcaLiveResource,
    ReadResource, ScopeRoots, WorktreeResource, WriteResource, normalize_path, valid_path,
};
pub use config::{PluginGrant, PluginsConfig};
pub use credentials::{CredentialBindings, valid_reference};
pub use error::BrokerError;
pub use hardening::{PolicyDetailAccess, PrivatePolicyCaller};
pub use hardening::{
    PolicyPrivacy, allowed_planner_command, js_canonical_json, planner_environment,
};
pub use host_lease::{HostLeaseBroker, HostLeaseError, ProviderSnapshot};
pub use manifest::{ManifestError, ParsedManifest, host_range_accepts, parse_manifest};
pub use native_write::NativeWrite;
pub use observation_generation::{ObservationCall, ObservationGeneration};
pub use observations::{
    EVENT_QUEUE_BYTES, EVENT_QUEUE_COUNT, EventBatch, EventSubscription, POLICY_EVENT_TYPES,
    ReadContext, ReadOwner, TaskProjection, read_task,
};
pub use pairing::{PairingCandidate, PairingRegistry, handover_pairing, pair};
pub use policy::{
    PolicyCaller, PolicyCancellation, PolicyEntry, PolicyOptions, PolicyReceipt, PolicySnapshot,
    evaluate_policy, evaluate_policy_with,
};
pub use process::{MAX_LINE_BYTES, ProcessError, ProcessFrame, SpawnSpec, frame, parse_frame};
pub use registry::{HostMode, PluginState, Registry, RegistryError};
pub use spawn_spec::{CODEX_REQUEST, SpawnCapture, SpawnMode};
pub use work_lease::{Blocker, BlockerKind, WorkLease, begin_blocker};
