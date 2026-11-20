import { afterEach, expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadStrategy, type Strategy } from "../src/config/strategy";
import { computeStatus } from "../src/engine/status";
import { buildAccounts, buildExecutors, buildPlanner } from "../src/api/read-model/capacity";
import { list as accountsList } from "../src/core/accounts";
import { markExhausted } from "../src/usage/reactive";
import { claudeCachePaths } from "../src/usage/claude";
import { writeUsageEntry } from "../src/usage/store";
import { accountEvidenceScope, recordExecutionEvidence } from "../src/core/evidence";
import { fakeCtx, withLoginIndicators, localTs } from "./helpers";
import { cleanupUsageFixtures } from "./usage-plugin-fixtures";
import { usageView } from "../src/view-model/usage";
import { plannerBudget } from "../src/view-model/dispatch";
import { UsageDetails } from "../app/src/shell/StatusBar";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { Account } from "../app/src/model/accounts";
import uiFixture from "./fixtures/ui/snapshot.json";
import type { Ctx } from "../src/types";

afterEach(cleanupUsageFixtures);

// Cross-surface guard (ADR 0030 §6): for the shared fixture states, the status bar chip,
// the Usage popover row, the Executors table cell, the Accounts tab, the Dispatch planner
// budget and the tray quote the SAME figure, reset and freshness strings for one account,
// because every one of them renders usageView over the same usageState record.

const now = localTs(2026, 11, 20, 10, 0);
const CURSOR = "planner: cursor\naccounts:\n  cursor: {kind: cursor}\nrunners:\n  cursor: {}\nrouting:\n  - default: [cursor]\n";
const CURSOR_UNMETERED = "planner: cursor\naccounts:\n  cursor: {kind: cursor, usage: unmetered}\nrunners:\n  cursor: {}\nrouting:\n  - default: [cursor]\n";
const CLAUDE = "planner: claude-code\naccounts:\n  claude: {kind: claude}\nrunners:\n  claude-code: {}\nrouting:\n  - default: [claude-code]\n";

function load(ctx: Ctx, text: string): Strategy {
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), text);
  return loadStrategy(ctx);
}

function claudeRateLimit(ctx: Ctx, account: Parameters<typeof claudeCachePaths>[1], body: Record<string, unknown>): void {
  const file = claudeCachePaths(ctx, account)[0]!;
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, JSON.stringify(body));
}

const claudeReading = (capturedAt: number, weekly: number) =>
  ({seven_day: {used_percentage: weekly, resets_at: capturedAt + 3 * 86400}, five_hour: {used_percentage: Math.round(weekly / 2), resets_at: capturedAt + 2 * 3600}, captured_at: capturedAt});

/** The fixture states (a)-(d) and (g): each seeds its account and returns its strategy. */
const states = [
  { id: "a: reactive with an active limit", strategy: CURSOR, account: "cursor", seed: (ctx: Ctx, s: Strategy) => { markExhausted(ctx, "cursor", now + 3600, {manual: true}); } },
  { id: "b: reactive without a mark", strategy: CURSOR, account: "cursor", seed: async (ctx: Ctx, s: Strategy) => {
    await recordExecutionEvidence(ctx, accountEvidenceScope(s.accounts.cursor!, s.hosts), {endedAt: now - 60, exitCode: 0, timedOut: false, classification: "success"});
  } },
  { id: "c: failed read over an older stored reading", strategy: CLAUDE, account: "claude", seed: (ctx: Ctx, s: Strategy) => {
    writeUsageEntry(ctx, accountEvidenceScope(s.accounts.claude!, s.hosts).identity, "claude-code", {
      source: "session-log", capturedAt: now - 3 * 3600, stale: false,
      availability: {state: "ready", reason: "usage_observed", validUntil: null},
      windows: [{name: "weekly", usedPct: 40, resetsAt: now + 3 * 86400, lengthS: 7 * 86400, paced: true}],
    });
  } },
  { id: "d: days-old quota reading", strategy: CLAUDE, account: "claude", seed: async (ctx: Ctx, s: Strategy) => {
    claudeRateLimit(ctx, s.accounts.claude!, claudeReading(now - 3 * 86400, 40));
    await recordExecutionEvidence(ctx, accountEvidenceScope(s.accounts.claude!, s.hosts), {endedAt: now - 60, exitCode: 0, timedOut: false, classification: "success"});
  } },
  { id: "g: unmetered", strategy: CURSOR_UNMETERED, account: "cursor", seed: () => {} },
] as const;

