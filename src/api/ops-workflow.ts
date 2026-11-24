// The workflow frame's /v3 operations (plan Task 8): definition management, runs
// and step results. All state lives in the workflow tables of the task store
// (src/workflow/store.ts), so the native host keeps these TypeScript-forwarded;
// the protocol change is additive and v3-only (P4). Run mutations publish a run
// entity so clients draw the run view from the event stream.
import { z } from "zod";
import type { OpDef, OpDeps } from "./ops";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { isExecutorSession, isOrchestratorSession } from "../install/role";
import { WORKFLOW_OPS_REFUSAL } from "./caller-policy";
import { normalizeWorkflowObject, parseWorkflow } from "../workflow/parse";
import { validateWorkflow } from "../workflow/validate";
import {
  addDefinition, getDefinition, getGraph, getQuestion, getRun, listDefinitions, listOpenPersonQuestions,
  listQuestions, listRuns, recordDecision,
  rootRunId, runEntityValue, stepByTask, stepByTaskIfPresent, stepsOfRun, updateRun, workflowDatabase,
  type RunRow, type RunStatus,
} from "../workflow/store";
import {
  answerQuestion, askQuestion, escalateQuestion, syncHumanStepAnswerers,
} from "../workflow/questions";
import { questionInputSchema } from "../workflow/question-schema";
import { convertPromptWaitToQuestion } from "../workflow/prompt-detector";
import {
  answerGenerateApproval, answerHumanStep, chooseWorkflow, defaultEngineDeps, recordStepResult, retryFailedStep,
  skipFailedStep, startPendingEntries, startRun, stopRun,
  type EngineDeps,
} from "../workflow/engine";
import { listArtifacts, storeArtifact } from "../workflow/artifacts";
import { syncBase } from "../workflow/branch";
import { publishRun } from "../workflow/publish";
import { cleanupRun } from "../workflow/cleanup";
import { canAutoApproveGenerate, canAutoDecide } from "../workflow/auto";
import { applyBudgetRaise, isBudgetBlocked, parseSpent, serializeSpent } from "../workflow/budget";
import { listGraphSummaries, noteGenerateSubmitErrors, submitGraph } from "../workflow/generate";
import {
  checkWorkflowShape, isPlainObject, type GenerateStep, type HumanStep, type WorkflowError, type WorkflowDef,
} from "../workflow/schema";
import { requireAskingExecutor } from "../core/tasks";
import { spawnRunner, type SpawnRunner } from "../tasks/api";
import { orchestratorTaskIdForGrant, verifyRunGrant } from "../workflow/run-grant";
import { PLANNERS } from "../config/strategy";
import { publish } from "../link/publish";
import {
  applyPriorityToQueuedRunTasks, RUN_PRIORITIES, type RunPriority,
} from "../workflow/priority";
import {
  pauseRunByPerson, readPacingMode, resumeRunByPerson, syncRunPacingPause,
} from "../workflow/pacing";
import { markRunSeen, storeRunSummary, SUMMARY_MAX_BYTES } from "../workflow/summary";

const op = <P extends z.ZodTypeAny>(def: OpDef<P>) => def as unknown as OpDef;

const runId = z.string().regex(/^run_[a-z2-7]{10}$/);
const questionId = z.string().regex(/^q_[a-z2-7]{10}$/);
const workflowRef = z.string().min(1).max(256);
const status = z.enum(["running", "waiting", "done", "failed", "stopped"]);
// A workflow file's text is capped at 256 KiB like other free-text bodies.
const source = z.string().min(1).max(256 * 1024);

/** Workflow and run operations are for the person and the planner; an executor's
 *  only frame operation is step.result. A run-grant caller is never a person
 *  caller (use run.decide / run.choose). assertCallerCanInvoke answers the same
 *  way for CLI paths, so every transport refuses with one text. */
function assertPersonCaller(ctx: Ctx): void {
  if (ctx.env.PACER_RUN_GRANT) throw new CoreError("not_allowed", "A run grant cannot call person-only workflow operations");
  if (isOrchestratorSession(ctx)) throw new CoreError("not_allowed", WORKFLOW_OPS_REFUSAL);
  if (isExecutorSession(ctx)) throw new CoreError("not_allowed", WORKFLOW_OPS_REFUSAL);
}

/** step.result identity: executor session, or a live run-grant whose task is a step of the grant's run. */
function requireStepResultCaller(ctx: Ctx): string {
  if (ctx.env.PACER_RUN_GRANT || isOrchestratorSession(ctx)) {
    const token = ctx.env.PACER_RUN_GRANT;
    if (!token) throw new CoreError("not_allowed", "A run grant is required");
    const grant = verifyRunGrant(ctx, token);
    if (!grant) throw new CoreError("not_allowed", "Expired or revoked run grant");
    // Serve HTTP has no PACER_TASK_ID; derive the orchestrator task from the turn (I6).
    const id = (typeof ctx.env.PACER_TASK_ID === "string" && ctx.env.PACER_TASK_ID)
      || orchestratorTaskIdForGrant(ctx, grant);
    if (!id) throw new CoreError("not_allowed", "pacer ask works only inside a delegated task");
    const step = stepByTask(ctx, id);
    if (!step || rootRunId(ctx, step.runId) !== grant.runId) {
      throw new CoreError("not_allowed", "Operation is outside this run grant");
    }
    return id;
  }
  return requireAskingExecutor(ctx);
}

