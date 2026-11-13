//! Process-owner and reverse-bridge shell for the P4d serve cutover.
//!
//! Default `serve` leaves plugin children with TypeScript
//! (`/_internal/plugins`) while [`serve_starts_reverse_bridge_by_default`] is
//! false. Library callers may hold live [`PluginProcess`] children under
//! [`ProcessOwner::native_for_tests`]. Truthy [`NATIVE_PLUGIN_HOST_ENABLE_ENV`]
//! / [`HOST_BRIDGE_ENABLE_ENV`] opt into a [`NativeHostSession`] that claims
//! supervision, binds the reverse bridge with live sealed `_host.plugin.call`
//! / `find` / `stop`, and exports [`HOST_SOCKET_ENV`] and the per-start
//! credential [`HOST_SOCKET_KEY_ENV`] for Core alone ([`OwnerKey`]).
//! Falsy values (`0` / `false` / `no`) are the P4d-5 escape hatch for the
//! future default-on cutover. Flag-on serve routes native plugin RPC through
//! that owner so TypeScript does not also spawn the same plugin id. P4d-6/7
//! installs a [`PluginCapabilitySession`] so the owner answers `capability.*`
//! via `pacer-plugin-capabilities` (log/config.get always; native fs/process/http when
//! Core issues call-scoped resources). Default-on stays off until TypeScript
//! plugin consumers reach the owner over the bridge. A home has one owner
//! lease, serve's live `host.sock`: stdio connections attach to it
//! ([`probe_home_owner`]) or own children on a per-connection socket
//! ([`NativeHostSession::start_connection`]) — ADR 0027. The owner detects
//! crashed children, reports them to the owning door's Core and holds a
//! restart floor ([`crash`]). A lane keeps the observation generation its
//! plugin subscribed under, fed by the owning door's Core, and answers requests
//! sent between calls in its own idle session (`observation`).

mod bridge_auth;
mod bridge_call;
mod bridge_listener;
mod capability;
mod connection_dir;
pub mod crash;
mod executor_attach;
mod host_attach;
mod host_bridge;
mod observation;
mod orca_attach;
mod owner;
mod owner_attach;
mod plugin_log;
mod process;
mod serve_host;
mod worktree_attach;

pub use bridge_auth::{
    AuthError, HOST_KEY_NAME, HOST_SOCKET_KEY_ENV, METHOD_AUTH, OwnerKey, authenticate,
};
pub use bridge_call::{CallFailure, DoorCall, DoorReady, call_door, ready_info};
pub use bridge_listener::{
    BRIDGE_MAX_LINE_BYTES, BridgeDispatch, BridgeError, BridgeHandle, PeerAuth, ReverseBridge,
    SharedOwner, bridge_methods_are_private, serve_starts_reverse_bridge_by_default,
};
pub use capability::{
    CapabilitySessionError, CoreForward, CoreRequest, FixtureHostProvider, LocalHostEffect,
    ObservationBootstrap, OrcaCallContext, PluginCapabilitySession, ProcessContext,
    call_resources_from_value, core_capability, host_snapshots_from_value,
    observation_bootstrap_from_value, orca_context_from_value, session_for_call,
    session_for_call_in, session_from_hello,
};
pub use crash::{CrashReport, StartFailure, crash_message, start_lane};
pub use executor_attach::{ExecutorCallContext, executor_context_from_value};
pub use host_attach::HostAttachSnapshot;
pub use host_bridge::{
    HOST_BRIDGE_ENABLE_ENV, HOST_SOCKET_ENV, HOST_SOCKET_NAME, METHOD_PLUGIN_CALL,
    METHOD_PLUGIN_FIND, METHOD_PLUGIN_SPAWN, METHOD_PLUGIN_STOP, SOCKET_PATH_MAX,
    connection_socket_name, dark_bridge_disabled, dark_bridge_enabled, host_socket_path,
    prepare_host_run_dir, prepare_run_dir,
};
pub use observation::{DoorRefusal, DoorRequest, PUMP_EVERY};
pub use orca_attach::{FixtureOrcaSession, OrcaBridge, SharedOrcaBridge};
pub use owner::{OwnerError, Ownership, PluginLane, ProcessOwner, terminate_lanes};
pub use owner_attach::{
    AttachError, HomeOwner, OwnerTrust, StopOutcome, probe_home_owner, probe_home_owner_as,
    stop_on_owner, stop_on_owner_as,
};
pub use pacer_plugin_capabilities::{CapabilityBroker, NativeHttp, NativeProcess, NativeRead};
pub use pacer_plugin_host::{
    CallAuthority, CallResources, NativeWrite, PluginState, ProcessError, ProviderSnapshot,
    ReadResource, Registry, SpawnSpec, WriteResource, parse_manifest,
};
pub use process::{PluginProcess, TERMINATE_GRACE};
pub use serve_host::{
    HOST_SOCKET_PID_NAME, NATIVE_PLUGIN_HOST_ENABLE_ENV, NativeHostError, NativeHostSession,
    native_plugin_host_enabled, native_plugin_host_enabled_from_env, read_owner_pid,
};
pub use worktree_attach::{WorktreeCallContext, worktree_context_from_value};
