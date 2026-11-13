import type { AvailableModel } from "../../../src/models/available";
import type { ModelDeclaration, RunnerModels } from "../../../src/core/runner-models";
import type { TierTargets } from "../../../src/dispatch/types";
import { TIERS } from "../../../src/dispatch/candidates";
import { suggestTier } from "./executor-models";

export type MatrixTier = "small" | "medium" | "frontier" | "unknown";
export type MatrixDifficulty = "simple" | "standard" | "complex";
export const MATRIX_DIFFICULTIES: readonly MatrixDifficulty[] = ["simple", "standard", "complex"] as const;
export const MATRIX_TIERS: readonly MatrixTier[] = ["small", "medium", "frontier"] as const;

export interface MatrixListingModel {
  id: string;
  context?: number;
  tools?: boolean | null;
  costOut?: number | null;
}

export interface MatrixRow {
  id: string;
  context?: number;
  tools?: boolean | null;
  costOut?: number | null;
  on: boolean;
  tier: MatrixTier;
  isDefault: boolean;
  takes: MatrixDifficulty[];
  suggestedOn?: boolean;
  suggestedTier?: MatrixTier;
  suggestionReason?: string;
  pending?: boolean;
  /** The originally declared model, kept so a save can re-send its metadata (strengths, tools, context). */
  declared?: ModelDeclaration;
}

export interface MatrixDraft {
  runner: string;
  revision: string;
  default: string | null;
  rows: MatrixRow[];
  baseRows: MatrixRow[];
  addedIds: string[];
}

export interface MatrixSavePlan {
  changed: boolean;
  changedRunners: string[];
  runners: { id: string; default: string; models: ModelDeclaration[] }[];
}

const TIER_RANK: Record<MatrixTier, number> = { unknown: TIERS.unknown, small: TIERS.small, medium: TIERS.medium, frontier: TIERS.frontier };

/** Union of listing models and declared models for one executor. */
export function mergeRows(listing: MatrixListingModel[] | null, declared: ModelDeclaration[], defaultModel: string | null = null): MatrixRow[] {
  const ids = new Set<string>();
  for (const model of listing ?? []) ids.add(model.id);
  for (const model of declared ?? []) ids.add(model.id);
  return [...ids].map(id => {
    const listed = (listing ?? []).find(model => model.id === id);
    const decl = (declared ?? []).find(model => model.id === id);
    return {
      id,
      context: listed?.context,
      tools: listed?.tools,
      costOut: listed?.costOut,
      on: !!decl,
      tier: (decl?.tier as MatrixTier) ?? "unknown",
      isDefault: defaultModel === id,
      takes: [],
      ...(decl ? { declared: decl } : {}),
    };
  });
}

export function takesFor(tier: MatrixTier, targets: TierTargets): MatrixDifficulty[] {
  if (tier === "unknown") return [];
  return MATRIX_DIFFICULTIES.filter(difficulty => TIER_RANK[tier] >= TIERS[targets[difficulty]]);
}

export function applyTakes(rows: MatrixRow[], targets: TierTargets): MatrixRow[] {
  return rows.map(row => ({ ...row, takes: takesFor(row.tier, targets) }));
}

export function createDraft(runner: string, revision: string, declaredDefault: string | null, declaredModels: ModelDeclaration[], listing: MatrixListingModel[] | null, targets: TierTargets): MatrixDraft {
  const rows = applyTakes(mergeRows(listing, declaredModels, declaredDefault), targets);
  return { runner, revision, default: declaredDefault, rows, baseRows: rows.map(row => ({ ...row })), addedIds: [] };
}

/** Suggest on/off and size from listing facts. tools must be true to suggest on. Rows
 * without listing facts (unknown listing, or a price-less connection) get no suggestion
 * and keep their current state: never propose turning off a model without evidence. */
export function suggestRow(row: MatrixRow, listing: MatrixListingModel | undefined): MatrixRow {
  const hasFacts = !!listing && listing.costOut != null;
  if (!hasFacts) {
    return { ...row, suggestedOn: undefined, suggestedTier: undefined, suggestionReason: undefined, pending: false };
  }
  const suggestedTier = suggestTier(listing as AvailableModel);
  const suggestedOn = listing!.tools === true && suggestedTier !== null;
  const pending = suggestedOn !== row.on || (suggestedTier !== null && suggestedTier !== row.tier);
  return {
    ...row,
    suggestedOn,
    suggestedTier: suggestedTier ?? undefined,
    suggestionReason: suggestedOn
      ? "Suggested from listing facts"
      : (row.on && pending ? "Suggested to leave off from listing facts" : row.suggestionReason),
    pending,
  };
}

