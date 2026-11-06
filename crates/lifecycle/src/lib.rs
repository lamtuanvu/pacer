//! Task admission contracts, safe store-only lifecycle ops, and P6e decisions.
//! Runner/_run-dependent task ops stay forwarded until P6b/P6c cutover.
mod brief;
mod capacity;
mod dependencies;
mod json;
mod lineage;
mod request_review;
mod schema;
mod semantics;

pub use brief::{AdmissionError, ExecutorResolution, ValidationContext};
pub use capacity::{
    SlotLimits, holds_slot, queue_capacity, queue_capacity_for, slot_limit, slot_use,
};

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
pub use request_review::{RequestReviewError, request_review};

// Unactivated P6e decisions take snapshots and effect results; these modules
// perform no filesystem, process or plugin work.
pub mod attention;
pub mod clients;
mod diagnostics;
pub mod hosts;
pub mod jobs;
mod js;
pub mod notify;
pub mod runner_check;
pub use js::Text as JsText;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct Error {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}
impl Error {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            hint: None,
        }
    }
    pub fn value(&self) -> Value {
        json!({"error":self})
    }
}
pub(crate) fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub(crate) fn n(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}
pub(crate) fn a(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub(crate) fn truth(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(_) => n(v) != 0.0,
        _ => true,
    }
}
pub(crate) fn now(c: &Value) -> f64 {
    c["now"].as_f64().unwrap_or(100.0)
}
pub(crate) fn event(events: &mut Vec<Value>, kind: &str, name: &str, detail: Option<&str>) {
    let mut e = json!({"type":kind,"name":name});
    if let Some(d) = detail {
        e["detail"] = d.into();
    }
    events.push(e);
}
