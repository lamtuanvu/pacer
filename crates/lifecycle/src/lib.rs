//! Task admission contracts. No served operation calls this crate yet.
mod brief;
mod capacity;
mod dependencies;
mod lineage;
mod schema;

pub use brief::{
    AdmissionError, ExecutorResolution, ValidationContext, parse_delegate_brief, validate_input,
};
pub use capacity::{SlotLimits, queue_capacity, slot_use};
pub use dependencies::pending_dependencies;
pub use lineage::work_node;
mod drain;
mod prepared;
mod state;
pub use drain::{DrainOptions, DrainRoute, RouteAdmission, queue_preflight};
pub use prepared::{AdmissionLifetime, PreparedAdmission};
pub use state::AdmissionState;
mod strategy;
pub use strategy::{project_selection, resolve_runner, validate_current, validate_strategy_input};

mod mutation;
pub use mutation::MutationError;
mod projects;
pub use projects::{read_project_strategies, validate_project_strategies};
