//! Per-call output token budget: the turn's `maxOutputTokens` is shared across rounds (R3).

use rig::completion::{CompletionError, CompletionRequest};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// Remaining output tokens for the next model call (`max - used`), or an error when exhausted.
pub fn remaining_output(max: u64, used: u64) -> Result<u64, CompletionError> {
    let left = max.saturating_sub(used);
    if left == 0 {
        return Err(CompletionError::RequestError(
            "output token budget exhausted for this turn".into(),
        ));
    }
    Ok(left)
}

/// Set `max_tokens` and any provider-specific mirror in `additional_params` to the remaining budget.
///
/// - openai-compatible: Rig drops `max_tokens` on Completions TryFrom; the agent stores it under
///   `additional_params.max_tokens`, which we rewrite here.
/// - Gemini: `additional_params` is `AdditionalParameters` with `generationConfig.maxOutputTokens`.
/// - Anthropic: uses the request's `max_tokens` field only.
pub fn apply_remaining(
    req: &mut CompletionRequest,
    max: u64,
    used: u64,
) -> Result<u64, CompletionError> {
    let left = remaining_output(max, used)?;
    req.max_tokens = Some(left);
    if let Some(Value::Object(map)) = req.additional_params.as_mut() {
        if map.contains_key("max_tokens") {
            map.insert("max_tokens".into(), json!(left));
        }
        if let Some(Value::Object(generation)) = map.get_mut("generationConfig") {
            generation.insert("maxOutputTokens".into(), json!(left));
        }
    }
    Ok(left)
}

/// Shared turn budget counters the completion model and the prompt hook both update.
#[derive(Clone, Debug)]
pub struct OutputBudget {
    pub max: u64,
    pub used: Arc<AtomicU64>,
}

impl OutputBudget {
    pub fn new(max: u64) -> Self {
        Self {
            max,
            used: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn used(&self) -> u64 {
        self.used.load(Ordering::SeqCst)
    }

    pub fn apply(&self, req: &mut CompletionRequest) -> Result<u64, CompletionError> {
        apply_remaining(req, self.max, self.used())
    }
}
