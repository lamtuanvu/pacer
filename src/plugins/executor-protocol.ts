import { z } from "zod";

/** One backend identity per executor plugin; selection and ownership stay with the host. */
export const executorContribution = z.object({ backends: z.tuple([z.enum(["direct", "orca"])]) }).strict();
/** Availability receives a host-selected public strategy projection, never raw config or credentials. */
export const executorAvailableParams = z.object({
  strategy: z.object({ name: z.string().min(1).max(128) }).strict(),
}).strict();
export const executorAvailableResult = z.object({
  available: z.boolean(), reason: z.string().min(1).max(1024).optional(),
}).strict();
/** The host supplies only an owned task id; the provider retains its private terminal mapping. */
export const executorSessionStateParams = z.object({ taskId: z.string().min(1).max(128) }).strict();
export const executorSessionStateResult = z.object({ live: z.boolean(), handle: z.string().min(1).max(256).optional() }).strict();

/** Fake-only contract. Attempt ownership and effect authority require a later reviewed slice. */
export const EXECUTOR_METHODS = {
  "executor.available": { description: "Report availability for a host-selected direct backend using a credential-free strategy name; staged only, with no production caller.",
    params: executorAvailableParams, result: executorAvailableResult, deadlineMs: 10_000 },
  "executor.sessionState": { description: "Report an owned Orca task's live terminal state without exposing command or credential authority; staged only, with no production caller.",
    params: executorSessionStateParams, result: executorSessionStateResult, deadlineMs: 10_000 },
} as const;
