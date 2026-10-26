import { z } from "zod";
import type { UsageReading } from "../types";

// Results are additive. Preserve evidence and future fields at every object layer.
export const usageWindow = z.object({ name: z.string(), usedPct: z.number().nullable(), resetsAt: z.number().nullable(),
  lengthS: z.number(), paced: z.boolean(), stale: z.boolean().optional() }).passthrough();
const spending = z.object({ creditsAvailable: z.boolean().nullable(), creditBalance: z.number().nullable(),
  paidConsumption: z.enum(["observed", "not_observed", "unknown"]) }).passthrough();
const scope = z.object({ account: z.string(), identity: z.string(), runner: z.string().optional(),
  model: z.string().optional(), host: z.string().optional() }).passthrough();
const fact = z.object({ id: z.string(), scope, source: z.enum(["status-line", "session-log", "provider-cli", "metered", "reactive", "unmetered", "execution", "configuration"]),
  observedAt: z.number().nullable(), validUntil: z.number().nullable(), reason: z.string(), budgetPolicy: z.string().optional() });
const evidence = z.object({ availability: z.array(fact.extend({ value: z.enum(["ready", "unavailable", "unknown"]) }).passthrough()),
  budget: z.array(fact.extend({ value: usageWindow }).passthrough()), spending: z.array(fact.extend({ value: spending }).passthrough()) }).passthrough();
export const usageReading: z.ZodType<UsageReading> = z.lazy(() => z.object({
  windows: z.array(usageWindow), capturedAt: z.number().nullable(), stale: z.boolean(),
  alternatives: z.array(usageReading).optional(), evidence: evidence.optional(),
  availability: z.object({ state: z.enum(["ready", "unavailable", "unknown"]), reason: z.string(), validUntil: z.number().nullable() }).passthrough().optional(),
  spending: spending.optional(), source: z.enum(["status-line", "session-log", "provider-cli", "metered", "reactive", "unmetered"]).optional(),
  remoteHost: z.string().optional(), error: z.string().optional(), spendUsd: z.number().optional(),
}).passthrough());

// Params deliberately project identity rather than serializing evolving account config.
export const usageAccount = z.object({ name: z.string(), kind: z.enum(["claude", "codex", "cursor", "agy", "endpoint"]),
  source: z.enum(["default", "pacer", "orca", "endpoint", "opencode"]) });
export const usageReadParams = z.object({ provider: z.string().min(1), usage: z.enum(["quota", "metered", "reactive", "unmetered"]), account: usageAccount.nullable(), accountHome: z.string().nullable(),
  model: z.string().nullable(), weeklyTokens: z.number().nullable(), weeklyUsd: z.number().nullable(), quotaSource: z.string().nullable(),
  resources: z.object({ claudeFiles: z.array(z.string().min(1).max(4096)).max(2).optional(), codexSessions: z.string().min(1).max(4096).optional() }).optional(),
  now: z.number(), readOnly: z.boolean(), refresh: z.boolean() });
export type UsageReadParams = z.infer<typeof usageReadParams>;

/** Optional additive top-level RPC metadata; old peers need not send it. */
export const callMetadata = z.object({ capabilityCall: z.string().min(1).max(256) }).passthrough().optional();
