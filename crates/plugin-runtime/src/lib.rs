//! Process-owner and reverse-bridge shell for the P4d serve cutover.
//!
//! Default `serve` leaves plugin children with TypeScript
//! (`/_internal/plugins`). Library callers may hold live [`PluginProcess`]
//! children under [`ProcessOwner::native_for_tests`]. When
//! [`NATIVE_PLUGIN_HOST_ENABLE_ENV`] or [`HOST_BRIDGE_ENABLE_ENV`] is set,
//! serve may start a [`NativeHostSession`] that claims supervision, binds the
//! reverse bridge with live `_host.plugin.call` / `find` against owned
//! children, and exports [`HOST_SOCKET_ENV`] for the Core child.

mod bridge_listener;
mod host_bridge;
mod owner;
mod serve_host;

pub use bridge_listener::{
    BRIDGE_MAX_LINE_BYTES, BridgeDispatch, BridgeError, BridgeHandle, PeerAuth, ReverseBridge,
    SharedOwner, bridge_methods_are_private, serve_starts_reverse_bridge_by_default,
};
pub use host_bridge::{
    HOST_BRIDGE_ENABLE_ENV, HOST_SOCKET_ENV, HOST_SOCKET_NAME, METHOD_PLUGIN_CALL,
    METHOD_PLUGIN_FIND, dark_bridge_enabled, host_socket_path, prepare_host_run_dir,
};
pub use owner::{OwnerError, Ownership, ProcessOwner};
pub use pacer_plugin_host::{PluginProcess, PluginState, ProcessError, Registry, SpawnSpec};
pub use serve_host::{
    NATIVE_PLUGIN_HOST_ENABLE_ENV, NativeHostError, NativeHostSession, native_plugin_host_enabled,
    native_plugin_host_enabled_from_env,
};
