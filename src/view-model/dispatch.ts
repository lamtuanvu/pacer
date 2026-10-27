/** Descriptors for the Dispatch home: Needs you cards, the at-a-glance strip and the token share. Facts pacer lacks are left out, never shown as zero. */
import type { AttentionItem } from "../attention/types";
import type { ClientSnapshot } from "./snapshot";
import { markAgent } from "./agents";
import { attentionOrder, doneToday, needsYou, type Scope } from "./selectors";
import { compactCount, scopedTaskTree, type TaskAttention, type TaskNodeView } from "./task-tree";
import { attentionStatus, executorLabel } from "./words";

export type NeedsYouCard =
  | { kind: "task"; id: string; node: TaskNodeView; items: AttentionItem[] }
  | { kind: "item"; id: string; level: Exclude<TaskAttention, "none">; item: AttentionItem };

const SEVERITY: Record<AttentionItem["severity"], number> = { blocked: 0, problem: 1, decide: 2 };
const LEVEL: Record<Exclude<TaskAttention, "none">, number> = { bad: 0, warn: 1 };

function walk(nodes: TaskNodeView[], root: string, into: Map<string, string>) {
  for (const node of nodes) { into.set(node.id, root); walk(node.children, root, into); }
}

/**
 * Needs you as cards: an item about a task joins that task's root card (one card per root, its most urgent item first);
 * items about executors, hosts, accounts or setup stay as their own cards. Bad before warn, then blocked, problem, decide, then oldest.
 */
export function needsYouCards(snapshot: ClientSnapshot, scope: Scope, opts: { now: number }): NeedsYouCard[] {
  const items = [...needsYou(snapshot, scope)].sort(attentionOrder);
  const roots = scopedTaskTree(snapshot, scope, { now: opts.now });
  const rootOf = new Map<string, string>();
  for (const root of roots) walk([root], root.id, rootOf);
  const byRoot = new Map<string, AttentionItem[]>();
  const cards: NeedsYouCard[] = [];
  for (const item of items) {
    const root = item.taskId ? rootOf.get(item.taskId) : undefined;
    if (root) byRoot.set(root, [...byRoot.get(root) ?? [], item]);
    else cards.push({ kind: "item", id: item.id, level: attentionStatus(item, snapshot.tasks).tone === "bad" ? "bad" : "warn", item });
  }
  for (const root of roots) {
    const own = byRoot.get(root.id);
    if (!own) continue;
    // The service's words for why it needs you lead the card's facts.
    const node = { ...root, attention: root.attention === "none" ? "warn" as const : root.attention, meta: own[0]!.detail ? [{ icon: "notes" as const, text: own[0]!.detail }, ...root.meta] : root.meta };
    cards.push({ kind: "task", id: root.id, node, items: own });
  }
  const level = (card: NeedsYouCard) => LEVEL[card.kind === "task" ? card.node.attention as "bad" | "warn" : card.level];
  const lead = (card: NeedsYouCard) => card.kind === "task" ? card.items[0]! : card.item;
  return cards.sort((a, b) => level(a) - level(b) || SEVERITY[lead(a).severity] - SEVERITY[lead(b).severity] || lead(a).raisedAt - lead(b).raisedAt);
}

/** The per-period token summary of the attempt-token-accounting spec (`insights.summary`). Absent until that slice ships. */
export interface TokenReport {
  coverage: "measured" | "partial" | "unknown"; total: number | null;
  measuredAttempts: number; partialAttempts: number; unknownAttempts: number;
  byExecutor: { executor: string; tokens: number; tasks: number }[];
}
const reported = (tokens: TokenReport | null | undefined): tokens is TokenReport & { total: number } =>
  !!tokens && tokens.coverage !== "unknown" && tokens.total !== null;

export interface GlanceTile { id: "finished" | "accepted" | "tokens"; label: string; value: string; detail?: string }
/**
 * Today at a glance. Finished counts what the service counted today; the accept rate shows once something was reviewed;
 * tokens show only with a measured or partial reading, as a lower bound when partial.
 */
