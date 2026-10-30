import { z } from "zod";

/** Staged SP09 contribution: only the existing direct backend is named. */
export const executorContribution = z.object({ backends: z.tuple([z.literal("direct")]) }).strict();
/** Availability receives a host-selected public strategy projection, never raw config or credentials. */
export const executorAvailableParams = z.object({
  strategy: z.object({ name: z.string().min(1).max(128) }).strict(),
}).strict();
export const executorAvailableResult = z.object({
  available: z.boolean(), reason: z.string().min(1).max(1024).optional(),
}).strict();

/** Fake-only contract. Attempt ownership and effect authority require a later reviewed slice. */
export const EXECUTOR_METHODS = {
  "executor.available": { description: "Report availability for a host-selected direct backend using a credential-free strategy name; staged only, with no production caller.",
    params: executorAvailableParams, result: executorAvailableResult, deadlineMs: 10_000 },
} as const;
