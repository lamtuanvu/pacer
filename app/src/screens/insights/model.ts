export type PeriodKey = "today" | "7d" | "30d";
export const PERIODS = [{ value: "today", label: "Today" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }] as const;

/** Whole seconds, rounded so the query key is stable between renders; `to` is exclusive. */
export function periodRange(period: PeriodKey, nowMs: number): { from: number; to: number; bucket: "day" } {
  const to = Math.ceil(nowMs / 60000) * 60 + 60, start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const from = period === "today" ? start.getTime() / 1000 : start.getTime() / 1000 - (period === "7d" ? 6 : 29) * 86400;
  return { from: Math.floor(from), to, bucket: "day" };
}
export const compact = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
export const percent = (v: number | null): string => v === null ? "—" : `${Math.round(v * 100)}%`;
/** Chart series classes; colors come from the chart tokens in CSS, never inline. */
export const agentClass = (index: number): string => `pc-insights__c${index % 5}`;

/** One stacked bar per bucket on a 0-100 scale: the tallest bucket fills the chart. */
export function bars(daily: Summary["daily"], agents: string[]): { at: number; total: number; rects: { agent: string; index: number; y: number; height: number }[] }[] {
  const totals = daily.map(d => Object.values(d.byAgent).reduce((n, v) => n + v, 0)), max = Math.max(1, ...totals);
  return daily.map((d, i) => {
    let y = 100;
    const rects = agents.flatMap((agent, index) => {
      const value = d.byAgent[agent];
      if (!value) return [];
      const height = value / max * 100;
      y -= height;
      return [{ agent, index, y, height }];
    });
    return { at: d.at, total: totals[i]!, rects };
  });
}

interface Sums { total: number; input: number; output: number; cacheRead: number; cacheWrite: number; measuredAttempts: number; partialAttempts: number; unknownAttempts: number }
export interface Summary {
  from: number; to: number; bucket: "day" | "week"; rootTasksHandled: number; subtasks: number; attempts: number; retryAttempts: number;
  acceptedFirstTry: number; reviewedRoots: number; acceptedFirstTryRate: number | null;
  tokens: Sums & { attempts: number; lowerBound: boolean };
  spread: (Sums & { agent: string; rootTasks: number; tasks: number; attempts: number; share: number | null; tokensPerTask: number | null; acceptanceRate: number | null })[];
  daily: { at: number; byAgent: Record<string, number> }[];
  kindByAgent: { kind: string; byAgent: Record<string, number> }[];
  ladder: { rule: string; count: number }[];
  skipReasons: { agent: string; reason: string; count: number }[];
  planner: { coverage: "unknown" }; decision: { coverage: "unknown" }; ranOutsidePlanner: null;
  previous: { rootTasksHandled: number; subtasks: number; retryAttempts: number; acceptedFirstTryRate: number | null; tokens: Sums & { attempts: number; lowerBound: boolean } };
}
