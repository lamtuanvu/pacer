//! `assistant.reply` handler: Rig agent loop over an openai-compatible endpoint.

use crate::delta;
use crate::manifest;
use crate::tools::HostTool;
use pacer_plugin::types::{
    AssistantReplyParams, AssistantReplyParamsBackend, AssistantReplyParamsHistoryItemRole,
    AssistantReplyResult, AssistantReplyResultMessage, AssistantReplyResultUsage,
    AssistantReplyResultUsageCoverage,
};
use pacer_plugin::{Ctx, Plugin, PluginError, Progress};
use rig::agent::{AgentBuilder, CancelSignal, PromptHook};
use rig::client::CompletionClient;
use rig::completion::{CompletionModel, CompletionResponse, Message, Prompt, PromptError, Usage};
use rig::providers::openai;
use serde_json::{Value, json};
use std::time::Duration;

/// Build the stdio plugin that serves `assistant.reply`.
pub fn plugin() -> Plugin {
    Plugin::new(manifest()).handle_typed("assistant.reply", |params, ctx| async move {
        reply(params, ctx).await
    })
}

pub async fn reply(
    params: AssistantReplyParams,
    ctx: Ctx,
) -> Result<AssistantReplyResult, PluginError> {
    if params.backend != AssistantReplyParamsBackend::Pacer {
        return Err(PluginError::new(
            "invalid_input",
            "assistant-pacer only serves backend \"pacer\"",
        ));
    }

    let cancel = ctx.cancel.clone();
    if cancel.is_cancelled() {
        return Err(cancelled());
    }

    let deadline = Duration::from_millis(params.limits.deadline_ms.max(0) as u64);
    let work = run_reply(params, ctx);
    tokio::select! {
        _ = cancel.cancelled() => Err(cancelled()),
        result = tokio::time::timeout(deadline, work) => match result {
            Ok(Ok(r)) => {
                if cancel.is_cancelled() {
                    Err(cancelled())
                } else {
                    Ok(r)
                }
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err(PluginError::new(
                "plugin_timeout",
                "The model did not answer in time.",
            )),
        },
    }
}

async fn run_reply(
    params: AssistantReplyParams,
    ctx: Ctx,
) -> Result<AssistantReplyResult, PluginError> {
    let turn_id = params.turn_id.to_string();
    let account = params.account.to_string();
    let model = params
        .model
        .as_ref()
        .map(|m| m.to_string())
        .filter(|m| !m.is_empty())
        .ok_or_else(|| PluginError::new("invalid_input", "assistant.reply requires a model"))?;

    let base_url = resolve_base_url(&ctx).await?;
    let key = resolve_key(&ctx, &account).await?;

    let client = openai::Client::builder(&key).base_url(&base_url).build();
    // openai-compatible endpoints (and our tests) speak Chat Completions, not Responses.
    let completion = client.completion_model(&model).completions_api();

    let system = format!("{}\n\n{}", params.system.as_str(), params.digest.as_str());
    let max_output = params.limits.max_output_tokens.get();
    let max_tool_rounds = params.limits.max_tool_rounds.max(0) as usize;

    let offer_tools = max_tool_rounds > 0 && !params.tools.is_empty();
    let rounds = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let agent = if offer_tools {
        let mut tools = params.tools.iter();
        let Some(first) = tools.next() else {
            return Err(PluginError::new("internal", "tools list was empty"));
        };
        let make = |tool: &pacer_plugin::types::AssistantReplyParamsToolsItem| HostTool {
            name: tool.name.to_string(),
            description: tool.description.to_string(),
            parameters: tool.parameters.clone(),
            turn_id: turn_id.clone(),
            host: ctx.host.clone(),
            progress: ctx.progress.clone(),
            rounds: rounds.clone(),
            max_rounds: max_tool_rounds,
        };
        let mut builder = AgentBuilder::new(completion)
            .preamble(&system)
            .max_tokens(max_output)
            .tool(make(first));
        for tool in tools {
            builder = builder.tool(make(tool));
        }
        builder.build()
    } else {
        AgentBuilder::new(completion)
            .preamble(&system)
            .max_tokens(max_output)
            .build()
    };

    let mut history: Vec<Message> = Vec::new();
    for item in &params.history {
        match item.role {
            AssistantReplyParamsHistoryItemRole::User => {
                history.push(Message::user(item.content.as_str()));
            }
            AssistantReplyParamsHistoryItemRole::Assistant => {
                history.push(Message::assistant(item.content.as_str()));
            }
        }
    }

    // Give Rig room for a final text turn; HostTool enforces max_tool_rounds.
    let depth = max_tool_rounds.saturating_add(1);
    let hook = DeltaHook {
        turn_id: turn_id.clone(),
        progress: ctx.progress.clone(),
        cancel: ctx.cancel.clone(),
    };

    let response = match agent
        .prompt(params.message.as_str())
        .with_history(&mut history)
        .multi_turn(depth)
        .with_hook(hook)
        .extended_details()
        .await
    {
        Ok(r) => r,
        Err(PromptError::PromptCancelled { .. }) => return Err(cancelled()),
        Err(PromptError::MaxDepthError { chat_history, .. }) => {
            let text = last_assistant_text(&chat_history).unwrap_or_default();
            delta::text(&ctx.progress, &turn_id, &text);
            return Ok(reply_result(
                text,
                Usage::new(),
                AssistantReplyResultUsageCoverage::Unknown,
            ));
        }
        Err(e) => {
            if ctx.cancel.is_cancelled() {
                return Err(cancelled());
            }
            return Err(PluginError::new(
                "plugin_unavailable",
                format!("The model call failed: {e}"),
            ));
        }
    };

    if ctx.cancel.is_cancelled() {
        return Err(cancelled());
    }

    delta::text(&ctx.progress, &turn_id, &response.output);
    let coverage = if response.total_usage.input_tokens > 0 || response.total_usage.output_tokens > 0
    {
        AssistantReplyResultUsageCoverage::Measured
    } else {
        AssistantReplyResultUsageCoverage::Unknown
    };
    Ok(reply_result(response.output, response.total_usage, coverage))
}

fn reply_result(
    message: String,
    usage: Usage,
    coverage: AssistantReplyResultUsageCoverage,
) -> AssistantReplyResult {
    AssistantReplyResult {
        message: message_of(&message),
        session: None,
        tools: Vec::new(),
        usage: AssistantReplyResultUsage {
            input: usage.input_tokens as i64,
            output: usage.output_tokens as i64,
            cache_read: None,
            cache_write: None,
            coverage,
        },
    }
}

#[allow(clippy::unwrap_used)] // empty string always satisfies the max-length-only schema
fn message_of(text: &str) -> AssistantReplyResultMessage {
    let clipped: String = text.chars().take(200_000).collect();
    AssistantReplyResultMessage::try_from(clipped.as_str())
        .or_else(|_| AssistantReplyResultMessage::try_from(""))
        .unwrap()
}

fn last_assistant_text(history: &[Message]) -> Option<String> {
    history.iter().rev().find_map(|m| match m {
        Message::Assistant { content, .. } => {
            let texts: Vec<_> = content
                .iter()
                .filter_map(|c| match c {
                    rig::message::AssistantContent::Text(t) => Some(t.text.as_str()),
                    _ => None,
                })
                .collect();
            if texts.is_empty() {
                None
            } else {
                Some(texts.join("\n"))
            }
        }
        _ => None,
    })
}

fn cancelled() -> PluginError {
    PluginError::new("plugin_unavailable", "The turn was cancelled.")
}

/// Endpoint base URL from `capability.config.get` → `baseUrl`.
///
/// `assistant.reply` params do not yet carry the connection (unlike `assistant.respond`'s
/// `context.backend.baseUrl`). Phase 3b should put the account base URL into this plugin's
/// config slice, or extend the protocol. Tests set it through the harness.
async fn resolve_base_url(ctx: &Ctx) -> Result<String, PluginError> {
    let cfg = ctx.host.config().await.map_err(|e| {
        PluginError::new(
            "plugin_unavailable",
            format!("Could not read plugin config: {}", e.message),
        )
    })?;
    let url = cfg
        .get("baseUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            PluginError::new(
                "invalid_input",
                "assistant-pacer needs config.baseUrl (openai-compatible endpoint)",
            )
        })?;
    Ok(url.trim_end_matches('/').to_owned())
}

