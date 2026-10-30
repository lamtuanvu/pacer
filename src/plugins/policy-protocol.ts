import { callMetadata } from "./usage-protocol";
import { z } from "zod";
import { KINDS } from "../config/strategy";
import type { MethodDef } from "./protocol";

export const readOwnerMetadata = z
  .object({
    readOwner: z.string().min(1).max(256),
    capabilityCall: z.never().optional(),
  })
  .passthrough();
/** Exactly one authority domain; old callMetadata remains unchanged for old consumers. */
export const pluginMetadata = z
  .xor([
    callMetadata.unwrap().extend({ readOwner: z.never().optional() }),
    readOwnerMetadata,
  ])
  .optional();
export const POLICY_OBSERVATIONS_FEATURE = "policyObservations";
export const POLICY_DECISIONS = ["delegate", "route", "review"] as const;
export const POLICY_EVENT_TYPES = [
  "desktop.update",
  "plugin",
  "pause",
  "task",
  "mode",
  "config",
  "reset",
  "planner",
  "executor",
  "account",
  "host",
  "repo",
  "counts",
  "attention",
  "activity",
  "job",
  "notify",
  "machine",
  "assistant",
  "discovery.found",
] as const;
export const POLICY_TASK_STATES = [
  "queued",
  "running",
  "done",
  "partial",
  "failed",
  "limit",
  "stopped",
  "needs_input",
] as const;
const id = z.string().min(1).max(128),
  kind = z.enum(KINDS).nullable(),
  placement = z.enum(["current", "new", "auto"]);
const delegateInput = z
  .object({
    goal: z.string().max(200000),
    repo: z.string().min(1).max(4096),
    kind: z.string().min(1).max(128).nullable(),
    requestedExecutor: id.nullable(),
    placement,
  })
  .strict();
const routeInput = z.object({ taskId: id, candidates: z.array(id) }).strict();
const reviewInput = z
  .object({
    taskId: id,
    revision: z.number().int().nonnegative().safe(),
    state: z.enum(POLICY_TASK_STATES),
    verdict: z.enum(["accept", "reject", "send_back", "retry"]),
    note: z.string().max(4096).optional(),
    kind: kind.optional(),
    executor: id.optional(),
  })
  .strict();
export const policyBeforeParams = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("delegate"), input: delegateInput }).strict(),
  z.object({ decision: z.literal("route"), input: routeInput }).strict(),
  z.object({ decision: z.literal("review"), input: reviewInput }).strict(),
]);
export const policyDelegateAmend = z
  .object({
    kind: kind.optional(),
    requestedExecutor: id.nullable().optional(),
    placement: placement.optional(),
  })
  .strict();
export const policyRouteAmend = z.object({ exclude: z.array(id) }).strict();
const reason = z.string().max(512).optional();
export const policyVerdict = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("allow"), reason }).strict(),
  z.object({ verdict: z.literal("veto"), reason }).strict(),
  z
    .object({
      verdict: z.literal("amend"),
      amend: z.union([policyDelegateAmend, policyRouteAmend]),
      reason,
    })
    .strict(),
]);
export const policyEvent = z
  .object({
    seq: z.number().int().nonnegative().safe(),
    at: z.number(),
    type: z.enum(POLICY_EVENT_TYPES),
    data: z.json(),
  })
  .strict();
export type PolicyBeforeParams = z.infer<typeof policyBeforeParams>;
export type PolicyVerdict = z.infer<typeof policyVerdict>;
export type PolicyEvent = z.infer<typeof policyEvent>;
const method = <P extends z.ZodType, R extends z.ZodType>(
  description: string,
  params: P,
  result: R,
  deadlineMs: number,
) => ({ description, params, result, deadlineMs }) as unknown as MethodDef;
export const POLICY_METHODS: Record<string, MethodDef> = {
  "policy.before": method(
    "Judge a decision before host mutation. Amend only the fields allowed for that decision; review permits allow or veto only.",
    policyBeforeParams,
    policyVerdict,
    3000,
  ),
};
// Contracts only. The broker and generation-owned subscription lifecycle are a later batch.
const task = z.object({ id, state: z.enum(POLICY_TASK_STATES) }).passthrough();
export const POLICY_CAPABILITY_METHODS: Record<string, MethodDef> = {
  "capability.tasks.read": method(
    "Read one existing public API task detail; never raw state or credentials.",
    z.object({ id }).strict(),
    z.object({ task }).strict(),
    3000,
  ),
  "capability.tasks.list": method(
    "List public API task summaries, filtering states before the bounded limit (default 100).",
    z
      .object({
        states: z
          .array(z.enum(POLICY_TASK_STATES))
          .max(POLICY_TASK_STATES.length)
          .optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    z.object({ tasks: z.array(task).max(500) }).strict(),
    5000,
  ),
  "capability.events.subscribe": method(
    "Subscribe to future v3 API events. Requires a current host call or generation read owner; reset requires resnapshot. Subscription authority is read-only and retires with its process/config/grant generation.",
    z
      .object({ types: z.array(z.enum(POLICY_EVENT_TYPES)).min(1).max(32) })
      .strict(),
    z
      .object({ ok: z.literal(true), readOwner: z.string().min(1).max(256) })
      .strict(),
    2000,
  ),
};
export const POLICY_METHOD_CAPABILITY = {
  "capability.tasks.read": "tasks.read",
  "capability.tasks.list": "tasks.read",
  "capability.events.subscribe": "events.subscribe",
} as const;
