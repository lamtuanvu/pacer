import { z } from "zod";
import { CoreError } from "../core/errors";
import { nativeOnly } from "./native-only";
import type { OpDef } from "./ops";
import { assistantLimitsSchema, backendSchema, retentionSchema, scopeSchema } from "../assistant/types";

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
  "assistant.settings.get": op({ description: "The assistant's account, backend, limits and retention, with a revision for assistant.settings.set.", params: z.object({}), handler: async ctx => (await store()).readSettings(ctx) }),
  "assistant.settings.set": op({ description: "Choose the account and backend the assistant answers on, and its limits and retention. Needs the current revision.",
    params: z.object({ runner: z.string().min(1).max(128).nullable(), account: z.string().min(1).max(64).nullable(), limits: assistantLimitsSchema.partial().optional(), retention: retentionSchema.partial().optional(), expect_rev: z.number().int().positive(), backend: backendSchema.optional() }),
    handler: async (ctx, p) => (await svc()).saveSettings(ctx, p) }),
  "assistant.selftest": op({ description: "Run the fail-closed ask-mode check for one account the executor backend drives: canary turns in ask mode must attempt and be denied a shell command, a file read outside the run directory and a URL fetch, on a first and a resumed turn. Records the result for that account and the installed CLI version. Runs the agent CLI and spends the account's tokens.", params: z.object({ account: z.string().min(1).max(64) }).strict(), handler: nativeOnly("assistant.selftest") }),
  "assistant.candidates": op({ description: "Endpoint accounts the assistant could run on, each with the backend it answers on, whether it is available and why not, and what the assistant is allowed to read.", params: z.object({}), handler: async ctx => { const m = await svc(); return { accounts: m.candidates(ctx), reads: m.READS_SUMMARY }; } }),
  "assistant.card.record": op({ description: "Record the user's decision and the outcome on an action card in the conversation. The app runs the proposed op itself.", params: z.object({ turnId: id, cardId: id, state: z.enum(["done", "failed", "dismissed", "stale"]), result: z.string().max(500).optional() }),
    handler: async (ctx, p) => (await svc()).updateCard(ctx, p.turnId, p.cardId, { state: p.state, ...(p.result !== undefined ? { result: p.result } : {}) }) }),
  "assistant.card.refresh": op({ description: "Rebuild a card whose task changed, with the task's current revision.", params: z.object({ turnId: id, cardId: id }), handler: async (ctx, p) => (await svc()).refreshCard(ctx, p.turnId, p.cardId) }),
  "assistant.tool": op({
    description: "Run one assistant tool for the turn in progress: the host's read pipeline (permitted op, parameter parsing, scope, projection, redaction and size cap), with propose_action becoming a card and its result as delimited data. The turn's assistant grant is the only caller, only while it is live and only for its own turnId; it shares one tool-round budget with capability.assistant.tool, and a call after the turn has ended is refused.",
    params: z.object({ turnId: id, name: z.string().min(1).max(64), params: z.record(z.string(), z.unknown()).optional() }),
    handler: async (ctx, p) => {
      const { assistantTurnById } = await import("../assistant/turn-tools");
      const turn = assistantTurnById(p.turnId);
      if (!turn) throw new CoreError("not_allowed", "That assistant turn has ended; its tools are closed.");
      const { runAssistantTool } = await import("../assistant/service");
      const out = await runAssistantTool(ctx, { id: p.turnId, name: p.name, arguments: p.params ?? {} },
        { read: turn.read, scope: turn.scope, redactor: turn.redactor, cards: turn.cards, state: turn.state });
      return { name: p.name, content: out.content, ok: out.ok };
    },
  }),
};
