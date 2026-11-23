//! `assistant.reply` handler: Rig agent loop over openai-compatible, Anthropic or Gemini.

use crate::budget::OutputBudget;
use crate::budget_model::BudgetedModel;
use crate::delta;
use crate::http::CompatChatModel;
use crate::manifest;
use crate::tools::HostTool;
use pacer_plugin::types::{
    AssistantReplyParams, AssistantReplyParamsBackend, AssistantReplyParamsEndpointApi,
    AssistantReplyParamsHistoryItemRole, AssistantReplyResult, AssistantReplyResultMessage,
    AssistantReplyResultUsage, AssistantReplyResultUsageCoverage,
};
use pacer_plugin::{Ctx, Plugin, PluginError, Progress};
use rig::agent::{AgentBuilder, CancelSignal, PromptHook};
use rig::client::CompletionClient;
use rig::completion::{
    AssistantContent, CompletionModel, CompletionResponse, Message, Prompt, PromptError, Usage,
};
use rig::message::UserContent;
use rig::providers::gemini::completion::gemini_api_types::{
    AdditionalParameters as GeminiAdditionalParameters, GenerationConfig as GeminiGenerationConfig,
};
use rig::providers::{anthropic, gemini};
use rig::tool::server::ToolServer;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const ANTHROPIC_DEFAULT_BASE: &str = "https://api.anthropic.com";
const GEMINI_DEFAULT_BASE: &str = "https://generativelanguage.googleapis.com";

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

    let api = params
        .endpoint
        .as_ref()
        .and_then(|e| e.api)
        .unwrap_or(AssistantReplyParamsEndpointApi::OpenaiCompatible);
    let base_url = resolve_base_url(&params, &api)?;
    let keyless = params
        .endpoint
        .as_ref()
        .and_then(|e| e.keyless)
        .unwrap_or(false);
    if keyless && api != AssistantReplyParamsEndpointApi::OpenaiCompatible {
        return Err(PluginError::new(
            "invalid_input",
            "keyless is only valid for openai-compatible endpoints",
        ));
    }
    // key=none: skip secrets.resolve and call without Authorization. Other sources still fail closed.
    // Anthropic and Gemini always require a resolved key.
    let key = if keyless {
        None
    } else {
        Some(resolve_key(&ctx, &account).await?)
    };

    let system = format!("{}\n\n{}", params.system.as_str(), params.digest.as_str());
    let max_output = params.limits.max_output_tokens.get();
    let max_input = params.limits.max_input_tokens.max(0) as u64;
    let max_tool_rounds = params.limits.max_tool_rounds.max(0) as usize;
    let budget = OutputBudget::new(max_output);
    let usage_acc = Arc::new(AtomicU64::new(0));
    let usage_out = budget.used.clone();

    match api {
        AssistantReplyParamsEndpointApi::OpenaiCompatible => {
            let completion =
                BudgetedModel::new(CompatChatModel::new(base_url, key, &model), budget.clone());
            run_agent(
                completion,
                &params,
                &ctx,
                &turn_id,
                &system,
                max_output,
                max_input,
                max_tool_rounds,
                usage_acc,
                usage_out,
                Some(json!({ "max_tokens": max_output })),
            )
            .await
        }
        AssistantReplyParamsEndpointApi::Anthropic => {
            let key = key.ok_or_else(|| {
                PluginError::new(
                    "plugin_unavailable",
                    "Anthropic accounts require a resolved key.",
                )
            })?;
            let client = anthropic::ClientBuilder::new(&key)
                .base_url(&base_url)
                .build()
                .map_err(|e| {
                    PluginError::new(
                        "plugin_unavailable",
                        format!("Could not build the Anthropic client: {e}"),
                    )
                })?;
            let completion = BudgetedModel::new(client.completion_model(&model), budget.clone());
            run_agent(
                completion,
                &params,
                &ctx,
                &turn_id,
                &system,
                max_output,
                max_input,
                max_tool_rounds,
                usage_acc,
                usage_out,
                None,
            )
            .await
        }
        AssistantReplyParamsEndpointApi::Gemini => {
            let key = key.ok_or_else(|| {
                PluginError::new(
                    "plugin_unavailable",
                    "Gemini accounts require a resolved key.",
                )
            })?;
            let client = gemini::Client::builder(&key)
                .base_url(&base_url)
                .build()
                .map_err(|e| {
                    PluginError::new(
                        "plugin_unavailable",
                        format!("Could not build the Gemini client: {e}"),
                    )
                })?;
            // Gemini deserializes additional_params as AdditionalParameters (needs generationConfig).
            let gemini_params = serde_json::to_value(
                GeminiAdditionalParameters::default().with_config(GeminiGenerationConfig {
                    max_output_tokens: Some(max_output),
                    ..GeminiGenerationConfig::default()
                }),
            )
            .map_err(|e| {
                PluginError::new(
                    "internal",
                    format!("Could not encode Gemini generation config: {e}"),
                )
            })?;
            let completion = BudgetedModel::new(client.completion_model(&model), budget.clone());
            run_agent(
                completion,
                &params,
                &ctx,
                &turn_id,
                &system,
                max_output,
                max_input,
                max_tool_rounds,
                usage_acc,
                usage_out,
                Some(gemini_params),
            )
            .await
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_agent<M>(
    completion: M,
    params: &AssistantReplyParams,
    ctx: &Ctx,
    turn_id: &str,
    system: &str,
    max_output: u64,
    max_input: u64,
    max_tool_rounds: usize,
    usage_acc: Arc<AtomicU64>,
    usage_out: Arc<AtomicU64>,
    completion_params: Option<Value>,
) -> Result<AssistantReplyResult, PluginError>
where
    M: CompletionModel + Clone + 'static,
{
    // openai-compatible: Rig Completions TryFrom drops max_tokens — pass via additional_params (§7).
    // Gemini: AdditionalParameters with generationConfig (required by Rig's request builder).
    // BudgetedModel rewrites the remaining budget into those mirrors on every call (R3).

    let offer_tools = max_tool_rounds > 0 && !params.tools.is_empty();
    let rounds = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    // HostTool implements ToolDyn (not Tool) so result text is not JSON-encoded again.
    let agent = if offer_tools {
        let handle = ToolServer::new().run();
        for tool in &params.tools {
            let host_tool = HostTool {
                name: tool.name.to_string(),
                description: tool.description.to_string(),
                parameters: tool.parameters.clone(),
                turn_id: turn_id.to_owned(),
                host: ctx.host.clone(),
                progress: ctx.progress.clone(),
                rounds: rounds.clone(),
                max_rounds: max_tool_rounds,
            };
            handle.add_tool(host_tool).await.map_err(|e| {
                PluginError::new("internal", format!("Could not register tool: {e}"))
            })?;
        }
        let mut builder = AgentBuilder::new(completion)
            .preamble(system)
            .max_tokens(max_output)
            .tool_server_handle(handle);
        if let Some(params) = completion_params.clone() {
            builder = builder.additional_params(params);
        }
        builder.build()
    } else {
        let mut builder = AgentBuilder::new(completion)
            .preamble(system)
            .max_tokens(max_output);
        if let Some(params) = completion_params {
            builder = builder.additional_params(params);
        }
        builder.build()
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
    let stop_reason = Arc::new(std::sync::Mutex::new(StopReason::None));
    let hook = DeltaHook {
        turn_id: turn_id.to_owned(),
        progress: ctx.progress.clone(),
        cancel: ctx.cancel.clone(),
        max_input_tokens: max_input,
        max_output_tokens: max_output,
        usage_input: usage_acc.clone(),
        usage_output: usage_out.clone(),
        stop_reason: stop_reason.clone(),
        system_tokens: approx_tokens(system),
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
        Err(PromptError::PromptCancelled { chat_history }) => {
            if ctx.cancel.is_cancelled() {
                return Err(cancelled());
            }
            let reason = stop_reason.lock().map(|g| *g).unwrap_or(StopReason::None);
            let usage = accumulated_usage(&usage_acc, &usage_out);
            let text = last_assistant_text(&chat_history).unwrap_or_default();
            match reason {
                StopReason::InputCap => {
                    delta::text(&ctx.progress, turn_id, &text);
                    return Ok(reply_result(
                        if text.is_empty() {
                            "I stopped because this turn would exceed the input limit.".into()
                        } else {
                            text
                        },
                        usage,
                        coverage_of(&usage),
                    ));
                }
                StopReason::OutputCap => {
                    delta::text(&ctx.progress, turn_id, &text);
                    return Ok(reply_result(
                        if text.is_empty() {
                            format!(
                                "I stopped here because I reached the {max_output}-token answer limit."
                            )
                        } else {
                            text
                        },
                        usage,
                        coverage_of(&usage),
                    ));
                }
                StopReason::None => return Err(cancelled()),
            }
        }
        Err(PromptError::MaxDepthError { chat_history, .. }) => {
            let text = last_assistant_text(&chat_history).unwrap_or_default();
            delta::text(&ctx.progress, turn_id, &text);
            let usage = accumulated_usage(&usage_acc, &usage_out);
            return Ok(reply_result(text, usage, coverage_of(&usage)));
        }
        Err(e) => {
            if ctx.cancel.is_cancelled() {
                return Err(cancelled());
            }
            return Err(map_provider_error(ctx, &e).await);
        }
    };

    if ctx.cancel.is_cancelled() {
        return Err(cancelled());
    }

    delta::text(&ctx.progress, turn_id, &response.output);
    // Prefer Rig's total when present; otherwise the hook accumulator (covers max-depth-equivalent paths).
    let usage = if response.total_usage.input_tokens > 0 || response.total_usage.output_tokens > 0 {
        response.total_usage
    } else {
        accumulated_usage(&usage_acc, &usage_out)
    };
    Ok(reply_result(response.output, usage, coverage_of(&usage)))
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

fn coverage_of(usage: &Usage) -> AssistantReplyResultUsageCoverage {
    if usage.input_tokens > 0 || usage.output_tokens > 0 {
        AssistantReplyResultUsageCoverage::Measured
    } else {
        AssistantReplyResultUsageCoverage::Unknown
    }
}

fn accumulated_usage(input: &AtomicU64, output: &AtomicU64) -> Usage {
    let mut u = Usage::new();
    u.input_tokens = input.load(Ordering::SeqCst);
    u.output_tokens = output.load(Ordering::SeqCst);
    u
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
                    AssistantContent::Text(t) => Some(t.text.as_str()),
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

/// Endpoint base URL from `assistant.reply` params (`endpoint.baseUrl`).
///
/// openai-compatible requires a host-supplied URL. Anthropic and Gemini may omit it and use
/// the provider default. Never fall back to `capability.config.get`.
fn resolve_base_url(
    params: &AssistantReplyParams,
    api: &AssistantReplyParamsEndpointApi,
) -> Result<String, PluginError> {
    let url = params
        .endpoint
        .as_ref()
        .and_then(|e| e.base_url.as_ref())
        .map(|s| s.as_str().trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_owned());
    match api {
        AssistantReplyParamsEndpointApi::OpenaiCompatible => url.ok_or_else(|| {
            PluginError::new(
                "plugin_unavailable",
                "assistant.reply requires endpoint.baseUrl from the chosen account",
            )
        }),
        AssistantReplyParamsEndpointApi::Anthropic => {
            Ok(url.unwrap_or_else(|| ANTHROPIC_DEFAULT_BASE.to_owned()))
        }
        AssistantReplyParamsEndpointApi::Gemini => {
            Ok(url.unwrap_or_else(|| GEMINI_DEFAULT_BASE.to_owned()))
        }
    }
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

/// Classify a provider failure without echoing its body (bodies can contain keys).
fn provider_error_class(detail: &str) -> &'static str {
    if detail.contains("401") || detail.contains("403") || detail.contains("Unauthorized") {
        "auth"
    } else if detail.contains("429") {
        "rate_limited"
    } else if detail.contains("status")
        && (detail.contains("500")
            || detail.contains("502")
            || detail.contains("503")
            || detail.contains("504"))
    {
        "provider"
    } else if detail.contains("error decoding response body")
        || detail.contains("missing field")
        || detail.contains("invalid type")
    {
        "response_shape"
    } else if detail.contains("error sending request") || detail.contains("connection") {
        "transport"
    } else {
        "unknown"
    }
}

/// Map provider failures to a short fixed message; log only the error class (never the body).
async fn map_provider_error(ctx: &Ctx, err: &PromptError) -> PluginError {
    let detail = err.to_string();
    let class = provider_error_class(&detail);
    let _ = ctx
        .host
        .log("warn", &format!("provider error class={class}"))
        .await;
    let status_hint = match class {
        "auth" => " (auth)",
        "rate_limited" => " (rate limited)",
        "provider" => " (provider error)",
        _ => "",
    };
    PluginError::new(
        "plugin_unavailable",
        format!("The model call failed{status_hint}."),
    )
}

fn approx_tokens(text: &str) -> u64 {
    text.len().div_ceil(4) as u64
}

fn estimate_message_tokens(message: &Message) -> u64 {
    match message {
        Message::User { content } => content.iter().map(estimate_user_content).sum(),
        Message::Assistant { content, .. } => content
            .iter()
            .map(|c| match c {
                AssistantContent::Text(t) => approx_tokens(&t.text),
                AssistantContent::ToolCall(tc) => {
                    approx_tokens(&tc.function.name)
                        + approx_tokens(&tc.function.arguments.to_string())
                }
                AssistantContent::Reasoning(r) => {
                    r.reasoning.iter().map(|s| approx_tokens(s)).sum()
                }
            })
            .sum(),
    }
}

fn estimate_user_content(c: &UserContent) -> u64 {
    match c {
        UserContent::Text(t) => approx_tokens(&t.text),
        UserContent::ToolResult(tr) => tr
            .content
            .iter()
            .map(|part| match part {
                rig::message::ToolResultContent::Text(t) => approx_tokens(&t.text),
                _ => 0,
            })
            .sum(),
        _ => 0,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopReason {
    None,
    InputCap,
    OutputCap,
}

/// Emits `assistant.delta` for tool activity; enforces input/output budgets; cancels on host cancel.
#[derive(Clone)]
struct DeltaHook {
    turn_id: String,
    progress: Progress,
    cancel: tokio_util::sync::CancellationToken,
    max_input_tokens: u64,
    max_output_tokens: u64,
    usage_input: Arc<AtomicU64>,
    usage_output: Arc<AtomicU64>,
    stop_reason: Arc<std::sync::Mutex<StopReason>>,
    system_tokens: u64,
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
        prompt: &Message,
        history: &[Message],
        cancel_sig: CancelSignal,
    ) -> impl Future<Output = ()> + Send {
        let cancel = self.cancel.clone();
        let stop_reason = self.stop_reason.clone();
        let max_input = self.max_input_tokens;
        let max_output = self.max_output_tokens;
        let usage_output = self.usage_output.clone();
        let system_tokens = self.system_tokens;
        let history_tokens: u64 = history.iter().map(estimate_message_tokens).sum();
        let prompt_tokens = estimate_message_tokens(prompt);
        let estimated = system_tokens + history_tokens + prompt_tokens;
        async move {
            if cancel.is_cancelled() {
                cancel_sig.cancel();
                return;
            }
            if estimated > max_input {
                if let Ok(mut g) = stop_reason.lock() {
                    *g = StopReason::InputCap;
                }
                cancel_sig.cancel();
                return;
            }
            let used_out = usage_output.load(Ordering::SeqCst);
            if used_out >= max_output {
                if let Ok(mut g) = stop_reason.lock() {
                    *g = StopReason::OutputCap;
                }
                cancel_sig.cancel();
            }
        }
    }

    fn on_completion_response(
        &self,
        _prompt: &Message,
        response: &CompletionResponse<M::Response>,
        cancel_sig: CancelSignal,
    ) -> impl Future<Output = ()> + Send {
        let cancel = self.cancel.clone();
        let usage_input = self.usage_input.clone();
        let usage_output = self.usage_output.clone();
        let stop_reason = self.stop_reason.clone();
        let max_output = self.max_output_tokens;
        let in_tok = response.usage.input_tokens;
        let out_tok = response.usage.output_tokens;
        async move {
            usage_input.fetch_add(in_tok, Ordering::SeqCst);
            let total_out = usage_output.fetch_add(out_tok, Ordering::SeqCst) + out_tok;
            if cancel.is_cancelled() {
                cancel_sig.cancel();
                return;
            }
            if total_out >= max_output {
                if let Ok(mut g) = stop_reason.lock() {
                    *g = StopReason::OutputCap;
                }
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
