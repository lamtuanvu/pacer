import { z } from "zod";
import { CoreError } from "../core/errors";
import type { OpDef } from "./ops";
import { assistantLimitsSchema, retentionSchema, scopeSchema } from "../assistant/types";

const id = z.string().min(1).max(128);
const op = <P extends z.ZodTypeAny>(definition: OpDef<P>) => definition as unknown as OpDef;
const svc = () => import("../assistant/service");
const store = () => import("../assistant/store");

/** Client protocol v3 assistant ops (additive). Executor sessions get not_allowed for all of them (caller policy). */
export const assistantOps: Record<string, OpDef> = {
  "assistant.status": op({ description: "Whether the assistant is available, which account answers, why not when it is not, its limits and today's use.", params: z.object({}), handler: async ctx => (await svc()).assistantStatus(ctx) }),
  "assistant.ask": op({ description: "Ask the assistant one question. The answer streams from /v3/assistant/turns/<turnId>/stream; nothing runs until the user confirms a proposed action.",
    params: z.object({ conversationId: id.optional(), text: z.string().min(1).max(4000), scope: scopeSchema, requestId: id }),
    handler: async (ctx, p) => (await svc()).ask(ctx, p) }),
  "assistant.cancel": op({ description: "Cancel a turn that is still being answered.", params: z.object({ turnId: id }), handler: async (ctx, p) => (await svc()).cancel(ctx, p.turnId) }),
  "assistant.conversations": op({ description: "A page of assistant conversations, newest first.", params: z.object({ before: z.number().optional(), limit: z.number().int().min(1).max(100).optional() }),
    handler: async (ctx, p) => ({ conversations: (await svc()).listHistory(ctx, p) }) }),
  "assistant.conversation": op({ description: "The turns of one conversation, with action cards and their outcomes.", params: z.object({ id }), handler: async (ctx, p) => ({ id: p.id, turns: (await store()).conversationTurns(ctx, p.id) }) }),
  "assistant.turn": op({ description: "One turn, for reading its final state after a stream ends.", params: z.object({ turnId: id }), handler: async (ctx, p) => {
    const turn = (await store()).getTurn(ctx, p.turnId);
    if (!turn) throw new CoreError("not_found", "Unknown turn.");
    return turn;
  } }),
  "assistant.delete": op({ description: "Delete one conversation, or every conversation without an id. Usage figures stay, without the text.", params: z.object({ id: id.optional() }), handler: async (ctx, p) => (await svc()).deleteConversations(ctx, p.id) }),
  "assistant.settings.get": op({ description: "The assistant's account, limits and retention, with a revision for assistant.settings.set.", params: z.object({}), handler: async ctx => (await store()).readSettings(ctx) }),
  "assistant.settings.set": op({ description: "Choose the executor account the assistant runs on, and its limits and retention. Needs the current revision.",
    params: z.object({ runner: z.string().min(1).max(128).nullable(), account: z.string().min(1).max(64).nullable(), limits: assistantLimitsSchema.partial().optional(), retention: retentionSchema.partial().optional(), expect_rev: z.number().int().positive() }),
    handler: async (ctx, p) => (await svc()).saveSettings(ctx, p) }),
  "assistant.candidates": op({ description: "Endpoint accounts the assistant could run on, and what it is allowed to read.", params: z.object({}), handler: async ctx => { const m = await svc(); return { accounts: m.candidates(ctx), reads: m.READS_SUMMARY }; } }),
  "assistant.card.record": op({ description: "Record the user's decision and the outcome on an action card in the conversation. The app runs the proposed op itself.", params: z.object({ turnId: id, cardId: id, state: z.enum(["done", "failed", "dismissed", "stale"]), result: z.string().max(500).optional() }),
    handler: async (ctx, p) => (await svc()).updateCard(ctx, p.turnId, p.cardId, { state: p.state, ...(p.result !== undefined ? { result: p.result } : {}) }) }),
  "assistant.card.refresh": op({ description: "Rebuild a card whose task changed, with the task's current revision.", params: z.object({ turnId: id, cardId: id }), handler: async (ctx, p) => (await svc()).refreshCard(ctx, p.turnId, p.cardId) }),
};
