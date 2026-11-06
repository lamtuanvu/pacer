//! Native operation handlers for configuration, hosts, repositories, machine
//! identity, project messaging, discovery state and setup. `pacer-server`
//! registers and dispatches them; bridge futures arrive as `OpFuture`s.
pub mod config_get_ops;
mod config_params;
pub mod config_writes;
pub mod discovery_ops;
pub mod files_search_ops;
pub mod host_mut_ops;
pub mod host_read_ops;
mod machine_identity;
pub mod machine_ops;
pub mod p8_bridge_ops;
pub mod params;
pub mod project_messaging_ops;
pub mod repo_ops;
pub mod setup_ops;

#[doc(hidden)]
pub use machine_identity::set_identity_platform_for_tests;
