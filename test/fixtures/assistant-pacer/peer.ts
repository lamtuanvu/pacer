/**
 * Stub for the native `assistant-pacer` plugin: speaks the plugin protocol on stdio and
 * answers `assistant.reply` by running tools through `capability.assistant.tool` under the
 * turn's authority. Used when the real `pacer-assistant-pacer` binary is not built yet.
 *
 * Capability requests only attach `_meta.capabilityCall` (same as the Rust SDK). They do not
 * forward other host `_meta` fields the real SDK ignores.
 */
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, unknown>;
const write = (frame: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
const bundled = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../crates/assistant-pacer/manifest.json"), "utf8"),
) as { id: string; version: string };

const pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
/** Provider calls in flight, so a host `$/cancel` stops the same turn's fake request. */
const providerCalls = new Map<string | number, AbortController>();
let token: string | undefined;
let nextId = 1;

function toolCall(turnId: string, name: string): Promise<{ name: string; content: string; ok: boolean }> {
  const id = `p${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    // Match the Rust SDK: only capabilityCall, and only when the owning reply carried one.
    const frame: Json = { id, method: "capability.assistant.tool", params: { turnId, name, params: {} } };
    if (token) frame._meta = { capabilityCall: token };
    write(frame);
  });
}

const usage = { input: 7, output: 2, coverage: "measured" as const };

async function answer(id: string | number | undefined, p: {
  turnId: string;
  message: string;
  endpoint?: { api?: string; baseUrl?: string; keyless?: boolean };
}): Promise<{ message: string; usage: typeof usage }> {
  const scenario = p.message.trim();
  if (scenario === "ping") return { message: "assistant-pacer stub", usage };
  if (scenario === "endpoint") {
    return {
      message: `api=${p.endpoint?.api ?? ""};baseUrl=${p.endpoint?.baseUrl ?? ""};keyless=${p.endpoint?.keyless === true}`,
      usage,
    };
  }
  if (scenario === "leak-key") {
    throw Object.assign(new Error(`provider said key=${["sk", "-reply-test-key"].join("")} is bad`), {
      code: "plugin_unavailable",
    });
  }
  // Front-door turns ask this question against a fake OpenAI-compatible endpoint. Call it the
  // way the real plugin would, so the host sees a live turn a cancel can stop and a later turn
  // can answer. Other callers of this stub keep the tool-round scenarios below.
  if (scenario === "What is running?" && p.endpoint?.baseUrl) {
    const controller = new AbortController();
    if (id !== undefined) providerCalls.set(id, controller);
    try {
      const response = await fetch(`${p.endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: p.message }] }),
        signal: controller.signal,
      });
      if (!response.ok) throw Object.assign(new Error(`fixture endpoint returned ${response.status}`), { code: "plugin_unavailable" });
      const body = await response.json() as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        message: body.choices?.[0]?.message?.content ?? "",
        usage: { input: body.usage?.prompt_tokens ?? 0, output: body.usage?.completion_tokens ?? 0, coverage: "measured" },
      };
    } finally {
      if (id !== undefined) providerCalls.delete(id);
    }
  }
  const out = await toolCall(p.turnId, "snapshot");
  return { message: `via-tool ${out.content}`, usage };
}

async function handle(line: string): Promise<void> {
  let frame: Json;
  try { frame = JSON.parse(line) as Json; } catch { return; }
  if (!frame || typeof frame !== "object" || frame.jsonrpc !== "2.0") return;
  const id = frame.id as string | number | undefined;
  const method = frame.method as string | undefined;
  if (method === undefined) {
    if (id === undefined) return;
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    if (frame.error) waiting.reject(Object.assign(new Error((frame.error as { message?: string }).message ?? "host error"), { code: (frame.error as { data?: { code?: string } }).data?.code }));
    else waiting.resolve(frame.result);
    return;
  }
  if (method === "$/cancel") {
    const cancelled = (frame.params as { id?: string | number } | undefined)?.id;
    if (cancelled !== undefined) providerCalls.get(cancelled)?.abort();
    else for (const controller of providerCalls.values()) controller.abort();
    return;
  }
  if (method === "plugin.hello") {
    write({ id, result: { protocol: "1.12.0", id: bundled.id, version: bundled.version, contributes: ["assistant"] } });
    return;
  }
  if (id === undefined || id === null) return;
  if (method !== "assistant.reply") {
    write({ id, error: { code: -32601, message: `unknown method ${method}`, data: { code: "unknown_op" } } });
    return;
  }
  const meta = frame._meta as { capabilityCall?: string } | undefined;
  token = meta?.capabilityCall;
  try {
    write({
      id,
      result: await answer(id, frame.params as {
        turnId: string;
        message: string;
        endpoint?: { api?: string; baseUrl?: string; keyless?: boolean };
      }),
    });
  } catch (error) {
    write({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error), data: { code: "internal" } } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", line => { void handle(line); });
