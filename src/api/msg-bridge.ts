import { CoreError } from "../core/errors";
import { publishTaskMessages } from "../messaging/publish";
import { getMessage } from "../messaging/store";
import { deliver, notifyMessage } from "../messaging/turns";
import type { SpawnRunner } from "../tasks/api";
import type { Ctx } from "../types";

/** Native message writes: Core admits and launches a recipient's turn and republishes the human's tasks. */
export async function msgEffectsBridge(ctx: Ctx, request: unknown, spawn?: SpawnRunner): Promise<unknown> {
  const r = request && typeof request === "object" && !Array.isArray(request) ? request as Record<string, unknown> : {};
  if (r.kind === "deliver" && typeof r.to === "string") return deliver(ctx, r.to, spawn);
  if (r.kind === "notify" && typeof r.id === "string") {
    const m = getMessage(ctx, r.id);
    if (m) await notifyMessage(ctx, m);
    return { ok: true };
  }
  if (r.kind === "publish" && Array.isArray(r.taskIds) && r.taskIds.every(id => id === null || typeof id === "string")) {
    await publishTaskMessages(ctx, r.taskIds as (string | null)[]);
    return { ok: true };
  }
  throw new CoreError("invalid_input", "message effect required");
}
