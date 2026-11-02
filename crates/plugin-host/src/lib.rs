//! Native plugin registry shell. The TypeScript host owns plugins until the P4d cutover.

mod admission;
mod broker;
mod config;
mod hardening;
mod manifest;
mod native_http;
mod observation_generation;
mod observations;
mod pairing;
mod policy;
mod process;
mod registry;
mod registry_policy;

pub use admission::{AdmissionError, CallAdmission};
pub use broker::CapabilityBroker;
pub use config::{PluginGrant, PluginsConfig};
pub use hardening::{
    PolicyDetailAccess, PolicyPrivacy, PrivatePolicyCaller, allowed_planner_command,
    js_canonical_json, planner_environment,
};
pub use manifest::{ManifestError, ParsedManifest, host_range_accepts, parse_manifest};
pub use native_http::NativeHttp;
pub use observation_generation::{ObservationCall, ObservationGeneration};
pub use observations::{
    EVENT_QUEUE_BYTES, EVENT_QUEUE_COUNT, EventBatch, EventSubscription, POLICY_EVENT_TYPES,
    ReadContext, ReadOwner, TaskProjection, read_task,
};
pub use pacer_plugin_runtime::*;
pub use pairing::{PairingCandidate, PairingRegistry, handover_pairing, pair};
pub use policy::{
    PolicyCaller, PolicyCancellation, PolicyEntry, PolicyOptions, PolicyReceipt, PolicySnapshot,
    evaluate_policy, evaluate_policy_with,
};
pub use process::{
    MAX_LINE_BYTES, PluginProcess, ProcessError, ProcessFrame, SpawnSpec, frame, parse_frame,
};
pub use registry::{HostMode, PluginState, Registry, RegistryError};
