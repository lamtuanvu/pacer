export type PeriodKey = "today" | "7d" | "30d";
export const PERIODS = [{ value: "today", label: "Today" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }] as const;
const DAY = 86400;

/** Whole seconds, rounded so the query key is stable between renders; `to` is exclusive. */
export function periodRange(period: PeriodKey, nowMs: number): { from: number; to: number; bucket: "day" } {
  const to = Math.ceil(nowMs / 60000) * 60 + 60, start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const from = period === "today" ? start.getTime() / 1000 : start.getTime() / 1000 - (period === "7d" ? 6 : 29) * DAY;
  return { from: Math.floor(from), to, bucket: "day" };
}
/** The chart always shows the last 14 UTC days, which is how the service buckets them. */
export const CHART_DAYS = 14;
export function chartRange(nowMs: number): { from: number; to: number; bucket: "day" } {
  const to = Math.ceil(nowMs / 60000) * 60 + 60, today = Math.floor(nowMs / 1000 / DAY) * DAY;
  return { from: today - (CHART_DAYS - 1) * DAY, to, bucket: "day" };
}
export const compact = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
/** Axis labels read 4M / 2M / 0: whole millions and thousands carry no decimal. */
export const axisLabel = (n: number): string => n >= 1e6 ? `${Number.isInteger(n / 1e6) ? n / 1e6 : (n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Number.isInteger(n / 1e3) ? n / 1e3 : (n / 1e3).toFixed(1)}k` : String(n);
export const percent = (v: number | null): string => v === null ? "—" : `${Math.round(v * 100)}%`;
const shortDate = (seconds: number, utc = false) => new Date(seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(utc ? { timeZone: "UTC" } : {}) });
export const dayLabel = (at: number) => new Date(at * 1000).toLocaleDateString(undefined, { day: "numeric", timeZone: "UTC" });
export const fullDay = (at: number) => shortDate(at, true);
export const rangeLabel = (from: number, to: number) => `${shortDate(from)} – ${shortDate(to - 1)}`;

/** The previous period's words: "vs last wk" for a week, "vs yesterday" for today. */
export const versus = (period: PeriodKey) => period === "today" ? "vs yesterday" : period === "7d" ? "vs last wk" : "vs prev 30d";

/** Series slots follow agent identity: the same agent keeps its color. Slot 5 is the sixth chart color. */
const SLOTS: Record<string, number> = { codex: 0, "claude-code": 1, claude: 1, agy: 2, antigravity: 2, local: 3, cursor: 4 };
export const agentSlot = (agent: string): number => SLOTS[agent] ?? 5;
export const slotClass = (slot: number): string => `pc-insights__c${slot}`;

/** Round the chart's top up to 1, 2 or 5 times a power of ten, so the axis reads 4M / 2M / 0. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value)), f = value / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

interface Sums { total: number; input: number; output: number; cacheRead: number; cacheWrite: number; measuredAttempts: number; partialAttempts: number; unknownAttempts: number }
export interface Summary {
  from: number; to: number; bucket: "day" | "week"; rootTasksHandled: number; subtasks: number; attempts: number; retryAttempts: number;
  acceptedFirstTry: number; reviewedRoots: number; acceptedFirstTryRate: number | null;
  tokens: Sums & { attempts: number; lowerBound: boolean };
  spread: (Sums & { agent: string; rootTasks: number; tasks: number; subtasks: number; attempts: number; share: number | null; tokensPerTask: number | null; acceptanceRate: number | null })[];
  daily: { at: number; byAgent: Record<string, number> }[];
  kindByAgent: { kind: string; byAgent: Record<string, number> }[];
  ladder: { step: "1" | "2" | "P" | "Q"; name: string; count: number }[];
  rules: { rule: string; count: number }[];
  retryTokens: { attempts: number; total: number; unknownAttempts: number };
  skipReasons: { agent: string; reason: string; count: number }[];
  planner: { coverage: "unknown" }; decision: { coverage: "unknown" }; ranOutsidePlanner: null;
  previous: { rootTasksHandled: number; subtasks: number; retryAttempts: number; acceptedFirstTryRate: number | null; tokens: Sums & { attempts: number; lowerBound: boolean } };
}

/** One stacked bar per UTC day on a 0-100 scale against `max`; missing days are empty bars. */
export function bars(daily: Summary["daily"], agents: string[], from: number, days: number, max: number) {
  const byDay = new Map(daily.map(d => [d.at, d.byAgent]));
  return Array.from({ length: days }, (_, i) => {
    const at = Math.floor(from / DAY) * DAY + i * DAY, byAgent = byDay.get(at) ?? {};
    let y = 100;
    const rects = agents.flatMap(agent => {
      const value = byAgent[agent];
      if (!value) return [];
      const height = value / max * 100;
      y -= height;
      return [{ agent, slot: agentSlot(agent), y, height }];
    });
    return { at, total: Object.values(byAgent).reduce((n, v) => n + v, 0), rects };
  });
}

/** CSV of the summary response; the client builds it and the service is not involved. */
export function summaryCsv(s: Summary, label: (agent: string) => string): string {
  // Neutralize spreadsheet formulas first, then quote.
  const cell = (v: unknown) => { let t = v === null || v === undefined ? "" : String(v); if (/^[=+\-@\t\r]/.test(t) && typeof v === "string") t = `'${t}`; return /[",\n\r]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t; };
  const rows: unknown[][] = [
    ["agent", "root_tasks", "subtasks", "attempts", "tokens", "measured_attempts", "partial_attempts", "unknown_attempts", "share", "tokens_per_task", "acceptance_rate"],
    ...s.spread.map(g => [label(g.agent), g.rootTasks, g.subtasks, g.attempts, g.total, g.measuredAttempts, g.partialAttempts, g.unknownAttempts, g.share ?? "", g.tokensPerTask ?? "", g.acceptanceRate ?? ""]),
    [],
    ["period_start", "period_end", "root_tasks", "subtasks", "retry_attempts", "accepted_first_try", "reviewed_roots", "tokens", "tokens_lower_bound"],
    [new Date(s.from * 1000).toISOString(), new Date(s.to * 1000).toISOString(), s.rootTasksHandled, s.subtasks, s.retryAttempts, s.acceptedFirstTry, s.reviewedRoots, s.tokens.total, s.tokens.lowerBound],
  ];
  return rows.map(r => r.map(cell).join(",")).join("\n") + "\n";
}