async fn resolve_key(ctx: &Ctx, account: &str) -> Result<String, PluginError> {
    // Mirror plugins/assistant: endpoint/<id>; endpoint:id is also accepted by the host.
    let resolved = ctx
        .host
        .call(
            "capability.secrets.resolve",
            json!({ "ref": format!("endpoint/{account}") }),
        )
        .await
        .map_err(|e| {
            PluginError::new(
                "plugin_unavailable",
                format!("Could not resolve the account key: {}", e.message),
            )
        })?;
    let key = resolved
        .get("value")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            PluginError::new(
                "plugin_unavailable",
                "The endpoint account has no key to resolve.",
            )
        })?;
    Ok(key.to_owned())
}

/// Emits `assistant.delta` for tool activity; cancels the Rig loop when the host cancels.
#[derive(Clone)]
struct DeltaHook {
    turn_id: String,
    progress: Progress,
    cancel: tokio_util::sync::CancellationToken,
}

impl<M> PromptHook<M> for DeltaHook
where
    M: CompletionModel,
{
    fn on_tool_call(
        &self,
        tool_name: &str,
        _args: &str,
        cancel_sig: CancelSignal,
    ) -> impl Future<Output = ()> + Send {
        let turn_id = self.turn_id.clone();
        let progress = self.progress.clone();
        let cancel = self.cancel.clone();
        let name = tool_name.to_owned();
        async move {
            if cancel.is_cancelled() {
                cancel_sig.cancel();
                return;
            }
            delta::activity(&progress, &turn_id, &format!("Calling {name}…"));
        }
    }

    fn on_completion_call(
        &self,
        _prompt: &Message,
        _history: &[Message],
        cancel_sig: CancelSignal,
    ) -> impl Future<Output = ()> + Send {
        let cancel = self.cancel.clone();
        async move {
            if cancel.is_cancelled() {
                cancel_sig.cancel();
            }
        }
    }

    fn on_completion_response(
        &self,
        _prompt: &Message,
        _response: &CompletionResponse<M::Response>,
        cancel_sig: CancelSignal,
    ) -> impl Future<Output = ()> + Send {
        let cancel = self.cancel.clone();
        async move {
            if cancel.is_cancelled() {
                cancel_sig.cancel();
            }
        }
    }

    fn on_tool_result(
        &self,
        _tool_name: &str,
        _args: &str,
        _result: &str,
        cancel_sig: CancelSignal,
    ) -> impl Future<Output = ()> + Send {
        let cancel = self.cancel.clone();
        async move {
            if cancel.is_cancelled() {
                cancel_sig.cancel();
            }
        }
    }
}

use std::future::Future;
