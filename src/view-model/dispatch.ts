/** Descriptors for the Dispatch home: Needs you cards, the at-a-glance strip and the token spread. Facts pacer lacks are left out, never shown as zero. */
import type { AttentionItem } from "../attention/types";
import type { ClientSnapshot } from "./snapshot";
import { markAgent } from "./agents";
import { attentionOrder, needsYou, type Scope } from "./selectors";
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

export type Coverage = "measured" | "partial" | "unknown";
interface InsightsTokens { total: number; measuredAttempts: number; partialAttempts: number; unknownAttempts: number; attempts: number; lowerBound: boolean }
/**
 * What Dispatch reads from `insights.summary` (attempt token accounting; docs/dispatch.md "Insights") for one period; other fields are ignored.
 * Root tasks count by first settle; accepted first try is over reviewed roots, `null` with none reviewed; `previous` is the period of equal length before.
 */
export interface InsightsSummary {
  rootTasksHandled: number; acceptedFirstTry: number; reviewedRoots: number; acceptedFirstTryRate: number | null; retryAttempts: number;
  tokens: InsightsTokens;
  spread: { agent: string; tasks: number; total: number }[];
  planner: { coverage: Coverage };
  /** Share of tokens spent outside the planner, 0–1; `null` until planner attribution exists. */
  ranOutsidePlanner: number | null;
  previous?: { rootTasksHandled: number } | null;
}
/** Measured or partial: at least one attempt reported tokens. A lower bound is partial. */
const coverage = (tokens: InsightsTokens | undefined): Coverage =>
  !tokens || !(tokens.total > 0) || tokens.measuredAttempts + tokens.partialAttempts === 0 ? "unknown" : tokens.lowerBound ? "partial" : "measured";

export type Period = "today" | "7d" | "30d";
export const PERIODS: { value: Period; label: string }[] = [{ value: "today", label: "Today" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }];
const DAY = 86400;
/** The period's range and today, in epoch seconds (`to` exclusive). Today starts at local midnight; the others are rolling. */
export function periodRange(period: Period, now: number): { from: number; to: number; today: { from: number; to: number } } {
  const midnight = new Date(now * 1000); midnight.setHours(0, 0, 0, 0);
  const start = Math.floor(midnight.getTime() / 1000);
  const from = period === "today" ? start : now - (period === "7d" ? 7 : 30) * DAY;
  return { from, to: now, today: { from: start, to: now } };
}
/** Rolling windows are named as such: 7 days is the last seven days, not the calendar week. */
export const periodHeading = (period: Period) => period === "today" ? "Today at a glance" : period === "7d" ? "Last 7 days at a glance" : "Last 30 days at a glance";
const versus = (period: Period) => period === "today" ? "vs the hours before" : period === "7d" ? "vs the 7 days before" : "vs the 30 days before";

export interface KpiTile { id: "handled" | "tokens" | "outside" | "accepted"; label: string; value: string; delta?: { text: string; tone: "good" | "bad" | "neutral" }; note?: string }
const pct = (part: number, whole: number) => `${Math.round(part / whole * 100)}%`;
/**
 * The at-a-glance strip from `insights.summary`. Each figure shows only when pacer measured it: tokens need a measured or partial
 * reading (a lower bound when partial), "ran outside planner" needs planner attribution, the accept rate needs a reviewed root,
 * and nothing is shown as zero or a dash.
 */
