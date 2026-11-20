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
import { usageView, captionReset } from "../src/view-model/usage";
import { plannerBudget } from "../src/view-model/dispatch";
import { agentInfo } from "../src/view-model/agents";
import { accountLabel, executorLabel } from "../src/view-model/words";
import { StatusBar, UsageDetails } from "../app/src/shell/StatusBar";
import { createKeyRegistry } from "../app/src/keys/registry";
import { SettingsGeneral } from "../app/src/screens/settings";
import { Tray } from "../app/src/tray/Tray";
import { createTrayIpc } from "../app/src/tray/ipc";
import { DispatchView } from "../app/src/screens/dispatch/Dispatch";
import { createActionRunner } from "../app/src/data/actions";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import { settings } from "./fixtures/ui/settings";
import type { Route } from "../app/src/router";
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

const EXT = "planner: claude-code\naccounts:\n  claude: {kind: claude}\nhosts:\n  devbox: {ssh: devbox, accounts: {claude: {home: ~/claude-devbox}}}\nrunners:\n  claude-code: {}\n  claude-code@devbox: {host: devbox}\nrouting:\n  - default: [claude-code, claude-code@devbox]\n";

/** The fixture states (a)-(f) and (g): each seeds its account and returns its strategy. */
const states: { id: string; strategy: string; account: string; seed: (ctx: Ctx, s: Strategy) => void | Promise<void> }[] = [
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
  // (e) A runner-scoped limit on one of two runners: the planner reads the planner RUNNER record,
  // the account row reads the account record, and the rows never borrow each other's figure.
  { id: "e: runner-scoped limit on one of two runners", strategy: EXT, account: "claude", seed: (ctx: Ctx, s: Strategy) => {
    markExhausted(ctx, "claude", now + 3600, {scope: {...accountEvidenceScope(s.accounts.claude!, s.hosts), runner: "claude-code", model: "default", host: "local"}});
  } },
  // (f) A 3h-old reading: the 5h window is stale, the weekly one is not, and the record quotes the weekly binding.
  { id: "f: 5h and weekly windows with different freshness", strategy: CLAUDE, account: "claude", seed: async (ctx: Ctx, s: Strategy) => {
    claudeRateLimit(ctx, s.accounts.claude!, claudeReading(now - 3 * 3600, 40));
  } },
  { id: "g: unmetered", strategy: CURSOR_UNMETERED, account: "cursor", seed: () => {} },
];

