import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { InsightsSummary } from "../src/view-model/dispatch";
import { DelegateContext } from "../app/src/shell/delegate";
import { createActionRunner } from "../app/src/data/actions";
import { DispatchView, type InsightsState, type RoutingPreview } from "../app/src/screens/dispatch/Dispatch";
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
const view = (repo: string | null = null, s: ClientSnapshot = snap, extra: { routing?: RoutingPreview | null; insights?: InsightsState; delegate?: () => void } = {}) =>
  renderToString(<DelegateContext.Provider value={extra.delegate ?? null}><DispatchView snapshot={s} query={{ repo, scope: null }} now={snap.at} runner={runner} routing={extra.routing === undefined ? routing : extra.routing} insights={extra.insights} onPeriod={() => {}} startWork={<p>start work composer</p>} /></DelegateContext.Provider>);
const order = (html: string, words: string[]) => words.map(w => html.indexOf(w));
const section = (html: string, id: string) => { const at = html.indexOf(`aria-labelledby="${id}"`); return at < 0 ? "" : html.slice(html.indexOf(">", at) + 1, html.indexOf("</section>", at)); };
const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("regions follow the board: header, planner and next task, the period's figures, tokens and Needs you, then live work", () => {
  const html = view(null, snap, { insights: measured, delegate: () => {} });
  const at = order(html, ['aria-label="Period"', ">New task", ">Planner budget<", ">Next task goes to<", ">Last 7 days at a glance<", ">Where the tokens went<", ">Needs you<", ">Live dispatch<", "start work composer"]);
  expect(at.every(i => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  // The page title is the top bar's; sections use the DS heading only (UI-9).
  expect(html).not.toContain("<h1");
});

test("period switch offers Today, 7 days and 30 days with 7 days selected, only with task insights", () => {
  // Without insights.summary the period changes nothing, so there is no switch.
  expect(view()).not.toContain('aria-label="Period"');
  const html = view(null, snap, { insights: measured });
  const group = html.slice(html.indexOf(">", html.indexOf('aria-label="Period"')) + 1, html.indexOf("</div>", html.indexOf('aria-label="Period"')));
  expect(strip(group)).toBe("Today 7 days 30 days");
  expect(group).toMatch(/aria-pressed="true"[^>]*>7 days</);
  expect(group.match(/aria-pressed="true"/g)).toHaveLength(1);
  expect(strip(section(view(null, snap, { insights: measured }).replace("pc-dispatch", ""), "glance"))).toContain("Last 7 days at a glance");
});

test("New task is the primary action and opens the Delegate dialog until the composer lands", () => {
  const html = view(null, snap, { delegate: () => {} });
  expect(html).toMatch(/<button aria-keyshortcuts="d" type="button" class="[^"]*pc-btn--primary[^"]*">New task <kbd class="pc-kbd">D<\/kbd>/);
  // No quick-delegate box: the board has none.
  expect(html).not.toContain("Quick delegate");
  expect(view()).not.toContain(">New task");
});

test("kpi_strip_shows_the_week_from_insights", () => {
  expect(strip(section(view(null, snap, { insights: measured }), "glance"))).toBe(
    "Last 7 days at a glance Root tasks handled 42 +8 vs the 7 days before · 9 today Tokens spent 1.8M 43.8k per root task Accepted first try 78% 31 of 40 reviewed · 6 retries");
});

test("kpi_strip_without_insights_says_why_and_never_invents_numbers", () => {
  const states: [InsightsState | undefined, string][] = [
    [undefined, "Last 7 days at a glance These figures need a newer pacer service with task insights."],
    [{ supported: true, loading: true }, "Last 7 days at a glance Loading figures…"],
    [{ supported: true, loading: false, error: new Error("boom") }, "Last 7 days at a glance Could not load these figures. They are checked again on the next update."],
  ];
  for (const [insights, words] of states) {
    const html = view(null, snap, { insights });
    expect(strip(section(html, "glance"))).toBe(words);
    expect(html).not.toContain('aria-labelledby="token-share"');
    expect(section(html, "glance")).not.toMatch(/>\s*(0|0%|—)\s*</);
  }
  // A summary with no measured tokens shows the root count only, and no token share.
  const unmeasured = { ...summary(0), acceptedFirstTry: 0, reviewedRoots: 0, acceptedFirstTryRate: null, previous: null,
    tokens: { total: 0, measuredAttempts: 0, partialAttempts: 0, unknownAttempts: 2, attempts: 2, lowerBound: true } };
  const html = view(null, snap, { insights: { supported: true, loading: false, current: unmeasured } });
  expect(strip(section(html, "glance"))).toBe("Last 7 days at a glance Root tasks handled 0");
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
});

test("needs you cards are task tree nodes, most urgent first, with the service's words and actions", () => {
  const html = section(view(), "needs-you");
  expect(html).toContain('<span class="pc-count pc-count--warn">4</span>');
  const at = order(html, ["buildbox is not answering", "Retry budget refresh on 429", "Fix flaky retry test in the payments client", "Add dark mode to the web header"]);
  expect(at.every(i => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  // Task items render as the shared composite, tinted, with words beside the tint (UI-2, UI-10).
  expect(html.match(/class="pc-task-node pc-task-node--regular pc-task-node--bad"/g)).toHaveLength(1);
  expect(html.match(/class="pc-task-node pc-task-node--regular pc-task-node--warn"/g)).toHaveLength(2);
  expect(html.match(/>Review requested</g)?.length).toBe(2);
  const failed = html.slice(html.indexOf("Retry budget refresh on 429") - 400, html.indexOf("Fix flaky retry test"));
  expect(failed).toContain("Failed twice on Antigravity · test timed out after 120 s");
  expect(failed).toContain(">Retry on Codex<");
  expect(failed).toContain(">See error<");
  expect(failed).toContain('href="#/tasks/t-0409"');
  expect(html.match(/>Retry on [A-Z]/g)?.length).toBe(1);
  // A host problem has no task, so it keeps its row with the glyph and the label.
  const host = html.slice(html.indexOf('data-attention-id="host_down:buildbox"'), html.indexOf("Retry budget refresh on 429"));
  expect(host).toContain("pc-list-row--bad");
  expect(host).toContain("✕");
  expect(host).toContain(">Run checks<");
  // Each card is a keyboard stop for j/k.
  expect(html.match(/data-attention-id="[^"]+" tabindex="0"/g)).toHaveLength(4);
  expect(html).toContain('href="#/needs-you"');
  expect(html).not.toContain("pc-btn--primary");
});

test("live dispatch shows running and queued work as compact cards with their actions", () => {
  const html = section(view(), "live-dispatch");
  expect(strip(html)).toContain("Live dispatch 2 running · 1 queued");
  expect(html.match(/pc-task-node--compact/g)).toHaveLength(3);
  expect(html).toContain(">Editing<");
  expect(html).toContain(">Queued<");
  expect(html).toContain('href="#/tasks/t-0420"');
  expect(html.match(/>Take over</g)).toHaveLength(2);
  expect(html.match(/>Stop</g)).toHaveLength(1);
  expect(html).not.toContain("pc-btn--primary");
});

test("planner budget is the one place that states the planner figure", () => {
  const html = section(view(), "planner-budget-h");
  expect(strip(html)).toContain("Claude Code");
  expect(html).toContain("14 pts under pace — spend it.");
  expect(html).toContain(">Behind pace<");
  expect(html).toContain('aria-label="Claude Code planner usage"');
  expect(html).toContain("63% used · pace 77%");
  expect(view(null, { ...snap, planner: null })).not.toContain("planner-budget");
  // With no reading, the pill says so once; there is no empty meter repeating "usage unknown".
  const unknown = section(view(null, { ...snap, planner: { ...snap.planner!, usedPct: null, pacePct: null, verdict: "unknown" } }), "planner-budget-h");
  expect(unknown).not.toContain("pc-meter");
  expect(strip(unknown).match(/usage unknown/gi)).toHaveLength(1);
});

test("next task goes to names the next agent and the order after it, without internal reasons", () => {
  const html = section(view(), "next-task");
  expect(strip(html)).toContain("Codex · team on devbox");
  expect(html).toContain(">Eligible<");
  expect(strip(html)).toMatch(/Then Cursor Claude Code/);
  expect(html).not.toContain("ok, used 0%");
  expect(html).toContain('href="#/settings/dispatcher"');
  expect(strip(section(view(null, snap, { routing: { loading: false, data: { ranked: [], excluded: [] } } }), "next-task"))).toContain("No agent can take new work now.");
  expect(strip(section(view(null, snap, { routing: { loading: true } }), "next-task"))).toContain("Checking routing…");
  expect(view(null, snap, { routing: null })).not.toContain('aria-labelledby="next-task"');
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

test("repo chips show counts, pressed state and the shared-budget note", () => {
  const html = view("github.com/acme/api");
  expect(html).toContain("All repos");
  expect(html).toMatch(/aria-pressed="true"[^>]*><span[^>]*>acme\/api<\/span><span[^>]*aria-label="3 work items"[^>]*>3</);
  expect(html).toContain("Budgets are shared across repos; the filter only narrows work.");
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
  expect(html).toContain("Nothing running. Start work, delegate a task, or ask your planner to.");
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

