import { CoreError } from "../core/errors";
import type { SpawnRunner } from "../tasks/api";
import type { Ctx } from "../types";
import { callerParticipant, rootOf, taskOf } from "./participants";
import { checkSend } from "./policy";
import * as store from "./store";
import { assertOpen, deliver, notifyMessage, type Delivery } from "./turns";
import { participantSchema, type Message, type MsgKind } from "./types";

export interface SendInput { to: string; kind?: MsgKind; body: string; replyTo?: string; requestId?: string }
export interface SendDeps { appAuthenticated?: boolean; participant?: string; spawnRunner?: SpawnRunner }

export async function sendMessage(ctx: Ctx, input: SendInput, deps: SendDeps = {}): Promise<{ message: Message; duplicate: boolean; delivery: Delivery }> {
  if (!participantSchema.safeParse(input.to).success) throw new CoreError("invalid_input", `Invalid participant ${input.to}`);
  const kind = input.kind ?? "message";
  if (kind === "nudge") throw new CoreError("not_allowed", "Only the broker sends nudges", undefined, { reason: "msg_forbidden", layer: "protocol" });
  if (kind === "answer" && !input.replyTo) throw new CoreError("invalid_input", "An answer needs reply_to");
  const body = input.body.trim();
  if (!body) throw new CoreError("invalid_input", "Message body is empty");
  const caller = callerParticipant(ctx, deps);
  assertOpen(ctx, input.to);
  const verdict = checkSend(ctx, { from: caller.id, to: input.to, kind, bytes: Buffer.byteLength(body, "utf8"), hasGrant: !!caller.grant });
  const taskId = taskOf(input.to) ?? taskOf(caller.id);
  const root = taskOf(input.to) ? rootOf(ctx, input.to) : rootOf(ctx, caller.id);
  const r = store.insertMessage(ctx, { taskId, rootId: root, from: caller.id, to: input.to, kind, body, replyTo: input.replyTo ?? null,
    requestId: input.requestId ?? null, status: verdict.hold ? "held" : "pending" });
  if (r.duplicate) return { ...r, delivery: r.message.status === "held" ? "held" : "queued" };
  notifyMessage(ctx, r.message);
  const delivery = verdict.hold ? "held" : deliver(ctx, input.to, deps.spawnRunner);
  return { ...r, delivery };
}
