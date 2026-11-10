import { CoreError } from "../core/errors";
import { assertLiveInput, send } from "../session/send";
import { isTaskId, readTask } from "../tasks/store";
import type { Ctx } from "../types";

/**
 * Core's side of native `task.send` (`crates/task-ops/src/task_send_ops.rs`), which has already validated the params
 * and refused from the task record. `probe` answers whether the lane can take live input, before Rust reports another
 * caller's driving lease; `send` runs the whole TypeScript send under the task lock, rechecking every refusal.
 */
export async function taskSendBridge(ctx: Ctx, request: unknown): Promise<unknown> {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new CoreError("invalid_input", "request required");
  const r = request as Record<string, unknown>;
  if (typeof r.id !== "string" || !isTaskId(r.id)) throw new CoreError("invalid_input", "id required");
  if (r.kind === "probe") {
    const task = readTask(ctx, r.id);
    if (!task) throw new CoreError("unknown_task", `unknown task ${r.id}`);
    assertLiveInput(task);
    return null;
  }
  if (r.kind !== "send") throw new CoreError("invalid_input", "kind must be probe or send");
  if (typeof r.text !== "string" || typeof r.by !== "string" || !r.by) throw new CoreError("invalid_input", "text and by required");
  if (r.expectRev !== undefined && (typeof r.expectRev !== "number" || !Number.isSafeInteger(r.expectRev))) {
    throw new CoreError("invalid_input", "expectRev must be an integer");
  }
  return send(ctx, r.id, r.text, { force: r.force === true, by: r.by, expectRev: r.expectRev as number | undefined });
}
