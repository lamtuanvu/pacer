import { parseRunnerId } from "../config/runner-id";
import type { Attempt, AttemptTokens } from "../tasks/types";
import type { Ctx } from "../types";
import { unknownTokens } from "./extract";
import { dispatchDatabase } from "../dispatch/store";
import { attemptTokensFromRow, readAttemptUsage, type AttemptUsageRow } from "./store";

/** One attempt as the roll-up sees it: its tokens and where they were spent. */
export interface TokenItem { executor: string; account: string | null; model: string | null; tokens: AttemptTokens }

export interface TokenReporting { reported: { input: boolean; output: boolean; cacheRead: boolean; cacheWrite: boolean } }
export interface TokenSums { total: number; input: number; cacheRead: number; cacheWrite: number; output: number }
export interface TokenCounts { measuredAttempts: number; partialAttempts: number; unknownAttempts: number }
export interface TokenSplit extends TokenSums, TokenCounts, TokenReporting { agent: string; account: string | null; model: string | null; attempts: number }
export interface TokenRollup extends TokenSums, TokenCounts, TokenReporting {
  /** True when any attempt is unknown or partial: the sums are then a lower bound. */
  lowerBound: boolean;
  byExecutor: TokenSplit[];
  planner: { coverage: "unknown" };
  decision: { coverage: "unknown" };
}

const zero = (): TokenSums => ({ total: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const unreported = (): TokenReporting => ({ reported: { input: false, output: false, cacheRead: false, cacheWrite: false } });
function add(into: TokenSums & TokenCounts & TokenReporting, t: AttemptTokens): void {
  // Keep the numeric sums compatible, while preserving null-means-not-reported per field.
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    into.reported[field] ||= t[field] !== null;
  }
  into.total += t.total ?? 0; into.input += t.input ?? 0; into.cacheRead += t.cacheRead ?? 0;
  into.cacheWrite += t.cacheWrite ?? 0; into.output += t.output ?? 0;
  if (t.coverage === "measured") into.measuredAttempts++; else if (t.coverage === "partial") into.partialAttempts++; else into.unknownAttempts++;
}

/** Each attempt belongs to exactly one node, so summing items never counts an attempt twice. */
export function rollupTokens(items: TokenItem[]): TokenRollup {
  const all = { ...zero(), ...unreported(), measuredAttempts: 0, partialAttempts: 0, unknownAttempts: 0 };
  const groups = new Map<string, TokenSplit>();
  for (const item of items) {
    add(all, item.tokens);
    const agent = parseRunnerId(item.executor)?.agent ?? item.executor, key = JSON.stringify([agent, item.account, item.model]);
    const group = groups.get(key) ?? { agent, account: item.account, model: item.model, attempts: 0, ...zero(), ...unreported(), measuredAttempts: 0, partialAttempts: 0, unknownAttempts: 0 };
    groups.set(key, group); group.attempts++; add(group, item.tokens);
  }
  const byExecutor = [...groups.values()].sort((a, b) => b.total - a.total || a.agent.localeCompare(b.agent));
  return { ...all, lowerBound: all.unknownAttempts > 0 || all.partialAttempts > 0, byExecutor, planner: { coverage: "unknown" }, decision: { coverage: "unknown" } };
}

/** The attempt's tokens: its own record first, else the index row (backfilled history), else unknown. */
export function attemptsWithTokens(ctx: Ctx, taskId: string, attempts: Attempt[]): (Attempt & { tokens: AttemptTokens })[] {
  const indexed = attempts.some(a => !a.tokens) ? readAttemptUsage(ctx, taskId) : new Map<number, AttemptTokens>();
  return attempts.map((a, i) => ({ ...a, tokens: a.tokens ?? indexed.get(i + 1) ?? unknownTokens("rollup@1", ctx, "no usage record for this attempt") }));
}

export interface ItemAttempt { executor: string; model?: string | null; actualModel?: string | null; usageAtStart?: { account?: string | null } | null; tokens: AttemptTokens }
export function itemsOf(attempts: ItemAttempt[]): TokenItem[] {
  return attempts.map(a => ({ executor: a.executor, account: a.usageAtStart?.account ?? parseRunnerId(a.executor)?.account ?? null, model: a.actualModel ?? a.model ?? null, tokens: a.tokens }));
}

/** A node whose task record cannot be read still contributes its index rows; with none it is one unknown attempt. */
export function itemsFromIndex(ctx: Ctx, taskId: string): TokenItem[] {
  const rows = dispatchDatabase(ctx).query<AttemptUsageRow, [string]>("SELECT * FROM attempt_usage WHERE task_id=? ORDER BY attempt").all(taskId);
  if (!rows.length) return [{ executor: "unknown", account: null, model: null, tokens: unknownTokens("rollup@1", ctx, "task record is unavailable and has no usage rows") }];
  return rows.map(r => ({ executor: r.executor, account: r.account ?? parseRunnerId(r.executor)?.account ?? null, model: r.model, tokens: attemptTokensFromRow(r) }));
}