export function suggestRows(rows: MatrixRow[], listingById: Map<string, MatrixListingModel>): MatrixRow[] {
  return rows.map(row => suggestRow(row, listingById.get(row.id)));
}

export function acceptSuggestion(row: MatrixRow): MatrixRow {
  return {
    ...row,
    on: row.suggestedOn ?? row.on,
    tier: (row.suggestedTier ?? row.tier) as MatrixTier,
    pending: false,
    suggestedOn: undefined,
    suggestedTier: undefined,
  };
}

export function acceptAllSuggestions(rows: MatrixRow[]): MatrixRow[] {
  return rows.map(acceptSuggestion);
}

export function dismissSuggestions(rows: MatrixRow[]): MatrixRow[] {
  return rows.map(row => ({ ...row, pending: false, suggestedOn: undefined, suggestedTier: undefined, suggestionReason: undefined }));
}

/** Default rules when toggling a model. */
export function toggleModel(rows: MatrixRow[], id: string, nextOn: boolean, currentDefault: string | null): { rows: MatrixRow[]; default: string | null } {
  const nextRows = rows.map(row => row.id === id ? { ...row, on: nextOn } : row);
  let nextDefault = currentDefault;
  const target = nextRows.find(row => row.id === id);
  if (!nextOn && currentDefault === id) {
    const firstEnabled = nextRows.find(row => row.on && row.id !== id);
    nextDefault = firstEnabled?.id ?? currentDefault;
  }
  if (nextOn && !nextDefault) nextDefault = id;
  // all off: keep default current
  const anyOn = nextRows.some(row => row.on);
  if (!anyOn) nextDefault = currentDefault;
  return { rows: nextRows, default: nextDefault };
}

export function setTier(rows: MatrixRow[], id: string, tier: MatrixTier): MatrixRow[] {
  return rows.map(row => row.id === id ? { ...row, tier } : row);
}

export function addModel(rows: MatrixRow[], id: string): MatrixRow[] {
  const trimmed = id.trim();
  if (!trimmed || rows.some(row => row.id === trimmed)) return rows;
  return [...rows, { id: trimmed, on: true, tier: "unknown", isDefault: false, takes: [] }];
}

export function removeModel(rows: MatrixRow[], id: string): MatrixRow[] {
  return rows.filter(row => row.id !== id);
}

function rowSignature(row: MatrixRow): { id: string; on: boolean; tier: MatrixTier } {
  return { id: row.id, on: row.on, tier: row.tier };
}

export function isDirty(rows: MatrixRow[], baseRows: MatrixRow[]): boolean {
  return JSON.stringify(rows.map(rowSignature)) !== JSON.stringify(baseRows.map(rowSignature));
}

export interface MatrixSavePlanRunner {
  runner: string;
  revision: string;
  baseRows: MatrixRow[];
  rows: MatrixRow[];
  default: string | null;
  /** The default model actually loaded from runner.models.get (may not be a row). */
  baseDefault: string | null;
}

/** Build save plan with only changed runners, comparing rows and default against what was LOADED. */
export function buildSavePlan(runners: MatrixSavePlanRunner[], targets: TierTargets, baseRevision: string): MatrixSavePlan {
  const changedRunners: string[] = [];
  const out: MatrixSavePlan["runners"] = [];
  for (const runner of runners) {
    const baseDefault = runner.baseDefault ?? runner.baseRows.find(row => row.isDefault)?.id ?? null;
    const defaultChanged = runner.default !== baseDefault;
    const rowsChanged = isDirty(runner.rows, runner.baseRows);
    if (!rowsChanged && !defaultChanged) continue;
    changedRunners.push(runner.runner);
    const enabledRows = runner.rows.filter(row => row.on);
    const baseDefaultFallback = baseDefault ?? runner.default ?? "";
    let models: ModelDeclaration[];
    if (enabledRows.length === 0) {
      models = [];
    } else {
      models = enabledRows.map(row => row.declared
        ? { ...row.declared, id: row.id, tier: row.tier }
        : { id: row.id, tier: row.tier });
    }
    // default rules: all off => models [] and default stays current default
    const finalDefault = enabledRows.length === 0
      ? (runner.default ?? baseDefaultFallback ?? "")
      : (runner.default && enabledRows.some(r => r.id === runner.default) ? runner.default : enabledRows[0].id);
    out.push({ id: runner.runner, default: finalDefault, models });
  }
  return { changed: changedRunners.length > 0, changedRunners, runners: out };
}

