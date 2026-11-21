// Auto-mode rules for human steps: the orchestrator may answer only when the
// run's auto flag is on, the step is marked decision:auto, and the person has
// not made it stricter for this run. A must step can never be answered here.
import type { HumanStep } from "./schema";
import type { RunRow } from "./store";

/** Effective decision for a human step on this run (strict override wins). */
export function effectiveDecision(run: RunRow, stepId: string, step: HumanStep): "must" | "auto" {
  if (run.strictSteps?.includes(stepId)) return "must";
  return step.decision === "auto" ? "auto" : "must";
}

/** Whether run.decide may answer this human step under the run's auto flag. */
export function canAutoDecide(run: RunRow, stepId: string, step: HumanStep): boolean {
  if (!run.auto) return false;
  return effectiveDecision(run, stepId, step) === "auto";
}
