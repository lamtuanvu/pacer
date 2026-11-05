//! Process-owner and reverse-bridge shell for the P4d serve cutover.
//!
//! Production `serve` still leaves plugin children with TypeScript
//! (`/_internal/plugins`). Library callers may hold live [`PluginProcess`]
//! children under [`ProcessOwner::native_for_tests`] and may bind a dark
//! [`ReverseBridge`] without setting `PACER_HOST_SOCKET` unless
//! [`HOST_BRIDGE_ENABLE_ENV`] is explicitly enabled. Default serve must not
//! start the bridge or flip [`ProcessOwner::claim_native_supervision`].

mod bridge_listener;
mod host_bridge;
mod owner;

pub use bridge_listener::{
    BRIDGE_MAX_LINE_BYTES, BridgeError, BridgeHandle, PeerAuth, ReverseBridge,
    bridge_methods_are_private, serve_starts_reverse_bridge_by_default,
};
pub use host_bridge::{
    HOST_BRIDGE_ENABLE_ENV, HOST_SOCKET_ENV, HOST_SOCKET_NAME, METHOD_PLUGIN_CALL,
    METHOD_PLUGIN_FIND, dark_bridge_enabled, host_socket_path, prepare_host_run_dir,
};
pub use owner::{OwnerError, Ownership, ProcessOwner};
pub use pacer_plugin_host::{PluginProcess, PluginState, ProcessError, Registry, SpawnSpec};
