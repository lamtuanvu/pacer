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
  rootRunId, runEntityValue, stepByTask, stepsOfRun, updateRun, workflowDatabase,
  type RunRow, type RunStatus,
} from "../workflow/store";
import {
  answerQuestion, askQuestion, escalateQuestion, syncHumanStepAnswerers,
} from "../workflow/questions";
import { questionInputSchema } from "../workflow/question-schema";
import { convertPromptWaitToQuestion } from "../workflow/prompt-detector";
import {
  answerGenerateApproval, answerHumanStep, chooseWorkflow, defaultEngineDeps, recordStepResult, retryFailedStep,
  skipFailedStep, startRun, stopRun,
  type EngineDeps,
} from "../workflow/engine";
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
    params: z.object({ workflow: workflowRef, repo: z.string().min(1).max(4096), brief: z.string().min(1).max(8000), title: z.string().min(1).max(120).optional() }),
    handler: async (ctx, p, deps) => {
      assertPersonCaller(ctx);
      const { deps: engine, spawn } = engineDeps(deps);
      // The engine publishes the run entity: on creation, on a failed start and on
      // every status change it makes.
      return startRun(ctx, { workflow: p.workflow, repo: p.repo, brief: p.brief, ...(p.title ? { title: p.title } : {}) }, spawn, engine);
    },
  }),
  "run.get": op({
    description: "One run with its step instances and generated graph versions.",
    params: z.object({ id: runId }),
    handler: (ctx, p) => {
      assertPersonCaller(ctx);
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
    description: "Answer an auto human step or auto graph approval under a live run grant. Never answers a must step.",
    params: z.object({
      id: runId,
      step: z.string().min(1).max(128),
      choice: z.string().min(1).max(4000),
      reason: z.string().min(1).max(4000),
    }),
    handler: async (ctx, p, deps) => {
      // Grant-only: person uses run.answer. An executor without a grant is refused.
      const grant = ctx.env.PACER_RUN_GRANT ? verifyRunGrant(ctx, ctx.env.PACER_RUN_GRANT) : null;
      if (!grant || rootRunId(ctx, p.id) !== grant.runId) {
        throw new CoreError("not_allowed", "run.decide requires a live run grant for this run");
      }
      const run = getRun(ctx, p.id);
      if (!run) throw new CoreError("not_found", `unknown run ${p.id}`);
      const def = getDefinition(ctx, `${run.workflow}@${run.version}`) ?? getDefinition(ctx, run.workflow);
      const stepDef = def?.steps[p.step];
      const waiting = stepsOfRun(ctx, p.id).filter(s => s.stepId === p.step && s.status === "waiting");
      const row = waiting[waiting.length - 1];
      const attempt = row?.attempt ?? 0;
      // Auto/strict live on the root run; child choose_workflow rows have auto=0 (I2).
      const root = getRun(ctx, rootRunId(ctx, p.id)) ?? run;
      const { deps: engine, spawn } = engineDeps(deps);
      if (stepDef?.type === "generate") {
        if (!canAutoApproveGenerate(root, p.step, stepDef as GenerateStep)) {
          recordDecision(ctx, {
            runId: p.id, stepId: p.step, attempt, actor: "orchestrator",
            kind: "refused", choice: p.choice, reason: p.reason,
          });
          throw new CoreError("not_allowed", "Orchestrator cannot answer this step (must, strict, or auto off)");
        }
        if (!row) throw new CoreError("conflict", `conflict: step ${p.step} of ${p.id} is not waiting for an answer`);
        const updated = await answerGenerateApproval(ctx, {
          runId: p.id, stepId: p.step, answer: p.choice, note: p.reason, expectRev: run.rev,
        }, engine, spawn);
        recordDecision(ctx, {
          runId: p.id, stepId: p.step, attempt: row.attempt, actor: "orchestrator",
          kind: "decide", choice: p.choice, reason: p.reason,
        });
        return updated;
      }
      if (!stepDef || stepDef.type !== "human") {
        throw new CoreError("conflict", `conflict: step ${p.step} is not a human step`);
      }
      if (!canAutoDecide(root, p.step, stepDef as HumanStep)) {
        recordDecision(ctx, {
          runId: p.id,
          stepId: p.step,
          attempt,
          actor: "orchestrator",
          kind: "refused",
          choice: p.choice,
          reason: p.reason,
        });
        throw new CoreError("not_allowed", "Orchestrator cannot answer this step (must, strict, or auto off)");
      }
      if (!row) throw new CoreError("conflict", `conflict: step ${p.step} of ${p.id} is not waiting for an answer`);
      const updated = await answerHumanStep(ctx, p.id, p.step, p.choice, run.rev, engine, spawn);
      recordDecision(ctx, {
        runId: p.id,
        stepId: p.step,
        attempt: row.attempt,
        actor: "orchestrator",
        kind: "decide",
        choice: p.choice,
        reason: p.reason,
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
      const q = getQuestion(ctx, p.id);
      if (!q) throw new CoreError("not_found", `unknown question ${p.id}`);
      if (ctx.env.PACER_RUN_GRANT) {
        const grant = verifyRunGrant(ctx, ctx.env.PACER_RUN_GRANT);
        if (!grant || rootRunId(ctx, q.runId) !== grant.runId) {
          throw new CoreError("not_found", `unknown question ${p.id}`);
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
