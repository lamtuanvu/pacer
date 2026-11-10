//! Private Core HTTP and stdio bridge clients for native operation effects.
pub mod config_host_sync;
pub mod config_sync;
pub mod core_bridge_sync;
pub mod host_mut_sync;
pub mod host_read_sync;
pub mod msg_write_sync;
pub mod service_effects_sync;
pub mod session_sync;
pub mod setup_effects_sync;
pub mod snapshot_sync;
pub mod status_sync;
pub mod task_clean_sync;
pub mod task_read_sync;
pub mod task_review_sync;
pub mod task_stop_sync;
pub mod task_wait_sync;
