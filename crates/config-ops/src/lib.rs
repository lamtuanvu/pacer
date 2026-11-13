//! Native config and host operation handlers that `pacer-server` assembles into its registry.
pub mod config_get_ops;
pub mod config_params;
pub mod config_set_ops;
pub mod config_writes;
pub mod doctor_ops;
pub mod executor_candidates_ops;
pub mod executor_setup_ops;
pub mod host_check_clean_setup_ops;
pub mod host_mut_ops;
pub mod host_read_ops;
pub mod limits_refresh_ops;
pub mod p8_bridge_ops;
pub mod project_messaging_ops;
pub mod project_strategy_ops;
pub mod repo_ops;
pub mod repo_registry_ops;
pub mod runner_check_ops;
pub mod runner_ops;
pub mod setup_effects;
pub mod setup_init_ops;
pub mod setup_ops;
pub mod strategy_build_ops;
pub mod strategy_load;
pub mod strategy_preview_ops;

pub mod engine_ops;
