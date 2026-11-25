import { PluginError } from "@pacer/plugin";
import type { HostClient } from "@pacer/plugin";

interface Call { id: string; name: string; arguments: Record<string, unknown> }
interface Message { role: "user" | "assistant" | "tool"; content: string; toolCallId?: string; toolCalls?: Call[] }
export interface RespondParams {
  conversationId: string; turnId: string; messages: Message[]; tools: { name: string; description: string; parameters: unknown }[];
  context: { system: string; backend: { kind: "endpoint"; account: string; model: string; baseUrl: string } };
  limits: { maxOutputTokens: number; maxToolRounds: number; deadlineMs: number };
}
export interface RespondResult { message: string; toolCalls?: Call[]; usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; coverage: "measured" | "partial" | "unknown" } }

/** OpenAI-compatible chat request. The key is added by the caller and never logged. */
export function chatRequest(p: RespondParams): Record<string, unknown> {
  return {
    model: p.context.backend.model, stream: false, max_tokens: p.limits.maxOutputTokens,
    messages: [{ role: "system", content: p.context.system }, ...p.messages.map(m => m.role === "tool"
      ? { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content }
      : m.toolCalls?.length ? { role: "assistant", content: m.content || null, tool_calls: m.toolCalls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
      : { role: m.role, content: m.content })],
    ...(p.tools.length && p.limits.maxToolRounds > 0 ? { tools: p.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
  };
}

export function chatResult(body: unknown): RespondResult {
  const b = body as { choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } };
  const message = b?.choices?.[0]?.message;
  if (!message) throw new PluginError("plugin_refused", "The model returned no message.");
  const toolCalls = (message.tool_calls ?? []).flatMap((c, i): Call[] => {
    if (!c.function?.name) return [];
    let args: unknown = {};
    try { args = JSON.parse(c.function.arguments || "{}"); } catch { args = {}; }
    return [{ id: c.id || `call-${i}`, name: c.function.name, arguments: args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {} }];
  });
  const u = b.usage;
  const measured = typeof u?.prompt_tokens === "number" && typeof u.completion_tokens === "number";
  return {
    message: message.content ?? "", ...(toolCalls.length ? { toolCalls } : {}),
    usage: { input: u?.prompt_tokens ?? 0, output: u?.completion_tokens ?? 0, ...(typeof u?.prompt_tokens_details?.cached_tokens === "number" ? { cacheRead: u.prompt_tokens_details.cached_tokens } : {}), coverage: measured ? "measured" : "unknown" },
  };
}

export async function respond(p: RespondParams, host: Pick<HostClient, "call">, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<RespondResult> {
  const { account, baseUrl } = p.context.backend;
  const { value: key } = await host.call<{ value: string | null }>("capability.secrets.resolve", { ref: `endpoint/${account}` });
  const deadline = AbortSignal.timeout(p.limits.deadlineMs);
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST", signal: AbortSignal.any([signal, deadline]),
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(chatRequest(p)),
    });
  } catch (error) {
    if (deadline.aborted) throw new PluginError("plugin_timeout", "The model did not answer in time.");
    if (signal.aborted) throw new PluginError("plugin_unavailable", "The turn was cancelled.");
    throw new PluginError("plugin_unavailable", "The model endpoint could not be reached.");
  }
  // Status only: an error body can echo credentials.
  if (!response.ok) throw new PluginError("plugin_unavailable", `The model endpoint answered HTTP ${response.status}.`);
  return chatResult(await response.json());
}

export const handlers = {
  "assistant.respond": (params: unknown, host: HostClient, signal: AbortSignal) => respond(params as RespondParams, host, signal),
};
