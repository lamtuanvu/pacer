/**
 * A test-only plugin that serves `assistant.reply` end to end: it streams `assistant.delta`
 * notifications, runs its tools through `capability.assistant.tool` under the reply call's own
 * authority, and answers with the host's own pipeline output. The user's message names the
 * scenario, so one fixture covers streaming, tool rounds, refusals, cancellation and the deadline.
 *
 * It speaks newline-delimited JSON-RPC on stdio by hand, so the published SDK stays untouched.
 */
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;
const write = (frame: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const cancelled = new Set<string | number>();
/** The `capabilityCall` token of the reply being answered; a delayed call reuses it on purpose. */
let token: string | undefined;
let nextId = 1;

/** One capability call, correlated with the owning reply call the host gave us. */
function toolCall(turnId: string, name: string): Promise<{ name: string; content: string; ok: boolean }> {
  const id = `p${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    write({ id, method: "capability.assistant.tool", params: { turnId, name, params: {} }, ...(token ? { _meta: { capabilityCall: token } } : {}) });
  });
}
const notify = (method: string, params: Json) => write({ method, params });
const delta = (turnId: string, kind: "text" | "activity", text: string) => notify("assistant.delta", { turnId, kind, text });

interface Reply { conversationId: string; turnId: string; session?: string; message: string; system: string; digest: string; tools: unknown[]; history: unknown[]; limits: { maxToolRounds: number; deadlineMs: number } }
const usage = { input: 12, output: 3, coverage: "measured" as const };

async function answer(p: Reply): Promise<{ message: string; session?: string; usage: { input: number; output: number; coverage: "measured" } }> {
  const scenario = p.message.trim();
  // Continuity: echo the handle the host passed, and hand back a new one (or one past the input cap).
  // Streamed text that carries a secret: the host must redact it before it reaches the sheet.
  if (scenario === "leak") { delta(p.turnId, "text", `key: ${["sk", "-reply-test-key"].join("")}`); return { message: "done", usage }; }
  if (scenario === "session") return { message: `got=${p.session ?? "none"}`, session: `s-${p.turnId}`, usage };
  if (scenario === "session big") return { message: `got=${p.session ?? "none"}`, session: "s-big", usage: { ...usage, input: 10_000_000 } };
  // A slow backend: the host's cancel or deadline aborts it, and its reply is dropped.
  if (scenario.startsWith("slow")) { await sleep(5000); return { message: "late", usage }; }

  if (scenario.startsWith("rounds")) {
    let ran = 0, refusal = "";
    for (;;) {
      try {
        const out = await toolCall(p.turnId, "snapshot");
        if (!out.ok) { refusal = `not ok: ${out.content.slice(0, 80)}`; break; }
        ran++;
      } catch (error) { refusal = `${(error as { code?: string }).code ?? "internal"}: ${(error as Error).message}`; break; }
      if (ran > 32) { refusal = "never refused"; break; }
    }
    return { message: `ran=${ran} refused=${refusal}`, usage };
  }

  if (scenario.startsWith("stale")) {
    const other = scenario.slice("stale".length).trim();
    try { await toolCall(other, "snapshot"); return { message: "unexpected success", usage }; }
    catch (error) { return { message: `refused ${(error as { code?: string }).code}: ${(error as Error).message}`, usage }; }
  }

  if (scenario.startsWith("delayed")) {
    // After this reply ends the host revokes the call: a later tool call must be refused, and the
    // plugin says so on its own stderr, which the host writes to its plugin log.
    setTimeout(() => {
      void toolCall(p.turnId, "snapshot").then(
        () => console.error("delayed: unexpectedly allowed"),
        (error: { code?: string }) => console.error(`delayed: ${(error as Error).message}`),
      );
    }, 300);
    return { message: "scheduled", usage };
  }

  // The default scenario: two deltas and one tool run through the host's read pipeline.
  delta(p.turnId, "activity", "Reading tasks…");
  // A delta for a turn that is not running must be dropped, not routed anywhere.
  delta("turn-not-running", "text", "dropped");
  const out = await toolCall(p.turnId, "snapshot");
  delta(p.turnId, "text", "Streamed hello. ");
  return { message: out.content, usage };
}

async function handle(line: string): Promise<void> {
  let frame: Json;
  try { frame = JSON.parse(line) as Json; } catch { return; }
  if (!frame || typeof frame !== "object" || frame.jsonrpc !== "2.0") return;
  const id = frame.id as string | number | undefined;
  const method = frame.method as string | undefined;
  if (method === undefined) {
    // A reply to one of our own capability calls.
    if (id === undefined) return;
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    if (frame.error) waiting.reject(Object.assign(new Error((frame.error as { message?: string }).message ?? "host error"), { code: (frame.error as { data?: { code?: string } }).data?.code }));
    else waiting.resolve(frame.result);
    return;
  }
  if (method === "$/cancel") { cancelled.add((frame.params as { id?: string | number }).id as string | number); return; }
  if (method === "plugin.hello") {
    write({ id, result: { protocol: "1.11.0", id: "fx-reply", version: "1.0.0", contributes: ["assistant"] } });
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
    const result = await answer(frame.params as Reply);
    if (!cancelled.has(id)) write({ id, result });
  } catch (error) {
    if (!cancelled.has(id)) write({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error), data: { code: "internal" } } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", line => { void handle(line); });
