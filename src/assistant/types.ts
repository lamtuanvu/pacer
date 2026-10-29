import { z } from "zod";

/** Limits the host enforces on every turn. All are configurable within these bounds. */
export const assistantLimitsSchema = z.object({
  maxInputTokens: z.number().int().min(1000).max(200_000).default(32_000),
  maxOutputTokens: z.number().int().min(100).max(32_000).default(8_000),
  maxToolRounds: z.number().int().min(0).max(6).default(6),
  turnsPerDay: z.number().int().min(1).max(1000).default(50),
  deadlineMs: z.number().int().min(1000).max(120_000).default(120_000),
});
export type AssistantLimits = z.infer<typeof assistantLimitsSchema>;

export const retentionSchema = z.object({ days: z.number().int().min(1).max(365).default(30), conversations: z.number().int().min(1).max(1000).default(200) });
export type AssistantRetention = z.infer<typeof retentionSchema>;

export interface AssistantSettings { runner: string | null; account: string | null; limits: AssistantLimits; retention: AssistantRetention; rev: number }

export const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dispatch"), days: z.number().int().min(1).max(90).default(7) }),
  z.object({ kind: z.literal("task"), id: z.string().min(1).max(128) }),
  z.object({ kind: z.literal("repo"), repo: z.string().min(1).max(4096) }),
]);
export type AssistantScope = z.infer<typeof scopeSchema>;

export type Coverage = "measured" | "partial" | "unknown";
export interface AssistantUsage { input: number; output: number; cacheRead?: number; cacheWrite?: number; coverage: Coverage }

export interface ProposedCall { id: string; name: string; arguments: Record<string, unknown> }
export interface AssistantMessage { role: "user" | "assistant" | "tool"; content: string; toolCalls?: ProposedCall[]; toolCallId?: string }

export const ACTION_OPS = ["dispatch.retry", "task.retry", "dispatch.stop", "task.stop", "dispatch.answer", "task.answer", "delegation.pause", "delegation.resume", "dispatch.submit"] as const;
export type ActionOp = (typeof ACTION_OPS)[number];

export interface ActionCard {
  id: string; op: ActionOp | "navigate"; params: Record<string, unknown>;
  /** Drawn by the host from the op and its params. Never model text. */
  title: string; summary: string;
  /** Free-text parameters shown editable on the card. */
  editable: { name: string; label: string; value: string }[];
  /** The assistant's own words, shown beneath the card and labelled as such. */
  why: string; href?: string;
  state: "pending" | "done" | "failed" | "dismissed" | "stale"; result?: string;
}

export interface Citation { label: string; href: string }
export interface TurnView {
  id: string; conversationId: string; at: number; question: string; answer: string | null; state: "running" | "done" | "error" | "cancelled" | "refused";
  error: string | null; account: string | null; usage: AssistantUsage | null; cards: ActionCard[]; citations: Citation[]; scope: AssistantScope;
}
export interface ConversationView { id: string; title: string; updatedAt: number; turns: number }
