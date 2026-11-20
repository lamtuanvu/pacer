import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { clientIdentity } from "./client-identity";
import { callOp, type OpDeps } from "./ops";

/** The operations `crates/task-ops/src/session_lifecycle_ops.rs` admits and hands to Core over HTTP. */
const OPERATIONS = new Set([
  "session.create", "session.resume", "session.end", "session.prepare", "session.draft.create", "session.file.read", "session.attachment.prepare",
  "session.agent.create", "session.agent.list", "session.agent.get", "session.agent.end", "session.agent.retry", "session.agent.resume",
  "task.attach", "task.session", "task.takeover", "task.hand_back",
]);

/**
 * Core's side of the native session lifecycle. Rust has refused what it can decide alone; `callOp` runs the same
 * authorization, schema and handler as a forwarded request, with the caller identity the front door received.
 */
export async function sessionLifecycleBridge(ctx: Ctx, request: unknown, deps: OpDeps = {}): Promise<unknown> {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new CoreError("invalid_input", "request required");
  const r = request as Record<string, unknown>;
  if (typeof r.op !== "string" || !OPERATIONS.has(r.op)) throw new CoreError("invalid_input", "op is not a session lifecycle operation");
  const identity = clientIdentity(typeof r.client === "string" ? r.client : "", typeof r.clientInstance === "string" ? r.clientInstance : "");
  return callOp(ctx, r.op, r.params, { ...deps, ...identity });
}