export function kpiTiles(current: InsightsSummary, period: Period, opts: { today?: InsightsSummary | null } = {}): KpiTile[] {
  const tiles: KpiTile[] = [], handled = current.rootTasksHandled, tokens = current.tokens;
  const change = current.previous ? handled - current.previous.rootTasksHandled : null;
  const today = period !== "today" && opts.today ? `${opts.today.rootTasksHandled} today` : null;
  tiles.push({ id: "handled", label: "Root tasks handled", value: String(handled),
    ...(change !== null ? { delta: { text: change > 0 ? `+${change}` : change < 0 ? `−${-change}` : "No change", tone: change > 0 ? "good" as const : "neutral" as const } } : {}),
    ...(change !== null || today ? { note: [change !== null ? versus(period) : null, today].filter(Boolean).join(" · ") } : {}) });
  const cover = coverage(tokens);
  if (cover !== "unknown") {
    const lower = cover === "partial" ? "≥ " : "";
    tiles.push({ id: "tokens", label: "Tokens spent", value: `${lower}${compactCount(tokens.total)}`,
      ...(handled > 0 ? { delta: { text: `${lower}${compactCount(Math.round(tokens.total / handled))}`, tone: "neutral" as const }, note: "per root task" } : {}) });
    if (current.planner.coverage !== "unknown" && typeof current.ranOutsidePlanner === "number") {
      const executors = current.spread.filter(row => row.total > 0).length;
      tiles.push({ id: "outside", label: "Ran outside planner", value: `${Math.round(current.ranOutsidePlanner * 100)}%`,
        delta: { text: compactCount(Math.round(tokens.total * current.ranOutsidePlanner)), tone: "neutral" }, note: `tokens on ${executors} executor${executors === 1 ? "" : "s"}` });
    }
  }
  if (current.acceptedFirstTryRate !== null && current.reviewedRoots > 0) tiles.push({ id: "accepted", label: "Accepted first try", value: `${Math.round(current.acceptedFirstTryRate * 100)}%`,
    delta: { text: `${current.acceptedFirstTry} of ${current.reviewedRoots}`, tone: "neutral" }, note: current.retryAttempts ? `reviewed · ${current.retryAttempts} ${current.retryAttempts === 1 ? "retry" : "retries"}` : "reviewed" });
  return tiles;
}

export type ChartSeries = 1 | 2 | 3 | 4 | 5;
export interface ShareSegment { id: string; label: string; agent?: string; role?: string; share: number; tasks: number; tokens: string; series: ChartSeries }
export interface TokenSpread { caption: string; partial: boolean; segments: ShareSegment[] }

/** Largest-remainder rounding, so the legend's percentages add up to 100. */
function percents(values: number[]): number[] {
  const sum = values.reduce((a, b) => a + b, 0);
  const raw = values.map(v => v / sum * 100), floor = raw.map(Math.floor);
  let left = 100 - floor.reduce((a, b) => a + b, 0);
  for (const i of raw.map((v, i) => [v - floor[i]!, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) { if (left-- <= 0) break; floor[i]!++; }
  return floor;
}

/**
 * Where the tokens went: shown only with a measured or partial reading. Five chart series at most; the rest group as "Other agents".
 * Shares are token volume, never cost. The planner is not in the spread until planner attribution exists.
 */
export function tokenSpread(summary: InsightsSummary | null | undefined): TokenSpread | null {
  if (!summary || coverage(summary.tokens) === "unknown") return null;
  const tokens = summary.tokens;
  const rows = summary.spread.filter(row => row.total > 0).sort((a, b) => b.total - a.total);
  if (!rows.length) return null;
  const top = rows.length > 5 ? rows.slice(0, 4) : rows, rest = rows.slice(top.length);
  const groups = [...top.map(row => ({ id: row.agent, label: executorLabel(row.agent), agent: markAgent(row.agent), role: "executor" as string | undefined, total: row.total, tasks: row.tasks })),
    ...rest.length ? [{ id: "other", label: "Other agents", agent: undefined, role: undefined, total: rest.reduce((n, r) => n + r.total, 0), tasks: rest.reduce((n, r) => n + r.tasks, 0) }] : []];
  const shares = percents(groups.map(g => g.total));
  const partial = coverage(tokens) === "partial", lower = partial ? "At least " : "", handled = summary.rootTasksHandled;
  const outside = summary.planner.coverage !== "unknown" && typeof summary.ranOutsidePlanner === "number" ? ` · ${Math.round(summary.ranOutsidePlanner * 100)}% ran outside the planner` : "";
  return {
    partial,
    caption: `${lower}${compactCount(tokens.total)} tokens on ${handled} root task${handled === 1 ? "" : "s"}${outside}${partial ? " · some attempts were not measured" : ""}`,
    segments: groups.map((g, i) => ({ id: g.id, label: g.label, ...(g.agent ? { agent: g.agent } : {}), ...(g.role ? { role: g.role } : {}), share: shares[i]!, series: (i + 1) as ChartSeries,
      tasks: g.tasks, tokens: compactCount(g.total) })),
  };
}
