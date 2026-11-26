// Auto-mode rules for human steps and generate approvals: the orchestrator may
// answer only when the run's auto flag is on, the step is marked auto, and the
// person has not made it stricter for this run. A must step can never be answered.
import type { GenerateStep, HumanStep } from "./schema";
import type { RunRow } from "./store";

/** Effective decision for a human step on this run (strict override wins). */
export function effectiveDecision(run: RunRow, stepId: string, step: HumanStep): "must" | "auto" {
  if (run.strictSteps?.includes(stepId)) return "must";
  return step.decision === "auto" ? "auto" : "must";
}

/** Whether run.decide may answer this human step under the run's auto flag. */
export function canAutoDecide(run: RunRow, stepId: string, step: HumanStep): boolean {
  if (!run.auto) return false;
  // Defence in depth: publish approval is person-only (validator also requires must).
  if (step.approves === "publish") return false;
  return effectiveDecision(run, stepId, step) === "auto";
}

/** Whether the orchestrator may approve a generate step marked approval:auto. */
export function canAutoApproveGenerate(run: RunRow, stepId: string, step: GenerateStep): boolean {
  if (!run.auto) return false;
  if (run.strictSteps?.includes(stepId)) return false;
  return step.approval === "auto";
}

/** Whether the orchestrator may answer a pending plan approval. A re-plan the policy
 *  sends to the person stays theirs, whatever the step's approval says. */
export function orchestratorMayApprove(run: RunRow, stepId: string, step: GenerateStep, result: unknown): boolean {
  if ((result as { replanMode?: unknown } | null | undefined)?.replanMode === "ask") return false;
  return canAutoApproveGenerate(run, stepId, step);
}
