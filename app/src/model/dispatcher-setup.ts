import type { DispatchConfig } from "../../../src/dispatch/types";
import type { Rule } from "./executors";

export { moveKey, positionAnnouncement } from "../ds/SortableList";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Minimum single-item moves among retained entries, plus additions and removals. */
function sequenceChanges<T>(saved: readonly T[], draft: readonly T[], key: (value: T) => string, edits = false): number {
  const positions = new Map(saved.map((value, index) => [key(value), index]));
  const used = new Set<number>();
  const matches = draft.map(value => {
    const index = positions.get(key(value));
    if (index !== undefined) used.add(index);
    return { value, index };
  });
  // The step-name field edits the ID too. Pair unmatched steps so a rename is one edit.
  if (edits) for (const match of matches) if (match.index === undefined) {
    const index = saved.findIndex((_, at) => !used.has(at));
    if (index >= 0) { match.index = index; used.add(index); }
  }
  const retained = matches.filter((match): match is { value: T; index: number } => match.index !== undefined);
  const tails: number[] = [];
  for (const { index } of retained) {
    let low = 0, high = tails.length;
    while (low < high) { const mid = (low + high) >>> 1; if (tails[mid]! < index) low = mid + 1; else high = mid; }
    tails[low] = index;
  }
  return saved.length + draft.length - 2 * retained.length + retained.length - tails.length
    + (edits ? retained.filter(({ value, index }) => !same(saved[index], value)).length : 0);
}
export const orderChanges = (saved: readonly string[], draft: readonly string[]) => sequenceChanges(saved, draft, value => value);
/** Rules have no IDs: match their task kinds, then pair unmatched rules as edits. */
export function ruleChanges(saved: readonly Rule[], draft: readonly Rule[]): number {
  const used = new Set<number>();
  let changes = 0;
  const positions: number[] = [], unmatched: Rule[] = [];
  for (const rule of draft) {
    const index = saved.findIndex((value, at) => !used.has(at) && same(value.kinds, rule.kinds));
    if (index < 0) { unmatched.push(rule); continue; }
    used.add(index); positions.push(index);
    changes += orderChanges(saved[index]!.executors, rule.executors);
  }
  const removed = saved.filter((_, index) => !used.has(index));
  const paired = Math.min(removed.length, unmatched.length);
  for (let index = 0; index < paired; index++) changes += 1 + orderChanges(removed[index]!.executors, unmatched[index]!.executors);
  return changes + Math.max(removed.length, unmatched.length)
    - paired + sequenceChanges([...positions].sort((a, b) => a - b), positions, String);
}
/** Count each edited step once; reordering is the minimum number of single moves. */
export function ladderChanges(saved: DispatchConfig, draft: DispatchConfig): number {
  const { steps: savedSteps, ...savedRest } = saved, { steps, ...rest } = draft;
  return sequenceChanges(savedSteps, steps, step => step.id, true) + [...new Set([...Object.keys(savedRest), ...Object.keys(rest)])].filter(key => !same(savedRest[key as keyof typeof rest], rest[key as keyof typeof rest])).length;
}

export type EligibilityDraft = { kind: "global"; saved: Rule[]; draft: Rule[] } | { kind: "project"; saved: string[]; draft: string[]; rev?: number };
/** `strategy` is the profile the ladder draft started from; `rev` is the project revision the order draft started from. */
export interface SetupDraft { eligibility: EligibilityDraft; savedLadder: DispatchConfig; ladder: DispatchConfig; strategy?: string }
export const eligibilityChanges = (eligibility: EligibilityDraft) => eligibility.kind === "global"
  ? ruleChanges(eligibility.saved, eligibility.draft) : orderChanges(eligibility.saved, eligibility.draft);
/** The unsaved choice ladder as a strategy draft, as `strategy.preview` and `dispatch.explain` take it; none when the ladder is saved. */
export const strategyDraft = (setup: SetupDraft) => ladderChanges(setup.savedLadder, setup.ladder) ? { from: setup.strategy, set: { dispatch: setup.ladder } } : undefined;
export type StrategyDraft = NonNullable<ReturnType<typeof strategyDraft>>;
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
    const draft = strategyDraft(setup);
    if (draft) {
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
