import { z } from "zod";

const name = z.string().min(1).max(256);
export const tierSchema = z.enum(["small", "medium", "frontier", "unknown"]);
export const modelBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), id: name }).strict(),
  z.object({ kind: z.literal("executor-default") }).strict(),
]);
export const modelDeclarationSchema = z.object({
  id: name, tier: tierSchema.default("unknown"), strengths: z.array(name).max(64).default([]),
  tools: z.boolean().optional(), context: z.number().int().positive().optional(),
}).strict();
export const requirementsSchema = z.object({
  minTier: z.enum(["small", "medium", "frontier"]).optional(), tools: z.boolean().optional(),
  context: z.number().int().positive().optional(),
}).strict();
export const preferencesSchema = z.object({ models: z.array(name).max(256).default([]), strengths: z.array(name).max(64).default([]) }).strict();
const rankSchema = z.enum(["task-fit", "spare-capacity", "burn-before-reset", "cheapest-first", "preference"]);
export const dispatchConfigSchema = z.object({
  engine: z.literal("ladder").default("ladder"), timeoutMs: z.number().int().min(1).max(10000).default(1000),
  reservePct: z.number().min(0).max(100).default(0), comfortablePct: z.number().min(0).max(100).default(20),
  steps: z.array(z.object({
    id: name, match: z.object({ kind: name.optional() }).strict().default({}),
    require: requirementsSchema.default({}), prefer: preferencesSchema.default({ models: [], strengths: [] }),
    candidates: z.object({ models: z.array(name).max(256).optional(), executors: z.array(name).max(256).optional() }).strict().default({}),
    capacity: z.enum(["comfortable", "usable", "unknown"]).default("comfortable"),
    rank: z.array(rankSchema).min(1).max(5).default(["task-fit", "spare-capacity"]),
  }).strict()).min(1).max(64).default([
    { id: "capable-with-headroom", match: {}, require: {}, prefer: { models: [], strengths: [] }, candidates: {}, capacity: "comfortable", rank: ["task-fit", "spare-capacity"] },
    { id: "usable-fallback", match: {}, require: {}, prefer: { models: [], strengths: [] }, candidates: {}, capacity: "usable", rank: ["task-fit", "spare-capacity"] },
  ]),
  onNoMatch: z.enum(["queue", "fail"]).default("queue"),
}).strict().refine(c => new Set(c.steps.map(s => s.id)).size === c.steps.length, "duplicate step IDs").transform(value => structuredClone(value));

export const observationScopeSchema = z.object({ runner: name, account: name, binding: modelBindingSchema.optional() }).strict();
export const observationMethodSchema = z.enum(["models", "capabilities", "usage", "health", "actual-model"]);
const windowSchema = z.object({ pool: name, usedPct: z.number().min(0).max(100), hoursLeft: z.number().positive().optional() }).strict();
const observationValueSchema = z.object({
  models: z.array(modelDeclarationSchema).max(512).optional(),
  tools: z.boolean().optional(), context: z.number().int().positive().optional(), model: name.optional(),
  healthy: z.boolean().optional(), unmetered: z.boolean().optional(),
  windows: z.array(windowSchema).max(64).optional(), cost: z.number().nonnegative().optional(),
}).strict();
export const observationSchema = z.object({
  source: name, scope: observationScopeSchema, method: observationMethodSchema,
  state: z.enum(["known", "unknown", "unsupported", "error"]),
  observedAt: z.number().finite(), expiresAt: z.number().finite(), value: observationValueSchema.optional(),
}).strict();
export const modelRecordSchema = z.object({
  runner: name, account: name, executor: name, binding: modelBindingSchema, actualModel: name.nullable(),
  tier: tierSchema, strengths: z.array(name), tools: z.boolean().optional(), context: z.number().int().positive().optional(),
  provenance: z.enum(["declared", "observed", "mixed"]),
}).strict();
export const candidateSchema = modelRecordSchema.extend({
  id: name.max(1024), poolIds: z.array(name), headroom: z.number().nullable(),
  burn: z.number().nullable(), cost: z.number().nullable(), capacityKnown: z.boolean(),
});
export const previewInputSchema = z.object({
  repo: z.string().min(1).max(4096), goal: z.string().min(1).max(8000), kind: name.optional(),
  requirements: requirementsSchema.default({}), preferences: preferencesSchema.default({ models: [], strengths: [] }), model: name.optional(),
}).strict();
export const decisionRequestSchema = z.object({
  schemaVersion: z.literal(1), requestId: name, now: z.number().finite(), deadline: z.number().finite(),
  task: z.object({ kind: name.nullable(), requirements: requirementsSchema, preferences: preferencesSchema, model: name.optional(), provenance: z.literal("request") }).strict(),
  candidates: z.array(candidateSchema).max(512), observations: z.array(observationSchema).max(2048),
  observationRevision: name, strategyHash: name, config: dispatchConfigSchema,
}).strict();
const choiceSchema = z.object({ id: z.string().min(1).max(1024), factors: z.array(z.number().finite()).max(16), reason: z.string().max(1000) }).strict();
export const proposalSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ranked"), choices: z.array(choiceSchema).min(1).max(512), step: name, skipped: z.array(name).max(64) }).strict(),
  z.object({ state: z.enum(["abstain", "no-match"]), reason: z.string().max(1000), skipped: z.array(name).max(64) }).strict(),
]);
export type TaskRequirements = z.infer<typeof requirementsSchema>;
export type TaskPreferences = z.infer<typeof preferencesSchema>;
export type ModelRecord = z.infer<typeof modelRecordSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type ObservationScope = z.infer<typeof observationScopeSchema>;
export type ObservationMethod = z.infer<typeof observationMethodSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type DispatchConfig = z.infer<typeof dispatchConfigSchema>;
export type DispatchPreviewInput = z.infer<typeof previewInputSchema>;
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
export type DecisionProposal = z.infer<typeof proposalSchema>;
export interface DispatchPreview {
  schemaVersion: 1;
  engine: { id: string; version: string };
  request: DecisionRequest;
  inputHash: string;
  proposal: DecisionProposal | null;
  outputHash: string | null;
  validation: "valid" | "invalid" | "timeout";
  recommendedAction: "select" | "queue" | "fail";
  excluded: { id: string; reason: string }[];
  uncertainty: string[];
}
