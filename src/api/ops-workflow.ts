// The workflow frame's /v3 operations (plan Task 8): definition management, runs
// and step results. All state lives in the workflow tables of the task store
// (src/workflow/store.ts), so the native host keeps these TypeScript-forwarded;
// the protocol change is additive and v3-only (P4). Run mutations publish a run
// entity so clients draw the run view from the event stream.
import { z } from "zod";
import type { OpDef, OpDeps } from "./ops";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { isExecutorSession } from "../install/role";
import { WORKFLOW_OPS_REFUSAL } from "./caller-policy";
import { parseWorkflow } from "../workflow/parse";
import { validateWorkflow } from "../workflow/validate";
import {
  addDefinition, getRun, listDefinitions, listRuns, stepsOfRun,
  type RunRow, type RunStatus,
} from "../workflow/store";
import {
  answerHumanStep, defaultEngineDeps, recordStepResult, startRun, stopRun,
  type EngineDeps,
} from "../workflow/engine";
import type { WorkflowError, WorkflowDef } from "../workflow/schema";
import { requireAskingExecutor } from "../core/tasks";
import { spawnRunner, type SpawnRunner } from "../tasks/api";
import { publish } from "../link/publish";

const op = <P extends z.ZodTypeAny>(def: OpDef<P>) => def as unknown as OpDef;

const runId = z.string().regex(/^run_[a-z2-7]{10}$/);
const workflowRef = z.string().min(1).max(256);
const status = z.enum(["running", "waiting", "done", "failed", "stopped"]);
// A workflow file's text is capped at 256 KiB like other free-text bodies.
const source = z.string().min(1).max(256 * 1024);

/** Workflow and run operations are for the person and the planner; an executor's
 *  only frame operation is step.result. assertCallerCanInvoke answers the same
 *  way for CLI paths, so every transport refuses with one text. */
function assertPersonCaller(ctx: Ctx): void {
  if (isExecutorSession(ctx)) throw new CoreError("not_allowed", WORKFLOW_OPS_REFUSAL);
}

/** callOp deps → engine deps: tests stub delegation through OpDeps. */
function engineDeps(deps: OpDeps): { deps: EngineDeps; spawn?: SpawnRunner } {
  return {
    deps: deps.delegate ? { ...defaultEngineDeps, delegate: deps.delegate } : defaultEngineDeps,
    spawn: deps.spawnRunner,
  };
}

async function publishRun(ctx: Ctx, run: RunRow): Promise<RunRow> {
  await publish(ctx, [{ type: "entity", data: { kind: "run", id: run.id, value: run } }]);
  return run;
}

/** Parses a source and runs structural validation, so callers see every error at once. */
function definitionErrors(sourceText: string): { def?: WorkflowDef; errors: WorkflowError[] } {
  const { def, errors } = parseWorkflow(sourceText);
  if (!def) return { errors };
  return { def, errors: [...errors, ...validateWorkflow(def)] };
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
      const run = await startRun(ctx, { workflow: p.workflow, repo: p.repo, brief: p.brief, ...(p.title ? { title: p.title } : {}) }, spawn, engine);
      return publishRun(ctx, run);
    },
  }),
  "run.get": op({
    description: "One run with its step instances.",
    params: z.object({ id: runId }),
    handler: (ctx, p) => {
      assertPersonCaller(ctx);
      const run = getRun(ctx, p.id);
      if (!run) throw new CoreError("not_found", `unknown run ${p.id}`);
      return { run, steps: stepsOfRun(ctx, p.id) };
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
    description: "Answer a waiting human step; the answer advances the run. Requires the run's current rev.",
    params: z.object({ id: runId, step: z.string().min(1).max(128), answer: z.string().min(1).max(4000), expect_rev: z.number().int().positive() }),
    handler: async (ctx, p, deps) => {
      assertPersonCaller(ctx);
      const { deps: engine } = engineDeps(deps);
      return publishRun(ctx, await answerHumanStep(ctx, p.id, p.step, p.answer, p.expect_rev, engine));
    },
  }),
  "run.stop": op({
    description: "Stop a run and its running step tasks. Requires the run's current rev.",
    params: z.object({ id: runId, expect_rev: z.number().int().positive() }),
    handler: async (ctx, p, deps) => {
      assertPersonCaller(ctx);
      const { deps: engine } = engineDeps(deps);
      return publishRun(ctx, stopRun(ctx, p.id, p.expect_rev, engine));
    },
  }),
  "step.result": op({
    description: "Record the calling executor's structured result for its workflow step task, validated at once; once per step, before the task settles.",
    params: z.object({ result: z.record(z.string(), z.json()) }),
    handler: (ctx, p) => recordStepResult(ctx, requireAskingExecutor(ctx), p.result),
  }),
};
