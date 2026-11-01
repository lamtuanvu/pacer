//! Native plugin registry shell. The TypeScript host owns plugins until the P4d cutover.

mod admission;
mod authority;
mod broker;
mod config;
mod host_lease;
mod manifest;
mod native_read;
mod process;
mod registry;
mod transfers;

pub use admission::{AdmissionError, CallAdmission};
pub use authority::{
    AuthorityError, CallAuthority, CallResources, CommandResource, HostOperationResource,
    HttpResource, ReadResource, ScopeRoots, WriteResource,
};
pub use broker::{BrokerError, CapabilityBroker, CapabilityEffect};
pub use config::{PluginGrant, PluginsConfig};
pub use host_lease::{HostLeaseBroker, HostLeaseError, ProviderSnapshot};
pub use manifest::{ManifestError, ParsedManifest, host_range_accepts, parse_manifest};
pub use native_read::NativeRead;
pub use process::{
    MAX_LINE_BYTES, PluginProcess, ProcessError, ProcessFrame, SpawnSpec, frame, parse_frame,
};
pub use registry::{HostMode, PluginState, Registry, RegistryError};
pub use transfers::{TransferError, TransferKind, Transfers};
