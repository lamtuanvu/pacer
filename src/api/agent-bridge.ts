import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import type { OpDeps } from "./ops";

function kind(request: unknown): unknown {
  return request && typeof request === "object" && !Array.isArray(request) ? (request as { kind?: unknown }).kind : undefined;
}

/** Native agent ops over HTTP: Rust refused executor, assistant-grant and enforcement callers and validated the params. Core
 * runs the reference `setup.agentPreview`/`agentConnect`/`agentUndo`/`agentDisconnect`, so the planner-plugin file plan
 * and undo (ARCH-12) run where they live. The front door sets no deadline, so the reply means the operation finished, as
 * it does for a forwarded request. */
export async function agentEffectsBridge(ctx: Ctx, request: unknown, deps: OpDeps = {}): Promise<unknown> {
  const k = kind(request);
  const op = k === "preview" ? "agent.preview" : k === "connect" ? "agent.connect" : k === "undo" ? "agent.undo" : k === "disconnect" ? "agent.disconnect" : undefined;
  if (!op) throw new CoreError("invalid_input", "agent effect required");
  const params = request && typeof request === "object" && !Array.isArray(request) ? (request as { params?: unknown }).params : undefined;
  const { callOp } = await import("./ops");
  return callOp(ctx, op, params, deps);
}