for (const state of states) {
  test(`every app surface quotes the same usage words — ${state.id}`, async () => {
    const ctx = withLoginIndicators(fakeCtx({now}));
    const s = load(ctx, state.strategy);
    await state.seed(ctx, s);
    const st = await computeStatus(ctx, s, {profile: null});
    const listRows = (await accountsList(ctx)) as unknown as Account[];
    const summaryRows = buildAccounts(st, s, ctx);
    const executorRows = buildExecutors(st, s, [], ctx.now, ctx);
    const plannerRow = buildPlanner(st);
    const listRow = listRows.find(a => a.name === state.account)!;
    const summaryRow = summaryRows.find(a => a.name === state.account)!;

    // One ClientSnapshot fixture from the service rows over the shared UI fixture shell.
    const snapshot = {...uiFixture, at: ctx.now, accounts: summaryRows, executors: executorRows, planner: plannerRow} as unknown as ClientSnapshot;

    // Status bar chip and Executors table cell read the snapshot rows.
    const chip = usageView(plannerRow?.usageState ?? summaryRow.usageState, ctx.now);
    const cell = usageView(executorRows.find(r => r.account === state.account || r.id === plannerRow?.runner)?.usageState ?? summaryRow.usageState, ctx.now);
    // Accounts tab reads account.list; its record equals the snapshot's.
    const tab = usageView(listRow.usageState, ctx.now);
    expect(summaryRow.usageState).toEqual(listRow.usageState);
    // Dispatch planner budget and the tray read the planner row's record.
    const budget = plannerBudget(snapshot, ctx.now)!;
    const trayView = usageView(plannerRow?.usageState, ctx.now);

    // The Usage popover renders the account.list rows.
    const html = renderToString(<UsageDetails accounts={listRows} now={ctx.now} />);
    const section = html.slice(html.indexOf(`aria-label="${state.account} usage"`));
    const figureRe = /Out of quota|No usage figure|Unmetered|Usage unknown|\d+%/;
    const popoverFigure = section.match(figureRe)?.[0];
    const popoverReset = section.match(/resets [^<"]*|reset unknown/)?.[0];
    const popoverFreshness = section.match(/Updated \S+ ago|Reading \S+ old · refresh|Reading of unknown age · refresh/)?.[0];

    const record = usageView(summaryRow.usageState, ctx.now);
    const expected = { figure: record.figure, meter: record.meter, window: record.window, reset: record.reset, freshness: record.freshness };
    for (const [surface, view] of [["status bar chip", chip], ["executors cell", cell], ["accounts tab", tab], ["tray", trayView]] as const) {
      expect([surface, view.figure, view.reset, view.freshness]).toEqual([surface, expected.figure, expected.reset, expected.freshness]);
    }
    expect(["popover figure", popoverFigure]).toEqual(["popover figure", expected.figure]);
    expect(["popover reset", popoverReset ?? ""]).toEqual(["popover reset", expected.reset]);
    expect(["popover freshness", popoverFreshness ?? null]).toEqual(["popover freshness", expected.freshness || null]);
    // The planner budget caption states the record's figure when its meter is live; a historical
    // caption states the figure and the reading's age instead of a current reset.
    if (budget.meter && !budget.meter.stale) {
      expect(budget.caption).toContain(record.figure === `${expected.meter}%` ? `${expected.meter}% of ${expected.window} used` : expected.figure);
      if (expected.reset.startsWith("resets ")) expect(budget.caption).toContain(expected.reset);
    }
  });
}
