//! Process-owner and reverse-bridge shell for the P4d serve cutover.
//!
//! Production `serve` still leaves plugin children with TypeScript
//! (`/_internal/plugins`). Library callers may hold live [`PluginProcess`]
//! children under [`ProcessOwner::native_for_tests`] without setting
//! `PACER_HOST_SOCKET` or flipping serve ownership.

mod host_bridge;
mod owner;

pub use host_bridge::{
    HOST_SOCKET_ENV, HOST_SOCKET_NAME, METHOD_PLUGIN_CALL, METHOD_PLUGIN_FIND, host_socket_path,
    prepare_host_run_dir,
};
pub use owner::{OwnerError, Ownership, ProcessOwner};
pub use pacer_plugin_host::{PluginProcess, PluginState, ProcessError, Registry, SpawnSpec};
