import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { callOp } from "./ops";

/** The public op body limit; a valid ask is far smaller. */
export const ASSISTANT_TURN_MAX = 256 * 1024;

/** The HTTP route's body: `{ request }`, read up to the limit. */
export async function readAssistantTurnBody(req: Request): Promise<unknown> {
  const tooLarge = () => new CoreError("too_large", "body exceeds 256 KiB");
  if (Number(req.headers.get("content-length")) > ASSISTANT_TURN_MAX) throw tooLarge();
  const reader = req.body?.getReader(), decoder = new TextDecoder();
  let text = "", bytes = 0;
  if (reader) for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > ASSISTANT_TURN_MAX) { await reader.cancel(); throw tooLarge(); }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new CoreError("invalid_input", "params: invalid JSON"); }
  return body && typeof body === "object" && !Array.isArray(body) ? (body as { request?: unknown }).request : undefined;
}

/**
 * Core's side of native `assistant.ask` and `assistant.cancel` (`crates/assistant-ops/src/assistant_ops/turn.rs`).
 * The turn stays in this process, beside its live-turn map and its stream. The context carries no request signal, so
 * a turn outlives the bridge call that started it. `callOp` repeats the caller policy and the params check.
 */
export async function assistantTurnBridge(ctx: Ctx, request: unknown): Promise<unknown> {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new CoreError("invalid_input", "request required");
  const { op, params } = request as { op?: unknown; params?: unknown };
  if (op !== "assistant.ask" && op !== "assistant.cancel") throw new CoreError("invalid_input", "op must be assistant.ask or assistant.cancel");
  return callOp(ctx, op, params);
}
