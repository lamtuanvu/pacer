//! Runner model listings from `src/models/available.ts` and the `runner.set`
//! model check from `src/core/runners-config.ts`. Native today: runners
//! without a listing source, endpoint connection accounts (models declared in
//! the strategy) and a fresh, well-formed OpenCode listing cache. Listing an
//! OpenCode provider (`opencode models` plus catalog facts) is discovery that
//! TypeScript still owns, as is any cache shape TypeScript would fail on.
mod available;
mod closest;
#[cfg(test)]
mod tests;
mod validate;

pub use available::{
    AvailableModel, AvailableModels, CACHE_TTL_S, Listing, ModelSource, available_models,
    cache_file,
};
pub use closest::{closest_models, is_offered};
pub use validate::{Validation, validate_runner_model};