/**
 * Fold a successful `runner.models.set_many` result into the drafts and their
 * bases.
 *
 * Every runner that was part of the save plan is rebuilt onto the returned
 * server state by `buildBaseline` (a fresh `createDraft`), so turned-off
 * models drop out of the declared baseline and a later refresh with identical
 * server models does not raise a false "changed elsewhere" (H3). A runner
 * whose draft was edited while the save was in flight (its generation version
 * moved) keeps the user's edit — its `drafts` row is left alone beyond
 * adopting the returned revision — but its base is still rebuilt from the
 * returned server state, so it stays dirty against the new base.
 *
 * `versionOf` reads a runner's current generation version and `startVersion`
 * the version it had when the save started. Call this from a functional
 * state update (or read the runner drafts from a fresh ref) so it folds over
 * the *current* drafts, not the snapshot taken when Save was clicked (H1).
 */
export interface SavedRebase {
  drafts: MatrixDraft[];
  baseDrafts: MatrixDraft[];
}

export function rebaseSavedDrafts(
  drafts: MatrixDraft[],
  changedRunners: readonly string[],
  versionOf: (runner: string) => number,
  startVersion: (runner: string) => number,
  returned: ReadonlyMap<string, RunnerModels>,
  buildBaseline: (runner: string, saved: RunnerModels) => MatrixDraft,
): SavedRebase {
  const changed = new Set(changedRunners);
  const draftsOut = drafts.map(draft => {
    if (!changed.has(draft.runner)) return draft;
    const saved = returned.get(draft.runner);
    if (!saved) return draft;
    const baseline = buildBaseline(draft.runner, saved);
    if (versionOf(draft.runner) !== startVersion(draft.runner)) {
      // Edited while the save ran: keep the user's edit, adopt the returned
      // revision so the next save runs against it; the base rebase below
      // settles onto the returned server state so the runner stays dirty.
      return { ...draft, revision: baseline.revision };
    }
    // Not edited: the save made the running state the new base, so the draft
    // becomes clean against it.
    return baseline;
  });
  // Bases settle onto the returned server state for every saved runner, so a
  // later refresh with identical server models stays silent (H3).
  const baseDraftsOut = drafts.map((draft, i) => {
    if (!changed.has(draft.runner)) return draftsOut[i]!;
    const saved = returned.get(draft.runner);
    if (!saved) return draftsOut[i]!;
    const baseline = buildBaseline(draft.runner, saved);
    return baseline;
  });
  return { drafts: draftsOut, baseDrafts: baseDraftsOut };
}

export function defaultForRows(rows: MatrixRow[], currentDefault: string | null): string | null {
  const enabled = rows.filter(row => row.on);
  if (enabled.length === 0) return currentDefault;
  if (currentDefault && enabled.some(row => row.id === currentDefault)) return currentDefault;
  return enabled[0].id;
}

/** Format costOut (USD per million output tokens) for display. */
export function formatPrice(costOut: number | null | undefined): string {
  if (costOut == null) return "—";
  const n = Number(costOut);
  const s = n.toFixed(2).replace(/\.?0+$/, "");
  return `$${s}/M`;
}
export const formatCost = formatPrice;
export const formatCostOut = formatPrice;
export const formatModelPrice = formatPrice;
export const priceText = formatPrice;

/** Format context token count: 200000 -> "200K", 1000000 -> "1M". */
export function formatContext(context: number | null | undefined): string {
  if (context == null) return "—";
  const n = Number(context);
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${Number.isInteger(v) ? v : v.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return `${Number.isInteger(v) ? v : v.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return String(n);
}
export const formatCtx = formatContext;
export const contextText = formatContext;

/** Format tools support. */
export function formatTools(tools: boolean | null | undefined): string {
  if (tools === true) return "Yes";
  if (tools === false) return "No";
  return "—";
}
export const toolsText = formatTools;
