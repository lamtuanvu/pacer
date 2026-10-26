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

const taskId = z.string().regex(/^t-[A-Za-z0-9_-]{1,120}$/);
const positive = z.number().int().positive().safe();
/** Staged local-attempt envelope. The host selects the task and revision. */
export const executorRunParams = z.object({
  task: z.object({ id: taskId, rev: positive }).strict(),
  attempt: positive,
  runDir: z.literal(1),
}).strict();
export const executorRunResult = z.object({
  status: z.enum(["done", "failed"]),
  exitCode: z.number().int().safe(),
  report: z.string().max(65_536),
}).strict();
export const executorStopParams = z.object({ taskId, attempt: positive,
  graceMs: z.number().int().nonnegative().max(30_000) }).strict();
export const executorStopResult = z.object({ code: z.number().int().safe(), killed: z.boolean() }).strict();
export const executorProgress = z.object({
  phase: z.enum(["driving", "testing", "needs-input", "starting", "working", "idle", "lost-contact"]),
  lastOutputAt: z.number().finite().nullable(), lastChangeAt: z.number().finite().nullable(),
  files: z.number().int().nonnegative().safe(), commits: z.number().int().nonnegative().safe(),
  logBytes: z.number().int().nonnegative().safe(), host: z.string().min(1).max(256),
  updatedAt: z.number().finite(),
}).strict();
export const executorRunEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("spawned"), pid: positive }).strict(),
  z.object({ kind: z.literal("progress"), expectRev: positive, progress: executorProgress }).strict(),
  z.object({ kind: z.literal("log"), stream: z.enum(["stdout", "stderr"]), text: z.string().max(4096) }).strict(),
]);

/** Fake-only contract. Attempt ownership and effect authority require a later reviewed slice. */
export const EXECUTOR_METHODS = {
  "executor.available": { description: "Report availability for a host-selected direct backend using a credential-free strategy name; staged only, with no production caller.",
    params: executorAvailableParams, result: executorAvailableResult, deadlineMs: 10_000 },
  "executor.run": { description: "Staged owned local attempt; no production caller is switched yet.",
    params: executorRunParams, result: executorRunResult, deadlineMs: 0 },
  "executor.stop": { description: "Stop the matching staged local attempt.",
    params: executorStopParams, result: executorStopResult, deadlineMs: 30_000 },
} as const;
