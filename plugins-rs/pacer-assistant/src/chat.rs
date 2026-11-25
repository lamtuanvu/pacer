//! OpenAI-compatible chat request/result mapping. Port of
//! `plugins/assistant/index.ts:14-41` (`chatRequest` / `chatResult`). The key
//! is never handled here; `respond` adds it out-of-band.
//!
//! Every field-omission and coercion rule of the TypeScript reference is
//! reproduced exactly:
//!
//! * An assistant message with tool calls sends `content: m.content || null`
//!   (an empty string becomes `null`); a tool result sends
//!   `tool_call_id: m.toolCallId ?? ""`.
//! * `function.arguments` is `JSON.stringify(arguments)`.
//! * `tools` is present only when there are tools *and* `maxToolRounds > 0`.
//! * `chat_result` default tool-call `id` is `call-<i>`; a non-object or
//!   unparseable `arguments` becomes `{}`.
//! * Usage numbers are cloned as JSON values, never converted; `coverage` is
//!   `measured` only when both counts are JSON numbers.

use pacer_plugin::PluginError;
use serde_json::{Value, json};

/// Build the OpenAI-compatible request body, mirroring `chatRequest`.
pub fn chat_request(p: &Value) -> Value {
    let model = p["context"]["backend"]["model"].clone();
    let max_tokens = p["limits"]["maxOutputTokens"].clone();
    let system = p["context"]["system"].clone();

    let mut messages = vec![json!({ "role": "system", "content": system })];
    if let Some(list) = p.get("messages").and_then(Value::as_array) {
        for m in list {
            let role = m.get("role").and_then(Value::as_str).unwrap_or_default();
            if role == "tool" {
                // tool_call_id: m.toolCallId ?? ""
                let tool_call_id = m
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": m.get("content").cloned().unwrap_or(Value::Null),
                }));
            } else if m
                .get("toolCalls")
                .and_then(Value::as_array)
                .map(|a| !a.is_empty())
                .unwrap_or(false)
            {
                // content: m.content || null
                let content = match m.get("content").cloned() {
                    Some(Value::String(s)) if s.is_empty() => Value::Null,
                    other => other.unwrap_or(Value::Null),
                };
                let tool_calls: Vec<Value> =
                    m.get("toolCalls")
                        .and_then(Value::as_array)
                        .map_or(Vec::new(), |arr| {
                            arr.iter()
                                .map(|c| {
                                    let arguments = serde_json::to_string(
                                        &c.get("arguments").cloned().unwrap_or(Value::Null),
                                    )
                                    .unwrap_or_default();
                                    json!({
                                        "id": c.get("id").cloned().unwrap_or(Value::Null),
                                        "type": "function",
                                        "function": {
                                            "name": c.get("name").cloned().unwrap_or(Value::Null),
                                            "arguments": arguments,
                                        }
                                    })
                                })
                                .collect()
                        });
                messages.push(json!({
                    "role": "assistant",
                    "content": content,
                    "tool_calls": tool_calls,
                }));
            } else {
                messages.push(json!({
                    "role": role,
                    "content": m.get("content").cloned().unwrap_or(Value::Null),
                }));
            }
        }
    }

    let mut body = json!({
        "model": model,
        "stream": false,
        "max_tokens": max_tokens,
        "messages": messages,
    });
    let has_tools = p
        .get("tools")
        .and_then(Value::as_array)
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    let max_rounds = p
        .get("limits")
        .and_then(|l| l.get("maxToolRounds"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if has_tools && max_rounds > 0 {
        let tools: Vec<Value> =
            p.get("tools")
                .and_then(Value::as_array)
                .map_or(Vec::new(), |arr| {
                    arr.iter()
                        .map(|t| {
                            json!({
                                "type": "function",
                                "function": {
                                    "name": t.get("name").cloned().unwrap_or(Value::Null),
                                    "description": t
                                        .get("description")
                                        .cloned()
                                        .unwrap_or(Value::Null),
                                    "parameters": t
                                        .get("parameters")
                                        .cloned()
                                        .unwrap_or(json!({})),
                                }
                            })
                        })
                        .collect()
                });
        body["tools"] = Value::Array(tools);
    }
    body
}

/// Parse an OpenAI-compatible chat response into a `RespondResult`, mirroring
/// `chatResult`. No message → `plugin_refused`.
pub fn chat_result(body: &Value) -> Result<Value, PluginError> {
    let message = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .and_then(|c| c.get("message"));
    let Some(message) = message else {
        return Err(PluginError::new(
            "plugin_refused",
            "The model returned no message.",
        ));
    };

    let mut tool_calls: Vec<Value> = Vec::new();
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for (i, c) in calls.iter().enumerate() {
            let name = c
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str);
            let Some(name) = name else {
                continue;
            };
            let raw = c
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_default();
            let parsed = if raw.is_empty() {
                json!({})
            } else {
                serde_json::from_str(&raw).unwrap_or(json!({}))
            };
            // JS: `args && typeof args === "object" && !Array.isArray(args) ? args : {}`
            let arguments = if parsed.is_object() {
                parsed
            } else {
                json!({})
            };
            let id = c
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("call-{i}"));
            tool_calls.push(json!({ "id": id, "name": name, "arguments": arguments }));
        }
    }

    let usage_raw = body.get("usage");
    let input_raw = usage_raw.and_then(|u| u.get("prompt_tokens"));
    let output_raw = usage_raw.and_then(|u| u.get("completion_tokens"));
    // Cloned as JSON values, not converted; defaults to 0 when absent.
    let input = input_raw.cloned().unwrap_or(json!(0));
    let output = output_raw.cloned().unwrap_or(json!(0));
    let measured =
        input_raw.is_some_and(Value::is_number) && output_raw.is_some_and(Value::is_number);
    let mut usage = json!({
        "input": input,
        "output": output,
        "coverage": if measured { "measured" } else { "unknown" },
    });
    if let Some(cached) = usage_raw
        .and_then(|u| u.get("prompt_tokens_details"))
        .and_then(|d| d.get("cached_tokens"))
        && cached.is_number()
    {
        usage["cacheRead"] = cached.clone();
    }

    let content = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut out = json!({ "usage": usage });
    out["message"] = json!(content);
    if !tool_calls.is_empty() {
        out["toolCalls"] = Value::Array(tool_calls);
    }
    Ok(out)
}
