//! Native plugin registry shell. The TypeScript host owns plugins until the P4d cutover.

mod admission;
mod authority;
mod broker;
mod config;
mod credentials;
mod hardening;
mod host_lease;
mod js_semantics;
mod manifest;
mod native_bundle;
mod native_duplex;
mod native_hosts;
mod native_http;
mod native_orca;
mod native_process;
mod native_read;
mod native_remote;
mod native_run;
mod native_worktree;
mod native_write;
mod observation_generation;
mod observations;
mod pairing;
mod policy;
mod process;
mod registry;
mod registry_policy;
mod spawn_spec;
mod transfers;

pub use admission::{AdmissionError, CallAdmission};
pub use authority::{
    AuthorityError, CallAuthority, CallResources, CommandResource, HostOperationResource,
    HttpResource, ReadResource, ScopeRoots, WriteResource,
};
pub use broker::{BrokerError, CapabilityBroker, CapabilityEffect};
pub use config::{PluginGrant, PluginsConfig};
pub use credentials::{CredentialBindings, valid_reference};
pub use hardening::{PolicyDetailAccess, PrivatePolicyCaller};
pub use hardening::{
    PolicyPrivacy, allowed_planner_command, js_canonical_json, planner_environment,
};
pub use host_lease::{HostLeaseBroker, HostLeaseError, ProviderSnapshot};
pub use manifest::{ManifestError, ParsedManifest, host_range_accepts, parse_manifest};
pub use native_bundle::{BundleSpec, BundleTicket, NativeBundle};
pub use native_duplex::{DuplexSpec, NativeDuplex};
pub use native_hosts::{HostProvider, NativeHosts};
pub use native_http::NativeHttp;
pub use native_orca::{
    NativeOrca, NativeOrcaLive, NativeOrcaStatus, OrcaAttemptResource, OrcaLiveControl,
    OrcaLiveResource, OrcaSessionOwner,
};
pub use native_process::NativeProcess;
pub use native_read::NativeRead;
pub use native_remote::{NativeRemote, RemoteHost, RemoteIntent, RemoteOperation};
pub use native_run::{NativeRun, RunLaunch, RunLaunchFile};
pub use native_worktree::NativeWorktree;
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
pub use process::{
    MAX_LINE_BYTES, PluginProcess, ProcessError, ProcessFrame, SpawnSpec, frame, parse_frame,
};
pub use registry::{HostMode, PluginState, Registry, RegistryError};
pub use spawn_spec::{SpawnCapture, SpawnMode};
pub use transfers::{TransferError, TransferKind, Transfers};
