import type { StepRow } from "./store";

/** Retries a step and branch allow before only a skip is left. */
export const MAX_STEP_RETRIES = 3;

/** Whether this failed row's step and branch already used every retry. */
export function stepRetriesSpent(rows: StepRow[], failed: StepRow): boolean {
  return rows.filter(s => s.stepId === failed.stepId && s.branch === failed.branch
    && s.status === "failed" && s.advancedAt !== undefined).length >= MAX_STEP_RETRIES;
}