export function glanceTiles(snapshot: ClientSnapshot, scope: Scope, tokens?: TokenReport | null): GlanceTile[] {
  const tiles: GlanceTile[] = [];
  const today = snapshot.today;
  if (today) {
    const rows = scope.repo === null ? null : doneToday(snapshot, scope);
    const done = scope.repo === null ? today.done : today.byRepo[scope.repo] ?? 0;
    const accepted = rows ? rows.filter(t => t.review?.accepted === true).length : today.accepted;
    const reviewed = accepted + (rows ? rows.filter(t => t.review?.accepted === false).length : today.rejected);
    const failed = rows ? rows.filter(t => t.state === "failed" || t.state === "limit").length : today.failed;
    tiles.push({ id: "finished", label: "Tasks finished", value: String(done), ...(failed ? { detail: `${failed} failed` } : {}) });
    if (reviewed > 0) tiles.push({ id: "accepted", label: "Accepted", value: `${Math.round(accepted / reviewed * 100)}%`, detail: `${accepted} of ${reviewed} reviewed` });
  }
  if (reported(tokens)) {
    const attempts = tokens.measuredAttempts + tokens.partialAttempts + tokens.unknownAttempts;
    tiles.push({ id: "tokens", label: "Tokens spent", value: `${tokens.coverage === "partial" ? "≥ " : ""}${compactCount(tokens.total)}`,
      detail: tokens.coverage === "partial" ? `${tokens.measuredAttempts} of ${attempts} attempts measured` : `${attempts} attempt${attempts === 1 ? "" : "s"} measured` });
  }
  return tiles;
}

export type ChartSeries = 1 | 2 | 3 | 4 | 5;
export interface ShareSegment { id: string; label: string; agent?: string; share: number; detail: string; series: ChartSeries }
export interface TokenSpread { caption: string; partial: boolean; segments: ShareSegment[] }

/** Largest-remainder rounding, so the legend's percentages add up to 100. */
function percents(values: number[]): number[] {
  const sum = values.reduce((a, b) => a + b, 0);
  const raw = values.map(v => v / sum * 100), floor = raw.map(Math.floor);
  let left = 100 - floor.reduce((a, b) => a + b, 0);
  for (const i of raw.map((v, i) => [v - floor[i]!, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) { if (left-- <= 0) break; floor[i]!++; }
  return floor;
}

/** Where the tokens went: shown only with a measured or partial reading. Five chart series at most; the rest group as "Other agents". */
export function tokenSpread(tokens: TokenReport | null | undefined): TokenSpread | null {
  if (!reported(tokens)) return null;
  const rows = tokens.byExecutor.filter(row => row.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  if (!rows.length) return null;
  const top = rows.length > 5 ? rows.slice(0, 4) : rows, rest = rows.slice(top.length);
  const groups = [...top.map(row => ({ id: row.executor, label: executorLabel(row.executor), agent: markAgent(row.executor), tokens: row.tokens, tasks: row.tasks })),
    ...rest.length ? [{ id: "other", label: "Other agents", agent: undefined, tokens: rest.reduce((n, r) => n + r.tokens, 0), tasks: rest.reduce((n, r) => n + r.tasks, 0) }] : []];
  const shares = percents(groups.map(g => g.tokens));
  const partial = tokens.coverage === "partial";
  return {
    partial,
    caption: `${partial ? "At least " : ""}${compactCount(tokens.total)} tokens${partial ? " · some attempts were not measured" : ""}`,
    segments: groups.map((g, i) => ({ id: g.id, label: g.label, ...(g.agent ? { agent: g.agent } : {}), share: shares[i]!, series: (i + 1) as ChartSeries,
      detail: `${compactCount(g.tokens)} tokens · ${g.tasks} task${g.tasks === 1 ? "" : "s"}` })),
  };
}
