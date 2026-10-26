import { z } from "zod";
import { MAX_PROCESS_SPAWN_MS } from "./capability-protocol";
import { secretReference } from "./http-protocol";

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
/** The host selects the task, revision and any exact, bounded local command. */
export const executorRunParams = z.object({
  task: z.object({ id: taskId, rev: positive }).strict(),
  attempt: positive,
  runDir: z.literal(1),
  effect: z.object({
    argv: z.array(z.string().min(1).max(4096)).min(1).max(32),
    cwd: z.string().min(1),
    timeoutMs: z.number().int().positive().max(MAX_PROCESS_SPAWN_MS),
    stdin: z.string().max(262144).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(name => !name.startsWith("PACER_KEY_")), z.string()).optional(),
    secretEnv: z.record(z.string().regex(/^PACER_KEY_[A-Z0-9_]+$/), secretReference).optional(),
  }).strict().optional(),
}).strict();
export const executorRunResult = z.object({
  status: z.enum(["done", "failed"]),
  exitCode: z.number().int().safe(),
  report: z.string().max(65_536),
}).strict();

/** The files the eventual executor owner must preserve for current task and session readers. */
export const RUN_DIR_CONTRACT = {
  version: 1,
  files: ["argv", "stdout", "stderr", "pid", "exit", "session.log", "session.json",
    "report.json", "transcript-report.md", "prompt.md"],
} as const;

/** Preparatory full outcome contract; the staged executor.run method still returns executorRunResult. */
export const executorAttemptOutcome = z.object({
  takeover: z.boolean().optional(),
  attempt: z.object({
    executor: z.string().min(1), model: z.string().nullable(),
    actualModel: z.string().nullable().optional(), dispatchSettingsHash: z.string().optional(),
    startedAt: z.number().finite(), endedAt: z.number().finite(), exitCode: z.number().int().safe(),
    timedOut: z.boolean(), limitHit: z.boolean(), log: z.string(), brokenReason: z.string().optional(),
    routing: z.json().optional(), usageAtStart: z.json().optional(), usageAtEnd: z.json().optional(),
  }).strict(),
  exec: z.object({
    code: z.number().int().safe(), stdout: z.string(), stderr: z.string(), timedOut: z.boolean(),
    stdoutOverflow: z.boolean().optional(),
  }).strict(),
  report: z.string(), backend: z.string().optional(), worktree: z.string().optional(),
  partial: z.string().optional(),
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

/** Full attempt outcome, stop and recovery remain later SP09 slices. */
export const EXECUTOR_METHODS = {
  "executor.available": { description: "Report availability for a host-selected direct backend using a credential-free strategy name; staged only, with no production caller.",
    params: executorAvailableParams, result: executorAvailableResult, deadlineMs: 10_000 },
  "executor.run": { description: "Owned local attempt with an optional host-issued bounded process effect.",
    params: executorRunParams, result: executorRunResult, deadlineMs: 0 },
  "executor.stop": { description: "Stop the matching staged local attempt.",
    params: executorStopParams, result: executorStopResult, deadlineMs: 30_000 },
} as const;
