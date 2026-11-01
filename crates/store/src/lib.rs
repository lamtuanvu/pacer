//! SQLite task adapter shared with the TypeScript task store.
//! No public operation is routed through this library yet.

mod retention;
mod task;
pub use retention::{PruneResult, PrunedTask};
pub use task::{StoreError, TaskFilter, TaskStore, is_task_id, retention_eligible, settled_at};
