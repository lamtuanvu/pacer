import type { AvailableModel, AvailableModels } from "../../../src/models/available";
import type { TierTargets } from "../../../src/dispatch/types";
import { TIERS } from "../../../src/dispatch/candidates";
import { suggestTier, tierLabels } from "./executor-models";
import { formatContext, MATRIX_DIFFICULTIES, type MatrixDifficulty, type MatrixDraft, type MatrixRow, type MatrixTier } from "./model-matrix";

/** A rated size; "unknown" (unrated) is never suggested. */
export type ModelSize = Exclude<MatrixTier, "unknown">;

/** One pickable model in Dispatcher › Agents › Add a model. */
export interface AddModelOption {
  id: string;
  /** Plain description: listing facts, or what an alias means. */
  note?: string;
  /** The size the model gets when picked; null leaves it unrated. */
  tier: ModelSize | null;
  /** Group heading, for the built-in Claude Code choices. */
  group?: string;
}

const ALIASES = "Aliases · always the newest model";
const PINNED = "Pinned versions · stay on one release";

/** Claude Code takes these ids without a provider listing: aliases follow the newest release, pinned ids stay on one. */
export const CLAUDE_CODE_MODELS: readonly AddModelOption[] = [
  { id: "opus", note: "Hardest work: planning, cross-cutting changes", tier: "frontier", group: ALIASES },
  { id: "sonnet", note: "Everyday coding", tier: "medium", group: ALIASES },
  { id: "haiku", note: "Fast and cheap: docs, renames, small fixes", tier: "small", group: ALIASES },
  { id: "claude-opus-5-5", note: "Opus 5.5", tier: "frontier", group: PINNED },
  { id: "claude-sonnet-5-5", note: "Sonnet 5.5", tier: "medium", group: PINNED },
  { id: "claude-haiku-5-5", note: "Haiku 5.5", tier: "small", group: PINNED },
  { id: "claude-fable-5-2", note: "Fable 5.2", tier: null, group: PINNED },
];
const ALIAS_NOTES: Readonly<Record<string, string>> = {
  opus: "Alias for the newest Opus model",
  sonnet: "Alias for the newest Sonnet model",
  haiku: "Alias for the newest Haiku model",
};

/** Listing facts in plain words, for example "128K context · tools". */
export function listingNote(model: Pick<AvailableModel, "context" | "tools">): string | undefined {
  const parts = [model.context ? `${formatContext(model.context)} context` : "", model.tools === true ? "tools" : model.tools === false ? "no tools" : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * Models the agent can add: its live listing when it has one, else the built-in Claude Code choices.
 * Ids already on the agent are left out; any other id can still be typed.
 */
export function addModelOptions(agent: string, available: AvailableModels | undefined, taken: readonly string[]): AddModelOption[] {
  const used = new Set(taken);
  if (available?.models?.length) {
    return available.models.filter(model => !used.has(model.id)).map(model => ({ id: model.id, note: listingNote(model), tier: suggestTier(model) }));
  }
  if (agent === "claude-code") return CLAUDE_CODE_MODELS.filter(option => !used.has(option.id));
  return [];
}

/** The size a picked or typed id gets: the listing's suggestion, a built-in choice's size, else unrated. */
export function suggestedSize(agent: string, available: AvailableModels | undefined, id: string): ModelSize | null {
  const listed = available?.models?.find(model => model.id === id);
  if (listed) return suggestTier(listed);
  return agent === "claude-code" ? CLAUDE_CODE_MODELS.find(option => option.id === id)?.tier ?? null : null;
}

/** The description under a model row's id. */
export function modelNote(agent: string, available: AvailableModels | undefined, id: string): string | undefined {
  const listed = available?.models?.find(model => model.id === id);
  if (listed) return listingNote(listed);
  if (agent !== "claude-code") return undefined;
  return ALIAS_NOTES[id] ?? CLAUDE_CODE_MODELS.find(option => option.id === id)?.note;
}

const sizeWord = (tier: MatrixTier) => tier === "unknown" ? "unrated" : tierLabels[tier].toLowerCase();

/** The caption under an agent in the list: its models in words, warning while any is unrated. */
export function agentCaption(draft: MatrixDraft | undefined, fallbackModel: string | null = null): { text: string; warn: boolean } {
  const rows = draft?.rows.filter(row => row.on) ?? [];
  if (!rows.length) return { text: draft?.default ?? fallbackModel ?? "Picks its own model", warn: false };
  const warn = rows.some(row => row.tier === "unknown");
  if (rows.length === 1) return { text: `${rows[0]!.id} · ${sizeWord(rows[0]!.tier)}`, warn };
  const sizes = (["small", "medium", "frontier", "unknown"] as const).filter(tier => rows.some(row => row.tier === tier)).map(sizeWord);
  return { text: `${rows.length} models · ${sizes.join(", ")}`, warn };
}

/** Agents with at least one model on but unrated: difficulty cannot steer them yet. */
export function unratedAgents(drafts: readonly MatrixDraft[]): number {
  return drafts.filter(draft => draft.rows.some(row => row.on && row.tier === "unknown")).length;
}

const fits = (row: Pick<MatrixRow, "on" | "tier">, need: ModelSize) => row.on && row.tier !== "unknown" && TIERS[row.tier] >= TIERS[need];

export interface ModelCoverage {
  /** Executor models (planner excluded) whose size reaches each difficulty's target. */
  counts: Record<MatrixDifficulty, number>;
  /** Executors without a rated model on: they run their default for any difficulty. */
  defaultExecutors: number;
  /** The planner has a model on that reaches the complex target. */
  plannerFits: boolean;
}

/** Dispatch coverage of a set of drafts; the planner counts only through the tier fallback. */
export function modelCoverage(drafts: readonly MatrixDraft[], plannerId: string | null, targets: TierTargets): ModelCoverage {
  const executors = drafts.filter(draft => draft.runner !== plannerId);
  const counts = Object.fromEntries(MATRIX_DIFFICULTIES.map(difficulty => [difficulty, executors.flatMap(draft => draft.rows).filter(row => fits(row, targets[difficulty])).length])) as Record<MatrixDifficulty, number>;
  return {
    counts,
    defaultExecutors: executors.filter(draft => !draft.rows.some(row => row.on && row.tier !== "unknown")).length,
    plannerFits: drafts.some(draft => draft.runner === plannerId && draft.rows.some(row => fits(row, targets.complex))),
  };
}

/** One line per unsaved model change, for the save bar. */
export function modelChanges(draft: MatrixDraft, base: MatrixDraft | undefined): string[] {
  const before = new Map((base?.rows ?? []).map(row => [row.id, row]));
  const after = new Map(draft.rows.map(row => [row.id, row]));
  const lines: string[] = [];
  for (const row of draft.rows) {
    const old = before.get(row.id);
    if (!old) { lines.push(row.tier === "unknown" ? `${row.id} added, unrated` : `${row.id} added at ${sizeWord(row.tier)}`); continue; }
    if (old.tier !== row.tier) lines.push(`${row.id} set to ${sizeWord(row.tier)}`);
    if (old.on !== row.on) lines.push(`${row.id} turned ${row.on ? "on" : "off"}`);
  }
  for (const row of base?.rows ?? []) if (!after.has(row.id)) lines.push(`${row.id} removed`);
  if ((base?.default ?? null) !== draft.default && draft.default && after.has(draft.default)) lines.push(`${draft.default} made default`);
  return lines;
}
