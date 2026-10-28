import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { InsightsSummary } from "../src/view-model/dispatch";
import { createActionRunner } from "../app/src/data/actions";
import { DispatchView, holdInsights, insightsReads, NeedsYouList, type InsightsState, type RoutingPreview } from "../app/src/screens/dispatch/Dispatch";
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
const view = (repo: string | null = null, s: ClientSnapshot = snap, extra: { routing?: RoutingPreview | null; insights?: InsightsState; connected?: boolean } = {}) =>
  renderToString(<DispatchView snapshot={s} query={{ repo, scope: null }} now={snap.at} runner={runner} routing={extra.routing === undefined ? routing : extra.routing} insights={extra.insights} onPeriod={() => {}} connected={extra.connected ?? true} startWork={<p>start work composer</p>} />);
const order = (html: string, words: string[]) => words.map(w => html.indexOf(w));
const section = (html: string, id: string) => { const at = html.indexOf(`aria-labelledby="${id}"`); return at < 0 ? "" : html.slice(html.indexOf(">", at) + 1, html.indexOf("</section>", at)); };
const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** The at-a-glance strip is named by aria-label, so it is found by its id. */
const glance = (html: string) => { const at = html.indexOf('id="glance"'); return at < 0 ? "" : html.slice(html.indexOf(">", at) + 1, html.indexOf("</section>", at)); };
const plannerHalf = (html: string) => { const at = html.indexOf('id="planner-budget"'); return at < 0 ? "" : html.slice(at, html.indexOf('aria-labelledby="next-task"') > at ? html.indexOf('aria-labelledby="next-task"') : html.indexOf("</section>", at)); };

