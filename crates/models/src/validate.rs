//! The model checks `runnersConfig.set` and `runner.models.set*` run before
//! editing a runner.
use crate::{
    AvailableModels, Listing, ModelSource, closest_models, is_offered, listing, listing_needs_core,
};
use pacer_config::config_writes::{planner, resolve};
use serde_json::{Map, Value};
use std::{collections::HashSet, path::Path};

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

/// An `invalid_input` refusal with its optional hint.
#[derive(Clone, Debug, PartialEq)]
pub struct Refusal {
    pub message: String,
    pub hint: Option<String>,
}

/// The account's provider when it names one, else the account name.
pub fn provider_name<'a>(strategy: &'a Value, runner: &'a Value) -> &'a str {
    let account = runner["account"].as_str().unwrap_or("");
    strategy["accounts"][account]["provider"]
        .as_str()
        .unwrap_or(account)
}

/// Check one model id against a listing: an absent model is refused with the
/// closest offers; an unknown listing warns unless it has no source.
pub fn check_offered(
    list: &AvailableModels,
    provider: &str,
    model: &str,
) -> Result<Option<String>, Refusal> {
    match is_offered(list, model) {
        Some(false) => {
            let suggestions = closest_models(list, model, 3);
            Err(Refusal {
                message: format!("{model} is not offered by {provider}"),
                hint: (!suggestions.is_empty())
                    .then(|| format!("Available: {}", suggestions.join(", "))),
            })
        }
        None if list.source != ModelSource::None => Ok(Some(format!(
            "{model} could not be checked: {}",
            list.note.as_deref().unwrap_or("")
        ))),
        _ => Ok(None),
    }
}

/// The runner id `set_runner` lists models for: a known runner that is not the planner.
fn listed_runner<'a>(strategy: &'a Value, reference: &'a str) -> Option<(&'a Value, &'a str)> {
    let runner = resolve(strategy, reference).filter(|r| !planner(strategy, r))?;
    Some((runner, runner["id"].as_str().unwrap_or(reference)))
}

/// Whether [`validate_runner_model`] could answer `NeedsCore`.
pub fn model_check_needs_core(home: &Path, now: f64, strategy: &Value, reference: &str) -> bool {
    listed_runner(strategy, reference)
        .is_some_and(|(_, id)| listing_needs_core(home, now, strategy, id))
}

/// Check `model` for the runner `reference` names, against the strategy
/// `set_runner` would edit (already migrated; params already validated).
/// An OpenCode runner without a fresh cache runs discovery first.
pub async fn validate_runner_model(
    home: &Path,
    now: f64,
    strategy: &Value,
    reference: &str,
    model: &str,
) -> Validation {
    let Some((runner, id)) = listed_runner(strategy, reference) else {
        return Validation::NotReached;
    };
    let Listing::Known(list) = listing(home, now, strategy, id).await else {
        return Validation::NeedsCore;
    };
    match check_offered(&list, provider_name(strategy, runner), model) {
        Ok(warning) => Validation::Accepted(warning),
        Err(Refusal { message, hint }) => Validation::Refused { message, hint },
    }
}

/// `validateRunnerModels` for declarations `model_declarations` parsed: drops
/// empty strengths (moving the rest last), refuses duplicate ids and a default
/// outside the list, then checks every id, or the default alone when the list
/// is empty. Warnings for unverifiable ids are appended to `warnings`.
pub fn validate_runner_models(
    provider: &str,
    list: &AvailableModels,
    default: &str,
    declarations: &[Value],
    warnings: &mut Vec<String>,
) -> Result<Vec<Value>, Refusal> {
    let refuse = |message: String| Refusal {
        message,
        hint: None,
    };
    let models: Vec<Value> = declarations
        .iter()
        .map(|declaration| {
            let mut model: Map<String, Value> =
                declaration.as_object().cloned().unwrap_or_default();
            let strengths = model.shift_remove("strengths");
            if let Some(strengths) =
                strengths.filter(|s| s.as_array().is_some_and(|s| !s.is_empty()))
            {
                model.insert("strengths".into(), strengths);
            }
            Value::Object(model)
        })
        .collect();
    let ids: Vec<&str> = models
        .iter()
        .map(|m| m["id"].as_str().unwrap_or(""))
        .collect();
    if ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Err(refuse("duplicate models".into()));
    }
    if !ids.is_empty() && !ids.contains(&default) {
        return Err(refuse(format!(
            "default must be one of models: {}",
            ids.join(", ")
        )));
    }
    let checked = if ids.is_empty() { vec![default] } else { ids };
    for model in checked {
        warnings.extend(check_offered(list, provider, model)?);
    }
    Ok(models)
}

/// `modelDeclarationWarnings`: a default outside the allowed list and unrated
/// models warn instead of failing.
pub fn model_declaration_warnings(runner: &Value) -> Vec<String> {
    let id = runner["id"].as_str().unwrap_or("");
    let Some(models) = runner["models"].as_array() else {
        return Vec::new();
    };
    let mut warnings = Vec::new();
    if let Some(model) = runner["model"].as_str()
        && !models.iter().any(|m| m["id"] == model)
    {
        warnings.push(format!(
            "runners.{id}: default model \"{model}\" is not in models"
        ));
    }
    for m in models.iter().filter(|m| m["tier"] == "unknown") {
        let model = m["id"].as_str().unwrap_or("");
        warnings.push(format!(
            "runners.{id}: model \"{model}\" is unrated (tier unknown)"
        ));
    }
    warnings
}
