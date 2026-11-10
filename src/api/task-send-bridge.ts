import { CoreError } from "../core/errors";
import { authorizeWorkOperation } from "../core/work";
import { send } from "../session/send";
import { isTaskId } from "../tasks/store";
import type { Ctx } from "../types";

/**
 * Core's side of native `task.send` (`crates/task-ops/src/task_send_ops.rs`), which has already validated the params,
 * refused enforcement identities and answered the refusals the locked task record decides. `send` runs the whole
 * TypeScript send with the caller Rust named; it rechecks every refusal under the task lock, then decides the live
 * worker and the driving lease there.
 */
export async function taskSendBridge(ctx: Ctx, request: unknown): Promise<unknown> {
  authorizeWorkOperation(ctx, "task.send", request);
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new CoreError("invalid_input", "request required");
  const r = request as Record<string, unknown>;
  if (r.kind !== "send") throw new CoreError("invalid_input", "kind must be send");
  if (typeof r.id !== "string" || !isTaskId(r.id)) throw new CoreError("invalid_input", "id required");
  if (typeof r.text !== "string" || typeof r.by !== "string" || !r.by) throw new CoreError("invalid_input", "text and by required");
  if (r.expectRev !== undefined && (typeof r.expectRev !== "number" || !Number.isSafeInteger(r.expectRev))) {
    throw new CoreError("invalid_input", "expectRev must be an integer");
  }
  return send(ctx, r.id, r.text, { force: r.force === true, by: r.by, expectRev: r.expectRev as number | undefined });
}
