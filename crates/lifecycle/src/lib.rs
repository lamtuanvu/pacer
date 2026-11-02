//! Task admission contracts. No served operation calls this crate yet.
mod brief;
mod capacity;
mod dependencies;
mod json;
mod lineage;
mod schema;
mod semantics;

pub use brief::{AdmissionError, ExecutorResolution, ValidationContext};
pub use capacity::{SlotLimits, queue_capacity, slot_use};

pub use json::{AdmissionString, AdmissionValue};

/// Existing UTF-8 callers retain the serde_json API. JSON callers should use
/// `parse_delegate_brief_json` to preserve unpaired UTF-16 code units.
pub fn parse_delegate_brief(
    raw: &serde_json::Value,
    default_repo: &str,
) -> Result<serde_json::Value, AdmissionError> {
    let parsed = brief::parse_delegate_value(&raw.clone().into(), default_repo)?;
    serde_json::from_str(&parsed.to_json()).map_err(|e| AdmissionError(e.to_string()))
}

pub fn parse_delegate_brief_json(
    raw: &str,
    default_repo: &str,
) -> Result<AdmissionValue, AdmissionError> {
    brief::parse_delegate_value(&json::Value::parse(raw)?, default_repo).map(AdmissionValue)
}

pub fn validate_input(
    input: &serde_json::Value,
    repo_validated: bool,
    context: &ValidationContext<'_>,
) -> Vec<String> {
    brief::validate_value(&input.clone().into(), repo_validated, context)
        .into_iter()
        .map(|s| s.to_string())
        .collect()
}

pub fn validate_input_json(
    input: &str,
    repo_validated: bool,
    context: &ValidationContext<'_>,
) -> Result<Vec<AdmissionString>, AdmissionError> {
    Ok(brief::validate_value(
        &json::Value::parse(input)?,
        repo_validated,
        context,
    ))
}

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
