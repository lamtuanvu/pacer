//! OpenAI-compatible chat completions without Rig's always-on Bearer header.
//!
//! Rig 0.22 only implements `completion::CompletionModel` for `Client<reqwest::Client>`,
//! which always attaches `Authorization`. Local key=none endpoints need no auth header, and
//! some openai-compatible servers omit `created` (which Rig requires). This thin model
//! speaks the same Completions wire format Rig uses, with those two fixes.

use rig::completion::{
    self, CompletionError, CompletionModel as CompletionModelTrait, CompletionRequest as CoreRequest,
    GetTokenUsage,
};
use rig::streaming::StreamingCompletionResponse;
use serde_json::Value;

/// Chat Completions model for one openai-compatible base URL.
#[derive(Clone, Debug)]
pub struct CompatChatModel {
    http: reqwest::Client,
    base_url: String,
    /// `None` → no Authorization header (keyless).
    api_key: Option<String>,
    model: String,
}

impl CompatChatModel {
    pub fn new(base_url: impl Into<String>, api_key: Option<String>, model: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            api_key,
            model: model.into(),
        }
    }
}

/// Ensure a chat-completion JSON body has `created` so Rig's response types deserialize.
fn ensure_created(text: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(text) else {
        return text.to_owned();
    };
    let Some(obj) = value.as_object_mut() else {
        return text.to_owned();
    };
    if !obj.contains_key("choices") {
        return text.to_owned();
    }
    if !obj.contains_key("created") {
        obj.insert("created".into(), Value::from(0_u64));
    }
    match serde_json::to_string(&value) {
        Ok(s) => s,
        Err(_) => text.to_owned(),
    }
}

impl CompletionModelTrait for CompatChatModel {
    type Response = rig::providers::openai::CompletionResponse;
    type StreamingResponse = NoStreamUsage;

    async fn completion(
        &self,
        completion_request: CoreRequest,
    ) -> Result<completion::CompletionResponse<Self::Response>, CompletionError> {
        // Same request shaping Rig's openai Completions path uses (includes additional_params).
        let request = rig::providers::openai::CompletionRequest::try_from((
            self.model.clone(),
            completion_request,
        ))?;
        let mut builder = self
            .http
            .post(format!("{}/chat/completions", self.base_url))
            .header("content-type", "application/json")
            .json(&request);
        if let Some(key) = self.api_key.as_ref().filter(|k| !k.is_empty()) {
            builder = builder.bearer_auth(key);
        }
        let response = builder.send().await.map_err(|e| {
            CompletionError::HttpError(rig::http_client::Error::Instance(Box::new(e)))
        })?;
        let status = response.status();
        let text = response.text().await.map_err(|e| {
            CompletionError::HttpError(rig::http_client::Error::Instance(Box::new(e)))
        })?;
        if !status.is_success() {
            return Err(CompletionError::ProviderError(text));
        }
        let text = ensure_created(&text);
        let parsed: Self::Response = serde_json::from_str(&text)?;
        parsed.try_into()
    }

    async fn stream(
        &self,
        _request: CoreRequest,
    ) -> Result<StreamingCompletionResponse<Self::StreamingResponse>, CompletionError> {
        Err(CompletionError::ProviderError(
            "assistant-pacer does not stream chat completions".into(),
        ))
    }
}

/// Placeholder streaming response type; streaming is unused.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct NoStreamUsage;

impl GetTokenUsage for NoStreamUsage {
    fn token_usage(&self) -> Option<completion::Usage> {
        None
    }
}
