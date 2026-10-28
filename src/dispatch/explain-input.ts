import { z } from "zod";
import { preferencesSchema, requirementsSchema } from "./types";

/** Kept apart from the explain implementation so the operation registry can import it without a cycle. */
const name = z.string().min(1).max(256);
const draftSchema = z.object({ from: z.string().min(1).max(128), set: z.record(z.string().max(256), z.json()).optional(), unset: z.array(z.string().max(256)).max(256).optional(), description: z.string().max(1000).optional() })
  .refine(d => JSON.stringify(d).length <= 64 * 1024, "strategyDraft exceeds 64 KiB");
export const explainInputSchema = z.object({
  repo: z.string().min(1).max(4096), goal: z.string().min(1).max(20000), kind: name.optional(), executor: z.string().min(1).max(128).optional(),
  model: name.optional(), requirements: requirementsSchema.default({}), preferences: preferencesSchema.default({ models: [], strengths: [] }),
  delegationEnforcement: z.enum(["strict", "cooperative"]).optional(), difficulty: z.enum(["simple", "standard", "complex"]).optional(),
  strategyDraft: draftSchema.optional(),
}).strict();
