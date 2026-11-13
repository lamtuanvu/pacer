//! Runner model listings from `src/models/available.ts`, the `runner.set`
//! model check from `src/core/runners-config.ts`, and the declaration schema
//! and checks `runner.models.set*` share (`src/core/runner-models.ts`).
//! Runners without a listing source, endpoint connection accounts (models
//! declared in the strategy) and the OpenCode listing cache are read from
//! files. An OpenCode provider without a fresh cache is discovered by running
//! `opencode models` with the core child's environment and working directory
//! (`discover`), which the front door records; without that record, and for
//! cache or catalog shapes the native reply cannot reproduce, TypeScript
//! still answers.
mod available;
mod catalog;
mod closest;
pub mod declarations;
mod discover;
mod reply;
#[cfg(test)]
mod tests;
mod validate;

pub use available::{
    AvailableModel, AvailableModels, CACHE_TTL_S, Discovery, Listing, ModelSource, PROTOTYPE_KEYS,
    available_models, cache_file,
};
pub use closest::{closest_models, is_offered};
pub use discover::{
    CoreProcess, STDOUT_CAP, TIMEOUT, core_process, discover, model_ids, run_models,
    set_core_process,
};
pub use reply::{available_needs_core, available_reply, listing, listing_needs_core, wire_value};
pub use validate::{
    Refusal, Validation, check_offered, model_check_needs_core, model_declaration_warnings,
    provider_name, validate_runner_model, validate_runner_models,
};
