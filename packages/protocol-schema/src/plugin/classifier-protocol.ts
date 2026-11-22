import { z } from "zod";
import type { MethodDef } from "./protocol";

export const questionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    id: z.string(),
    instructions: z.string(),
    criteria: z.record(z.string(), z.string()),
  }),
  z.object({
    type: z.literal("score"),
    id: z.string(),
    instructions: z.string(),
    min: z.number(),
    max: z.number(),
  }),
  z.object({
    type: z.literal("yesno"),
    id: z.string(),
    instructions: z.string(),
  }),
]);
export const answerSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  probabilities: z.record(z.string(), z.number()).optional(),
  confidence: z.number().min(0).max(1),
  latencyMs: z.number().nonnegative(),
  costUsd: z.number().optional(),
});
/** Opaque host-projected configuration. Provider bridge validates secret-free contents. */
export const classifierAdapterConfig = z.record(z.string(), z.json());
export const classifierAskParams = z.object({
  adapter: z.string(),
  state: z.string().max(256 * 1024),
  question: questionSchema,
  timeoutMs: z.number().positive(),
  config: classifierAdapterConfig.optional(),
});
export type ClassifierQuestion = z.infer<typeof questionSchema>;
export type ClassifierAnswer = z.infer<typeof answerSchema>;
export type ClassifierAskParams = z.infer<typeof classifierAskParams>;
export const CLASSIFIER_METHODS: Record<string, MethodDef> = {
  "classifier.adapters": {
    description:
      "Adapters this plugin serves; external adapters leave the machine.",
    params: z.object({}),
    result: z.object({
      adapters: z.array(z.object({ id: z.string(), external: z.boolean() })),
    }),
    deadlineMs: 2000,
  },
  "classifier.ask": {
    description:
      "Answer one question with the named adapter and host-projected configuration; the owning call uses the configured deadline.",
    params: classifierAskParams,
    result: answerSchema,
    deadlineMs: 5000,
  },
};
