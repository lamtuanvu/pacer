//! The dispatch decision library: model inventory, candidates, the decision hash,
//! tier choice and the ladder engine (`src/dispatch/*.ts`), plus the read-only task
//! store view and the status-cache observation adapter that previews read, learned
//! fit, reason codes and the route explanation builders (`src/core/dispatch-explain*.ts`).
//!
//! Everything here is pure or read-only. Admission, reservations and launches stay
//! with the operation handlers. Records, candidates, observations, requests and
//! proposals are JSON objects in the key order TypeScript produces, because that
//! order reaches replies byte for byte.
//!
//! Inputs follow the TypeScript types: a strategy as `load_strategy` returns it
//! (its `dispatch` section already carries the schema defaults), observations that
//! passed [`parse_observation`], and requests built from those.
mod candidates;
mod explain;
mod hash;
mod inventory;
mod js;
mod ladder;
mod learning;
mod observation;
mod readonly;
mod reasons;
mod status_adapter;
mod tier_select;

pub use candidates::{Built, build_candidates, meets_requirements, tier_rank};
pub use explain::{Explain, LadderPreview, Ranked, build_explanation, explain_ranked};
pub use hash::decision_hash;
pub use inventory::{is_exact, model_inventory};
pub use js::Object;
pub use ladder::evaluate_ladder;
pub use learning::apply_learned_fit;
pub use observation::{METHODS, parse_observation, stored_observations};
pub use readonly::{ReadOnlyStore, Reservation};
pub use reasons::{exclusion_reason, reason};
pub use status_adapter::{STATUS_SOURCE, status_observations};
pub use tier_select::{
    SelectOptions, TierChoice, TierReason, Tiered, select_model, target_tier, tier_buckets,
};

#[cfg(test)]
mod tests;
