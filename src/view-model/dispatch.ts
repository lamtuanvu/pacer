/** Descriptors for the Dispatch home: Needs you cards, the at-a-glance strip and the token spread. Facts pacer lacks are left out, never shown as zero. */
import type { AttentionItem } from "../attention/types";
import type { ClientSnapshot } from "./snapshot";
import { agentInfo, markAgent } from "./agents";
import { attentionOrder, needsYou, type Scope } from "./selectors";
import { compactCount, scopedTaskTree, type TaskAttention, type TaskNodeView } from "./task-tree";
import { attentionStatus, executorLabel, paceStatus } from "./words";
import { ago, clock } from "./time";
import { knownRouteReason, routeReasonCopy, type RouteReason } from "./route-explanation";

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
/** The board's wording: 7 days reads as "this week" (a rolling seven days); Today and 30 days follow the same pattern. */
export const periodHeading = (period: Period) => period === "today" ? "Today at a glance" : period === "7d" ? "This week at a glance" : "Last 30 days at a glance";
const versus = (period: Period) => period === "today" ? "vs the hours before" : period === "7d" ? "vs last week" : "vs the 30 days before";

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
        delta: { text: compactCount(Math.round(tokens.total * current.ranOutsidePlanner)), tone: "good" }, note: `tokens on ${executors} executor${executors === 1 ? "" : "s"}` });
    }
  }
  if (current.acceptedFirstTryRate !== null && current.reviewedRoots > 0) tiles.push({ id: "accepted", label: "Accepted first try", value: `${Math.round(current.acceptedFirstTryRate * 100)}%`,
    delta: { text: `${current.acceptedFirstTry} of ${current.reviewedRoots}`, tone: "neutral" }, ...(current.retryAttempts ? { note: `· ${current.retryAttempts} retried` } : {}) });
  return tiles;
}

export type ChartSeries = 1 | 2 | 3 | 4 | 5;
export interface ShareSegment { id: string; label: string; agent?: string; role?: string; share: number; tasks: number; tokens: string; series: ChartSeries }
export interface TokenSpread { caption: string; partial: boolean; segments: ShareSegment[]; /** Says the planner's own tokens are not measured yet, instead of a number. */ plannerNote?: string }

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
 * Shares are token volume, never cost. Roles come from config: the configured planner is "planner", every other agent "executor".
 * The planner's own planning and review tokens are unknown until planner attribution exists, and the spread says so.
 */
export function tokenSpread(summary: InsightsSummary | null | undefined, planner: string | null = null): TokenSpread | null {
  if (!summary || coverage(summary.tokens) === "unknown") return null;
  const tokens = summary.tokens;
  const rows = summary.spread.filter(row => row.total > 0).sort((a, b) => b.total - a.total);
  if (!rows.length) return null;
  const top = rows.length > 5 ? rows.slice(0, 4) : rows, rest = rows.slice(top.length);
  const groups = [...top.map(row => ({ id: row.agent, label: executorLabel(row.agent), agent: markAgent(row.agent), role: (planner && (row.agent === planner || markAgent(row.agent) === planner) ? "planner" : "executor") as string | undefined, total: row.total, tasks: row.tasks })),
    ...rest.length ? [{ id: "other", label: "Other agents", agent: undefined, role: undefined, total: rest.reduce((n, r) => n + r.total, 0), tasks: rest.reduce((n, r) => n + r.tasks, 0) }] : []];
  const shares = percents(groups.map(g => g.total));
  const partial = coverage(tokens) === "partial", lower = partial ? "At least " : "", handled = summary.rootTasksHandled;
  const outside = summary.planner.coverage !== "unknown" && typeof summary.ranOutsidePlanner === "number" ? ` · ${Math.round(summary.ranOutsidePlanner * 100)}% ran outside the planner` : "";
  return {
    partial,
    caption: `${lower}${compactCount(tokens.total)} tokens on ${handled} root task${handled === 1 ? "" : "s"}${outside}${partial ? " · some attempts were not measured" : ""}`,
    segments: groups.map((g, i) => ({ id: g.id, label: g.label, ...(g.agent ? { agent: g.agent } : {}), ...(g.role ? { role: g.role } : {}), share: shares[i]!, series: (i + 1) as ChartSeries,
      tasks: g.tasks, tokens: compactCount(g.total) })),
    ...(planner && summary.planner.coverage === "unknown" ? { plannerNote: `${executorLabel(planner)} (planner): planning and review tokens are not measured yet.` } : {}),
  };
}

/** Planner pace in the board's words; tone and glyph come from the shared vocabulary. */
export function plannerPace(verdict: string): { label: string; tone: string } {
  const pace = paceStatus(verdict);
  const words: Record<string, string> = { behind: "Under pace · spend it", on_pace: "On pace", ahead: "Ahead of pace · save it" };
  return { label: words[verdict] ?? pace.label, tone: pace.tone };
}
/**
 * The planner caption under its meter, as on the board: "16% of week used · pace 38% · resets Thu 14:00 · 5h window 4%".
 * Each part shows only when measured; the short window comes from the planner account's own reading.
 */
