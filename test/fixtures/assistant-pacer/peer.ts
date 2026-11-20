/**
 * Stub for the native `assistant-pacer` plugin: speaks the plugin protocol on stdio and
 * answers `assistant.reply` by running tools through `capability.assistant.tool` under the
 * turn's authority. Used when the real `pacer-assistant-pacer` binary is not built yet.
 */
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;
const write = (frame: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);

const pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let token: string | undefined;
let nextId = 1;

function toolCall(turnId: string, name: string): Promise<{ name: string; content: string; ok: boolean }> {
  const id = `p${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    write({
      id,
      method: "capability.assistant.tool",
      params: { turnId, name, params: {} },
      ...(token ? { _meta: { capabilityCall: token } } : {}),
    });
  });
}

const usage = { input: 7, output: 2, coverage: "measured" as const };

async function answer(p: { turnId: string; message: string }): Promise<{ message: string; usage: typeof usage }> {
  const scenario = p.message.trim();
  if (scenario === "ping") return { message: "assistant-pacer stub", usage };
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
  if (method === "$/cancel") return;
  if (method === "plugin.hello") {
    write({ id, result: { protocol: "1.11.0", id: "assistant-pacer", version: "1.0.0", contributes: ["assistant"] } });
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
    write({ id, result: await answer(frame.params as { turnId: string; message: string }) });
  } catch (error) {
    write({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error), data: { code: "internal" } } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", line => { void handle(line); });
