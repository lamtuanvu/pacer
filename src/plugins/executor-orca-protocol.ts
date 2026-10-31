import { z } from "zod";
import type { MethodDef } from "./protocol";
import { executorAttemptOutcome } from "./executor-protocol";

const taskId = z.string().regex(/^t-[A-Za-z0-9_-]{1,120}$/);
const positive = z.number().int().positive().safe();
const reason = z.string().min(1).max(4096);
const handle = z.string().min(1).max(256);
const text = z.string().max(65_536);
const owner = z.object({ taskId, attempt: positive }).strict();

export const orcaWaitResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("done"), outcome: z.string().max(256), subject: text, body: text }).strict(),
  z.object({ kind: z.literal("settled"), state: z.string().max(256), error: z.string().max(4096).nullable(),
    tail: text.optional(), needsStop: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("timeout") }).strict(),
  z.object({ kind: z.literal("stopped") }).strict(),
]);
const started = z.object({ kind: z.literal("started"), dispatchId: handle, state: z.string().max(256).nullable(),
  stage: z.string().max(256).nullable(), failedStage: z.string().max(256).nullable(),
  lastError: z.string().max(4096).nullable() }).strict();
const failed = z.object({ ok: z.literal(false), reason }).strict();
const method = (description: string, params: z.ZodTypeAny, result: z.ZodTypeAny, deadlineMs: number): MethodDef =>
  ({ description, params, result, deadlineMs });

/**
 * Task-owned Orca effects. Each call is bound to the host-issued attempt of the calling executor.run; the host
 * constructs every Orca argv, the quoted terminal command and the worker spec, and checks worktree, terminal and
 * worker identity before it records or closes anything.
 */
export const ORCA_CAPABILITY_METHODS: Record<string, MethodDef> = {
  "capability.orca.status": method("Read whether the Orca runtime is ready; no effect.", z.object({}).strict(),
    z.object({ ready: z.boolean(), reason: z.string().max(1024).optional() }).strict(), 20_000),
  "capability.orca.liveAnswer": method("Reattach an answering attempt to its interactive lane's live worker, or release a worker that cannot take the answer.",
    owner, z.discriminatedUnion("kind", [z.object({ kind: z.literal("none") }).strict(),
      z.object({ kind: z.literal("fallback"), reason }).strict(),
      z.object({ kind: z.literal("attached"), dispatchId: handle }).strict()]), 120_000),
  "capability.orca.prepare": method("Resolve the host placement, Orca repository, coordinator and agent for this attempt.",
    owner, z.union([z.object({ ok: z.literal(true), agent: z.enum(["claude", "codex"]), model: z.string().max(256).nullable(),
      placement: z.enum(["new-child", "existing"]), notes: z.array(z.string().max(4096)).max(8) }).strict(),
    z.object({ ok: z.literal(false), reason, refuse: z.boolean() }).strict()]), 180_000),
  "capability.orca.place": method("Create or show the host-selected Orca worktree, verify its identity and close Orca's initial terminal.",
    owner, z.union([z.object({ ok: z.literal(true), worktreeId: z.string().min(1).max(4352), workdir: z.string().min(1).max(4096) }).strict(), failed]), 180_000),
  "capability.orca.terminal": method("Create the agent terminal with the host-composed unattended command and wait for TUI idle.",
    owner, z.union([z.object({ ok: z.literal(true), terminal: handle, incarnationId: handle.nullable() }).strict(), failed]), 120_000),
  "capability.orca.abandon": method("Before any worker exists: close the exact created terminal, discard the created worktree and release the lease on closure proof.",
    owner.extend({ reason }).strict(), z.object({ reason }).strict(), 120_000),
  "capability.orca.start": method("Persist the start intent, then attach one worker to the created terminal with worker-start --terminal.",
    owner, z.discriminatedUnion("kind", [started,
      z.object({ kind: z.literal("refused"), code: z.string().max(256), message: z.string().max(4096) }).strict(),
      z.object({ kind: z.literal("uncertain"), reason }).strict()]), 300_000),
  "capability.orca.lookup": method("Look the terminal's dispatch up in the run after an uncertain start; read-only.",
    owner, z.discriminatedUnion("kind", [z.object({ kind: z.literal("found"), dispatchId: handle, state: z.string().max(256) }).strict(),
      z.object({ kind: z.literal("none") }).strict(), z.object({ kind: z.literal("unknown"), reason }).strict()]), 120_000),
  "capability.orca.adopt": method("Bind the worker found after an uncertain start to this attempt.",
    owner, started, 60_000),
  "capability.orca.unstarted": method("Close and discard after a proven absent worker, or retain the terminal and lease when the start stays uncertain.",
    owner, executorAttemptOutcome, 120_000),
  "capability.orca.wait": method("Supervise the started worker until worker_done, settlement, the task timeout or a stop.",
    owner, orcaWaitResult, 0),
  "capability.orca.settle": method("Release a settled worker or stop an unsettled one, recording the closure receipt on the lease.",
    owner.extend({ settled: z.boolean() }).strict(), z.object({ ok: z.literal(true) }).strict(), 120_000),
  "capability.orca.finish": method("Close the exact terminal or keep a needs-input lane alive, release unused lane worktrees and return the attempt outcome.",
    owner.extend({ code: z.number().int().safe(), timedOut: z.boolean(), settled: z.boolean(), summary: text,
      tail: text.optional(), launchBroken: z.string().max(4096).optional(), keepAlive: z.boolean() }).strict(), executorAttemptOutcome, 180_000),
  "capability.orca.stop": method("Stop the task's recorded live worker and close its exact terminal.",
    owner, z.object({ code: z.number().int().safe(), killed: z.boolean() }).strict(), 120_000),
  "capability.orca.sessionState": method("Read whether the task's recorded live worker still runs its agent in the foreground; no effect.",
    owner, z.object({ state: z.enum(["running", "exited", "uncertain"]), handle: handle.nullable() }).strict(), 60_000),
};

export const ORCA_METHOD_CAPABILITY: Record<string, "orca"> = Object.fromEntries(
  Object.keys(ORCA_CAPABILITY_METHODS).map(name => [name, "orca"]),
) as Record<string, "orca">;
