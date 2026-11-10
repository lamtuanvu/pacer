//! Native task, session, snapshot and attention operation handlers that `pacer-server` assembles into its registry.
pub mod attention_ops;
pub mod files_search_ops;
pub mod job_ops;
pub mod lifecycle_ops;
pub mod session_context_ops;
pub mod session_ops;
pub mod snapshot_get_ops;
pub mod task_diff_ops;
pub mod task_dismiss_ops;
pub mod task_get_ops;
pub mod task_reads;
pub mod task_review_ops;
pub mod task_send_ops;
pub mod task_stop_ops;
pub mod task_wait_ops;
