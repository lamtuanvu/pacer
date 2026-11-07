//! Process-owner and reverse-bridge shell for the P4d serve cutover.
//!
//! Default `serve` leaves plugin children with TypeScript
//! (`/_internal/plugins`) while [`serve_starts_reverse_bridge_by_default`] is
//! false. Library callers may hold live [`PluginProcess`] children under
//! [`ProcessOwner::native_for_tests`]. Truthy [`NATIVE_PLUGIN_HOST_ENABLE_ENV`]
//! / [`HOST_BRIDGE_ENABLE_ENV`] opt into a [`NativeHostSession`] that claims
//! supervision, binds the reverse bridge with live `_host.plugin.call` /
//! `find` / `spawn` / `stop`, and exports [`HOST_SOCKET_ENV`] for Core.
//! Falsy values (`0` / `false` / `no`) are the P4d-5 escape hatch for the
//! future default-on cutover. Flag-on serve routes native plugin RPC through
//! that owner so TypeScript does not also spawn the same plugin id. P4d-6/7
//! installs a [`PluginCapabilitySession`] so the owner answers `capability.*`
//! via `pacer-plugin-host` (log/config.get always; native fs/process/http when
//! Core issues call-scoped resources). Default-on stays off until TypeScript
//! plugin consumers reach the owner over the bridge.

mod bridge_listener;
mod capability;
mod executor_attach;
mod host_attach;
mod host_bridge;
mod orca_attach;
mod owner;
mod serve_host;
mod worktree_attach;

pub use bridge_listener::{
    BRIDGE_MAX_LINE_BYTES, BridgeDispatch, BridgeError, BridgeHandle, PeerAuth, ReverseBridge,
    SharedOwner, bridge_methods_are_private, serve_starts_reverse_bridge_by_default,
};
pub use capability::{
    CapabilitySessionError, FixtureHostProvider, LocalHostEffect, ObservationBootstrap,
    OrcaCallContext, PluginCapabilitySession, call_resources_from_value, host_snapshots_from_value,
    observation_bootstrap_from_value, orca_context_from_value, session_for_call,
    session_from_hello,
};
pub use executor_attach::{ExecutorCallContext, executor_context_from_value};
pub use host_attach::HostAttachSnapshot;
pub use host_bridge::{
    HOST_BRIDGE_ENABLE_ENV, HOST_SOCKET_ENV, HOST_SOCKET_NAME, METHOD_PLUGIN_CALL,
    METHOD_PLUGIN_FIND, METHOD_PLUGIN_SPAWN, METHOD_PLUGIN_STOP, dark_bridge_disabled,
    dark_bridge_enabled, host_socket_path, prepare_host_run_dir,
};
pub use orca_attach::{FixtureOrcaSession, OrcaBridge, SharedOrcaBridge};
pub use owner::{OwnerError, Ownership, ProcessOwner};
pub use pacer_plugin_host::{
    CallAuthority, CallResources, CapabilityBroker, NativeHttp, NativeProcess, NativeRead,
    NativeWrite, PluginProcess, PluginState, ProcessError, ProviderSnapshot, ReadResource,
    Registry, SpawnSpec, WriteResource, parse_manifest,
};
pub use serve_host::{
    NATIVE_PLUGIN_HOST_ENABLE_ENV, NativeHostError, NativeHostSession, native_plugin_host_enabled,
    native_plugin_host_enabled_from_env,
};
pub use worktree_attach::{WorktreeCallContext, worktree_context_from_value};