const registry = createKeyRegistry({ controlActive: () => false });
const route = { name: "review", query: { repo: null, scope: null } } as unknown as Route;
const trayIpc = createTrayIpc({ location: { assign() {} } });
const runner = createActionRunner({ call: async <T,>() => ({}) as T, waitFor: async () => true, refetch: () => {}, navigate: () => {} });
const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

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

    // Each surface quotes its own record: the planner chip and tray read the planner RUNNER
    // record, the accounts tab reads the account record, and the cell reads the runner's record.
    expect(summaryRow.usageState).toEqual(listRow.usageState);
    const record = usageView(summaryRow.usageState, ctx.now);
    const expected = { figure: record.figure, meter: record.meter, window: record.window, reset: record.reset, freshness: record.freshness };
    const chip = usageView(plannerRow?.usageState ?? summaryRow.usageState, ctx.now);
    const cell = usageView(executorRows.find(r => r.account === state.account || r.id === plannerRow?.runner)?.usageState ?? summaryRow.usageState, ctx.now);
    const tab = usageView(listRow.usageState, ctx.now);
    const budget = plannerBudget(snapshot, ctx.now)!;
    const trayView = usageView(plannerRow?.usageState, ctx.now);
    for (const [surface, view, own] of [
      ["status bar chip", chip, plannerRow?.usageState ?? summaryRow.usageState],
      ["executors cell", cell, executorRows.find(r => r.account === state.account || r.id === plannerRow?.runner)?.usageState ?? summaryRow.usageState],
      ["accounts tab", tab, listRow.usageState],
      ["tray", trayView, plannerRow?.usageState ?? summaryRow.usageState],
    ] as const) {
      const ownView = usageView(own, ctx.now);
      expect([surface, view.figure, view.reset, view.freshness]).toEqual([surface, ownView.figure, ownView.reset, ownView.freshness]);
    }

    // The real surfaces render the same fixture: chips, the Executors and Accounts rows, the
    // tray planner strip and the Dispatch planner card each quote their own row's words.
    const appState = {...initialState(), snapshot};
    const api = {call: async () => ({}), hello: async () => ({}), snapshot: async () => ({})};
    const draw = (child: Parameters<typeof TaskContext.Provider>[0]["children"]) => renderToString(<TaskContext.Provider value={{state: appState, api} as never}>{child}</TaskContext.Provider>);

    const statusHtml = draw(<StatusBar route={route} snapshot={snapshot} registry={registry} />);
    // Each chip names its own agent and figure in its title; rows without a figure are absent.
    for (const row of executorRows) {
      const view = usageView(row.usageState, ctx.now);
      if (view.meter !== null) expect(statusHtml).toContain(`title="${executorLabel(row.id)} · ${view.figure}`);
    }
    if (plannerRow && usageView(plannerRow.usageState, ctx.now).meter !== null) {
      const plannerRecord = usageView(plannerRow.usageState, ctx.now);
      expect(statusHtml).toContain(`title="${agentInfo(plannerRow.agent).name} · ${plannerRecord.figure}`);
    }

    const popoverHtml = renderToString(<UsageDetails accounts={listRows} now={ctx.now} />);
    const popoverSection = popoverHtml.slice(popoverHtml.indexOf(`aria-label="${state.account} usage"`), popoverHtml.indexOf("</section>", popoverHtml.indexOf(`aria-label="${state.account} usage"`)));
    const figureRe = /Out of quota|No usage figure|Unmetered|Usage unknown|\d+%/;
    expect(["popover figure", popoverSection.match(figureRe)?.[0]]).toEqual(["popover figure", expected.figure]);
    expect(["popover reset", popoverSection.match(/resets [^<"]*|reset due|reset unknown/)?.[0] ?? ""]).toEqual(["popover reset", expected.reset]);
    expect(["popover freshness", popoverSection.match(/Updated \S+ ago|Reading \S+ old · refresh|Reading of unknown age · refresh/)?.[0] ?? null]).toEqual(["popover freshness", expected.freshness || null]);

    const executorsHtml = draw(<SettingsGeneral section="executors" initialData={settings}/>);
    const executorsRows = executorsHtml.split("<tr").slice(1);
    const cellHtml = (id: string) => executorsRows.find(r => r.includes(`<strong>${executorLabel(id)}</strong>`)) ?? "";
    // Target the specific row: the row quotes its own record — a live record states figure and
    // window, a historical one states the reading's age instead of a live figure.
    for (const row of executorRows) {
      const view = usageView(row.usageState, ctx.now);
      const cellText = strip(cellHtml(row.id));
      if (!cellText) continue;
      // A historical row keeps its figure next to the reading's age, like the popover and Accounts (UI-10).
      const words = row.usageState?.freshness === "historical" ? [view.summary, view.freshness].filter(Boolean).join(" · ")
        : [view.summary, captionReset(view.reset)].filter(Boolean).join(" · ");
      expect([`executors row ${row.id}`, cellText.includes(words)]).toEqual([`executors row ${row.id}`, true]);
    }

    const accountsHtml = draw(<SettingsGeneral section="accounts" initialData={{...settings, accounts: listRows}}/>);
    const accountHtml = accountsHtml.split("<tr").slice(1).find(r => r.includes(`<strong>${accountLabel({...listRow, agent: summaryRow.agent})}</strong>`)) ?? "";
    const accountWords = [record.summary, captionReset(record.reset), record.freshness].filter(Boolean).join(" · ");
    expect(strip(accountHtml)).toContain(accountWords);
    // The account row quotes the account record; it never borrows the planner runner's figure.
    if (plannerRow?.usageState && usageView(plannerRow.usageState, ctx.now).figure !== record.figure) {
      expect(strip(accountHtml)).not.toContain(usageView(plannerRow.usageState, ctx.now).summary);
    }

    // Budget windows: a limit window quotes the view ("Out of quota"), never a bare percent.
    const budgetHtml = draw(<SettingsGeneral section="planner" initialData={{...settings, accounts: listRows}}/>);
    if (record.figure === "Out of quota") {
      const windowsHtml = budgetHtml.slice(budgetHtml.indexOf('id="budget-windows-h"'));
      expect(strip(windowsHtml)).toContain("Out of quota");
      expect(strip(windowsHtml)).not.toMatch(/\b100%/);
    }

    const trayHtml = renderToString(<Tray snapshot={snapshot} api={api as never} ipc={trayIpc} />);
    const trayPlanner = trayHtml.slice(trayHtml.indexOf('aria-label="Planner budget"'), trayHtml.indexOf("</section>", trayHtml.indexOf('aria-label="Planner budget"')));
    if (plannerRow?.usageState && usageView(plannerRow.usageState, ctx.now).meter !== null) {
      const plannerRecord = usageView(plannerRow.usageState, ctx.now);
      const trayWords = strip(trayPlanner);
      expect(trayWords).toContain(plannerRecord.summaryUsed);
      if (plannerRecord.reset) expect(trayWords).toContain(plannerRecord.reset);
    }

    const dispatchHtml = renderToString(<DispatchView snapshot={snapshot} query={{ repo: null, scope: null }} now={ctx.now} runner={runner} routing={null}/>);
    const plannerCardAt = dispatchHtml.indexOf('id="planner-budget"');
    const plannerCard = dispatchHtml.slice(plannerCardAt, dispatchHtml.indexOf('aria-labelledby="next-task"') > plannerCardAt ? dispatchHtml.indexOf('aria-labelledby="next-task"') : dispatchHtml.indexOf("</section>", plannerCardAt));
    if (budget.meter) expect(strip(plannerCard)).toContain(budget.caption);

    // The planner budget caption states the record's figure when its meter is live; a historical
    // caption states the figure and the reading's age instead of a current reset.
    if (budget.meter && !budget.meter.stale) {
      expect(budget.caption).toContain(record.figure === `${expected.meter}%` ? `${expected.meter}% of ${expected.window} used` : expected.figure);
      if (expected.reset.startsWith("resets ")) expect(budget.caption).toContain(expected.reset);
    }
  });
}
