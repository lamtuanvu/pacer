import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { WorkRow } from "../src/view-model/task-tree";
import type { InsightsSummary } from "../src/view-model/dispatch";
import { createActionRunner } from "../app/src/data/actions";
import { DispatchView, FirstRun, isFirstRun, holdInsights, insightsReads, NeedsYouList, type InsightsState, type RoutingPreview } from "../app/src/screens/dispatch/Dispatch";
import { RepoFilter, repoChoices } from "../app/src/screens/RepoFilter";

const snap = fixture as unknown as ClientSnapshot;
const runner = createActionRunner({ call: async <T,>() => ({} as T), waitFor: async () => true, refetch: () => {}, navigate: () => {} });
const eligible = { state: "eligible" as const, reasons: [], evaluatedAt: snap.at, validUntil: null, evidenceAgeS: 10, availability: "ready" as const, budget: "permitted" as const, spendingRisk: "not_observed" as const };
const routing: RoutingPreview = { loading: false, data: { ranked: [
  { id: "codex#team@devbox", verdict: "ok", reason: "ok, used 0%", eligibility: eligible },
  { id: "cursor", verdict: "ok", reason: "ok", eligibility: eligible },
  { id: "claude-code", verdict: "ok", reason: "ok", eligibility: eligible },
], excluded: [{ id: "local", reason: "down" }] } };
const summary = (handled = 42): InsightsSummary => ({ rootTasksHandled: handled, acceptedFirstTry: 31, reviewedRoots: 40, acceptedFirstTryRate: 31 / 40, retryAttempts: 6,
  tokens: { total: 1_840_000, measuredAttempts: 6, partialAttempts: 0, unknownAttempts: 0, attempts: 6, lowerBound: false },
  spread: [{ agent: "codex", total: 980_000, tasks: 4 }, { agent: "claude-code", total: 520_000, tasks: 6 }, { agent: "agy", total: 340_000, tasks: 2 }],
  planner: { coverage: "unknown" }, ranOutsidePlanner: null, previous: { rootTasksHandled: handled - 8 } });
const measured: InsightsState = { supported: true, loading: false, current: summary(), today: summary(9) };
const view = (repo: string | null = null, s: ClientSnapshot = snap, extra: { routing?: RoutingPreview | null; insights?: InsightsState; connected?: boolean; workRows?: WorkRow[]; workLoading?: boolean; workError?: unknown } = {}) =>
  renderToString(<DispatchView snapshot={s} query={{ repo, scope: null }} now={snap.at} runner={runner} routing={extra.routing === undefined ? routing : extra.routing} insights={extra.insights} onPeriod={() => {}} connected={extra.connected ?? true} workRows={extra.workRows} workLoading={extra.workLoading} workError={extra.workError} onWorkReload={() => {}} startWork={<p>start work composer</p>} />);
const order = (html: string, words: string[]) => words.map(w => html.indexOf(w));
const section = (html: string, id: string) => { const at = html.indexOf(`aria-labelledby="${id}"`); return at < 0 ? "" : html.slice(html.indexOf(">", at) + 1, html.indexOf("</section>", at)); };
const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** The at-a-glance strip is named by aria-label, so it is found by its id. */
const glance = (html: string) => { const at = html.indexOf('id="glance"'); return at < 0 ? "" : html.slice(html.indexOf(">", at) + 1, html.indexOf("</section>", at)); };
const plannerHalf = (html: string) => { const at = html.indexOf('id="planner-budget"'); return at < 0 ? "" : html.slice(at, html.indexOf('aria-labelledby="next-task"') > at ? html.indexOf('aria-labelledby="next-task"') : html.indexOf("</section>", at)); };

