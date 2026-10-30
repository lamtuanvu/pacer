import { z } from "zod";
import { CoreError } from "../core/errors";

export const MSG_KINDS = ["message", "question", "answer", "report", "nudge", "close"] as const;
export type MsgKind = typeof MSG_KINDS[number];
export type ParticipantKind = "human" | "external" | "launched";
export const RELATIONS = ["self", "parent", "child", "sibling", "descendant", "ancestor", "top_peer", "same_tree", "none"] as const;
export type Relation = typeof RELATIONS[number];
export type MsgStatus = "held" | "pending" | "delivered" | "read";

export interface Message {
  id: string; taskId: string | null; rootId: string; from: string; to: string; kind: MsgKind; body: string;
  replyTo: string | null; requestId: string | null; status: MsgStatus;
  createdAt: number; deliveredAt: number | null; readAt: number | null; turnId: string | null;
}

export const participantSchema = z.string().regex(/^(human|external:[A-Za-z0-9._:-]{1,128}|task:t-\d{8}-\d{6}-[0-9a-f]{4})$/);
const kindMatch = z.enum(["human", "external", "launched", "any"]);
export const ruleSchema = z.object({
  effect: z.enum(["allow", "deny"]),
  from_kind: kindMatch.optional(),
  to_kind: kindMatch.optional(),
  from_position: z.enum(["top", "child", "any"]).optional(),
  relation: z.union([z.literal("any"), z.array(z.enum(RELATIONS)).min(1)]).optional(),
  kinds: z.array(z.enum(MSG_KINDS)).min(1).optional(),
  repo: z.string().min(1).optional(),
  executor: z.string().min(1).optional(),
  grant: z.enum(["required", "not_required"]).optional(),
  limits: z.object({
    per_minute: z.number().int().positive().optional(),
    max_bytes: z.number().int().positive().max(1 << 20).optional(),
    confirm: z.boolean().optional(),
  }).strict().optional(),
}).strict();
export type Rule = z.infer<typeof ruleSchema>;

export const messagingConfigSchema = z.object({
  defaults: z.boolean().default(true),
  rules: z.array(ruleSchema).max(200).default([]),
  message: z.object({ max_bytes: z.number().int().positive().max(1 << 20).default(65536) }).strict().prefault({}),
  tree: z.object({ max_turns: z.number().int().positive().max(10000).default(50) }).strict().prefault({}),
  // Parsed now so config is stable; consumed by plans 2 and 3.
  liveness: z.object({
    interval_s: z.number().int().min(10).default(60),
    backoff_max_s: z.number().int().min(10).default(900),
    max_nudges: z.number().int().min(0).default(3),
    nudge_in_modes: z.array(z.enum(["relaxed", "normal", "strict", "emergency"])).default(["relaxed", "normal"]),
  }).strict().prefault({}),
  hooks: z.object({ stop: z.enum(["block", "inject_only", "off"]).default("block"), stop_release_after: z.number().int().min(1).default(2) }).strict().prefault({}),
  grants: z.object({ user_started_tasks: z.enum(["on", "off"]).default("on") }).strict().prefault({}),
  // Days a resolved task open for messages keeps its worktree after its last activity; 0 keeps it only for pending messages.
  keep_worktree_days: z.number().int().min(0).max(3650).default(7),
}).strict();
export type MessagingConfig = z.infer<typeof messagingConfigSchema>;

export const messagingOverrideSchema = z.object({
  rules: z.array(ruleSchema).max(50).optional(),
  max_turns: z.number().int().positive().max(10000).optional(),
}).strict();
export type MessagingOverride = z.infer<typeof messagingOverrideSchema>;

export function parseMessagingConfig(raw: unknown): MessagingConfig {
  const parsed = messagingConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new CoreError("invalid_input", "Invalid messaging configuration", undefined, { issues: parsed.error.issues.map(i => ({ path: i.path, message: i.message })) });
  return parsed.data;
}
