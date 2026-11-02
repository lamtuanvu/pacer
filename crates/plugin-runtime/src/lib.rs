//! Native host capability effects, isolated from registry and plugin RPC admission.
pub mod authority;
pub mod orca_policy;
mod orca_prompt;
pub mod work_lease;
pub use work_lease::WorkLease;
pub mod orca_attempt;
pub use orca_attempt::{
    OrcaAttempt, OrcaAttemptSpec, OrcaLiveOwner, OrcaPlacement, checked_worktree,
};
pub mod credentials;
pub mod host_lease;
pub use pacer_plugin_wire::js_semantics;
pub mod native_bundle;
pub mod native_command;
pub mod native_duplex;
pub mod native_git;
pub mod native_hosts;
pub mod native_orca;
pub mod native_process;
pub mod native_read;
pub mod native_remote;
pub mod native_run;
pub mod native_ssh;
pub mod native_worktree;
pub mod native_write;
pub mod remote_transport;
pub mod spawn_spec;
pub use authority::{
    AuthorityError, CallAuthority, CallResources, CommandResource, HostOperationResource,
    HttpResource, ReadResource, ScopeRoots, WriteResource,
};
pub use credentials::{CredentialBindings, valid_reference};
pub use host_lease::{HostLeaseBroker, HostLeaseError, ProviderSnapshot};
pub use native_bundle::{BundleSpec, BundleTicket, NativeBundle};
pub use native_duplex::{DuplexSpec, NativeDuplex};
pub use native_git::{NativeGit, VerifiedBundle, remote_preflight};
pub use native_hosts::{HostProvider, NativeHosts};
pub use native_orca::{
    NativeOrca, NativeOrcaLive, NativeOrcaStatus, OrcaAttemptResource, OrcaLiveControl,
    OrcaLiveResource, OrcaSessionOwner,
};
pub use native_process::NativeProcess;
pub use native_read::NativeRead;
pub use native_remote::{NativeRemote, RemoteHost, RemoteIntent, RemoteOperation};
pub use native_run::{NativeRun, RunLaunch, RunLaunchFile};
pub use native_ssh::{NativeSsh, SshConfig};
pub use native_worktree::NativeWorktree;
pub use native_write::NativeWrite;
pub use pacer_plugin_wire as transfers;
pub use pacer_plugin_wire::{Utf16String, WireReply};
pub use remote_transport::RemoteTransport;
use serde_json::Value;
pub use spawn_spec::{SpawnCapture, SpawnMode};
use std::future::Future;
use thiserror::Error;
pub use transfers::{TransferError, TransferKind, Transfers};
#[derive(Clone, Debug, Error)]
pub enum BrokerError {
    #[error("Policy hash key cannot be accessed safely")]
    PolicyKey,
    #[error("{0}")]
    PolicyVeto(String),
    #[error(transparent)]
    Authority(#[from] AuthorityError),
    #[error("invalid capability parameters: {0}")]
    Invalid(&'static str),
    #[error("capability deadline passed")]
    Timeout,
    #[error("effect failed: {0}")]
    Effect(String),
    #[error("host lease failed: {0}")]
    HostLease(String),
}

/// Effects receive already admitted arguments. Implementations must retain their
/// own filesystem descriptor, executable identity and network redirect checks.
pub trait CapabilityEffect {
    /// Settle host-owned sessions and opaque stages after call revocation. The
    /// broker gives cleanup a fresh bounded budget, independent of admission.
    fn retire(&mut self) -> impl Future<Output = Result<(), BrokerError>> {
        async { Ok(()) }
    }
    /// Only a host-issued owner may admit lifecycle methods without a wire resource.
    fn owns_lifecycle(&self, _method: &str, _plugin_id: &str, _scopes: &[String]) -> bool {
        false
    }
    fn native_host_sessions(&self) -> bool {
        false
    }
    fn call(
        &mut self,
        method: &str,
        params: Value,
    ) -> impl Future<Output = Result<Value, BrokerError>>;
    /// Lossless wire path for JS UTF-16 slices. Scalar-only effects use the default.
    fn call_wire(
        &mut self,
        method: &str,
        params: Value,
    ) -> impl Future<Output = Result<WireReply, BrokerError>> {
        async { self.call(method, params).await.map(WireReply::new) }
    }
    fn provider_snapshot(&self, _alias: &str) -> Option<ProviderSnapshot> {
        None
    }
}
