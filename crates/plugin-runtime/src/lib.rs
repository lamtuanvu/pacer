//! Unactivated process-owner and reverse-bridge shell for the P4d serve cutover.
//!
//! Production `serve` still leaves plugin children with TypeScript
//! (`/_internal/plugins`). This crate names the ownership gate and the private
//! `PACER_HOST_SOCKET` contract so later slices can wire them without inventing
//! paths or flipping ownership early.

mod host_bridge;
mod owner;

pub use host_bridge::{
    HOST_SOCKET_ENV, HOST_SOCKET_NAME, METHOD_PLUGIN_CALL, METHOD_PLUGIN_FIND, host_socket_path,
    prepare_host_run_dir,
};
pub use owner::{OwnerError, Ownership, ProcessOwner};