/** callOp deps → engine deps: tests stub delegation through OpDeps. */
function engineDeps(deps: OpDeps): { deps: EngineDeps; spawn?: SpawnRunner } {
  return {
    deps: deps.delegate ? { ...defaultEngineDeps, delegate: deps.delegate } : defaultEngineDeps,
    spawn: deps.spawnRunner,
  };
}

/** Parses a source and runs structural validation, so callers see every error at once.
 *  Parse and validate both check the shape, so identical errors are reported once. */
function definitionErrors(sourceText: string): { def?: WorkflowDef; errors: WorkflowError[] } {
  const { def, errors } = parseWorkflow(sourceText);
  if (!def) return { errors };
  const seen = new Set<string>();
  const all = [...errors, ...validateWorkflow(def)].filter(error => {
    const key = `${error.path}\u0000${error.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { def, errors: all };
}

export const workflowOps: Record<string, OpDef> = {
  "workflow.validate": op({
    description: "Validate a workflow file's text without storing it. Returns every error at once with its path.",
    params: z.object({ source }),
    handler: (ctx, p) => {
      assertPersonCaller(ctx);
      const { errors } = definitionErrors(p.source);
      return { ok: errors.length === 0, errors };
    },
  }),
  "workflow.add": op({
    description: "Install a workflow version from its file text. The same id@version with identical text is a no-op; different text is a conflict.",
    params: z.object({ source }),
    handler: (ctx, p) => {
      assertPersonCaller(ctx);
      const { def, errors } = definitionErrors(p.source);
      if (!def || errors.length > 0) {
        const shown = errors.map(e => `${e.path}: ${e.message}`).join("; ");
        throw new CoreError("invalid_input", shown || "invalid workflow", "Fix the reported errors and add again.", { errors });
      }
      return addDefinition(ctx, def, p.source);
    },
  }),
  "workflow.list": op({
    description: "Installed workflow definitions, oldest first.",
    params: z.object({}),
    handler: ctx => {
      assertPersonCaller(ctx);
      return listDefinitions(ctx);
    },
  }),
  "run.start": op({
    description: "Start a run of an installed workflow for one brief and repository; the entry step becomes an ordinary task.",
    params: z.object({
      workflow: workflowRef,
      repo: z.string().min(1).max(4096),
      brief: z.string().min(1).max(8000),
      title: z.string().min(1).max(120).optional(),
      priority: z.enum(RUN_PRIORITIES).optional(),
      publish: z.literal("draft").optional(),
    }),
    handler: async (ctx, p, deps) => {
      assertPersonCaller(ctx);
      const { deps: engine, spawn } = engineDeps(deps);
      // The engine publishes the run entity: on creation, on a failed start and on
      // every status change it makes.
      // Return the store row (same shape as run.list); run.get adds the orchestrator block.
      return startRun(ctx, {
        workflow: p.workflow,
        repo: p.repo,
        brief: p.brief,
        ...(p.title ? { title: p.title } : {}),
        ...(p.priority ? { priority: p.priority as RunPriority } : {}),
        ...(p.publish ? { publish: p.publish } : {}),
      }, spawn, engine);
    },
  }),
  "run.get": op({
    description: "One run with its step instances and generated graph versions. Person, or a live run grant for its own run (expect_rev for sync/publish).",
    params: z.object({ id: runId }),
    handler: (ctx, p) => {
      // R3-I2: grants may read their own run (CLI sync/publish fetch expect_rev via run.get).
      // Foreign/unknown ids refuse with the same text so a grant cannot probe other runs.
      if (ctx.env.PACER_RUN_GRANT) {
        const grant = verifyRunGrant(ctx, ctx.env.PACER_RUN_GRANT);
        if (!grant || rootRunId(ctx, p.id) !== grant.runId) {
          throw new CoreError("not_found", `unknown run ${p.id}`);
        }
      } else {
        assertPersonCaller(ctx);
      }
      const run = getRun(ctx, p.id);
      if (!run) throw new CoreError("not_found", `unknown run ${p.id}`);
      const steps = stepsOfRun(ctx, p.id);
      let pendingApproval: {
        stepId: string;
        attempt: number;
        version: number;
        graph?: WorkflowDef;
        replanSummary?: string;
        replanDiff?: { added: string[]; removed: string[]; changed: string[] };
      } | undefined;
      for (const step of steps) {
        if (step.status !== "waiting") continue;
        const result = step.result != null && typeof step.result === "object"
          ? step.result as Record<string, unknown>
          : null;
        if (!result || result.pendingApproval !== true || typeof result.graphVersion !== "number") continue;
        const graph = getGraph(ctx, {
          runId: p.id, stepId: step.stepId, attempt: step.attempt, version: result.graphVersion,
        });
        pendingApproval = {
          stepId: step.stepId,
          attempt: step.attempt,
          version: result.graphVersion,
          ...(graph ? { graph: graph.def } : {}),
          ...(typeof result.replanSummary === "string" ? { replanSummary: result.replanSummary } : {}),
          ...(result.replanDiff != null && typeof result.replanDiff === "object"
            ? { replanDiff: result.replanDiff as { added: string[]; removed: string[]; changed: string[] } }
            : {}),
        };
        break;
      }
      return {
        run: runEntityValue(run),
        steps,
        graphs: listGraphSummaries(ctx, p.id),
        artifacts: listArtifacts(ctx, p.id),
        ...(pendingApproval ? { pendingApproval } : {}),
      };
    },
  }),
  "run.list": op({
    description: "Runs, oldest first, optionally filtered by status.",
    params: z.object({ status: status.optional() }),
    handler: (ctx, p) => {
      assertPersonCaller(ctx);
      return listRuns(ctx, p.status as RunStatus | undefined);
    },
  }),
  "run.answer": op({
    description: "Answer a waiting human step or approve/revise a generated graph. Requires the run's current rev.",
    params: z.object({ id: runId, step: z.string().min(1).max(128), answer: z.string().min(1).max(4000), expect_rev: z.number().int().positive() }),
    handler: async (ctx, p, deps) => {
      assertPersonCaller(ctx);
      const { deps: engine, spawn } = engineDeps(deps);
      const run = getRun(ctx, p.id);
      if (!run) throw new CoreError("not_found", `unknown run ${p.id}`);
      const def = getDefinition(ctx, `${run.workflow}@${run.version}`) ?? getDefinition(ctx, run.workflow);
      const stepDef = def?.steps[p.step];
      if (stepDef?.type === "generate") {
        return answerGenerateApproval(ctx, {
          runId: p.id, stepId: p.step, answer: p.answer, expectRev: p.expect_rev,
        }, engine, spawn);
      }
      return answerHumanStep(ctx, p.id, p.step, p.answer, p.expect_rev, engine, spawn);
    },
  }),
  "run.stop": op({
    description: "Stop a run and its running step tasks. Requires the run's current rev.",
    params: z.object({ id: runId, expect_rev: z.number().int().positive() }),
    handler: async (ctx, p, deps) => {
      assertPersonCaller(ctx);
      const { deps: engine } = engineDeps(deps);
      return stopRun(ctx, p.id, p.expect_rev, engine);
    },
  }),
  "step.result": op({
    description: "Record the calling executor's structured result for its workflow step task, validated at once; once per step, before the task settles.",
    params: z.object({ result: z.record(z.string(), z.json()) }),
    handler: (ctx, p) => recordStepResult(ctx, requireStepResultCaller(ctx), p.result),
  }),
  "step.artifact": op({
    description: "Attach a file from the calling step task's worktree or evidence directory to the run's artifact store. Own step only; 10 MiB per file, 200 MiB per run.",
    params: z.object({ path: z.string().min(1).max(4096), label: z.string().min(1).max(256) }),
    handler: (ctx, p) => {
      const row = storeArtifact(ctx, requireStepResultCaller(ctx), { path: p.path, label: p.label });
      // Never return filesystem paths to clients (DATA / no secrets in logs).
      return { id: row.id, label: row.label, name: row.name, mime: row.mime, size: row.size, stepId: row.stepId };
    },
  }),
  "step.skip": op({
    description: "Skip a failed step under a live run grant: mark it done as skipped and advance the run.",
    params: z.object({ id: runId, step: z.string().min(1).max(128) }),
    handler: async (ctx, p, deps) => {
      const grant = ctx.env.PACER_RUN_GRANT ? verifyRunGrant(ctx, ctx.env.PACER_RUN_GRANT) : null;
      if (!grant || rootRunId(ctx, p.id) !== grant.runId) {
        throw new CoreError("not_allowed", "step.skip requires a live run grant for this run");
      }
      const { deps: engine, spawn } = engineDeps(deps);
      return runEntityValue(await skipFailedStep(ctx, { runId: p.id, stepId: p.step }, spawn, engine));
    },
  }),
  "step.retry": op({
    description: "Retry a failed step under a live run grant: start a new attempt of the same step.",
    params: z.object({ id: runId, step: z.string().min(1).max(128) }),
    handler: async (ctx, p, deps) => {
      const grant = ctx.env.PACER_RUN_GRANT ? verifyRunGrant(ctx, ctx.env.PACER_RUN_GRANT) : null;
      if (!grant || rootRunId(ctx, p.id) !== grant.runId) {
        throw new CoreError("not_allowed", "step.retry requires a live run grant for this run");
      }
      const { deps: engine, spawn } = engineDeps(deps);
      return runEntityValue(await retryFailedStep(ctx, { runId: p.id, stepId: p.step }, spawn, engine));
    },
  }),
  "run.set_auto": op({
    description: "Turn auto mode on or off for a run, or mark auto steps must for this run. Person only; there is no way to loosen a must.",
    params: z.object({
      id: runId,
      auto: z.boolean().optional(),
      strict_steps: z.array(z.string().min(1).max(128)).optional(),
      expect_rev: z.number().int().positive(),
    }).refine(p => p.auto !== undefined || p.strict_steps !== undefined, {
      message: "auto or strict_steps is required",
    }),
    handler: (ctx, p) => {
      assertPersonCaller(ctx);
      const run = getRun(ctx, p.id);
      if (!run) throw new CoreError("not_found", `unknown run ${p.id}`);
      const patch: Parameters<typeof updateRun>[3] = {};
      if (p.auto !== undefined) patch.auto = p.auto;
      if (p.strict_steps !== undefined) {
        // Union with any prior strict steps; never remove a must.
        const prior = run.strictSteps ?? [];
        patch.strictSteps = [...new Set([...prior, ...p.strict_steps])];
      }
      const updated = updateRun(ctx, p.id, p.expect_rev, patch);
      syncHumanStepAnswerers(ctx, updated.id);
      return runEntityValue(updated);
    },
  }),
  "run.set_budget": op({
    description: "Raise or change the run's orchestrator and message turn budgets. Person only.",
    params: z.object({
      id: runId,
      orchestrator_turns: z.number().int().positive().optional(),
      message_turns: z.number().int().positive().optional(),
      expect_rev: z.number().int().positive(),
    }).refine(p => p.orchestrator_turns !== undefined || p.message_turns !== undefined, {
      message: "orchestrator_turns or message_turns is required",
    }),
    handler: (ctx, p) => {
      assertPersonCaller(ctx);
      const run = getRun(ctx, p.id);
      if (!run) throw new CoreError("not_found", `unknown run ${p.id}`);
      return runEntityValue(applyBudgetRaise(ctx, p.id, p.expect_rev, {
        ...(p.orchestrator_turns !== undefined ? { orchestratorTurns: p.orchestrator_turns } : {}),
        ...(p.message_turns !== undefined ? { messageTurns: p.message_turns } : {}),
      }));
    },
  }),
  "run.set_priority": op({
    description: "Set a run's priority (urgent|normal|background). Person only. Re-prioritizes the run's queued step tasks.",
    params: z.object({
      id: runId,
      priority: z.enum(RUN_PRIORITIES),
      expect_rev: z.number().int().positive(),
    }),
    handler: async (ctx, p) => {
      assertPersonCaller(ctx);
      const run = getRun(ctx, p.id);
      if (!run) throw new CoreError("not_found", `unknown run ${p.id}`);
      let updated = updateRun(ctx, p.id, p.expect_rev, { priority: p.priority as RunPriority });
      applyPriorityToQueuedRunTasks(ctx, updated);
      try {
        const mode = await readPacingMode(ctx);
        updated = syncRunPacingPause(ctx, updated, mode);
      } catch { /* */ }
      try {
        await publish(ctx, [
          { type: "entity", data: { kind: "run", id: updated.id, value: runEntityValue(updated) } },
        ]);
      } catch { /* */ }
      return runEntityValue(updated);
    },
  }),
  "run.pause": op({
    description: "Pause a run at the next step boundary. Person only. Running steps finish.",
    params: z.object({ id: runId, expect_rev: z.number().int().positive() }),
    handler: async (ctx, p) => {
      assertPersonCaller(ctx);
      const run = getRun(ctx, p.id);
      if (!run) throw new CoreError("not_found", `unknown run ${p.id}`);
      if (run.status === "done" || run.status === "failed" || run.status === "stopped") {
        throw new CoreError("not_allowed", `run ${p.id} is ${run.status}`);
      }
      const updated = pauseRunByPerson(ctx, p.id, p.expect_rev);
      try {
        await publish(ctx, [
          { type: "entity", data: { kind: "run", id: updated.id, value: runEntityValue(updated) } },
        ]);
      } catch { /* */ }
      return runEntityValue(updated);
    },
  }),
  "run.resume": op({
    description: "Resume a person-paused run. Person only. A pacing pause returns if the mode still requires it.",
    params: z.object({ id: runId, expect_rev: z.number().int().positive() }),
    handler: async (ctx, p, deps) => {
      assertPersonCaller(ctx);
      const run = getRun(ctx, p.id);
      if (!run) throw new CoreError("not_found", `unknown run ${p.id}`);
      if (run.status === "done" || run.status === "failed" || run.status === "stopped") {
        throw new CoreError("not_allowed", `run ${p.id} is ${run.status}`);
      }
      const mode = await readPacingMode(ctx);
      const updated = resumeRunByPerson(ctx, p.id, p.expect_rev, mode);
      // Paused-at-start runs (root or children) have no step rows; start entry once clear.
      // Scope to the resumed tree — do not scan every live run on each person resume.
      const { deps: engine, spawn } = engineDeps(deps);
      try {
        // Resume must not consume the durable transient entry-start budget (batch H);
        // the tick still counts toward the time/attempt bound.
        await startPendingEntries(ctx, {
          deps: engine, spawn, rootRunId: updated.id, countTransient: false,
        });
      } catch { /* tick retries */ }
      const live = getRun(ctx, updated.id) ?? updated;
      try {
        await publish(ctx, [
          { type: "entity", data: { kind: "run", id: live.id, value: runEntityValue(live) } },
        ]);
      } catch { /* */ }
      return runEntityValue(live);
    },
  }),
  "run.seen": op({
    description: "Mark that the person opened a run. Writes a returned wake-up when something changed since last look and no fresher summary exists. Person/client only; not a run-grant op.",
    params: z.object({ id: runId }),
    handler: async (ctx, p) => {
      assertPersonCaller(ctx);
      const { run } = markRunSeen(ctx, p.id);
      try {
        await publish(ctx, [
          { type: "entity", data: { kind: "run", id: run.id, value: runEntityValue(run) } },
        ]);
      } catch { /* */ }
      return runEntityValue(run);
    },
  }),
  "run.retry_orchestrator": op({
    description: "Clear a blocked orchestrator after repeated failures so the next tick can start a turn. Person only. Does not clear a budget block — use run.set_budget.",
    params: z.object({ id: runId, expect_rev: z.number().int().positive() }),
    handler: (ctx, p) => {
      assertPersonCaller(ctx);
      const run = getRun(ctx, p.id);
      if (!run) throw new CoreError("not_found", `unknown run ${p.id}`);
      // Optimistic concurrency first — never reset failures on a stale rev (round-3).
      if (run.rev !== p.expect_rev) {
        throw new CoreError("conflict", `conflict: run ${p.id} rev is ${run.rev}, expected ${p.expect_rev}`);
      }
      if (isBudgetBlocked(run)) {
        throw new CoreError("not_allowed", "The planning budget is spent. Add more planning or stop the run.");
      }
      // Reset consecutive failure count so the next turn does not inherit failures=N and re-block.
      workflowDatabase(ctx).query(
        "UPDATE workflow_turns SET failures = 0 WHERE run_id = ? AND status IN ('done', 'failed', 'stopped') AND ended_at IS NOT NULL",
      ).run(p.id);
      const spent = parseSpent(run.spent);
      const unresolved = !!(spent.unresolvedWakes || spent.blockedBy === "unresolved");
      if (unresolved) {
        delete spent.unresolvedWakes;
        delete spent.blockedBy;
      }
      // Clear failure/unresolved attention clocks in the SAME write as the idle
      // reset — a separate clearAttentionAt bumps rev and conflicts (G4 / N5-2).
      if (spent.attentionAtByKind) {
        delete spent.attentionAtByKind.unresolved_wake;
        delete spent.attentionAtByKind.orchestrator_failed;
        if (Object.keys(spent.attentionAtByKind).length === 0) {
          delete spent.attentionAtByKind;
          delete spent.attentionAt;
        }
      } else {
        delete spent.attentionAt;
      }
      return runEntityValue(updateRun(ctx, p.id, p.expect_rev, {
        orchestratorState: "idle",
        reason: null,
        nextWakeAt: null,
        spent: serializeSpent(spent),
      }));
    },
  }),
  "run.set_planner": op({
    description: "Queue a planner switch for the next orchestrator turn. Person only. Validated against PLANNERS.",
    params: z.object({
      id: runId,
      planner: z.string().min(1).max(64),
      expect_rev: z.number().int().positive(),
    }),
    handler: async (ctx, p) => {
      assertPersonCaller(ctx);
      if (!(PLANNERS as readonly string[]).includes(p.planner)) {
        throw new CoreError("invalid_input", `planner must be one of ${PLANNERS.join(", ")}`);
      }
      const run = getRun(ctx, p.id);
      if (!run) throw new CoreError("not_found", `unknown run ${p.id}`);
      // Optimistic concurrency first — never reset failures on a stale rev (I4).
      if (run.rev !== p.expect_rev) {
        throw new CoreError("conflict", `conflict: run ${p.id} rev is ${run.rev}, expected ${p.expect_rev}`);
      }
      const clearBlocked = run.orchestratorState === "blocked" && !isBudgetBlocked(run);
      const spent = parseSpent(run.spent);
      if (clearBlocked) {
        // Drop unresolved markers so a planner switch does not leave a stale block (round-4).
        delete spent.unresolvedWakes;
        if (spent.blockedBy === "unresolved") delete spent.blockedBy;
        // Clear attention stamps so a new episode gets a fresh since (N5-2).
        if (spent.attentionAtByKind) {
          delete spent.attentionAtByKind.unresolved_wake;
          delete spent.attentionAtByKind.orchestrator_failed;
          if (Object.keys(spent.attentionAtByKind).length === 0) {
            delete spent.attentionAtByKind;
            delete spent.attentionAt;
          }
        } else {
          delete spent.attentionAt;
        }
      }
      const updated = updateRun(ctx, p.id, p.expect_rev, {
        pendingPlanner: p.planner,
        ...(clearBlocked
          ? {
            orchestratorState: "idle" as const,
            reason: null,
            nextWakeAt: null,
            spent: serializeSpent(spent),
          }
          : {}),
      });
      if (clearBlocked) {
        // Reset consecutive failures only after updateRun succeeds (I4 / N5-3).
        workflowDatabase(ctx).query(
          "UPDATE workflow_turns SET failures = 0 WHERE run_id = ? AND status IN ('done', 'failed', 'stopped') AND ended_at IS NOT NULL",
        ).run(p.id);
      }
      recordDecision(ctx, {
        runId: p.id,
        stepId: "_planner",
        attempt: 0,
        actor: "person",
        kind: "set_planner",
        choice: p.planner,
        reason: `switch planner to ${p.planner} at next turn`,
      });
      const decision = { id: `dec_planner_${p.id}`, runId: p.id, planner: p.planner, at: ctx.now };
      try {
        await publish(ctx, [
          { type: "entity", data: { kind: "run", id: updated.id, value: runEntityValue(updated) } },
          { type: "entity", data: { kind: "decision", id: decision.id, value: decision } },
        ]);
      } catch { /* */ }
      return runEntityValue(updated);
    },
  }),
  "run.choose": op({
    description: "Choose a child workflow for a choose_workflow step under a live run grant.",
    params: z.object({
      id: runId,
      step: z.string().min(1).max(128),
      workflow: z.string().min(1).max(256),
      reason: z.string().min(1).max(4000),
    }),
    handler: async (ctx, p, deps) => {
      const grant = ctx.env.PACER_RUN_GRANT ? verifyRunGrant(ctx, ctx.env.PACER_RUN_GRANT) : null;
      if (!grant || rootRunId(ctx, p.id) !== grant.runId) {
        throw new CoreError("not_allowed", "run.choose requires a live run grant for this run");
      }
      const { deps: engine, spawn } = engineDeps(deps);
      const child = await chooseWorkflow(ctx, {
        runId: p.id, stepId: p.step, workflow: p.workflow, reason: p.reason,
      }, spawn, engine);
      recordDecision(ctx, {
        runId: p.id,
        stepId: p.step,
        attempt: 0,
        actor: "orchestrator",
        kind: "choose",
        choice: p.workflow,
        reason: p.reason,
      });
      return child;
    },
  }),
  "run.decide": op({
    description: "Answer an auto human step or auto graph approval under a live run grant, or write a since-you-last-looked summary (kind: summary). Never answers a must step.",
    params: z.union([
      z.object({
        id: runId,
        kind: z.literal("summary"),
        summary: z.string().min(1).superRefine((s, issueCtx) => {
          // Must match SUMMARY_MAX_BYTES so the op refuses what storage would truncate.
          if (Buffer.byteLength(s, "utf8") > SUMMARY_MAX_BYTES) {
            issueCtx.addIssue({ code: z.ZodIssueCode.custom, message: `Summary exceeds ${SUMMARY_MAX_BYTES} bytes UTF-8` });
          }
        }),
        reason: z.string().min(1).max(4000).optional(),
      }),
      z.object({
        id: runId,
        step: z.string().min(1).max(128),
        choice: z.string().min(1).max(4000),
        reason: z.string().min(1).max(4000),
        kind: z.literal("decide").optional(),
      }),
    ]),
    handler: async (ctx, p, deps) => {
      // Grant-only: person uses run.answer. An executor without a grant is refused.
      const grant = ctx.env.PACER_RUN_GRANT ? verifyRunGrant(ctx, ctx.env.PACER_RUN_GRANT) : null;
      if (!grant || rootRunId(ctx, p.id) !== grant.runId) {
        throw new CoreError("not_allowed", "run.decide requires a live run grant for this run");
      }
      if ("kind" in p && p.kind === "summary") {
        const run = getRun(ctx, p.id);
        if (!run) throw new CoreError("not_found", `unknown run ${p.id}`);
        const updated = storeRunSummary(ctx, p.id, run.rev, p.summary);
        recordDecision(ctx, {
          runId: p.id,
          stepId: "summary",
          attempt: 0,
          actor: "orchestrator",
          kind: "summary",
          choice: updated.summary ?? p.summary,
          reason: p.reason ?? "since you last looked",
        });
        try {
          await publish(ctx, [
            { type: "entity", data: { kind: "run", id: updated.id, value: runEntityValue(updated) } },
          ]);
        } catch { /* */ }
        return runEntityValue(updated);
      }
      const step = "step" in p ? p.step : undefined;
      const choice = "choice" in p ? p.choice : undefined;
      const reason = "reason" in p ? p.reason : undefined;
      if (!step || !choice || !reason) {
        throw new CoreError("invalid_input", "run.decide requires step, choice and reason (or kind: summary)");
      }
      const run = getRun(ctx, p.id);
      if (!run) throw new CoreError("not_found", `unknown run ${p.id}`);
      const def = getDefinition(ctx, `${run.workflow}@${run.version}`) ?? getDefinition(ctx, run.workflow);
      const stepDef = def?.steps[step];
      const waiting = stepsOfRun(ctx, p.id).filter(s => s.stepId === step && s.status === "waiting");
      const row = waiting[waiting.length - 1];
      const attempt = row?.attempt ?? 0;
      // Auto/strict live on the root run; child choose_workflow rows have auto=0 (I2).
      const root = getRun(ctx, rootRunId(ctx, p.id)) ?? run;
      const { deps: engine, spawn } = engineDeps(deps);
      if (stepDef?.type === "generate") {
        if (!canAutoApproveGenerate(root, step, stepDef as GenerateStep)) {
          recordDecision(ctx, {
            runId: p.id, stepId: step, attempt, actor: "orchestrator",
            kind: "refused", choice, reason,
          });
          throw new CoreError("not_allowed", "Orchestrator cannot answer this step (must, strict, or auto off)");
        }
        if (!row) throw new CoreError("conflict", `conflict: step ${step} of ${p.id} is not waiting for an answer`);
        const updated = await answerGenerateApproval(ctx, {
          runId: p.id, stepId: step, answer: choice, note: reason, expectRev: run.rev,
        }, engine, spawn);
        recordDecision(ctx, {
          runId: p.id, stepId: step, attempt: row.attempt, actor: "orchestrator",
          kind: "decide", choice, reason,
        });
        return updated;
      }
      if (!stepDef || stepDef.type !== "human") {
        throw new CoreError("conflict", `conflict: step ${step} is not a human step`);
      }
      if (!canAutoDecide(root, step, stepDef as HumanStep)) {
        recordDecision(ctx, {
          runId: p.id,
          stepId: step,
          attempt,
          actor: "orchestrator",
          kind: "refused",
          choice,
          reason,
        });
        throw new CoreError("not_allowed", "Orchestrator cannot answer this step (must, strict, or auto off)");
      }
      if (!row) throw new CoreError("conflict", `conflict: step ${step} of ${p.id} is not waiting for an answer`);
      // Escalated human_step questions stay person-owned even while canAutoDecide (I-2).
      const escalatedPerson = listQuestions(ctx, p.id, "open").some(q =>
        q.askerKind === "human_step"
        && q.stepId === step
        && q.attempt === row.attempt
        && (q.branch ?? undefined) === (row.branch ?? undefined)
        && q.answerer === "person"
        && q.chain.includes("orchestrator"),
      );
      if (escalatedPerson) {
        recordDecision(ctx, {
          runId: p.id,
          stepId: step,
          attempt: row.attempt,
          actor: "orchestrator",
          kind: "refused",
          choice,
          reason,
        });
        throw new CoreError("not_allowed", "Only the person can answer this question");
      }
      const updated = await answerHumanStep(ctx, p.id, step, choice, run.rev, engine, spawn);
      recordDecision(ctx, {
        runId: p.id,
        stepId: step,
        attempt: row.attempt,
        actor: "orchestrator",
        kind: "decide",
        choice,
        reason,
      });
      return updated;
    },
  }),
  "run.submit_graph": op({
    description: "Submit a generated sub-workflow for a waiting generate step under a live run grant.",
    params: z.object({
      id: runId,
      step: z.string().min(1).max(128),
      source: z.union([
        z.string().min(1).max(256 * 1024),
        z.record(z.string(), z.unknown()).superRefine((obj, ctx) => {
          const bytes = Buffer.byteLength(JSON.stringify(obj), "utf8");
          if (bytes > 256 * 1024) {
            ctx.addIssue({
              code: "custom",
              message: `object-form source is ${bytes} bytes; max is ${256 * 1024}`,
            });
          }
        }),
      ]),
    }),
    handler: async (ctx, p, deps) => {
      const grant = ctx.env.PACER_RUN_GRANT ? verifyRunGrant(ctx, ctx.env.PACER_RUN_GRANT) : null;
      if (!grant || rootRunId(ctx, p.id) !== grant.runId) {
        throw new CoreError("not_allowed", "run.submit_graph requires a live run grant for this run");
      }
      let def: WorkflowDef | undefined;
      let shapeErrors: WorkflowError[] | undefined;
      if (typeof p.source === "string") {
        const parsed = parseWorkflow(p.source);
        if (!parsed.def || parsed.errors.length > 0) {
          shapeErrors = parsed.errors.length ? parsed.errors : [{ path: "", message: "invalid workflow source" }];
        } else {
          def = parsed.def;
        }
      } else if (isPlainObject(p.source)) {
        const shaped = checkWorkflowShape(normalizeWorkflowObject(p.source));
        if (!shaped.def || shaped.errors.length > 0) {
          shapeErrors = shaped.errors.length ? shaped.errors : [{ path: "", message: "invalid workflow source" }];
        } else {
          def = shaped.def;
        }
      } else {
        shapeErrors = [{ path: "source", message: "invalid workflow source" }];
      }
      if (shapeErrors) {
        // Shape/parse errors count toward generate retries (same as validateGenerated).
        return noteGenerateSubmitErrors(ctx, p.id, p.step, shapeErrors);
      }
      const { deps: engine, spawn } = engineDeps(deps);
      const waiting = stepsOfRun(ctx, p.id).filter(s => s.stepId === p.step && s.status === "waiting");
      const attempt = waiting[waiting.length - 1]?.attempt ?? 0;
      const result = await submitGraph(ctx, { runId: p.id, stepId: p.step, source: def! }, engine, spawn);
      if (result.ok) {
        recordDecision(ctx, {
          runId: p.id,
          stepId: p.step,
          attempt,
          actor: "orchestrator",
          kind: "submit_graph",
          choice: `v${result.version ?? "?"}`,
          reason: "submit generated graph",
        });
      }
      return result;
    },
  }),
  "run.sync_base": op({
    description: "Merge the base branch tip into the run branch under the merge lock. Person or a live run grant for this run.",
    params: z.object({ id: runId, expect_rev: z.number().int().positive() }),
    handler: async (ctx, p) => {
      if (ctx.env.PACER_RUN_GRANT) {
        const grant = verifyRunGrant(ctx, ctx.env.PACER_RUN_GRANT);
        if (!grant || rootRunId(ctx, p.id) !== grant.runId) {
          throw new CoreError("not_allowed", "unknown run");
        }
      } else {
        assertPersonCaller(ctx);
      }
      const result = await syncBase(ctx, p.id, p.expect_rev);
      // M8: always return runEntityValue of a re-read run (conflict path had a stale pre-marker row).
      const live = getRun(ctx, p.id) ?? result.run;
      if (result.ok) return { ok: true as const, run: runEntityValue(live) };
      return {
        ok: false as const,
        merge: result.merge,
        resolution_task: result.resolution_task,
        run: runEntityValue(live),
      };
    },
  }),
  "run.publish": op({
    description: "Push the run branch and open a PR when the publishing gate allows it. Person or a live run grant for this run; executors refused.",
    params: z.object({
      id: runId,
      draft: z.boolean(),
      title: z.string().min(1).max(256),
      body: z.string().max(60 * 1024),
      expect_rev: z.number().int().positive(),
    }),
    handler: async (ctx, p) => {
      if (ctx.env.PACER_RUN_GRANT) {
        const grant = verifyRunGrant(ctx, ctx.env.PACER_RUN_GRANT);
        if (!grant || rootRunId(ctx, p.id) !== grant.runId) {
          throw new CoreError("not_allowed", "unknown run");
        }
      } else {
        assertPersonCaller(ctx);
      }
      const result = await publishRun(ctx, p.id, {
        draft: p.draft, title: p.title, body: p.body, expectRev: p.expect_rev,
      });
      return { pr_url: result.pr_url, run: runEntityValue(result.run) };
    },
  }),
  "run.cleanup": op({
    description: "Person-only: remove leftover integration worktree and optionally delete the local run branch. Never touches remotes.",
    params: z.object({
      id: runId,
      delete_branch: z.boolean(),
      expect_rev: z.number().int().positive(),
    }),
    handler: async (ctx, p) => {
      assertPersonCaller(ctx);
      const result = await cleanupRun(ctx, p.id, {
        deleteBranch: p.delete_branch, expectRev: p.expect_rev,
      });
      return {
        run: runEntityValue(result.run),
        deleted_branch: result.deleted_branch,
        ...(result.ahead !== undefined ? { ahead: result.ahead } : {}),
        ...(result.deleted_tip !== undefined ? { deleted_tip: result.deleted_tip } : {}),
        ...(result.pr_url !== undefined ? { pr_url: result.pr_url } : {}),
      };
    },
  }),
  "question.ask": op({
    description: "Ask a structured run question from an executor step or the orchestrator grant.",
    params: questionInputSchema.extend({
      stepId: z.string().min(1).max(128).optional(),
      attempt: z.number().int().positive().optional(),
      branch: z.string().min(1).max(128).optional(),
      runId: runId.optional(),
    }).strict(),
    handler: async (ctx, p) => askQuestion(ctx, {
      text: p.text,
      answerType: p.answerType,
      ...(p.options ? { options: p.options } : {}),
      ...(p.recommended ? { recommended: p.recommended } : {}),
      blocks: p.blocks,
      ...(p.artifact ? { artifact: p.artifact } : {}),
      ...(p.stepId ? { stepId: p.stepId } : {}),
      ...(p.attempt !== undefined ? { attempt: p.attempt } : {}),
      ...(p.branch ? { branch: p.branch } : {}),
      ...(p.runId ? { runId: p.runId } : {}),
    }),
  }),
  "question.answer": op({
    description: "Answer a structured run question as the current answerer (person or orchestrator grant).",
    params: z.object({
      id: questionId,
      answer: z.string().min(1).max(2000),
      note: z.string().max(4000).optional(),
      expect_rev: z.number().int().positive(),
    }),
    handler: async (ctx, p, deps) => answerQuestion(ctx, {
      id: p.id,
      answer: p.answer,
      ...(p.note !== undefined ? { note: p.note } : {}),
      expectRev: p.expect_rev,
    }, { spawnRunner: deps.spawnRunner }),
  }),
  "question.escalate": op({
    description: "Escalate an open orchestrator-answerer question to the person with a suggested answer.",
    params: z.object({
      id: questionId,
      suggested: z.string().min(1).max(4000),
      reason: z.string().min(1).max(4000),
      expect_rev: z.number().int().positive(),
    }),
    handler: (ctx, p) => escalateQuestion(ctx, {
      id: p.id,
      suggested: p.suggested,
      reason: p.reason,
      expectRev: p.expect_rev,
    }),
  }),
  "question.get": op({
    description: "Read one structured run question by id.",
    params: z.object({ id: questionId }),
    handler: (ctx, p) => {
      const unknownMsg = `unknown question ${p.id}`;
      const q = getQuestion(ctx, p.id);
      if (!q) throw new CoreError("not_found", unknownMsg);
      if (ctx.env.PACER_RUN_GRANT) {
        const grant = verifyRunGrant(ctx, ctx.env.PACER_RUN_GRANT);
        if (!grant || rootRunId(ctx, q.runId) !== grant.runId) {
          throw new CoreError("not_found", unknownMsg);
        }
      } else if (isExecutorSession(ctx)) {
        // Executors may only read questions on their own run (M-h).
        // stepByTaskIfPresent: never create the workflow schema for ordinary executors.
        const taskId = ctx.env.PACER_TASK_ID;
        if (!taskId) throw new CoreError("not_found", unknownMsg);
        const step = stepByTaskIfPresent(ctx, taskId);
        if (!step || rootRunId(ctx, step.runId) !== rootRunId(ctx, q.runId)) {
          throw new CoreError("not_found", unknownMsg);
        }
      }
      return q;
    },
  }),
  "question.list": op({
    description: "List structured run questions, optionally for one run.",
    params: z.object({
      run: runId.optional(),
      status: z.enum(["open", "answered", "withdrawn"]).optional(),
    }),
    handler: (ctx, p) => {
      const grant = ctx.env.PACER_RUN_GRANT ? verifyRunGrant(ctx, ctx.env.PACER_RUN_GRANT) : null;
      if (ctx.env.PACER_RUN_GRANT && !grant) throw new CoreError("not_found", "unknown run");
      if (p.run) {
        if (grant && rootRunId(ctx, p.run) !== grant.runId) {
          throw new CoreError("not_found", `unknown run ${p.run}`);
        }
        return listQuestions(ctx, p.run, p.status);
      }
      if (grant) {
        const runs = listRuns(ctx).filter(r => rootRunId(ctx, r.id) === grant.runId);
        const rows = runs.flatMap(r => listQuestions(ctx, r.id, p.status));
        return rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      }
      assertPersonCaller(ctx);
      if (p.status === "open" || p.status === undefined) return listOpenPersonQuestions(ctx);
      throw new CoreError("invalid_input", "run is required when listing non-open questions");
    },
  }),
  "question.convert_prompt": op({
    description: "Convert a step task's prompt-wait mark into a structured question. Never types into the terminal.",
    params: z.object({ id: z.string().min(1).max(128) }),
    handler: (ctx, p) => {
      assertPersonCaller(ctx);
      return convertPromptWaitToQuestion(ctx, p.id);
    },
  }),
};
