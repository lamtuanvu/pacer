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
export const executorEffectRunParams = z.object({
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
    detached: z.literal(true).optional(),
  }).strict().optional(),
}).strict();
export const executorEffectRunResult = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["done", "failed"]), exitCode: z.number().int().safe(),
    report: z.string().max(65_536) }).strict(),
  z.object({ status: z.literal("launched"), pid: positive, report: z.string().max(65_536) }).strict(),
]);
/** Credential-free owned attempt; every path and process effect comes from this call's host grants. */
export const executorOwnedRunParams = z.object({
  task: z.object({ id: taskId, rev: positive }).strict(), attempt: positive, runDir: z.literal(1),
  owned: z.object({ placement: z.enum(["current", "new"]), timeoutMs: z.number().int().positive().max(MAX_PROCESS_SPAWN_MS),
    session: z.literal("interactive").optional(),
    executor: z.string().min(1).max(256), model: z.string().max(256).nullable(),
    resume: z.object({ startedAt: z.number().finite(), logFile: z.string().min(1).max(4096),
      worktree: z.string().min(1).max(4096).optional() }).strict().optional() }).strict(),
}).strict();
export const executorOwnedRemoteRunParams = z.object({
  task: z.object({ id: taskId, rev: positive }).strict(), attempt: positive, runDir: z.literal(1),
  remote: z.object({ timeoutMs: z.number().int().positive().max(MAX_PROCESS_SPAWN_MS),
    executor: z.string().min(1).max(256), model: z.string().max(256).nullable(),
    resume: z.object({ startedAt: z.number().finite(), logFile: z.string().min(1).max(4096) }).strict().optional(),
  }).strict(),
}).strict();
export const executorRunParams = z.union([executorEffectRunParams, executorOwnedRunParams, executorOwnedRemoteRunParams]);

/** The files the eventual executor owner must preserve for current task and session readers. */
export const RUN_DIR_CONTRACT = {
  version: 1,
  files: ["argv", "stdout", "stderr", "pid", "exit", "session.log", "session.json",
    "report.json", "transcript-report.md", "prompt.md"],
} as const;

/** Host-verified durable state passed to a future plugin reattach/stop owner. */
export const executorRunState = z.object({
  task: z.object({ id: taskId, rev: positive }).strict(),
  attempt: positive, runDir: z.literal(1), dir: z.string().min(1).max(4096),
  state: z.enum(["running", "exited", "uncertain"]),
  pid: positive.nullable(), exitCode: z.number().int().safe().nullable(),
  startedAt: z.number().finite().nullable(),
  stdoutBytes: z.number().int().nonnegative().safe(),
  stderrBytes: z.number().int().nonnegative().safe(),
}).strict();

/** Preparatory full outcome contract; the staged executor.run method still returns executorRunResult. */
export const executorAttemptOutcome = z.object({
  takeover: z.boolean().optional(),
  attempt: z.object({
    executor: z.string().min(1), model: z.string().nullable(),
    actualModel: z.string().nullable().optional(), dispatchSettingsHash: z.string().optional(),
    startedAt: z.number().finite(), endedAt: z.number().finite(), exitCode: z.number().int().safe(),
    timedOut: z.boolean(), limitHit: z.boolean(), log: z.string().max(4096), brokenReason: z.string().optional(),
    routing: z.json().optional(), usageAtStart: z.json().optional(), usageAtEnd: z.json().optional(),
  }).strict(),
  exec: z.object({
    code: z.number().int().safe(), stdout: z.string().max(262144), stderr: z.string().max(262144), timedOut: z.boolean(),
    stdoutOverflow: z.boolean().optional(),
  }).strict(),
  report: z.string().max(65_536), backend: z.string().optional(), worktree: z.string().max(4096).optional(),
  partial: z.string().optional(),
}).strict();
export const executorRunResult = z.union([executorEffectRunResult, executorAttemptOutcome]);
export const executorStopParams = z.object({ taskId, attempt: positive,
  graceMs: z.number().int().nonnegative().max(25_000), remote: z.literal(true).optional() }).strict();
export const executorStopResult = z.object({ code: z.number().int().safe(), killed: z.boolean() }).strict();
/** Read-only session state; uncertainty cannot authorize a replacement launch. */
export const executorSessionStateParams = z.object({ taskId, attempt: positive }).strict();
export const executorSessionStateResult = z.object({
  state: z.enum(["running", "exited", "uncertain"]), host: z.literal("builtin"), handle: z.null(),
}).strict();
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
  "executor.available": { description: "Report bundled direct provider readiness for a host-selected credential-free strategy name; route admission remains host-owned.",
    params: executorAvailableParams, result: executorAvailableResult, deadlineMs: 10_000 },
  "executor.run": { description: "Owned direct attempt or compatibility local process effect, each under exact host-issued grants.",
    params: executorRunParams, result: executorRunResult, deadlineMs: 0 },
  "executor.stop": { description: "Stop the matching staged local attempt.",
    params: executorStopParams, result: executorStopResult, deadlineMs: 30_000 },
  "executor.sessionState": { description: "Read the running, exited or uncertain state of one host-issued persisted local executor session.",
    params: executorSessionStateParams, result: executorSessionStateResult, deadlineMs: 5_000 },
} as const;
