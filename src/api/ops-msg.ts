import { z } from "zod";
import type { OpDef } from "./ops";
import { CoreError } from "../core/errors";
import { workTree } from "../dispatch/work";
import { callerParticipant, parentOf, rootOf, taskOf } from "../messaging/participants";
import { checkSend, effectivePolicy } from "../messaging/policy";
import { sendMessage } from "../messaging/send";
import * as store from "../messaging/store";
import { deliver, isClosed, readMessages } from "../messaging/turns";
import { MSG_KINDS, participantSchema, type Message } from "../messaging/types";
import { readTask, updateTask } from "../tasks/store";
import { autoCleanTask } from "../tasks/cleanup";

const op = <P extends z.ZodTypeAny>(def: OpDef<P>) => def as unknown as OpDef;
const taskId = z.string().regex(/^t-\d{8}-\d{6}-[0-9a-f]{4}$/);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Executors may read only threads in their own tree; planners and the human read any. */
function assertCanRead(ctx: Parameters<OpDef["handler"]>[0], deps: Parameters<OpDef["handler"]>[2], task: string): void {
  const me = callerParticipant(ctx, deps).id;
  if (!taskOf(me) || rootOf(ctx, me) === rootOf(ctx, `task:${task}`)) return;
  throw new CoreError("not_allowed", "That task is outside your tree", undefined, { reason: "msg_forbidden", layer: "protocol" });
}

