import type { DispatchConfig } from "../../../src/dispatch/types";
import type { Rule } from "./executors";

export { moveKey, positionAnnouncement } from "../ds/SortableList";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** One change per rule position whose kinds or executor order differ, including added or removed rules. */
export function ruleChanges(saved: readonly Rule[], draft: readonly Rule[]): number {
  let count = 0;
  for (let index = 0; index < Math.max(saved.length, draft.length); index++) if (!same(saved[index], draft[index])) count++;
  return count;
}
export const orderChanges = (saved: readonly string[], draft: readonly string[]) => same(saved, draft) ? 0 : 1;
/** One change per ladder setting: each step position plus the shared thresholds and fallback. */
export function ladderChanges(saved: DispatchConfig, draft: DispatchConfig): number {
  const { steps: savedSteps, ...savedRest } = saved, { steps, ...rest } = draft;
  let count = 0;
  for (let index = 0; index < Math.max(savedSteps.length, steps.length); index++) if (!same(savedSteps[index], steps[index])) count++;
  for (const key of new Set([...Object.keys(savedRest), ...Object.keys(rest)]) as Set<keyof typeof rest>) if (!same(savedRest[key], rest[key])) count++;
  return count;
}

export type EligibilityDraft = { kind: "global"; saved: Rule[]; draft: Rule[] } | { kind: "project"; saved: string[]; draft: string[] };
export interface SetupDraft { eligibility: EligibilityDraft; savedLadder: DispatchConfig; ladder: DispatchConfig }
export const eligibilityChanges = (eligibility: EligibilityDraft) => eligibility.kind === "global"
  ? ruleChanges(eligibility.saved, eligibility.draft) : orderChanges(eligibility.saved, eligibility.draft);
export const countSetupChanges = (setup: SetupDraft) => eligibilityChanges(setup.eligibility) + ladderChanges(setup.savedLadder, setup.ladder);
/** Discard returns fresh copies of the saved values so later edits never mutate them. */
export function discardSetup(setup: SetupDraft): SetupDraft {
  const eligibility: EligibilityDraft = setup.eligibility.kind === "global"
    ? { ...setup.eligibility, draft: structuredClone(setup.eligibility.saved) }
    : { ...setup.eligibility, draft: [...setup.eligibility.saved] };
  return { ...setup, eligibility, ladder: structuredClone(setup.savedLadder) };
}
