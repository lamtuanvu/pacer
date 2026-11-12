//! Native capability brokers for plugin calls: the capability broker, transfers and the native
//! read, process, HTTP, bundle, duplex, hosts, worktree, run, remote and Orca effects.
//! Call authority, credentials, host leases, manifests and native writes stay in
//! `pacer-plugin-host`; they are imported at the crate root so the brokers reach them as `crate::`.

use pacer_plugin_host::{
    AuthorityError, BrokerError, CODEX_REQUEST, CallAuthority, CommandResource, CredentialBindings,
    HostLeaseBroker, HostOperationResource, MAX_LINE_BYTES, NativeWrite, ORCA_PROVIDER,
    OrcaAttemptResource, OrcaLiveResource, ParsedManifest, ProviderSnapshot, ReadResource,
    ScopeRoots, SpawnCapture, SpawnMode, WriteResource, js_semantics, normalize_path, valid_path,
    valid_reference,
};
#[cfg(test)]
use pacer_plugin_host::{CallResources, parse_manifest};

mod broker;
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
mod transfers;

pub use broker::{CapabilityBroker, CapabilityEffect};
pub use native_bundle::{BundleSpec, BundleTicket, NativeBundle};
pub use native_duplex::{DuplexSpec, NativeDuplex};
pub use native_hosts::{HostProvider, NativeHosts};
pub use native_http::NativeHttp;
pub use native_orca::{
    NativeOrca, NativeOrcaLive, NativeOrcaStatus, OrcaLiveControl, OrcaSessionOwner,
};
pub use native_process::NativeProcess;
pub use native_read::NativeRead;
pub use native_remote::{NativeRemote, RemoteHost, RemoteIntent, RemoteOperation};
pub use native_run::{NativeRun, RunLaunch, RunLaunchFile};
pub use native_worktree::NativeWorktree;
pub use transfers::{TransferError, TransferKind, Transfers};
