//! Wrap any Rig `CompletionModel` so each call gets the remaining turn output budget (R3).

use crate::budget::OutputBudget;
use rig::completion::{
    self, CompletionError, CompletionModel as CompletionModelTrait, CompletionRequest,
};
use rig::streaming::StreamingCompletionResponse;

/// Forwards to `inner` after setting `max_tokens` to the remaining turn budget.
#[derive(Clone, Debug)]
pub struct BudgetedModel<M> {
    inner: M,
    budget: OutputBudget,
}

impl<M> BudgetedModel<M> {
    pub fn new(inner: M, budget: OutputBudget) -> Self {
        Self { inner, budget }
    }
}

impl<M> CompletionModelTrait for BudgetedModel<M>
where
    M: CompletionModelTrait + Sync,
{
    type Response = M::Response;
    type StreamingResponse = M::StreamingResponse;

    async fn completion(
        &self,
        mut completion_request: CompletionRequest,
    ) -> Result<completion::CompletionResponse<Self::Response>, CompletionError> {
        self.budget.apply(&mut completion_request)?;
        self.inner.completion(completion_request).await
    }

    async fn stream(
        &self,
        request: CompletionRequest,
    ) -> Result<StreamingCompletionResponse<Self::StreamingResponse>, CompletionError> {
        self.inner.stream(request).await
    }
}
