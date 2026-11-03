//! Pinned native capability resources, without task-attempt or registry ownership.
pub mod authority;
pub mod credentials;
pub mod host_lease;
pub mod native_bundle;
pub mod native_command;
pub mod native_duplex;
pub mod native_hosts;
pub mod native_process;
pub mod native_read;
pub mod native_ssh;
pub mod native_write;
pub mod spawn_spec;
mod store_interop;
pub mod work_lease;
pub use authority::{
    AuthorityError, CallAuthority, CallResources, CommandResource, HostOperationResource,
    HttpResource, ORCA_PROVIDER, OrcaAttemptResource, OrcaLiveResource, ReadResource, ScopeRoots,
    WriteResource,
};
pub use credentials::{CredentialBindings, valid_reference};
pub use host_lease::{HostLeaseBroker, HostLeaseError, ProviderSnapshot};
pub use native_bundle::{BundleSpec, BundleTicket, NativeBundle};
pub use native_duplex::{DuplexSpec, NativeDuplex};
pub use native_hosts::{HostProvider, NativeHosts};
pub use native_process::NativeProcess;
pub use native_read::NativeRead;
pub use native_ssh::{NativeSsh, SshConfig};
pub use native_write::NativeWrite;
pub use pacer_plugin_wire as transfers;
pub use pacer_plugin_wire::js_semantics;
pub use pacer_plugin_wire::{Utf16String, WireReply};
use serde_json::Value;
pub use spawn_spec::{SpawnCapture, SpawnMode};
use std::future::Future;
use thiserror::Error;
pub use transfers::{TransferError, TransferKind, Transfers};
pub use work_lease::{Blocker, BlockerKind, WorkLease};
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