test("regions follow the board: title, period, repos and New task, then planner and next task, the period's figures, tokens and Needs you, live work", () => {
  const html = view(null, snap, { insights: measured });
  const at = order(html, ["<h1>Dispatch</h1>", "Live · ", 'aria-label="Period"', "All repos · 3", ">New task", 'aria-label="Planner budget and next decision"', ">Next task goes to<", 'aria-label="This week at a glance"', ">Where the tokens went<", ">Needs you<", ">Live dispatch<", "start work composer"]);
  expect(at.every(i => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  // The page carries the one title; the top bar drops its own on Dispatch (UI-9).
  expect(html.match(/<h1/g)).toHaveLength(1);
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

test("New task is the primary action and opens the Delegate dialog until the composer lands", () => {
  const html = view();
  expect(html).toMatch(/<button aria-keyshortcuts="d" type="button" class="[^"]*pc-btn--primary[^"]*">New task <kbd class="pc-kbd">D<\/kbd>/);
  // No quick-delegate box: the board has none.
  expect(html).not.toContain("Quick delegate");
});

test("kpi_strip_shows_the_week_from_insights with the board's icon tiles and no visible heading", () => {
  const strip_ = glance(view(null, snap, { insights: measured }));
  expect(strip(strip_)).toBe("Root tasks handled 42 +8 vs last week · 9 today Tokens spent 1.8M 43.8k per root task Accepted first try 78% 31 of 40 · 6 retried");
  expect(strip_).not.toMatch(/<h[1-6]/);
  expect(strip_.match(/class="pc-glance__icon pc-glance__icon--[a-z]+"/g)).toHaveLength(3);
  for (const icon of strip_.match(/<span class="pc-glance__icon[^"]*"><svg[^>]*>/g) ?? []) expect(icon).toContain('aria-hidden="true"');
});

test("kpi_strip_without_insights_says_why_and_never_invents_numbers", () => {
  const states: [InsightsState | undefined, string][] = [
    [undefined, "These figures need a newer pacer service with task insights."],
    [{ supported: true, loading: true }, "Loading figures…"],
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
  expect(strip(glance(html))).toBe("Root tasks handled 0");
  expect(html).not.toContain("Tokens spent");
  expect(html).not.toContain("pc-share-bar");
});

test("token share appears only with a reading, as a table by agent", () => {
  expect(view()).not.toContain("pc-share-bar");
  const share = section(view(null, snap, { insights: measured }), "token-share");
  expect(share).toContain('role="img"');
  expect(share).toContain('aria-label="Token share: Codex 53%, Claude Code 28%, Antigravity 19%"');
  expect(strip(share)).toContain("1.8M tokens on 42 root tasks");
  expect(strip(share)).toContain("Agent Tasks Tokens Share Codex executor 4 980k 53%");
  // Roles come from config: the configured planner is "planner"; its own tokens stay unknown until attribution exists.
  expect(strip(share)).toContain("Claude Code planner 6 520k 28%");
  expect(strip(share)).toContain("Claude Code (planner): planning and review tokens are not measured yet.");
});

test("needs you cards are compact as on the board: glyph, title, one caption line and one action, most urgent first", () => {
  const html = section(view(), "needs-you");
  expect(html).toContain('<span class="pc-count pc-count--bad">4</span>');
  const at = order(html, ["buildbox is not answering", "Retry budget refresh on 429", "Fix flaky retry test in the payments client", "Add dark mode to the web header"]);
  expect(at.every(i => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  // Tinted by tone, with the status words beside the glyph for assistive technology (UI-2, UI-10).
  expect(html.match(/pc-list-row--outlined pc-list-row--bad/g)).toHaveLength(2);
  expect(html.match(/pc-list-row--outlined pc-list-row--warn/g)).toHaveLength(2);
  expect(html.match(/<span class="sr-only">Review requested: <\/span>/g)).toHaveLength(2);
  const failed = html.slice(html.indexOf('data-attention-id="failed:t-0409"'), html.indexOf("Fix flaky retry test"));
  expect(failed).toMatch(/Failed twice on Antigravity · test timed out after 120 s · \d{1,2}:\d{2}/);
  expect(failed).toContain('href="#/tasks/t-0409"');
  // One action per card; only a task failure's action is the primary, as on the board. A host problem's stays secondary.
  expect(failed).toMatch(/pc-btn--primary[^>]*>Retry on Codex</);
  expect(failed).not.toContain(">See error<");
  expect(html.match(/pc-btn--primary/g)).toHaveLength(1);
  const host = html.slice(html.indexOf('data-attention-id="host_down:buildbox"'), html.indexOf('data-attention-id="failed:t-0409"'));
  expect(host).toContain(">Run checks<");
  expect(host).not.toContain("pc-btn--primary");
  expect(html.slice(html.indexOf("Fix flaky retry test"))).not.toContain("pc-btn--primary");
  // Each card is a keyboard stop for j/k.
  expect(html.match(/data-attention-id="[^"]+" tabindex="0"/g)).toHaveLength(4);
  expect(html).toMatch(/href="#\/needs-you"[^>]*>All open items</);
  // One page of cards has no range footer.
  expect(html).not.toContain("Needs you pages");
});

test("live dispatch shows running and queued work as compact cards with their actions", () => {
  const html = section(view(), "live-dispatch");
  expect(strip(html)).toContain("Live dispatch 2 running 1 queued");
  expect(html.match(/pc-task-card--compact/g)).toHaveLength(3);
  expect(html.match(/pc-task-card--flush/g)).toHaveLength(3);
  expect(html).toContain('class="pc-pill pc-pill--info">2 running</span>');
  expect(html).toContain('class="pc-pill pc-pill--neutral">1 queued</span>');
  expect(html).toContain(">Editing<");
  expect(html).toContain(">Queued<");
  expect(html).toContain('href="#/tasks/t-0420"');
  expect(html.match(/>Take over</g)).toHaveLength(2);
  expect(html.match(/>Stop</g)).toHaveLength(1);
  expect(html).not.toContain("pc-btn--primary");
});

test("planner budget and next task share one split section; the planner half is the one place that states the planner figure", () => {
  const html = plannerHalf(view());
  expect(strip(html)).toContain("Claude Code Planner");
  expect(html).toContain("14 pts under pace — spend it.");
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
  expect(html).toContain(">Eligible<");
  expect(strip(html)).toMatch(/Then: Cursor Claude Code Q Queue/);
  expect(html.match(/pc-dispatch-chain__sep/g)).toHaveLength(2);
  expect(html).not.toContain("ok, used 0%");
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
  expect(html).toContain(">Eligible<");
  expect(strip(html)).toMatch(/Then: Cursor Q Queue/);
  expect(html).not.toContain("Local");
  expect(html).toMatch(/href="#\/settings\/dispatcher"[^>]*>Strategy: balanced · change</);
  // An explanation that would queue the work names nobody, whatever the preview ranks first.
  expect(strip(section(view(null, snap, { routing: { ...routing, explain: { ...explain, outcome: "queue", chosen: null } } }), "next-task"))).toContain("No agent can take new work now. It waits in the queue. Local model is busy (1 of 1 running).");
});

test("narrow Dispatch keeps executor usage and pace while the status bar is absent", () => {
  expect(view()).not.toContain('aria-labelledby="agent-usage"');
  const narrow = (s: ClientSnapshot) => renderToString(<DispatchView snapshot={s} query={{ repo: null, scope: "repo:github.com/acme/api" }} now={snap.at} runner={runner} routing={null} />);
  const agents = section(narrow(snap), "agent-usage");
  expect(agents).toContain(">Executors<");
  expect(agents).toMatch(/aria-label="[^"]+ · \d+% used · [^"]+"/);
  expect(agents).toMatch(/aria-label="[^"]+ · usage unknown · [^"]+"/);
  expect(agents).toContain('href="#/settings/executors?scope=repo%3Agithub.com%2Facme%2Fapi"');
  // The planner's own row is left out; the Planner budget covers it.
  expect(agents.match(/<a /g)).toHaveLength(snap.executors!.filter(e => e.rank !== "planner").length);
  // A stale reading is never shown as current.
  const row = snap.executors!.find(e => e.rank !== "planner" && e.usedPct !== null)!;
  const stale = section(narrow({ ...snap, executors: snap.executors!.map(e => e.id === row.id ? { ...e, stale: true } : e) }), "agent-usage");
  expect(stale).toMatch(new RegExp(`${Math.round(row.usedPct!)}% used · Historical usage`));
  expect(strip(stale)).toContain("Historical usage");
});

test("repos are one All repos button that opens the repository menu", () => {
  const html = view();
  expect(html).toMatch(/aria-expanded="false"[^>]*>All repos · 3<span aria-hidden="true">⌄<\/span>/);
  expect(view("github.com/acme/api")).toMatch(/aria-expanded="false"[^>]*>acme\/api<span/);
  expect(html).not.toContain("Budgets are shared across repos");
});

test("a repo scope filters Needs you and Live dispatch", () => {
  const html = view("github.com/acme/api");
  expect(html).toContain("Retry budget refresh on 429");
  expect(html).not.toContain("Add dark mode to the web header");
  expect(html).toContain("Add SSH keepalive to remote runs");
  expect(html).not.toContain("Split the settings page into sections");
  expect(html).toContain("+1 in other repos");
  expect(html).toContain('href="#/?repo="');
});

test("empty states say what to do next", () => {
  const empty = { ...snap, attention: [], tasks: [], counts: { ...snap.counts!, attention: 0, running: 0 } };
  const html = view(null, empty);
  expect(html).toContain("Nothing needs your attention");
  expect(strip(html)).toContain("Nothing running Start work, delegate a task, or ask your planner to.");
});

test("Needs you bounds a long queue and exposes its page range", () => {
  const item = snap.attention![0]!;
  const snapshot = { ...snap, attention: Array.from({ length: 13 }, (_, i) => ({ ...item, id: `page-${i}`, title: `Attention ${i}`, taskId: undefined })) };
  const html = view(null, snapshot);
  expect(html.match(/data-attention-id=/g)).toHaveLength(5);
  expect(html).toContain('aria-label="Needs you pages"');
  expect(html).toContain("1–5 of 13");
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

test("live dispatch action names include each task title", () => {
  const html = section(view(), "live-dispatch");
  for (const task of snap.tasks.filter(t => t.state === "running" || t.state === "queued")) {
    expect(html).toContain(`aria-label="${task.state === "queued" ? "Stop" : "Take over"} ${task.fullTitle ?? task.title ?? task.goal}"`);
  }
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
    window.mount = (snapshot, ops, repo) => {
      render(null, root);
      window.calls = [];
      const api = { call: async (op, params) => {
        window.calls.push({op, params});
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
  expect(html).toContain("Historical reading of the 5h window · reading time unknown");
  expect(html).not.toContain("No usage reading");
  expect(html).not.toContain("5h window 99%");
  expect(html).not.toContain("as of");
});


test("live dispatch keeps both count pills when no work is queued, including the empty state", () => {
  const noQueue = { ...snap, tasks: snap.tasks.filter(t => t.state !== "queued") };
  expect(section(view(null, noQueue), "live-dispatch")).toContain('class="pc-pill pc-pill--neutral">0 queued</span>');
  const empty = { ...snap, tasks: [], counts: { ...snap.counts!, running: 0, queued: 0 } };
  const html = section(view(null, empty), "live-dispatch");
  expect(html).toContain('class="pc-pill pc-pill--info">0 running</span>');
  expect(html).toContain('class="pc-pill pc-pill--neutral">0 queued</span>');
  expect(html).toContain('<strong class="pc-empty__body-title">Nothing running</strong>');
  expect(html).not.toContain('class="pc-section-heading">Nothing running');
});