test("regions follow the board: title, period, repos and New task, then planner and next task, the period's figures, tokens and Needs you, live work", () => {
  const html = view(null, snap, { insights: measured });
  const at = order(html, ["<h1>Dispatch</h1>", "Live · ", 'aria-label="Period"', "All repos · 3", ">New task", 'aria-label="Planner budget and next decision"', ">Next task goes to<", 'aria-label="This week at a glance"', ">Where the tokens went<", ">Needs you<", ">Live dispatch<"]);
  expect(at.every(i => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  // The page carries the one title; the top bar drops its own on Dispatch (UI-9).
  expect(html.match(/<h1/g)).toHaveLength(1);
  expect(html).not.toContain("start work composer");
  // The page line carries the connection and update age, as on the board; the top bar drops its own on Dispatch (UI-15).
  expect(strip(html.slice(html.indexOf("Live · "), html.indexOf("</span>", html.indexOf("Live · "))))).toMatch(/^Live · \d+ agents? connected · updated \S+ ago$/);
  expect(view(null, snap, { connected: false })).toContain("Reconnecting…");
  // No snapshot time: no invented age.
  expect(strip(view(null, { ...snap, at: 0 }))).not.toMatch(/updated \d+d ago/);
});

test("period switch offers Today, 7 days and 30 days with 7 days selected, only with task insights", () => {
  // Without insights.summary the period changes nothing, so there is no switch.
  expect(view()).not.toContain('aria-label="Period"');
  const html = view(null, snap, { insights: measured });
  const group = html.slice(html.indexOf(">", html.indexOf('aria-label="Period"')) + 1, html.indexOf("</div>", html.indexOf('aria-label="Period"')));
  expect(strip(group)).toBe("Today 7 days 30 days");
  expect(group).toMatch(/aria-pressed="true"[^>]*>7 days</);
  expect(group.match(/aria-pressed="true"/g)).toHaveLength(1);
  for (const [period, label] of [["today", "Today at a glance"], ["7d", "This week at a glance"], ["30d", "Last 30 days at a glance"]] as const)
    expect(renderToString(<DispatchView snapshot={snap} query={{ repo: null, scope: null }} now={snap.at} runner={runner} period={period} insights={measured} />)).toContain(`aria-label="${label}"`);
});

test("New task is the primary action and uses the composer shortcut", () => {
  const html = view();
  expect(html).toMatch(/<button aria-keyshortcuts="Meta\+N" type="button" class="[^"]*pc-btn--primary[^"]*">New task <kbd class="pc-kbd">⌘N<\/kbd>/);
  // No quick-delegate box: the board has none.
  expect(html).not.toContain("Quick delegate");
});

test("kpi_strip_shows_the_week_from_insights with the board's icon tiles and no visible heading", () => {
  const strip_ = glance(view(null, snap, { insights: measured }));
  expect(strip(strip_)).toBe("Root tasks handled 42 +8 vs last week · 9 today Tokens spent 1.8M 43.8k per root task Ran outside planner Not measured Needs planner token attribution Accepted first try 78% 31 of 40 · 6 retried");
  expect(strip_).not.toMatch(/<h[1-6]/);
  expect(strip_.match(/class="pc-glance__icon pc-glance__icon--[a-z]+"/g)).toHaveLength(4);
  for (const icon of strip_.match(/<span class="pc-glance__icon[^"]*"><svg[^>]*>/g) ?? []) expect(icon).toContain('aria-hidden="true"');
});

test("kpi_strip_without_insights_says_why_and_never_invents_numbers", () => {
  const states: [InsightsState | undefined, string][] = [
    [undefined, "These figures need a newer pacer service with task insights."],
    [{ supported: true, loading: true }, ""],
    [{ supported: true, loading: false, error: new Error("boom") }, "Could not load these figures. They are checked again on the next update."],
  ];
  for (const [insights, words] of states) {
    const html = view(null, snap, { insights });
    expect(strip(glance(html))).toBe(words);
    expect(html).toContain('aria-label="This week at a glance"');
    expect(html).not.toContain('aria-labelledby="token-share"');
    expect(glance(html)).not.toMatch(/>\s*(0|0%|—)\s*</);
  }
  // A summary with no measured tokens shows the root count only, and no token share.
  const unmeasured = { ...summary(0), acceptedFirstTry: 0, reviewedRoots: 0, acceptedFirstTryRate: null, previous: null,
    tokens: { total: 0, measuredAttempts: 0, partialAttempts: 0, unknownAttempts: 2, attempts: 2, lowerBound: true } };
  const html = view(null, snap, { insights: { supported: true, loading: false, current: unmeasured } });
  expect(strip(glance(html))).toContain("Root tasks handled 0 Tokens spent Not measured");
  expect(strip(glance(html))).toContain("Ran outside planner Not measured");
  expect(html).not.toContain("pc-dispatch-share");
});

test("token share appears only with a reading, as a table by agent", () => {
  expect(view()).not.toContain("pc-dispatch-share");
  const share = section(view(null, snap, { insights: measured }), "token-share");
  expect(share).toContain('role="img"');
  expect(share).toContain('aria-label="Token share: Codex 53%, Claude Code 28%, Antigravity 19%"');
  expect(strip(share)).toContain("1.8M tokens on 42 root tasks");
  expect(strip(share)).toContain("Agent Tasks Tokens Share Codex executor 4 980k 53%");
  // Roles come from config: the configured planner is "planner"; its own tokens stay unknown until attribution exists.
  expect(strip(share)).toContain("Claude Code planner 6 520k 28%");
  expect(strip(share)).not.toContain("planning and review tokens are not measured yet.");
  expect(share).toContain('href="#/insights"');
});

test("Needs you shows three urgent cards, one board action and an All in Needs you link, without pagination", () => {
  const html = section(view(), "needs-you");
  expect(html.match(/data-attention-id=/g)).toHaveLength(3);
  expect(html).toContain("buildbox is not answering");
  expect(html).toContain('href="#/tasks/t-0409/failure"');
  expect(html).toContain(">Inspect failures<");
  expect(html).toContain('href="#/tasks/t-0412/review"');
  expect(html).toContain('href="#/needs-you"');
  expect(html).toContain(">All in Needs you<");
  expect(html).not.toContain("Needs you pages");
  expect(html).not.toContain(">Retry on Codex<");
  const question = { ...snap.attention![0]!, id: "question:answer-me", kind: "question" as const, taskId: "answer-me" };
  const answer = section(view(null, { ...snap, tasks: [], attention: [question] }), "needs-you");
  expect(answer).toContain('href="#/needs-you?answer=answer-me"');
  expect(answer).toContain(">Answer<");
});

test("Live dispatch is a six-row decision ledger with seven columns and task page links", () => {
  const html = section(view(), "live-dispatch");
  expect(strip(html)).toContain("Live dispatch 2 running 1 queued Kind · routed to · why · tokens");
  expect(html.match(/pc-list-row--link pc-dispatch-decision/g)).toHaveLength(6);
  expect(html).toContain('href="#/tasks/t-0420"');
  expect(html).toContain('href="#/tasks/t-0422"');
  expect(html).toContain("pc-dispatch-decision__agents");
  expect(html).toContain("pc-dispatch-decision__tokens");
  expect(html).toContain("pc-dispatch-decision__status");
  expect(html).not.toContain("pc-task-card");
  expect(html).not.toContain(">Take over<");
});

test("Live dispatch waits for parent links and offers retry when the work read fails", () => {
  const loading = section(view(null, snap, { workLoading: true }), "live-dispatch");
  expect(loading).not.toContain("pc-dispatch-decision__task");
  expect(strip(loading)).not.toContain("Loading dispatch");
  const failed = section(view(null, snap, { workError: new Error("Work read unavailable") }), "live-dispatch");
  expect(failed).not.toContain("pc-dispatch-decision__task");
  expect(strip(failed)).toContain("Work read unavailable");
  expect(strip(failed)).toContain("Try again");
});

test("Live dispatch groups two subtasks into one root row with its total tokens", () => {
  const root = { ...snap.tasks[0]!, id: "root", title: "Root work", updatedAt: 10 };
  const children = [1, 2].map(i => ({ ...root, id: `child-${i}`, title: `Child ${i}`, updatedAt: 20 + i }));
  const workRows: WorkRow[] = [root, ...children].map((task, i) => ({
    id: task.id, parentId: i ? root.id : null, rootId: root.id, depth: i ? 1 : 0,
    title: task.title, state: task.state, executor: task.executor, rev: 1,
    tokens: { total: 4000, measuredAttempts: 1, partialAttempts: 0, lowerBound: false },
  }));
  const html = section(view(null, { ...snap, tasks: [root, ...children] }, { workRows }), "live-dispatch");
  expect(html.match(/pc-list-row--link pc-dispatch-decision/g)).toHaveLength(1);
  expect(strip(html).match(/· 2 subtasks/g)).toHaveLength(1);
  expect(html).toContain('class="pc-dispatch-decision__tokens">12k</strong>');
  expect(html).not.toContain("Child 1");
  expect(html).not.toContain("Child 2");
  const running = section(view(null, { ...snap, tasks: [root, ...children].map(task => ({...task, state: "running"})), counts: {...snap.counts!, running: 3} }, { workRows: workRows.map(row => ({...row,state:"running"})) }), "live-dispatch");
  expect(strip(running)).toContain("1 running");
  expect(strip(running)).not.toContain("3 running");
});

test("Live dispatch shows unknown tokens as a muted dash with an explanation", () => {
  const html = section(view(null, { ...snap, tasks: [snap.tasks[0]!] }), "live-dispatch");
  expect(html).toContain('title="Token usage has not been measured for this task." class="pc-dispatch-decision__tokens muted">—</strong>');
  expect(html).not.toContain("Not measured");
});

test("Live dispatch orders roots newest first regardless of active state and hides orphan subtasks", () => {
  const tasks = Array.from({ length: 8 }, (_, i) => ({ ...snap.tasks[0]!, id: `root-${i}`, title: `Root ${i}`, updatedAt: i + 1, state: i === 0 ? "running" : "done" }));
  const orphan: WorkRow = { id: "orphan", parentId: "unloaded", rootId: "unloaded", depth: 1, title: "Orphan child", state: "running", executor: null, rev: 1 };
  const html = section(view(null, { ...snap, tasks }, { workRows: [orphan] }), "live-dispatch");
  expect(html.match(/pc-list-row--link pc-dispatch-decision/g)).toHaveLength(6);
  expect(order(html, ["Root 7", "Root 6", "Root 5", "Root 4", "Root 3", "Root 2"]).every(at => at >= 0)).toBe(true);
  expect(order(html, ["Root 7", "Root 6", "Root 5", "Root 4", "Root 3", "Root 2"])).toEqual([...order(html, ["Root 7", "Root 6", "Root 5", "Root 4", "Root 3", "Root 2"])].sort((a, b) => a - b));
  expect(html).not.toContain("Root 0");
  expect(html).not.toContain("Orphan child");
});

test("planner budget and next task share one split section; the planner half is the one place that states the planner figure", () => {
  const html = plannerHalf(view());
  expect(strip(html)).toContain("Claude Code Planner");
  expect(html).toContain("Claude Code is 14 points under pace. Small edits can stay on the planner; bulk work still goes out.");
  expect(html).toContain(">Under pace · spend it<");
  expect(html).toContain('aria-label="Claude Code weekly usage"');
  expect(strip(html)).toContain("63% of week used · pace 77% · resets");
  expect(strip(html)).not.toContain("5h window");
  expect(strip(plannerHalf(renderToString(<DispatchView snapshot={snap} query={{ repo: null, scope: null }} now={snap.at} runner={runner} shortWindowPct={4} />)))).toContain("· 5h window 4%");
  expect(view(null, { ...snap, planner: null })).not.toContain("planner-budget");
  // With no reading, the pill says so once; there is no empty meter repeating "usage unknown".
  const unknown = plannerHalf(view(null, { ...snap, accounts: [], executors: [], planner: { ...snap.planner!, usedPct: null, pacePct: null, verdict: "unknown" } }));
  expect(unknown).not.toContain("pc-meter");
  expect(strip(unknown).match(/usage unknown/gi)).toHaveLength(1);
});

test("next task goes to names the next agent, then the chain with chevrons ending in the queue, and the strategy", () => {
  const html = section(view(), "next-task");
  expect(strip(html)).toContain("Codex · team on devbox");
  expect(html).toContain(">Ready<");
  expect(strip(html)).toMatch(/Then: Cursor Claude Code Q Queue/);
  expect(html.match(/pc-dispatch-chain__sep/g)).toHaveLength(2);
  expect(html).not.toContain("ok, used 0%");
  expect(html).toContain("Execution permitted");
  expect(html).toMatch(/href="#\/settings\/dispatcher"[^>]*>Strategy: default · change</);
  expect(strip(section(view(null, snap, { routing: { loading: false, data: { ranked: [], excluded: [] } } }), "next-task"))).toContain("No agent can take new work now.");
  expect(strip(section(view(null, snap, { routing: { loading: true } }), "next-task"))).toContain("Checking routing…");
  expect(view(null, snap, { routing: null })).not.toContain('aria-labelledby="next-task"');
});

test("with dispatch.explain the next task states its ladder step, the dispatcher's own chain and strategy", () => {
  const explain = { outcome: "select" as const, strategy: { name: "balanced" }, engine: { id: "ladder" }, chosen: { runner: "claude-code" }, step: { id: "capable-spare", index: 0 },
    fallbacks: [{ runner: "claude-code", state: "eligible" as const }, { runner: "cursor", state: "eligible" as const }, { runner: "local", state: "excluded" as const, reason: { code: "executor_busy", facts: { used: 1, limit: 1 } } }],
    reasons: [{ outcome: "pass" as const, code: "step_match", facts: { stepId: "capable-spare" } }] };
  const html = section(view(null, snap, { routing: { ...routing, explain } }), "next-task");
  expect(strip(html)).toContain("Claude Code Ladder step 1 · capable spare");
  expect(html).toContain(">Ready<");
  expect(strip(html)).toMatch(/Then: Cursor Q Queue/);
  expect(html).not.toContain("Local");
  expect(html).toMatch(/href="#\/settings\/dispatcher"[^>]*>Strategy: balanced · change</);
  // An explanation that would queue the work names nobody, whatever the preview ranks first.
  expect(strip(section(view(null, snap, { routing: { ...routing, explain: { ...explain, outcome: "queue", chosen: null } } }), "next-task"))).toContain("No agent can take new work now. It waits in the queue. Local model is busy.");
});

test("narrow Dispatch follows the board: planner, Needs you, Running without desktop figures", () => {
  const html = renderToString(<DispatchView snapshot={snap} query={{ repo: null, scope: "repo:github.com/acme/api" }} now={snap.at} runner={runner} routing={routing} />);
  expect(html).not.toContain("<h1>");
  expect(html).not.toContain('aria-labelledby="agent-usage"');
  expect(html).not.toContain('id="glance"');
  const at = order(html, ['aria-label="Planner budget"', '>Needs you<', '>Running<']);
  expect(at.every(i => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  expect(html).toContain("Next capable task goes to");
});

test("repos are one All repos button that opens the repository menu", () => {
  const html = view();
  expect(html).toMatch(/aria-expanded="false"[^>]*>All repos · 3<\/button>/);
  expect(view("github.com/acme/api")).toMatch(/aria-expanded="false"[^>]*>acme\/api<\/button>/);
  expect(html).not.toContain("Budgets are shared across repos");
});

test("a repo scope filters Needs you and Live dispatch", () => {
  const html = view("github.com/acme/api");
  expect(html).toContain("Retry budget refresh on 429");
  expect(html).not.toContain("Add dark mode to the web header");
  expect(html).toContain("Add SSH keepalive to remote runs");
  expect(html).not.toContain("Split the settings page into sections");
  expect(html).toContain('href="#/needs-you?repo=github.com%2Facme%2Fapi"');
});

test("empty states say what to do next", () => {
  const empty = { ...snap, attention: [], tasks: [], counts: { ...snap.counts!, attention: 0, running: 0 } };
  const html = view(null, empty);
  expect(html).toContain("No work delegated yet");
  expect(html).toContain('href="#/tasks/new"');
  expect(html).not.toContain("Try a sample task");
});

test("Needs you bounds a long queue at three without a pager", () => {
  const item = snap.attention![0]!;
  const snapshot = { ...snap, attention: Array.from({ length: 13 }, (_, i) => ({ ...item, id: `page-${i}`, title: `Attention ${i}`, taskId: undefined })) };
  const html = view(null, snapshot);
  expect(html.match(/data-attention-id=/g)).toHaveLength(3);
  expect(html).not.toContain('aria-label="Needs you pages"');
  expect(html).not.toContain("1–5 of 13");
  expect(html).not.toContain("Attention 12");
});

// Thirty registrations include stale worktrees, recent completions and more active
// repositories than fit in the compact filter.
function thirtyRepos(): ClientSnapshot {
  const repos = Array.from({ length: 30 }, (_, i) => ({ key: `repo-${i}`, label: `Repo ${i}`, path: `/tmp/repos/${i}` }));
  return { ...snap, repos, attention: [], tasks: repos.map((repo, i) => ({ ...snap.tasks[0]!, id: `task-${i}`, repo, updatedAt: snap.at - i })),
    counts: { ...snap.counts!, byRepo: Object.fromEntries(repos.map((repo, i) => [repo.key, { attention: i < 7 ? (i === 0 ? 4 : 1) : 0, running: i === 1 ? 2 : 0, review: 0 }])) },
    today: { ...snap.today!, byRepo: { 'repo-8': 1 } },
  };
}

test("30 repos render All repos and at most five repo chips, ordered by work count then last use", () => {
  const snapshot = thirtyRepos();
  const html = renderToString(<RepoFilter snapshot={snapshot} query={{ repo: null, scope: null }} />);
  expect(repoChoices(snapshot, null).chips.map(repo => repo.key)).toEqual(['repo-0', 'repo-1', 'repo-2', 'repo-3', 'repo-4']);
  expect(html.match(/aria-pressed=/g)?.length).toBe(6);
  expect(html).toContain('All repos');
  expect(html).toContain('Find repo');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('Repo 29');
  expect(html).not.toContain('All repositories');
});

test("an idle active filter stays visible within the five repo limit", () => {
  const snapshot = thirtyRepos();
  const html = renderToString(<RepoFilter snapshot={snapshot} query={{ repo: 'repo-29', scope: null }} />);
  expect(html.match(/aria-pressed=/g)?.length).toBe(6);
  expect(html).toMatch(/aria-pressed="true"[^>]*><span[^>]*>Repo 29/);
  expect(html).not.toContain('>Repo 4 ');
  expect(repoChoices(snapshot, 'repo-29').chips.map(repo => repo.key)).toEqual(['repo-0', 'repo-1', 'repo-2', 'repo-3', 'repo-29']);
});

test("today's repos can fill spare chips, while zero-work repos are only in the searchable list", () => {
  const original = thirtyRepos();
  const snapshot = { ...original, counts: { ...original.counts!, byRepo: {} } };
  expect(repoChoices(snapshot, null).chips.map(repo => repo.key)).toEqual(['repo-8']);
  expect(repoChoices(snapshot, null).all).toHaveLength(30);
  expect(repoChoices(snapshot, null).all.find(repo => repo.key === 'repo-29')?.count).toBe(0);
});


test("insights reads always carry a range, and Today reads only itself", () => {
  const anchor = 1_800_000_000;
  expect(insightsReads("7d", anchor, null, false)).toEqual({ current: { op: "version.get", params: {} }, today: { op: "version.get", params: {} } });
  const week = insightsReads("7d", anchor, "github.com/acme/api", true);
  expect(week.current).toEqual({ op: "insights.summary", params: { from: anchor - 7 * 86400, to: anchor, bucket: "day", repo: "github.com/acme/api" } });
  expect(week.today.op).toBe("insights.summary");
  const today = insightsReads("today", anchor, null, true);
  expect(today.today).toEqual({ op: "version.get", params: {} });
  // Right at midnight the range is never empty (`to` is exclusive).
  const midnight = new Date(anchor * 1000); midnight.setHours(0, 0, 0, 0);
  const start = midnight.getTime() / 1000, atMidnight = insightsReads("today", start, null, true).current.params as { from: number; to: number };
  expect(atMidnight.to).toBeGreaterThan(atMidnight.from);
});

test("a moved range keeps the last figures for the same period and repo, never another's", () => {
  const first = holdInsights({ key: "" }, "7d", null, { data: summary(), loading: false }, { data: summary(9) });
  expect(first.state.current?.rootTasksHandled).toBe(42);
  // The anchor moved: the new range is loading, the last figures stay and nothing says loading.
  const moved = holdInsights(first.held, "7d", null, { loading: true }, {});
  expect(moved.state).toMatchObject({ loading: false, current: { rootTasksHandled: 42 }, today: { rootTasksHandled: 9 } });
  expect(moved.state.error).toBeUndefined();
  // Another repo or period starts empty, so its strip says it is loading instead of showing the wrong figures.
  for (const [period, repo] of [["7d", "github.com/acme/api"], ["30d", null]] as const) {
    const other = holdInsights(moved.held, period, repo, { loading: true }, {});
    expect(other.state).toEqual({ supported: true, loading: true, error: undefined, current: undefined, today: undefined });
  }
  // A failed first read with nothing to hold shows the error.
  expect(holdInsights({ key: "" }, "7d", null, { loading: false, error: new Error("x") }, {}).state.error).toBeInstanceOf(Error);
});

test("the standalone Needs you page keeps both actions per card, with the primary only for a task failure", () => {
  const html = renderToString(<NeedsYouList snapshot={snap} scope={{ repo: null }} runner={runner} now={snap.at} query={{ repo: null, scope: null }} narrow={false} standalone />);
  expect(html).toContain(">Decisions and problems<");
  const failed = html.slice(html.indexOf('data-attention-id="failed:t-0409"'), html.indexOf("Fix flaky retry test"));
  expect(failed).toMatch(/pc-btn--primary[^>]*>Retry on Codex</);
  expect(failed).toContain(">See error<");
  expect(html.match(/pc-btn--primary/g)).toHaveLength(1);
});

test("the repository menu button is named as a repository filter", () => {
  expect(view("github.com/acme/api")).toMatch(/id="repo-filter" role="group" aria-label="Repository filter"/);
});


test("an explained pick keeps its ladder step even when readiness is uncertain; the pill carries the warning", () => {
  const uncertain = { ...eligible, state: "uncertain" as const, availability: "unknown" as const, reasons: [{ code: "availability_unknown", evidenceIds: [] }] };
  const explain = { outcome: "select" as const, strategy: { name: "default" }, engine: { id: "ladder" }, chosen: { runner: "cursor" }, step: { id: "any-capacity-left", index: 1 }, fallbacks: [], reasons: [] };
  const html = section(view(null, snap, { routing: { loading: false, data: { ranked: [{ id: "cursor", verdict: "ok", reason: "ok", eligibility: uncertain }], excluded: [] }, explain } }), "next-task");
  expect(strip(html)).toContain("Cursor Ladder step 2 · any capacity left Executor availability is not confirmed");
  expect(html).toContain("pc-pill");
});

test("an explanation that does not apply still names the strategy beside the preview's pick", () => {
  const html = section(view(null, snap, { routing: { ...routing, strategy: "team" } }), "next-task");
  expect(strip(html)).toContain("Codex · team on devbox");
  expect(html).toMatch(/>Strategy: team · change</);
});

test("a chosen agent with no eligible fallback goes straight to the queue after it", () => {
  const explain = { outcome: "select" as const, strategy: { name: "default" }, engine: { id: "ladder" }, chosen: { runner: "claude-code" }, step: { id: "only", index: 0 },
    fallbacks: [{ runner: "cursor", state: "excluded" as const, reason: { code: "signed_out", facts: {} } }], reasons: [] };
  const html = section(view(null, snap, { routing: { ...routing, explain } }), "next-task");
  expect(strip(html)).toMatch(/Then: Q Queue/);
  expect(html).not.toContain("Cursor");
});

test("a failed dispatch refuses new tasks without promising a queue", () => {
  const explain = { outcome: "fail" as const, engine: { id: "ladder" }, strategy: { name: "default" }, chosen: null, step: null,
    fallbacks: [{ runner: "codex", state: "excluded" as const, reason: { code: "quota_exhausted", facts: {} } }], reasons: [] };
  const html = section(view(null, snap, { routing: { ...routing, explain } }), "next-task");
  expect(strip(html)).toContain("new tasks are refused rather than queued. Codex is out of budget. Change the strategy or make an agent available to accept new tasks.");
  expect(html).not.toContain("waits in the queue");
  expect(html).not.toContain("Then:");
  expect(html).not.toContain("pc-dispatch-chip--queue");
});

// A real mount runs useQuery effects; server rendering intentionally suppresses them.
test.skipIf(!process.env.PACER_TEST_BROWSER)("DispatchHome gates explain, aligns repositories and refreshes changed inputs", async () => {
  const { chromium } = await import("playwright-core");
  const root = process.cwd();
  const source = `/** @jsxImportSource preact */
    import { render } from "${root}/node_modules/preact";
    import { useState } from "${root}/node_modules/preact/hooks";
    import { DispatchHome } from "${root}/app/src/screens/dispatch/Dispatch";
    import { TaskContext } from "${root}/app/src/screens/task-shared";
    import { ActionContext } from "${root}/app/src/data/action-context";
    import { createActionRunner } from "${root}/app/src/data/actions";
    import { initialState } from "${root}/app/src/data/store";
    const root = document.getElementById("root");
    window.mount = (snapshot, ops, repo, workPages = {}) => {
      render(null, root);
      window.calls = [];
      const api = { call: async (op, params) => {
        window.calls.push({op, params});
        if (op === "dispatch.list") {
          if (window.failWork) throw new Error("Work read unavailable");
          await new Promise(resolve => setTimeout(resolve, 30));
          return workPages[params.before || "first"] || { tasks: [], next: null };
        }
        if (op === "routing.route") return {ranked: [], excluded: []};
        if (op === "dispatch.explain") return {outcome: "queue", engine: {id: "ladder"}, strategy: {name: "default"}, chosen: null, step: null, fallbacks: [], reasons: []};
        return {};
      }};
      const runner = createActionRunner({call: api.call, waitFor: async () => true, refetch() {}, navigate() {}});
      function Mounted() {
        const [current, update] = useState(snapshot);
        window.updateSnapshot = update;
        const state = {...initialState(), connected: true, snapshot: current, features: {readModel: true, ops: new Set(ops)}};
        return <TaskContext.Provider value={{state, api}}><ActionContext.Provider value={runner}><DispatchHome query={{repo, scope: null}} /></ActionContext.Provider></TaskContext.Provider>;
      }
      render(<Mounted />, root);
    };
  `;
  const build = await Bun.build({ entrypoints: ["dispatch-wiring"], tsconfig: `${root}/app/tsconfig.json`, target: "browser", format: "esm", minify: true,
    plugins: [{ name: "inline-dispatch-mount", setup(builder) {
      builder.onResolve({ filter: /^dispatch-wiring$/ }, () => ({ path: "dispatch-wiring", namespace: "inline" }));
      builder.onLoad({ filter: /.*/, namespace: "inline" }, () => ({ contents: source, loader: "tsx" }));
    } }] });
  expect(build.success).toBe(true);
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ type: "module", content: await build.outputs[0]!.text() });
    await page.waitForFunction(() => typeof (window as any).mount === "function");
    const both = ["routing.route", "dispatch.explain"];
    const cases = [
      { ops: both, repos: [{ key: "only-repo" }], repo: null, expected: "only-repo" },
      { ops: both, repos: [{ key: "one" }, { key: "two" }], repo: "active-repo", expected: "active-repo" },
      { ops: ["dispatch.explain"], repos: [{ key: "only-repo" }], repo: null, expected: null },
      { ops: ["routing.route"], repos: [{ key: "only-repo" }], repo: null, expected: null },
      { ops: [], repos: [{ key: "only-repo" }], repo: null, expected: null },
      { ops: both, repos: [], repo: null, expected: null },
      { ops: both, repos: [{ key: "one" }, { key: "two" }], repo: null, expected: null },
    ];
    for (const item of cases) {
      await page.evaluate(({ snapshot, ops, repo }) => (window as any).mount(snapshot, ops, repo), { snapshot: { ...snap, repos: item.repos.map(r => ({ ...r, label: r.key, path: `/tmp/${r.key}` })) }, ops: item.ops, repo: item.repo });
      await page.waitForFunction(() => (window as any).calls.length > 0);
      // Allow all effects to run, including a query that would incorrectly be gated off.
      await page.waitForTimeout(100);
      const calls = await page.evaluate(() => (window as any).calls as { op: string; params: unknown }[]);
      expect(calls).toContainEqual({ op: "dispatch.list", params: { relation: "all", limit: 100, ...(item.repo ? { repo: item.repo } : {}) } });
      expect(calls.filter(call => call.op === "dispatch.explain")).toEqual(item.expected ? [{ op: "dispatch.explain", params: { repo: item.expected, goal: "New task" } }] : []);
      if (item.expected) expect(calls).toContainEqual({ op: "routing.route", params: { repo: item.expected } });
    }
    let snapshot = { ...snap, repos: [{ key: "only-repo", label: "Only repo", path: "/tmp/only-repo" }] };
    await page.evaluate(snapshot => (window as any).mount(snapshot, ["routing.route", "dispatch.explain"], null), snapshot);
    const explainCount = () => page.evaluate(() => (window as any).calls.filter((c: any) => c.op === "dispatch.explain").length);
    await page.waitForFunction(() => (window as any).calls.some((c: any) => c.op === "dispatch.explain"));
    for (const change of ["executor", "running", "queued"]) {
      const before = await explainCount();
      snapshot = change === "executor" ? { ...snapshot, executors: snapshot.executors!.map((e, i) => i === 0 ? { ...e, state: "ready" } : e) } as typeof snapshot
        : { ...snapshot, tasks: [...snapshot.tasks, { ...snapshot.tasks[0]!, id: `new-${change}`, state: change }] };
      await page.evaluate(snapshot => (window as any).updateSnapshot(snapshot), snapshot);
      await page.waitForFunction(before => (window as any).calls.filter((c: any) => c.op === "dispatch.explain").length > before, before);
    }
    const rootTask = { ...snap.tasks[0]!, id: "root", title: "Paged root" };
    const childTasks = [1, 2].map(i => ({ ...rootTask, id: `child-${i}`, title: `Paged child ${i}` }));
    const rows = [rootTask, ...childTasks].map((task, i) => ({ id: task.id, title: task.title, parentId: i ? "root" : null, rootId: "root", depth: i ? 1 : 0, state: task.state, executor: task.executor, rev: 1, tokens: { total: 4000, measuredAttempts: 1, partialAttempts: 0, lowerBound: false } }));
    await page.evaluate(({ snapshot, rows }) => {
      (window as any).failWork = true;
      (window as any).mount(snapshot, ["dispatch.list"], "repo", { first: { tasks: rows.slice(0, 1), next: "older" }, older: { tasks: rows.slice(1), next: null } });
    }, { snapshot: { ...snap, tasks: [rootTask, ...childTasks].map(task => ({ ...task, repo: { key: "repo", label: "Repo" } })) }, rows });
    await page.getByText("Work read unavailable", { exact: true }).waitFor();
    expect(await page.locator(".pc-dispatch-decision").count()).toBe(0);
    await page.evaluate(() => { (window as any).failWork = false; });
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".pc-dispatch-decision__tokens")?.textContent === "12k");
    expect(await page.locator(".pc-dispatch-decision").count()).toBe(1);
    expect(await page.locator(".pc-dispatch-decision__repo").textContent()).toContain("· 2 subtasks");
    expect(await page.evaluate(() => (window as any).calls.some((call: any) => call.op === "dispatch.list" && call.params.before === "older" && call.params.repo === "repo"))).toBe(true);
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
}, 30000);


test("planner half shows a missing planner reading's historical figure as stale once", () => {
  const planner = { ...snap.planner!, runner: "codex#team", agent: "codex", usedPct: null, stale: true, advice: "No usage reading for the planner yet." };
  const historical = { ...snap, planner, accounts: [{ ...snap.accounts![0]!, executors: [planner.runner], usedPct: 28, window: "5h", stale: true, capturedAt: null }],
    executors: [{ ...snap.executors![0]!, id: planner.runner, usedPct: 28, stale: true }] };
  const html = plannerHalf(renderToString(<DispatchView snapshot={historical} query={{ repo: null, scope: null }} now={snap.at} runner={runner} shortWindowPct={99} />));
  expect(html).toContain("Usage reading is out of date.");
  expect(html).toContain("pc-meter--stale");
  expect(html).toContain('aria-valuenow="28"');
  expect(strip(html)).toContain("Historical usage · 28% used · 5h window · reading time unknown");
  // A historical reading has no current pace, so no pace pill sits above the meter.
  expect(html).not.toMatch(/Usage unknown|Under pace|On pace|Ahead of pace/);
  expect(html).not.toContain("No usage reading");
  expect(html).not.toContain("5h window 99%");
  expect(html).not.toContain("as of");
});

test("a fresh borrowed planner figure shows its meter without a pace pill or a stale mark", () => {
  const snapFresh = { ...snap, planner: { ...snap.planner!, usedPct: null, pacePct: null, verdict: "unknown" as const, stale: false },
    accounts: [{ name: "team", agent: "claude-code", source: "pacer", usedPct: 40, pacePct: null, window: "5h", resetsAt: null, verdict: "UNKNOWN", signedIn: true, executors: [snap.planner!.runner], stale: false, capturedAt: null, spendUsdWeek: null, capUsdWeek: null }] } as unknown as ClientSnapshot;
  const html = plannerHalf(view(null, snapFresh));
  expect(strip(html)).toContain("Planner pace is not measured yet.");
  expect(strip(html)).toContain("40% used · 5h window");
  expect(html).not.toMatch(/Usage unknown|Under pace|On pace|Ahead of pace/);
  expect(html).not.toContain("pc-meter--stale");
  expect(html).toContain('aria-valuetext="40% used"');
});

test("a live planner reading without a pace keeps its verdict pill", () => {
  for (const [verdict, usedPct] of [["out", 98], ["ahead", 92]] as const) {
    const html = plannerHalf(view(null, { ...snap, planner: { ...snap.planner!, verdict, usedPct, pacePct: null, stale: false } }));
    expect(html).toMatch(verdict === "out" ? /pc-pill[^>]*>[\s\S]*?Out of quota/ : /pc-pill[^>]*>[\s\S]*?Ahead of pace/);
    expect(html).toContain(`${usedPct}% of week used`);
  }
});


test("live dispatch keeps both count pills when no work is queued", () => {
  const noQueue = { ...snap, tasks: snap.tasks.filter(t => t.state !== "queued") };
  expect(section(view(null, noQueue), "live-dispatch")).toContain('class="pc-pill pc-pill--neutral">0 queued</span>');
  const empty = { ...snap, tasks: [], counts: { ...snap.counts!, running: 0, queued: 0 } };
  const html = section(view(null, empty), "live-dispatch");
  expect(html).toContain('class="pc-pill pc-pill--info">0 running</span>');
  expect(html).toContain('class="pc-pill pc-pill--neutral">0 queued</span>');
  expect(html).toContain('<strong class="pc-empty__body-title">Nothing running</strong>');
  expect(html).not.toContain('class="pc-section-heading">Nothing running');
});


test("the ledger preserves waiting/idle conversations and pairs failed-check copy with its failure tone", () => {
  const task = snap.tasks.find(task => task.state === "running")!;
  for (const [activity, label, tone] of [["waiting", "Needs input", "warn"], ["idle", "Ready for input", "neutral"]] as const) {
    const html = section(view(null, { ...snap, tasks: [{ ...task, interactionMode: "conversation", conversation: { activity } }] }), "live-dispatch");
    expect(html).toContain(`pc-pill pc-pill--${tone}">${label}</span>`);
    expect(html).not.toContain(">Working<");
  }
  const html = section(view(null, { ...snap, tasks: [{ ...task, state: "partial", acceptanceState: "failed" }] }), "live-dispatch");
  expect(html).toContain('pc-pill pc-pill--bad">Checks failed</span>');
});

test("task.answer has one link path without an unreachable ActionButton branch", async () => {
  const source = await Bun.file("app/src/screens/dispatch/Dispatch.tsx").text();
  expect(source.match(/action.op === "task.answer"/g)).toHaveLength(1);
  expect(source).toContain('action={action}');
});

test("first run requires missing planner integration and no configured executors", () => {
  expect(isFirstRun({ ...snap, planner: null, executors: [] })).toBe(true);
  expect(isFirstRun({ ...snap, executors: [] }, { checkedAt: 0, complete: false, ready: false, items: [{ id: "connect", title: "Connect", status: "pending", required: true }] })).toBe(true);
  expect(isFirstRun(snap)).toBe(false);
  expect(isFirstRun({ ...snap, executors: snap.executors!.filter(e => e.rank === "planner") }, { checkedAt: 0, complete: false, ready: false, items: [{ id: "connect", title: "Connect", status: "pending", required: true }] })).toBe(true);
  expect(isFirstRun({ ...snap, executors: [] }, { checkedAt: 0, complete: true, ready: true, items: [{ id: "connect", title: "Connect", status: "done", required: true }] })).toBe(false);
});
test("first run detection never invents installed agents", () => {
  const html = renderToString(<FirstRun query={{ repo: null, scope: null }} detections={[{ agent: "codex", found: false, version: null, path: null, install_hint: "Install Codex CLI" }]} />);
  expect(html).toContain("How to get it");
  expect(html).toContain("not installed");
  expect(html).not.toContain(">Found<");
  expect(renderToString(<FirstRun query={{ repo: null, scope: null }} />)).not.toContain("Looking for agent CLIs");
  expect(renderToString(<FirstRun query={{ repo: null, scope: null }} error={new Error("Detection failed")} retry={() => {}} />)).toContain("Check again");
});
