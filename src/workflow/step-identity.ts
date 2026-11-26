// Who is reporting for a workflow step: the executor's workflow operations (`step.result`,
// `step.artifact`, `question.ask`), gated by task identity (workflow frame design, "Grant";
// ADR 0029 decision 10). An attempt that is issued a credential proves that identity with it.
import { CoreError } from "../core/errors";
import { requireAskingExecutor } from "../core/tasks";
import { authorizeEnforcementToken } from "../dispatch/enforcement-token";
import { authorizeWorkGrant, getWork } from "../dispatch/work";
import { isExecutorSession } from "../install/role";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
import { stepByTaskIfPresent, type StepRow } from "./store";

/** The only operations a step worker's attempt credential adds, and only for its own step. */
export const STEP_SELF_OPS: readonly string[] = ["step.result", "step.artifact", "question.ask"];

const hasCredential = (ctx: Ctx): boolean => !!(ctx.env.PACER_ENFORCEMENT_TOKEN || ctx.env.PACER_WORK_GRANT);

/**
 * The caller's own step, proven by its attempt credential, or null. Every credential present must
 * verify (live, unrevoked, task running, current attempt) and name the task in `PACER_TASK_ID`,
 * which must be set: an HTTP bearer request carries none, so no bearer gains these operations.
 * The orchestrator is never a step worker; its identity is the run grant.
 * This is not containment against a same-user process that edits its own environment or store.
 */
export function verifiedStepWorker(ctx: Ctx): StepRow | null {
  const id = ctx.env.PACER_TASK_ID;
  if (!id || !hasCredential(ctx) || ctx.env.PACER_RUN_GRANT || ctx.env.PACER_ASSISTANT_GRANT || !isExecutorSession(ctx)) return null;
  const { PACER_ENFORCEMENT_TOKEN: token, PACER_WORK_GRANT: grant } = ctx.env;
  try {
    if (token && authorizeEnforcementToken(ctx, token).taskId !== id) return null;
    if (grant && authorizeWorkGrant(ctx, grant).taskId !== id) return null;
  } catch (error) {
    if (error instanceof CoreError) return null;
    throw error;
  }
  if (readTask(ctx, id)?.kind === "orchestrate") return null;
  return stepByTaskIfPresent(ctx, id);
}

/** Whether `question.ask` params stay on the worker's own step: no run, and nothing that differs from the step row. */
export function questionStaysOnStep(step: StepRow, params: unknown): boolean {
  const p = (params ?? {}) as { runId?: unknown; stepId?: unknown; attempt?: unknown; branch?: unknown };
  return p.runId === undefined
    && (p.stepId === undefined || p.stepId === step.stepId)
    && (p.attempt === undefined || p.attempt === step.attempt)
    && (p.branch === undefined || p.branch === step.branch);
}

/** Whether the runner issues this task's attempts a credential: strict enforcement or a work grant. */
function reportsWithCredential(ctx: Ctx, id: string): boolean {
  const options = getWork(ctx, id)?.options;
  return !!options && (options.delegationEnforcement === "strict" || options.allowDelegation);
}

/**
 * The task a step operation acts on. With a credential, the verified one. Without any, the
 * `PACER_TASK_ID` of an executor session, but never for a step whose attempts are issued a
 * credential: dropping the credential and naming that task, running or not, reports nothing.
 */
export function requireStepWorker(ctx: Ctx): string {
  if (hasCredential(ctx)) {
    const step = verifiedStepWorker(ctx);
    if (!step?.taskId) throw new CoreError("not_allowed", "This credential does not belong to the calling workflow step");
    return step.taskId;
  }
  const id = requireAskingExecutor(ctx);
  if (stepByTaskIfPresent(ctx, id) && reportsWithCredential(ctx, id)) {
    throw new CoreError("not_allowed", "This workflow step reports with its attempt credential");
  }
  return id;
}
