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
//! that owner so TypeScript does not also spawn the same plugin id.

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
    METHOD_PLUGIN_FIND, METHOD_PLUGIN_SPAWN, METHOD_PLUGIN_STOP, dark_bridge_disabled,
    dark_bridge_enabled, host_socket_path, prepare_host_run_dir,
};
pub use owner::{OwnerError, Ownership, ProcessOwner};
pub use pacer_plugin_host::{PluginProcess, PluginState, ProcessError, Registry, SpawnSpec};
pub use serve_host::{
    NATIVE_PLUGIN_HOST_ENABLE_ENV, NativeHostError, NativeHostSession, native_plugin_host_enabled,
    native_plugin_host_enabled_from_env,
};
