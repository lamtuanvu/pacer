import type { DispatchConfig } from "../../../src/dispatch/types";
import type { Rule } from "./executors";

export { moveKey, positionAnnouncement } from "../ds/SortableList";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Count positions whose values differ, including added or removed entries. */
const positionChanges = (saved: readonly unknown[], draft: readonly unknown[]) => Array.from({ length: Math.max(saved.length, draft.length) }, (_, index) => !same(saved[index], draft[index])).filter(Boolean).length;
/** One change per rule position whose kinds or executor order differ, including added or removed rules. */
export const ruleChanges = (saved: readonly Rule[], draft: readonly Rule[]) => positionChanges(saved, draft);
export const orderChanges = (saved: readonly string[], draft: readonly string[]) => same(saved, draft) ? 0 : 1;
/** One change per ladder setting: each step position plus the shared thresholds and fallback. */
export function ladderChanges(saved: DispatchConfig, draft: DispatchConfig): number {
  const { steps: savedSteps, ...savedRest } = saved, { steps, ...rest } = draft;
  return positionChanges(savedSteps, steps) + [...new Set([...Object.keys(savedRest), ...Object.keys(rest)])].filter(key => !same(savedRest[key as keyof typeof rest], rest[key as keyof typeof rest])).length;
}

export type EligibilityDraft = { kind: "global"; saved: Rule[]; draft: Rule[] } | { kind: "project"; saved: string[]; draft: string[]; rev?: number };
/** `strategy` is the profile the ladder draft started from; `rev` is the project revision the order draft started from. */
export interface SetupDraft { eligibility: EligibilityDraft; savedLadder: DispatchConfig; ladder: DispatchConfig; strategy?: string }
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

/**
 * Merge freshly loaded saved values into an open draft, part by part. A part whose new saved
 * value equals the draft (our own save) or that has no unsaved changes adopts the new value;
 * a part with unsaved changes keeps its draft and its original base, and is reported as a conflict.
 */
export function reconcileSetup(current: SetupDraft, incoming: SetupDraft): { setup: SetupDraft; conflict: boolean } {
  let conflict = false;
  let eligibility = current.eligibility;
  const nextEligibility = incoming.eligibility;
  if (nextEligibility.kind !== eligibility.kind) eligibility = nextEligibility;
  else if (!same(nextEligibility.saved, eligibility.saved)) {
    if (same(nextEligibility.saved, eligibility.draft) || !eligibilityChanges(eligibility)) eligibility = nextEligibility;
    else conflict = true;
  } else if (nextEligibility.kind === "project" && eligibility.kind === "project" && nextEligibility.rev !== eligibility.rev) {
    eligibility = { ...eligibility, rev: nextEligibility.rev };
  }
  let { savedLadder, ladder, strategy } = current;
  if (!same(incoming.savedLadder, savedLadder) || incoming.strategy !== strategy) {
    if (same(incoming.savedLadder, ladder) || !ladderChanges(savedLadder, ladder)) ({ savedLadder, ladder, strategy } = incoming);
    else conflict = true;
  }
  return { setup: { eligibility, savedLadder, ladder, strategy }, conflict };
}

export interface SaveSetupInput {
  call: <T>(op: string, params: unknown) => Promise<T>;
  setup: SetupDraft;
  /** Repository key and label when the scope is one repository. */
  repo?: { key: string; label: string };
  profile: { name: string; reason: string };
}
/** A save that stopped part-way: `done` names what was already saved. */
export class PartialSaveError extends Error {
  constructor(readonly done: string[], readonly cause: unknown) {
    super(`Saved ${done.join(" and ")}. ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
const message = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);
/**
 * Check a changed ladder's profile is current, save eligibility (routing rules or the project order,
 * with its revision), then validate the ladder, save it as a new profile and activate it.
 * Returns the saved parts; throws PartialSaveError when a later part fails after an earlier one saved.
 */
export async function saveSetup({ call, setup, repo, profile }: SaveSetupInput): Promise<string[]> {
  const done: string[] = [];
  const ladderDirty = ladderChanges(setup.savedLadder, setup.ladder) > 0;
  try {
    // Check the profile before writing anything, so a stale ladder never leaves a partial save.
    if (ladderDirty) {
      const latest = await call<{ strategy: string; config: DispatchConfig }>("dispatch.config.get", {});
      if (latest.strategy !== setup.strategy || !same(latest.config, setup.savedLadder)) throw new Error("The active profile changed in another client. Discard to load it.");
    }
    const { eligibility } = setup;
    if (eligibility.kind === "global" && eligibilityChanges(eligibility)) {
      await call("routing.set", { rules: eligibility.draft });
      done.push("executor rules");
    }
    if (eligibility.kind === "project" && repo && eligibilityChanges(eligibility)) {
      if (eligibility.draft.length) {
        await call("project.strategy.set", { repo: repo.key, executors: eligibility.draft, expect_rev: eligibility.rev ?? 0 });
        done.push("project order");
      } else {
        await call("project.strategy.remove", { repo: repo.key, expect_rev: eligibility.rev ?? 0 });
        done.push(`removal of the project order; ${repo.label} now uses the global rules`);
      }
    }
    if (ladderDirty) {
      const draft = { from: setup.strategy, set: { dispatch: setup.ladder } };
      const validation = await call<{ ok: boolean; errors: string[] }>("strategy.preview", { draft });
      if (!validation.ok) throw new Error(validation.errors.join(" ") || "The ladder needs changes before it can be saved.");
      await call("strategy.save", { name: profile.name, draft, reason: profile.reason.trim() });
      try { await call("strategy.use", { name: profile.name }); }
      catch (failure) { throw new Error(`Saved ${profile.name}, but it could not be activated: ${message(failure)}`); }
      done.push(`profile ${profile.name}, now active`);
    }
  } catch (failure) {
    if (done.length) throw new PartialSaveError(done, failure);
    throw failure;
  }
  return done;
}