export const msgOps: Record<string, OpDef> = {
  "msg.send": op({
    description: "Send a message to another participant. A message to a settled task starts a turn that resumes its native session.",
    params: z.object({ to: participantSchema, body: z.string().min(1).max(1 << 20), kind: z.enum(MSG_KINDS).optional(), reply_to: z.string().max(64).optional(), request_id: z.string().min(1).max(128).optional() }).strict(),
    handler: (ctx, p, deps) => sendMessage(ctx, { to: p.to, body: p.body, kind: p.kind, replyTo: p.reply_to, requestId: p.request_id }, deps),
  }),
  "msg.inbox": op({
    description: "Messages addressed to the caller.",
    params: z.object({ unread_only: z.boolean().optional(), limit: z.number().int().min(1).max(1000).optional() }).strict(),
    handler: (ctx, p, deps) => {
      const me = callerParticipant(ctx, deps).id;
      return { participant: me, messages: store.inbox(ctx, me, { unreadOnly: p.unread_only ?? true, limit: p.limit }) };
    },
  }),
  "msg.wait": op({
    description: "Block until a message for the caller arrives, or a reply to reply_to, or timeout_s passes (max 3000).",
    params: z.object({ reply_to: z.string().max(64).optional(), timeout_s: z.number().int().min(1).max(3000).optional() }).strict(),
    handler: async (ctx, p, deps) => {
      const me = callerParticipant(ctx, deps).id;
      const until = Date.now() + (p.timeout_s ?? 600) * 1000;
      const original = p.reply_to ? store.getMessage(ctx, p.reply_to) : null;
      // A reply names the message, or is the recipient's later report, answer or question back.
      const replies = (m: Message) => m.replyTo === p.reply_to || (!!original && m.from === original.to && ["report", "answer", "question"].includes(m.kind)
        && (m.createdAt > original.createdAt || (m.createdAt === original.createdAt && m.id > original.id)));
      for (;;) {
        const unread = store.inbox(ctx, me, { unreadOnly: true });
        const hits = p.reply_to ? unread.filter(replies) : unread;
        if (hits.length) {
          // Waiting consumes what it returns; msg.inbox does not.
          readMessages(ctx, me, hits.map(m => m.id), Date.now() / 1000);
          return { participant: me, messages: hits.map(m => store.getMessage(ctx, m.id) ?? m), timedOut: false };
        }
        if (Date.now() >= until) return { participant: me, messages: [], timedOut: true };
        await sleep(500);
      }
    },
  }),
  "msg.log": op({
    description: "A task's message thread.",
    params: z.object({ task: taskId, after: z.string().max(64).optional(), limit: z.number().int().min(1).max(1000).optional() }).strict(),
    handler: (ctx, p, deps) => { assertCanRead(ctx, deps, p.task); return { messages: store.thread(ctx, p.task, { after: p.after, limit: p.limit }) }; },
  }),
  "msg.read": op({
    description: "Mark the caller's messages read.",
    params: z.object({ ids: z.array(z.string().max(64)).min(1).max(500) }).strict(),
    handler: (ctx, p, deps) => ({ read: readMessages(ctx, callerParticipant(ctx, deps).id, p.ids) }),
  }),
  "msg.confirm": op({
    description: "Release a message that a guardrail held for human confirmation.",
    params: z.object({ id: z.string().max(64) }).strict(),
    handler: (ctx, p, deps) => {
      if (callerParticipant(ctx, deps).id !== "human") throw new CoreError("not_allowed", "Only the human confirms held messages", undefined, { reason: "msg_forbidden", layer: "protocol" });
      const m = store.confirmHeld(ctx, p.id);
      return { message: m, delivery: deliver(ctx, m.to, deps.spawnRunner) };
    },
  }),
  "msg.close": op({
    description: "Close a task for further messages and release its worktree when it is otherwise cleanable. Records no review verdict.",
    params: z.object({ task: taskId }).strict(),
    handler: async (ctx, p, deps) => {
      // Closing is not a send: only the node's parent, the tree's origin or the human may close it.
      const me = callerParticipant(ctx, deps).id, node = `task:${p.task}`;
      if (!readTask(ctx, p.task)) throw new CoreError("not_found", `Unknown participant ${node}`);
      if (me !== "human" && me !== parentOf(ctx, node) && me !== parentOf(ctx, rootOf(ctx, node)))
        throw new CoreError("not_allowed", `Only the parent of ${node}, its tree's origin or the human may close it`, undefined, { reason: "msg_forbidden", layer: "protocol" });
      const t = updateTask(ctx, p.task, x => { x.msgClosed = true; });
      // A resolved task kept its worktree only for messages: release it now, as a verdict does. Best effort.
      await autoCleanTask(ctx, t.id);
      return { task: t.id, closed: true };
    },
  }),
  "msg.policy": op({
    description: "The effective messaging guardrail, or which rule decides a hypothetical send.",
    params: z.object({ task: taskId.optional(), check: z.object({ from: participantSchema, to: participantSchema, kind: z.enum(MSG_KINDS), grant: z.boolean().optional() }).strict().optional() }).strict(),
    handler: (ctx, p) => {
      const policy = effectivePolicy(ctx, { root: p.task ? rootOf(ctx, `task:${p.task}`) : undefined });
      if (!p.check) return policy;
      try { return { ...policy, check: checkSend(ctx, { from: p.check.from, to: p.check.to, kind: p.check.kind, bytes: 0, hasGrant: !!p.check.grant }) }; }
      catch (e) { return { ...policy, check: { decision: "deny", error: e instanceof CoreError ? { code: e.code, message: e.message, data: e.data } : String(e) } }; }
    },
  }),
  "tree.status": op({
    description: "Turn state of every node in a task's tree.",
    params: z.object({ task: taskId }).strict(),
    handler: (ctx, p, deps) => {
      assertCanRead(ctx, deps, p.task);
      const root = taskOf(rootOf(ctx, `task:${p.task}`)) ?? p.task;
      let ids = [root];
      try { ids = workTree(ctx, root).nodes.map(n => n.taskId); } catch (e) { if (!(e instanceof CoreError && e.code === "unknown_task")) throw e; }
      const nodes = [root, ...ids.filter(i => i !== root)].map(id => {
        const t = readTask(ctx, id);
        const pending = store.pendingFor(ctx, `task:${id}`).length;
        return { id: `task:${id}`, state: t?.state ?? "missing", closed: t ? isClosed(t) : true, pendingTurn: t?.pendingTurn ?? null, pending,
          executor: t?.executor ?? null };
      });
      return { root: `task:${root}`, nodes, turns: store.turnsForRoot(ctx, `task:${root}`) };
    },
  }),
};
