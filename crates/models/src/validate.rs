//! The model check `runnersConfig.set` runs before editing a runner.
use crate::{Listing, ModelSource, available_models, closest_models, is_offered};
use pacer_config::config_writes::{planner, resolve};
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Debug, PartialEq)]
pub enum Validation {
    /// The runner is unknown or is the planner: `set_runner` refuses it first.
    NotReached,
    /// The model may be set; an unverifiable one carries its warning.
    Accepted(Option<String>),
    /// `invalid_input` with up to three close offered ids as the hint.
    Refused {
        message: String,
        hint: Option<String>,
    },
    /// Only TypeScript can list these models: OpenCode discovery or an odd cache.
    NeedsCore,
}

/// Check `model` for the runner `reference` names, against the strategy
/// `set_runner` would edit (already migrated; params already validated).
pub fn validate_runner_model(
    home: &Path,
    now: f64,
    strategy: &Value,
    reference: &str,
    model: &str,
) -> Validation {
    let Some(runner) = resolve(strategy, reference).filter(|r| !planner(strategy, r)) else {
        return Validation::NotReached;
    };
    let id = runner["id"].as_str().unwrap_or(reference);
    let Listing::Known(list) = available_models(home, now, strategy, id) else {
        return Validation::NeedsCore;
    };
    match is_offered(&list, model) {
        Some(false) => {
            let account = runner["account"].as_str().unwrap_or("");
            let provider = strategy["accounts"][account]["provider"]
                .as_str()
                .unwrap_or(account);
            let suggestions = closest_models(&list, model, 3);
            Validation::Refused {
                message: format!("{model} is not offered by {provider}"),
                hint: (!suggestions.is_empty())
                    .then(|| format!("Available: {}", suggestions.join(", "))),
            }
        }
        None if list.source != ModelSource::None => Validation::Accepted(Some(format!(
            "{model} could not be checked: {}",
            list.note.as_deref().unwrap_or("")
        ))),
        _ => Validation::Accepted(None),
    }
}
