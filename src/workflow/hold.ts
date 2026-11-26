// A role:orchestrator step held for the orchestrator's own blocking question: it
// waits without a turn, and runs again once no such question is open (answered or
// withdrawn). Spec "Structured questions": a blocking question holds the asker.
import type { Ctx } from "../types";
import { readTask, updateTask } from "../tasks/store";
import { TERMINAL_STATES } from "../tasks/types";
import {
  attachStepTask, getDefinition, getRun, liveRuns, rootRunId, stepsOfRun, updateStep, workflowDatabase,
} from "./store";
import { enqueueWakeup, liveTurn, openBlockingAsk, stepWakeRef, stepsOfRootTree } from "./wakeups";

/** Re-queues the shared orchestrator task for a new turn, clearing its last attempt. */
export function requeueOrchestratorTask(ctx: Ctx, taskId: string): void {
  updateTask(ctx, taskId, t => {
    if (!TERMINAL_STATES.includes(t.state) && t.state !== "needs_input") return;
    t.state = "queued";
    delete t.result;
    delete t.settledAt;
    delete t.queue;
    delete t.reviewRequest;
    delete t.progress;
    delete t.runnerPid;
  });
}

/**
 * Resumes every held step whose questions are closed. Safe to call at any time
 * (idempotent, derived from durable rows), so a restart between an answer and the
 * resume loses nothing. A run with a live turn waits until that turn settles.
 */
export function resumeHeldSteps(ctx: Ctx): number {
  let resumed = 0;
  for (const run of liveRuns(ctx)) {
    const def = getDefinition(ctx, `${run.workflow}@${run.version}`) ?? getDefinition(ctx, run.workflow);
    if (!def) continue;
    for (const row of stepsOfRun(ctx, run.id)) {
      const stepDef = def.steps[row.stepId];
      // An orchestrator-role step only ever waits because it asked.
      if (row.status !== "waiting" || stepDef?.type !== "agent" || stepDef.role !== "orchestrator") continue;
      if (openBlockingAsk(ctx, row)) continue;
      const root = rootRunId(ctx, run.id);
      if (liveTurn(ctx, root)) continue;
      const taskId = getRun(ctx, root)?.orchestratorTaskId;
      // Another step of the tree owns the shared task until it settles.
      if (taskId && stepsOfRootTree(ctx, root).some(other => other.taskId === taskId && other.status === "running")) continue;
      // The wake-up and the queued task come first: a crash before the step runs again
      // leaves it waiting, and this pass repeats.
      enqueueWakeup(ctx, {
        runId: run.id, cause: "orchestrator_step",
        ref: stepWakeRef(run.id, row.stepId, row.attempt, row.branch), byPerson: true,
      });
      const attach = taskId && readTask(ctx, taskId) ? taskId : undefined;
      if (attach) requeueOrchestratorTask(ctx, attach);
      const key = {
        runId: run.id, stepId: row.stepId, attempt: row.attempt,
        ...(row.branch !== undefined ? { branch: row.branch } : {}),
      };
      workflowDatabase(ctx).transaction(() => {
        if (attach) {
          workflowDatabase(ctx).query("UPDATE workflow_steps SET task_id = NULL WHERE task_id = ?").run(attach);
          attachStepTask(ctx, key, attach);
        }
        updateStep(ctx, key, { status: "running" });
      }).immediate();
      resumed++;
    }
  }
  return resumed;
}