export function plannerCaption(meter: { usedPct: number | null; pacePct: number | null; window: string | null; resetsAt: number | null }, now: number, shortWindowPct?: number | null): string {
  const span = meter.window === "weekly" ? "week" : meter.window === "monthly" ? "month" : meter.window === "daily" ? "day" : meter.window ? `the ${meter.window} window` : "the budget";
  return [
    meter.usedPct !== null ? `${Math.round(meter.usedPct)}% of ${span} used` : null,
    meter.pacePct !== null ? `pace ${Math.round(meter.pacePct)}%` : null,
    meter.resetsAt ? `resets ${clock(meter.resetsAt, now)}` : null,
    // The planner's own window may already be the 5-hour one; then it is not stated twice.
    typeof shortWindowPct === "number" && meter.window?.toLowerCase() !== "5h" ? `5h window ${Math.round(shortWindowPct)}%` : null,
  ].filter(Boolean).join(" · ");
}

/** One planner budget statement; historical figures never borrow a live short-window caption or pace. */
export function plannerBudget(snapshot: ClientSnapshot, now: number, shortWindowPct?: number | null): {
  lead: string; meter?: { used: number; pace: number | null; stale: boolean; label: string }; caption: string;
} | null {
  const p = snapshot.planner;
  if (!p) return null;
  const name = agentInfo(p.agent).name;
  if (p.usedPct !== null && !p.stale) return {
    lead: p.advice,
    meter: { used: p.usedPct, pace: p.pacePct, stale: false, label: `${name} ${p.window ? `${p.window} ` : ""}usage` },
    caption: plannerCaption(p, now, shortWindowPct),
  };
  const account = snapshot.accounts?.find(a => a.executors.includes(p.runner));
  const executor = snapshot.executors?.find(e => e.id === p.runner);
  const used = p.usedPct ?? account?.usedPct ?? executor?.usedPct;
  if (used == null) return { lead: p.advice, caption: "" };
  const window = p.usedPct !== null ? p.window : account?.usedPct != null ? account.window : null;
  const capturedAt = account?.capturedAt;
  return {
    lead: "Usage reading is out of date.",
    meter: { used, pace: null, stale: true, label: `${name} ${window ? `${window} ` : ""}usage` },
    caption: `Historical reading · ${plannerCaption({ usedPct: used, pacePct: null, window, resetsAt: null }, now)} · ${capturedAt == null ? "reading time unknown" : `read ${ago(capturedAt, now)}`}`,
  };
}

/** The parts of a `dispatch.explain` answer the Next task half uses. */
export interface RouteExplanationView {
  outcome: "select" | "queue" | "fail" | "override";
  strategy: { name: string; source?: "project" | "strategy" | "built-in" };
  engine: { id: string };
  chosen: { runner: string } | null;
  step: { id: string; index: number } | null;
  fallbacks: { runner: string; state: "eligible" | "excluded"; reason?: RouteReason }[];
  reasons: (RouteReason & { outcome: "pass" | "fail" | "info" })[];
}
/**
 * Whether the explanation describes what delegating would do. Without a dispatch block in the strategy, delegated
 * tasks are not managed work: the runner ranks executors as `routing.route` does, not by the ladder the explanation runs.
 */
export const explanationApplies = (e: RouteExplanationView): boolean => e.strategy.source !== "built-in";
/** The repository a "where would new work go" explanation is asked for: the active one, or the only one registered. */
export function explainRepo(scopeRepo: string | null, repos: { key: string }[] | undefined): string | null {
  return scopeRepo ?? (repos?.length === 1 ? repos[0]!.key : null);
}
/**
 * The Next task half from the dispatcher's own explanation: who takes new work, the ladder step that picked it,
 * and the eligible fallbacks after it in order. Null when the explanation names nobody (the work would queue or fail).
 */
export function nextFromExplanation(e: RouteExplanationView): { next: string; step: string | null; then: string[]; strategy: string } | null {
  if (e.outcome === "queue" || e.outcome === "fail" || !e.chosen) return null;
  const seen = new Set([e.chosen.runner]), then: string[] = [];
  for (const f of e.fallbacks) if (f.state === "eligible" && !seen.has(f.runner)) { seen.add(f.runner); then.push(f.runner); }
  const words = e.step?.id.replace(/[-_]+/g, " ");
  const step = e.step && e.engine.id === "ladder" && e.step.index >= 0 ? `Ladder step ${e.step.index + 1} · ${words}` : words ?? null;
  return { next: e.chosen.runner, step, then, strategy: e.strategy.name };
}
/** Structural exclusions do not explain why new work waits. */
const STRUCTURAL = new Set(["planner_account", "local_grant_required", "needs_new_worktree"]);
/** Dispatcher-wide reasons outrank any one executor's: a paused dispatcher is why work waits, not a busy agent. */
const DISPATCHER = new Set(["paused", "engine_failed"]);
export function queueReason(e: RouteExplanationView, now: number): string | null {
  const global = e.reasons.find(r => r.outcome === "fail" && DISPATCHER.has(r.code));
  if (global) return routeReasonCopy(global, now);
  const fallback = e.fallbacks.find(f => f.state === "excluded" && f.reason && !STRUCTURAL.has(f.reason.code));
  if (fallback?.reason) return routeReasonCopy(fallback.reason, now, fallback.runner);
  const reason = e.reasons.find(r => r.outcome === "fail" && !STRUCTURAL.has(r.code) && knownRouteReason(r.code));
  return reason ? routeReasonCopy(reason, now) : null;
}
